# Eumaeus — Implementation Plan

> Source of truth: `architecture.md` + `architecture-review.md`. This document turns those into a concrete, buildable plan. No application code yet — this is the last document before code.

## 0. Locked principles (from this phase's brief)

The 20 principles in the brief are treated as non-negotiable constraints on everything below. Where a design choice below could conflict with one, the principle wins and the tradeoff is called out explicitly rather than silently avoided.

## 0.1 Stack decisions (committed, not left open)

A plan with open-ended "could use X or Y" choices isn't implementation-ready. Committing now:

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (backend + frontend) | One shared `packages/shared` for `DecisionSchema`, rule condition trees, destination config types — the exact places where a frontend/backend type mismatch would be a silent bug |
| Backend runtime | Node.js, single codebase, two entrypoints (`server.ts`, `worker.ts`) | Modular monolith as instructed — one deployable image, multiple process roles, no network hop between "modules" |
| HTTP framework | Fastify | Lightweight, schema-validated request/response (pairs well with the zod-typed API contracts in §R) |
| Database | PostgreSQL | JSONB for `DecisionSchema`/rule conditions/Jev answers, native row-level security for tenant isolation |
| ORM/migrations | Prisma | Type-safe queries matching the shared TS types; migrations are plain SQL files that can be hand-extended with RLS policies Prisma itself doesn't manage |
| Queue | Redis + BullMQ | Durable jobs, delay/backoff/retry built in, cron-style repeatable jobs for reconciliation/watch-renewal without a separate scheduler service |
| Object storage | S3-compatible (AWS S3 or Cloudflare R2) | `body_ref` blobs with a bucket lifecycle rule doing the 30-day purge — no app-level cron required for retention |
| Gmail push transport | **Pull subscription**, not push-to-webhook | See §E — avoids exposing a public webhook endpoint, avoids JWT verification complexity, identical code path in local dev and production |
| Frontend | Next.js (React), talks to backend only via REST — no direct DB access from the frontend | Keeps the "no secrets in frontend" boundary structurally enforced, not just a convention |
| Secrets | Cloud KMS (envelope encryption for OAuth tokens) + a secrets manager for service credentials | See §Q |

**Deliberately not abstracted yet (YAGNI, per the brief's instruction not to build for hypothetical future integrations):**
- No generic `EmailProvider` interface pretending to support Outlook — `mailbox/gmail/*` is Gmail-specific, direct Gmail API calls. Outlook support later means adding a `mailbox/outlook/*` sibling and *then* extracting a shared interface from two real implementations, not designing one from a single implementation today.
- No generic `AIProvider`/`LLMProvider` interface wrapping Jev — `jev/client.ts` is Jev-specific, matching Jev's actual `state`+`questions` request shape. A second decision-engine provider is not in scope for V1 and no abstraction is invented to anticipate it.
- The **destination adapter interface IS built now**, because V1 already ships four concrete channel types (email/webhook/archive/human_review) that genuinely need a common `deliver(action): Promise<DeliveryResult>` contract today — this is abstraction justified by present need, not speculative future need.

---

## A. Repository / project structure

Single monorepo, pnpm workspaces:

```
eumaeus/
├── apps/
│   ├── api/                 # backend: HTTP server + worker entrypoints, one codebase
│   │   ├── src/
│   │   │   ├── server.ts        # Fastify HTTP entrypoint (dashboard API, OAuth callback)
│   │   │   ├── worker.ts        # BullMQ worker entrypoint (all queues below)
│   │   │   ├── modules/
│   │   │   │   ├── tenancy/
│   │   │   │   ├── mailbox/         # Gmail OAuth + watch + Gmail API calls
│   │   │   │   ├── ingestion/       # raw message → Email row, preprocessing
│   │   │   │   ├── jev/             # Jev client + DecisionSchema
│   │   │   │   ├── rules/           # rule CRUD + condition evaluator
│   │   │   │   ├── destinations/    # destination/channel CRUD + delivery adapters
│   │   │   │   ├── review/          # Human Review CRUD + resolution
│   │   │   │   ├── audit/           # AuditEvent writer + query
│   │   │   │   └── health/          # stuck-state + connection-health checks
│   │   │   └── queues/              # BullMQ queue + job definitions, one file per job type
│   │   └── prisma/
│   │       ├── schema.prisma
│   │       └── migrations/
│   └── web/                 # Next.js dashboard, REST client only, zero DB/queue access
│       └── src/app/...
├── packages/
│   └── shared/               # types + zod schemas shared by api and web:
│                              #   DecisionSchema, RuleCondition tree, DestinationConfig,
│                              #   API request/response contracts
├── docker-compose.yml        # postgres, redis, minio (S3-compatible), for local dev
└── pnpm-workspace.yaml
```

**Why this shape:** `apps/api` is the entire modular monolith — `server.ts` and `worker.ts` both import the same `modules/*`, so there is exactly one implementation of "how a rule is evaluated" or "how an email is preprocessed," regardless of which process triggers it. `apps/web` never talks to Postgres/Redis directly, which is what makes "no API keys in frontend code" a structural property of the repo layout, not a rule someone has to remember.

---

## B. Backend services/modules

Applying the required template to every module:

### `modules/tenancy`
- **Why it exists:** every other table is scoped by tenant; this module owns tenant creation, plan/retention settings, and is the thing Postgres RLS policies key off of.
- **Owns:** `Tenant`, `RetentionPolicy` (embedded settings on Tenant).
- **Must NOT:** contain any email-processing logic — it's pure account/settings state.
- **Dependencies:** none (foundational).
- **Failure behavior:** N/A (simple CRUD; failures are standard DB-error-to-500).

### `modules/mailbox`
- **Why it exists:** the only module that talks to Gmail — OAuth flow, token storage/refresh, `watch()` registration and renewal, and the Gmail API calls used by ingestion.
- **Owns:** `MailboxConnection` (including encrypted refresh token).
- **Must NOT:** make routing/action decisions, or store parsed email content (that's `ingestion`'s job) — this module's job ends at "here is a raw Gmail message payload."
- **Dependencies:** `tenancy` (a mailbox belongs to a tenant), `Q` secrets/KMS for token encryption.
- **Failure behavior:** OAuth token invalid/revoked → `MailboxConnection.status = reauth_required`, surfaced to dashboard, ingestion for that mailbox pauses (visibly, not silently) until re-auth.

### `modules/ingestion`
- **Why it exists:** turns a raw Gmail message into a durable, idempotent `Email` row, and runs the untrusted-input preprocessing pipeline (§ architecture-review §3) before anything else touches the content.
- **Owns:** `Email` rows (state machine owner), the preprocessing pipeline (HTML→text, quoted-chain stripping, size cap, Unicode normalization, hidden-content heuristic, SPF/DKIM/DMARC extraction from headers).
- **Must NOT:** call Jev, evaluate rules, or execute any action — ingestion's only output is a normalized `Email` row plus an enqueued `analyze` job.
- **Dependencies:** `mailbox` (source of raw messages), `audit` (logs every insert).
- **Failure behavior:** malformed MIME/parse failure → email still gets an `Email` row (state=`failed`) rather than being dropped, then routed to Human Review — a parse failure is data, not a reason to lose the message.

### `modules/jev`
- **Why it exists:** the only module allowed to call the Jev API; owns the pinned model version and the versioned `DecisionSchema`.
- **Owns:** `AnalysisResult` rows, `DecisionSchema` definitions (versioned config, not DB-migrated per field).
- **Must NOT:** decide a destination, execute an action, or treat its own output as authorization for anything — this module's contract ends at "here is a typed answer set with probabilities," full stop. Enforced by construction: this module has no reference to `Destination`/`Action` types at all.
- **Dependencies:** `ingestion` (consumes normalized `Email.body_normalized`), `audit`.
- **Failure behavior:** timeout/error/malformed response → `AnalysisResult(status=error)` written (never silently skipped), email routed to Human Review (`reason=failed`) by the `route` job, per the SDK's documented retry defaults before giving up (architecture-review §1 fact #8).

### `modules/rules`
- **Why it exists:** the deterministic gate between AI signal and action, per principle #11.
- **Owns:** `Rule` (versioned), `RuleEvaluation` (one row per active rule per email, matched or not).
- **Must NOT:** call Jev, call a destination adapter directly, or apply "all matching rules" semantics — strictly evaluates and selects, execution is `destinations`' job.
- **Dependencies:** `jev` (reads `AnalysisResult.answers`), `ingestion` (reads deterministic email fields: sender/subject/attachments/headers).
- **Failure behavior:** an exception mid-evaluation is caught, logged, and the email is routed to Human Review (`reason=failed`) — a rule engine bug must degrade to "ask a human," never to "silently do nothing" or crash the worker.

### `modules/destinations`
- **Why it exists:** the only module allowed to produce an external side effect (send email, POST webhook, apply archive label).
- **Owns:** `Destination`, `DestinationChannel`, `Action`.
- **Must NOT:** make classification or routing decisions — it receives "deliver to destination X because rule Y matched" as a fully-formed instruction and executes it; it never independently interprets a Jev signal.
- **Dependencies:** `rules` (receives the routing decision), `mailbox` (email-notification channel uses the system relay address, not the user's mailbox — see architecture-review §9), `audit`.
- **Failure behavior:** per-channel retry with backoff; after exhaustion, `Action.status=failed` and the email is reopened to Human Review even if other channels under the same destination succeeded — partial failure is a visible state, not swallowed.

### `modules/review`
- **Why it exists:** the mandatory safety net (principle #12) — implements "unmatched/low-confidence/failed → Human Review" as unconditional engine behavior, not an optional feature.
- **Owns:** `HumanReviewItem`.
- **Must NOT:** auto-resolve itself — every item requires an explicit human action (classify + pick destination) that is itself logged through `audit` and executed through `destinations`, same as an automated match.
- **Dependencies:** `rules` (creates items on unmatched/failed), `destinations` (executes the human-chosen action).
- **Failure behavior:** N/A — this module *is* the failure-handling destination for every other module.

### `modules/audit`
- **Why it exists:** the permanent, append-only decision trail (principle #19) — every other module writes through this one function, never directly to a log table of their own.
- **Owns:** `AuditEvent` (append-only).
- **Must NOT:** be skippable — every state transition in every module calls `audit.record(...)` as part of the same transaction as the state change, not as a best-effort afterthought.
- **Dependencies:** none (leaf module every other module depends on).
- **Failure behavior:** if the audit write itself fails, the whole transaction fails and rolls back — a state transition that can't be recorded must not be allowed to happen "silently," which would violate principle #19 at the source.

### `modules/health`
- **Why it exists:** the backstop for architecture-review §6's honest version of the guarantee — "nothing can go wrong invisibly."
- **Owns:** no new tables; queries `Email.state` + `state_updated_at` and `MailboxConnection.status`/`watch_expiration`.
- **Must NOT:** attempt to auto-fix stuck emails — it only detects and alerts; a stuck email is exactly the kind of anomaly that should get a human's attention, not a second layer of automated guessing.
- **Dependencies:** reads from `ingestion`, `mailbox`.
- **Failure behavior:** the health check itself failing to run (cron didn't fire) is the one failure mode this module can't self-detect — mitigated by external uptime monitoring on the cron job's own heartbeat (§U).

---

## C. Database schema

Finalizing architecture.md §4 + architecture-review's additions into concrete tables. Types are Postgres; JSONB used deliberately only where the shape is genuinely variable (rule conditions, Jev answers, decision schema) — everything else is typed columns, not JSONB-for-convenience.

```sql
tenant (
  id uuid pk, name text, plan text, zdr_enabled boolean default false,
  body_retention_days int default 30, created_at timestamptz
)

mailbox_connection (
  id uuid pk, tenant_id uuid fk, provider text check in ('gmail'),
  email_address text, oauth_refresh_token_encrypted bytea,
  scopes text[], watch_expiration timestamptz,
  status text check in ('active','reauth_required','disabled'),
  last_synced_history_id text, created_at timestamptz
)

email (
  id uuid pk, tenant_id uuid fk, mailbox_connection_id uuid fk,
  provider_message_id text, thread_id text,
  from_address text, to_addresses text[], cc_addresses text[], subject text,
  received_at timestamptz,
  spf_result text, dkim_result text, dmarc_result text,
  has_attachments boolean, attachment_meta jsonb,   -- [{filename, mime, size}], content never stored
  body_normalized text,               -- preprocessed text sent to Jev
  body_ref text null,                 -- pointer into object storage; nulled by retention purge
  state text check in ('received','analyzing','rules_evaluating','routing',
                        'executing_actions','completed','awaiting_review','failed'),
  state_updated_at timestamptz,
  ingested_at timestamptz,
  unique (tenant_id, provider_message_id)
)

decision_schema (
  id uuid pk, version text unique,     -- e.g. 'decision-schema/v1'
  jev_model text,                      -- pinned, e.g. 'jev-1.13.0'
  questions jsonb,                     -- the question map, see §J
  is_active boolean, created_at timestamptz
)

analysis_result (
  id uuid pk, email_id uuid fk, decision_schema_id uuid fk,
  answers jsonb,                       -- {question_key: {value/probabilities/confidence}}
  status text check in ('ok','timeout','error'),
  latency_ms int, input_tokens int, output_tokens int,
  created_at timestamptz
  -- immutable; a re-analysis inserts a new row
)

rule (
  id uuid pk, tenant_id uuid fk, name text, priority int,
  is_active boolean, is_shadow boolean,
  decision_schema_id uuid fk,          -- pins which schema version this rule's conditions reference
  conditions jsonb,                    -- condition tree, see §K
  destination_id uuid fk,
  version int, created_by uuid, created_at timestamptz, deactivated_at timestamptz null,
  unique (tenant_id, priority) where is_active     -- structurally prevents priority ties
)

rule_evaluation (
  id uuid pk, email_id uuid fk, rule_id uuid fk,
  matched boolean, reason jsonb,       -- which leaves passed/failed
  evaluated_at timestamptz
)

destination (
  id uuid pk, tenant_id uuid fk, name text, description text, created_at timestamptz
)

destination_channel (
  id uuid pk, destination_id uuid fk,
  type text check in ('email','webhook','archive','human_review'),
  config jsonb,                        -- {to:[...]} | {url,secret} | {labels:[...]} | {}
  is_active boolean
)

action (
  id uuid pk, email_id uuid fk, rule_id uuid fk null,   -- null if human-resolved
  destination_id uuid fk, destination_channel_id uuid fk,
  type text, status text check in ('pending','success','failed','retrying'),
  attempt_count int default 0, last_error text, executed_at timestamptz
)

audit_event (
  id uuid pk, tenant_id uuid fk, email_id uuid fk null,
  event_type text, payload jsonb, actor text,   -- 'system' | user_id
  created_at timestamptz
  -- append-only: no UPDATE/DELETE grants on this table for the app role, enforced at the DB level
)

human_review_item (
  id uuid pk, tenant_id uuid fk, email_id uuid fk,
  reason text check in ('low_confidence','unmatched','ambiguous','failed'),
  status text check in ('open','resolved'),
  assigned_to uuid null, resolved_action_id uuid fk null, resolved_at timestamptz null
)
```

**Row-Level Security:** every table above has `tenant_id` (directly or via `email_id`→`email.tenant_id` for child tables) and gets an RLS policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)`, set per-request by the API layer after authenticating the caller. This is defense-in-depth on top of application-layer tenant scoping — a bug that forgets a `WHERE tenant_id = ...` clause still can't cross tenants.

**`audit_event` append-only enforcement:** the Postgres role the app connects as has `INSERT`/`SELECT` but not `UPDATE`/`DELETE` on this table, enforced by `GRANT`, not just convention.

---

## D. Gmail OAuth architecture

- **Flow:** standard OAuth 2.0 authorization code flow, initiated from the dashboard (`modules/mailbox`), callback handled by `apps/api/server.ts`.
- **Scopes requested (default):** `gmail.readonly`, `gmail.labels` (for archive/label actions) — no `gmail.send`, per architecture-review §9's notify-not-forward decision. `gmail.send` is never requested in V1.
- **Token storage:** refresh token encrypted (envelope encryption via KMS, §Q) before the `INSERT` into `mailbox_connection.oauth_refresh_token_encrypted`; access tokens are never persisted — fetched fresh from the refresh token at call time and held only in memory for the duration of a single job.
- **Re-consent path:** if a refresh fails with `invalid_grant`, `MailboxConnection.status` flips to `reauth_required` and the dashboard shows a blocking banner with a re-connect button that re-runs the same OAuth flow.
- **Failure behavior:** OAuth callback errors (user denies consent, state mismatch) redirect to the dashboard with an inline error — never a bare 500 page, since this is the first thing a new tenant does with the product.

---

## E. Gmail webhook / Pub/Sub architecture

**Decision: pull subscription, not push-to-webhook.**

- Gmail's `users.watch()` publishes to a **Google Cloud Pub/Sub topic** (this is unavoidable — it's how Gmail push works regardless of what cloud the app itself runs on, so a GCP project is required purely to own this topic and the Gmail API OAuth client, even if Postgres/Redis/compute live elsewhere).
- A single **pull subscription** on that topic is consumed by a dedicated long-running worker process (`pubsub-consume`, part of `apps/api worker.ts`) using Google's Pub/Sub client library.
- **Why pull over push:** push requires a publicly reachable HTTPS endpoint plus JWT verification of the incoming request (attack surface, extra security code to get right); pull requires no public endpoint at all — the worker reaches out to Google, not the other way around. It also means local development needs no tunnel (ngrok etc.) to receive real push traffic — the same pull worker code runs identically in dev and prod against the same subscription (scoped to a dev-only GCP project).
- **What the message contains:** Gmail's Pub/Sub payload is just `{emailAddress, historyId}` — not the message content itself. On receipt, the consumer resolves `emailAddress` → `mailbox_connection_id` and enqueues a `sync-mailbox` job (BullMQ job id = `mailbox_connection_id`, so rapid repeated notifications for the same mailbox coalesce into one queued sync rather than a flood of redundant jobs).
- **Ack semantics:** the Pub/Sub message is only ack'd after the `sync-mailbox` job is successfully enqueued (not after it completes) — this keeps the ack fast (Pub/Sub has a limited ack deadline) while still guaranteeing durability, because the job itself is now durably in Redis/BullMQ.
- **Failure behavior:** if enqueueing fails (Redis down), the message is not ack'd and Pub/Sub redelivers later — this is exactly the kind of at-least-once delivery the idempotency strategy (§G) is built to tolerate, so a redelivered notification is safe by construction, not by luck.

---

## F. Reconciliation worker architecture

- A repeatable BullMQ job (`reconcile`, cron-scheduled every 3–5 minutes) iterates active `mailbox_connection` rows and enqueues the **same** `sync-mailbox` job used by the Pub/Sub path (job id = `mailbox_connection_id`, so if a push-triggered sync is already queued/running for that mailbox, the poll-triggered one coalesces with it instead of duplicating work).
- `sync-mailbox`'s own logic (not the trigger) decides how to sync: if `last_synced_history_id` is set and still valid, use `history.list` from that checkpoint; if it's missing or Gmail returns 404 (expired/invalid history), fall back to a bounded `messages.list` scan (e.g. last 7 days) to resync, then resume history-based sync from the new checkpoint.
- **Why this unification matters:** there is exactly one ingestion code path regardless of whether push or poll triggered it — this directly satisfies principle #6 ("push combined with reconciliation") without maintaining two separate implementations that could drift and disagree.
- **Watch renewal:** a second repeatable job (`watch-renew`, daily) re-registers `users.watch()` for any mailbox within 24h of `watch_expiration`; failure flips `MailboxConnection.status` appropriately and is surfaced, not silently retried forever.
- **Failure behavior:** a single mailbox's sync failing (e.g. that tenant's OAuth token is revoked) must not block reconciliation for other tenants — each mailbox's sync job fails/succeeds independently, standard BullMQ per-job isolation.

---

## G. Idempotency strategy

The single mechanism that makes push+poll safe to run concurrently, restated as concrete rules:

1. **Ingestion:** `INSERT INTO email (...) ON CONFLICT (tenant_id, provider_message_id) DO NOTHING`, then only enqueue `analyze` if the insert actually happened (check `RETURNING` row count) — a redelivered/duplicate sync is a guaranteed no-op past this point.
2. **Analysis:** `analyze` job checks `SELECT 1 FROM analysis_result WHERE email_id = $1 AND decision_schema_id = $2` before calling Jev — a retried job for an already-analyzed email under the same schema version skips the (paid) API call entirely.
3. **Action delivery:** `deliver` job checks `SELECT 1 FROM action WHERE email_id = $1 AND destination_channel_id = $2 AND status = 'success'` before executing — a retried delivery job never double-sends a notification email or double-posts a webhook.
4. **BullMQ job IDs:** wherever a natural key exists (`mailbox_connection_id` for sync jobs, `email_id` for analyze/route jobs), it's used as the BullMQ job ID, so BullMQ's own dedup prevents redundant queueing before the idempotency checks above even run.

---

## H. Email processing state machine

Unchanged from architecture.md §8 / architecture-review §6, restated as the authoritative version with the module that owns each transition:

```
received            [ingestion: insert]
   │
   ▼
analyzing            [jev: call in progress]
   │
   ├─(timeout/error, retries exhausted)──▶ awaiting_review(reason=failed)   [review]
   │
   ▼ (AnalysisResult written)
rules_evaluating     [rules: evaluate]
   │
   ├─(match found)──▶ routing ──▶ executing_actions ──▶ completed          [destinations]
   │                                    │
   │                                    └─(channel failure, retries exhausted)──▶ failed → awaiting_review(reason=failed)
   │
   └─(no match / low confidence)──▶ awaiting_review(reason=unmatched|low_confidence)  [review]
                                          │
                                   (human resolves)
                                          ▼
                                   routing → executing_actions → completed
```

`Email.state` + `state_updated_at` are updated in the same DB transaction as the corresponding `audit_event` insert — never as two separate writes that could disagree if one fails.

---

## I. Jev client module

- **Why it exists:** isolates the one place in the codebase that knows Jev's request/response shape, the pinned model version, and the retry policy — every other module only ever sees `AnalysisResult` rows.
- **Owns:** the HTTP call to `POST https://api.typesafe.ai/v1/systemone` (architecture-review §1 fact #1), request construction from `DecisionSchema.questions` + `Email.body_normalized`, response parsing into `AnalysisResult`.
- **Configuration:** `model` pinned to a resolved version string (e.g. `jev-1.13.0`), never the floating `jev-latest` alias (architecture-review §2) — changing this value is a deliberate, reviewed config change, not something that drifts.
- **Retry policy:** mirrors the officially-documented SDK defaults (architecture-review §1 fact #8) — retry on 408/429/500-599 + connection/timeout errors, exponential backoff 0.5s→5.0s doubling with jitter, max 2 retries, 30s total budget — implemented explicitly in this module rather than assumed from an SDK default, since the plan should not silently depend on whatever a third-party SDK's defaults happen to be today.
- **Must NOT:** retry on 401/422 (these are configuration bugs, not transient failures — retrying them just wastes the budget before the inevitable failure) or on the 529-overloaded code beyond the same backoff policy as 5xx.
- **Dependencies:** `Q` (API key from secrets manager, injected at process start, never hardcoded).
- **Failure behavior:** exhausted retries → `AnalysisResult(status=error)`, propagates to `route` job → Human Review. A malformed response (fails schema validation against expected `answers` shape) is treated identically to a network error, not passed through partially-parsed.

---

## J. Decision Schema v1

Implementation of architecture-review §4, stored in the `decision_schema` table (not hardcoded in application code) so a new version is a data row, not a deploy:

```jsonc
{
  "version": "decision-schema/v1",
  "jev_model": "jev-1.13.0",
  "questions": {
    "is_spam":                { "type": "noul" },
    "category":                { "type": "choice", "options": ["sales","business_opportunity",
                                  "collaboration","invoice","support","job_offer",
                                  "marketing","personal","customer_message","other"] },
    "is_business_opportunity": { "type": "noul" },
    "is_collaboration":        { "type": "noul" },
    "is_customer_related":     { "type": "noul" },
    "requires_response":       { "type": "noul" },
    "urgency":                 { "type": "score", "levels": ["low","medium","high","critical"] },
    "human_review_required":   { "type": "noul" }
  },
  "fallback": {
    "on_timeout": "route_to_review",
    "on_error": "route_to_review",
    "on_low_confidence": { "threshold": 0.55, "action": "route_to_review" }
  }
}
```

- **Extensibility:** a `decision-schema/v2` row can add fields without a migration — `rules.decision_schema_id` pins each rule to the version its conditions were authored against, so adding v2 fields never breaks a v1-authored rule (architecture-review §4).
- **Validation at rule-save-time:** creating/editing a `Rule` validates its condition tree's field references exist in the referenced `decision_schema.questions` — a schema field rename/removal is a save-time rejection, not a runtime silent no-match.
- **Instructions text** (the actual prompt-like wording per question) is deliberately kept out of this illustrative JSON and lives in a reviewed, version-controlled config file loaded into the row at deploy time — this is copy that affects classification quality and should go through the same review as code, not be editable ad hoc through a database console.

---

## K. Rule engine

**Condition tree**, stored as `rule.conditions` JSONB:

```jsonc
{
  "op": "AND",
  "children": [
    { "field": "answers.category", "op": "==", "value": "collaboration" },
    { "field": "answers.confidence", "op": ">=", "value": 0.80 },
    { "op": "NOT", "children": [
      { "field": "sender.domain", "op": "in", "value": ["known-bad.example.com"] }
    ]}
  ]
}
```

- **Field namespaces:** `answers.*` (from `AnalysisResult`, validated against the rule's `decision_schema_id`), `sender.*`/`recipient.*`/`subject`/`headers.*`/`has_attachment`/`attachment.*`/`labels` (from `Email`, deterministic).
- **Evaluator:** a pure function `evaluate(conditionTree, emailContext) → boolean`, unit-testable in complete isolation from the database/queue (architecture-review's rule engine failure behavior depends on this function never throwing on well-formed input — exhaustively tested per §V).
- **Selection algorithm:** load active, non-shadow rules for the tenant ordered by `priority`; evaluate in order; first `true` wins; write a `RuleEvaluation` row for every rule evaluated (matched or not) including shadow rules evaluated in parallel; if no active non-shadow rule matches, create a `HumanReviewItem(reason=unmatched)` — this is unconditional engine behavior, not a rule the tenant has to configure.
- **`rule.priority` uniqueness** is a DB constraint (`unique(tenant_id, priority) where is_active`), so "which rule wins on a tie" is structurally impossible to ask.
- **Versioning:** editing an active rule's conditions writes a new `Rule` row (`version` incremented, prior row's `deactivated_at` set); `RuleEvaluation` always references the exact version live at evaluation time.

---

## L. Destination abstraction

```ts
interface DestinationChannelAdapter {
  type: 'email' | 'webhook' | 'archive' | 'human_review';
  deliver(action: Action, channel: DestinationChannel, email: Email): Promise<DeliveryResult>;
}
```

- **`email` adapter:** sends a notification (architecture-review §9) from the system relay address — the original message quoted, a link back to the dashboard thread view. Never uses `gmail.send` on the connected mailbox.
- **`webhook` adapter:** POSTs a signed (HMAC, per-destination secret), versioned JSON payload; retries with backoff; this is the escape hatch that covers Slack/CRM/anything else without a native integration (architecture-review §8).
- **`archive` adapter:** applies a Gmail label / archives via `gmail.labels` scope — no external network call, so its only failure mode is the Gmail API itself.
- **`human_review` adapter:** not really a "delivery" — creates/updates the `HumanReviewItem`; included in the same interface for uniformity in the `route` job's dispatch logic, even though it has no external side effect.
- **Fan-out:** a `Destination` with multiple channels dispatches one `deliver` job per channel; each tracked independently in `Action`, so partial failure (e.g. webhook down, email fine) is a representable, visible state.

---

## M. Human Review system

- **Why it exists:** implements principle #12 as the system's actual default-safe behavior, not an opt-in feature.
- **Owns:** `HumanReviewItem` lifecycle (`open` → `resolved`), the manual-classify-and-route use case.
- **Resolution flow:** a human picks a category/destination (this creates an `AnalysisResult`-equivalent manual record — implemented as a normal `Action` with `rule_id = null` so the audit trail shows "human decided," not "a phantom rule matched") → `destinations` executes it → `Email.state = completed`.
- **Must NOT:** silently auto-resolve on a timer, and must NOT let a human action bypass `audit` — a human resolution is logged with the same rigor as an automated one (principle #19 doesn't carve out an exception for manual actions).
- **Dependencies:** `rules` (source of unmatched/failed items), `destinations` (execution), `audit`.
- **Failure behavior:** if the chosen destination delivery fails, the item does not silently close — it stays `open` (or reopens) until delivery succeeds or is explicitly abandoned by a human, mirroring the automated path's failure handling.

---

## N. Audit log

- Every module's state-changing operation writes exactly one `AuditEvent` inside the same transaction as the change itself (§B's `audit` module contract).
- **Event types (initial set):** `email_received`, `analysis_started`, `analysis_completed`, `analysis_failed`, `rule_evaluated`, `rule_matched`, `routed_to_review`, `action_started`, `action_succeeded`, `action_failed`, `human_resolved`, `mailbox_reauth_required`, `watch_renewed`, `watch_renewal_failed`.
- **Query surface:** a single `GET /emails/:id/audit` endpoint returns the full ordered trail for the Email Detail dashboard page — this is a direct, unmodified read of `audit_event`, not a reconstructed/derived view, so what the user sees is provably what happened.
- **Retention:** indefinite (architecture-review §7) — small, structured rows, not raw content, so keeping them forever is cheap and is the actual mechanism behind "inspect this email's history" surviving body purge.

---

## O. Retry and dead-letter strategy

| Job type | Retry policy | On exhaustion |
|---|---|---|
| `sync-mailbox` | BullMQ default backoff, 5 attempts | Log + `health` module flags mailbox if repeated failures persist across multiple scheduled runs |
| `analyze` (Jev call) | Handled inside `jev` module per §I (not BullMQ-level retry, since the module's own retry budget already covers transient failure) | `AnalysisResult(status=error)` → `route` job still runs, routes to Human Review |
| `route` (rule evaluation) | 3 attempts, short backoff (this is in-process logic, near-instant, failure implies a bug not a transient condition) | Route to Human Review (`reason=failed`) rather than leaving `rules_evaluating` |
| `deliver` (destination action) | 5 attempts, exponential backoff up to e.g. 10 min | `Action.status=failed`, email reopened to Human Review |
| All queues | BullMQ dead-letter: jobs that exhaust all attempts move to a `failed` job state retained in Redis for inspection, not deleted | Surfaced in an internal ops view (not customer-facing) for debugging systemic issues |

**Principle #20 in this table's terms:** note that no row above allows a single Jev signal, alone, to reach a `deliver` action for anything irreversible without having passed through `rules` first — retry exhaustion always routes to a human, never to an automatically-escalated destructive action.

---

## P. Security boundaries

- **Frontend ↔ Backend:** REST over HTTPS only; frontend holds a session token, never a Jev/Gmail/DB credential.
- **Backend ↔ Jev:** API key from secrets manager, injected as an env var at process start, never logged (request/response logging redacts the `Authorization` header and truncates `state` content in logs — see §U).
- **Backend ↔ Gmail:** per-tenant OAuth token, decrypted only in-memory for the duration of a single API call inside `mailbox`, never passed to any other module as plaintext.
- **Tenant isolation:** app-layer `WHERE tenant_id = ...` on every query **plus** Postgres RLS (§C) as a second, independent layer — a bug in one doesn't compromise the other.
- **Webhook destination security:** outbound payloads signed with a per-destination HMAC secret; the receiving side is the customer's own system, so this protects *them* from spoofed callbacks claiming to be from Eumaeus.
- **Untrusted email content:** never reaches a code path that could interpret it as instructions (architecture-review §3) — `state` sent to Jev is data, not concatenated into any control-flow-affecting string; the rule engine only ever reads `AnalysisResult.answers` as typed values to compare against thresholds, never as code/expressions to execute.
- **What is explicitly NOT a security boundary in V1:** attachment content (never opened/parsed — architecture-review §3.1) and any claim of malware scanning — stated as a known V1 limitation, not a silent gap.

---

## Q. Secrets management

| Secret | Storage | Access pattern |
|---|---|---|
| Gmail OAuth refresh tokens | Postgres, envelope-encrypted with a per-tenant or per-region KMS data key | Decrypted only inside `mailbox` module, in-memory, per-call |
| Jev API key | Secrets manager (e.g. AWS Secrets Manager / Doppler) | Injected as env var at process start for `apps/api`; never in `apps/web` |
| Postgres/Redis credentials | Secrets manager | Injected at process start, standard connection-string pattern |
| Webhook destination signing secrets | Postgres, encrypted at rest same as OAuth tokens (they're customer-facing secrets too) | Decrypted only inside `destinations` module at delivery time |
| KMS key itself | Cloud provider KMS, never leaves the KMS service | App calls KMS encrypt/decrypt APIs; the raw key material is never held in application memory |

Nothing in this table is ever committed to the repo, present in `apps/web`, or logged in plaintext.

---

## R. API endpoints (backend REST surface)

```
POST   /auth/login, /auth/logout                         -- dashboard session
GET    /mailboxes                                          -- list connections + health status
POST   /mailboxes/connect                                  -- start Gmail OAuth
GET    /oauth/gmail/callback                                -- OAuth callback (not a "dashboard" endpoint, browser redirect target)
DELETE /mailboxes/:id                                        -- disconnect

GET    /emails?state=&reason=&page=                         -- inbox overview / filtered lists
GET    /emails/:id                                           -- email detail (metadata + analysis + matched rule + actions)
GET    /emails/:id/audit                                     -- full decision trail

GET    /rules                                                -- list (incl. priority, active/shadow flags)
POST   /rules                                                -- create (validates conditions against decision_schema)
PATCH  /rules/:id                                             -- edit (creates new version)
POST   /rules/:id/activate | /deactivate | /reorder
GET    /rules/:id/shadow-results                              -- dry-run stats (§ architecture-review §7)

GET    /destinations                                          -- list
POST   /destinations                                          -- create
POST   /destinations/:id/channels                             -- add channel
POST   /destinations/:id/channels/:channelId/test              -- send synthetic test payload

GET    /review                                                -- Human Review queue (filter by reason, age)
POST   /review/:id/resolve                                    -- {category, destination_id}

GET    /overview                                              -- dashboard counts (monitored/processed/awaiting/routed/failed)
GET    /health/mailboxes                                      -- connection health for the overview banner
```

All list endpoints are tenant-scoped implicitly by the authenticated session (never a client-supplied `tenant_id` parameter — that would be a tenant-isolation bypass vector).

---

## S. Frontend pages/components

Directly implementing architecture.md §11, as a Next.js app:

- `/` **Overview** — counts, activity feed, mailbox connection health banner
- `/emails` **Email list** (filterable by state/reason) → `/emails/[id]` **Email Detail** — metadata, body preview, top-3 category probabilities, matched rule, actions, full audit trail (`AuditTrailTimeline` component, shared between this page and any future export view)
- `/rules` **Rule list** (priority-ordered, drag-to-reorder) → `/rules/new` / `/rules/[id]` **Rule builder** (condition tree UI: AND/OR/NOT groups over AI-field and deterministic-field leaves), live/shadow toggle, `/rules/[id]/shadow` **shadow results view**
- `/destinations` **Destination list** → `/destinations/[id]` **channel management**, per-channel "send test" button
- `/review` **Human Review queue** — reason filter, age/SLA indicator, inline classify+route action
- `/settings` **mailbox connections, retention policy display, audit log export**

Shared components worth naming now (because they're reused across ≥2 pages, the actual bar for extracting a component): `StateBadge` (renders `Email.state` consistently everywhere), `ConfidenceBar` (probability distribution visualization, used in Email Detail and Rule builder preview), `ConditionTreeEditor` (rule builder, also reused read-only in shadow-results and audit views).

---

## T. Background workers/jobs

All run inside `apps/api worker.ts`, one process, multiple BullMQ queues:

| Job | Trigger | Idempotency key | Owner module |
|---|---|---|---|
| `pubsub-consume` | long-running pull loop (not a discrete job, a process loop) | Pub/Sub's own ack/redelivery | `mailbox` |
| `sync-mailbox` | enqueued by `pubsub-consume` or `reconcile` cron | job id = `mailbox_connection_id` | `mailbox` + `ingestion` |
| `reconcile` | cron, every 3–5 min | — (enqueues `sync-mailbox`, which is itself idempotent) | `mailbox` |
| `watch-renew` | cron, daily | job id = `mailbox_connection_id` | `mailbox` |
| `analyze` | enqueued by `ingestion` on new `Email` insert | job id = `email_id` + `decision_schema_id` | `jev` |
| `route` | enqueued by `jev` on `AnalysisResult` write | job id = `email_id` | `rules` |
| `deliver` | enqueued by `rules`/`review` per matched destination channel | job id = `email_id` + `destination_channel_id` | `destinations` |
| `health-check` | cron, every 5–10 min | — (read-only) | `health` |

---

## U. Observability/logging

- **Structured logs** (JSON), one line per job execution with `tenant_id`, `email_id`, `job_type`, `duration_ms`, `outcome` — no raw email body content in logs; `body_normalized` is referenced by `email_id`, not inlined.
- **Redaction:** Gmail tokens, Jev API key, webhook secrets, and email body/subject content are never logged, even at debug level — logs must be safe to ship to a third-party log aggregator without becoming a data-handling liability themselves.
- **Metrics:** counts per `Email.state` (the same numbers the Overview dashboard shows, computed from the same source of truth), Jev call latency/error rate, per-destination-channel delivery success rate, queue depth per BullMQ queue.
- **Alerting:** `health-check` job findings (stuck emails, mailbox `reauth_required`, watch renewal failures) page/notify the operator, not just log — these are exactly the failure modes that would otherwise be silent.
- **Cron heartbeat:** `reconcile`, `watch-renew`, and `health-check` each emit a heartbeat metric on successful completion; external uptime monitoring alerts if a heartbeat is missing for longer than its expected interval — this is what catches "the cron scheduler itself died," which nothing internal to the app can self-detect.

---

## V. Testing strategy

| Layer | Approach |
|---|---|
| Rule condition evaluator | Pure-function unit tests, exhaustive table of AND/OR/NOT combinations + every operator, including the worked examples from architecture-review §5 |
| Preprocessing pipeline | Unit tests with adversarial fixtures: hidden-HTML injection, zero-width/bidi unicode, oversized bodies, malformed MIME — directly testing architecture-review §3's threat table, one fixture per row |
| Jev client | Mocked HTTP: success, 401/422/429/529, timeout, malformed JSON response — asserting the exact retry/backoff/give-up behavior from §I, without calling the real API |
| State machine | Integration tests driving an `Email` through every transition in §H, including forced failures at each stage (Jev down, rule engine throws, delivery fails) — asserting it always lands in a terminal-or-open-review state, never stuck |
| Idempotency | Integration tests that deliberately duplicate: same Pub/Sub message twice, same `sync-mailbox` job concurrently, same `deliver` job retried after a simulated crash — asserting no duplicate `Email`/`Action` rows and no duplicate external side effects |
| Full pipeline (Gmail + Jev faked) | End-to-end test using a fake Gmail API server and a fake Jev API server (fixture-driven, no live credentials) — this is the primary day-to-day test loop |
| Real integration (smoke only) | A small, separately-run suite against a real test Gmail account and the real Jev API, gated behind a flag, run pre-release rather than on every commit — real external dependencies are slow/flaky/costly, so they're not in the fast feedback loop |
| Frontend | Component tests for `ConditionTreeEditor` (the one genuinely complex UI piece) and `StateBadge`/`ConfidenceBar` rendering from fixture data; no need for exhaustive e2e browser tests in V1 |

**Open question carried from architecture-review §1 fact #17/UNKNOWN:** whether TypeSafe offers a sandbox/test-mode API key is unconfirmed — until verified, the fake-Jev-server approach above is the only safe way to test without spending real money on every test run.

---

## W. Local development environment

- `docker-compose.yml`: Postgres, Redis, MinIO (S3-compatible, for `body_ref` locally).
- `apps/api` runs against a **dev-only GCP project** (separate from prod) for Gmail OAuth client + Pub/Sub topic/subscription — since the pull-subscriber design (§E) means no tunnel/ngrok is needed, a developer's local `worker.ts` can pull real Pub/Sub messages from a real Gmail test account directly.
- **Fixture mode:** an env flag (`FIXTURE_MODE=1`) that replays a canned set of raw email payloads through `ingestion → jev(fake) → rules → destinations(fake)` without touching real Gmail or Jev credentials at all — this is the fast loop for day-to-day feature work; real-credential mode is reserved for the smoke suite in §V.
- `.env.example` documents every required var (DB/Redis URLs, KMS key ref, Jev API key placeholder, Gmail OAuth client id/secret, GCP project/topic/subscription names) with no real values committed.

---

## X. Deployment architecture

- **Backend:** single Docker image, two deployed services from it — `api` (HTTP, autoscaled on request volume) and `worker` (BullMQ consumer + cron jobs + the `pubsub-consume` pull loop, scaled on queue depth) — same image, different start command, on any container platform (Fly.io/Render/ECS Fargate).
- **Database:** managed Postgres (RDS, Neon, or Supabase — any of these support the RLS model in §C; Supabase additionally bundles auth/storage primitives that could reduce custom code if the team wants to lean on it, noted as an option not a requirement).
- **Redis:** managed (Elasticache/Upstash) — durability matters here (queued jobs), so a managed offering with persistence enabled, not an ephemeral cache-only instance.
- **Object storage:** S3 or R2, bucket lifecycle rule implementing the 30-day `body_ref` purge (architecture-review §7) at the infrastructure level, not app code.
- **Frontend:** Next.js deployed separately (Vercel or the same container platform) — stateless, scales independently of the backend.
- **GCP footprint:** minimal — one project solely for the Gmail OAuth client and Pub/Sub topic/subscription; no compute runs there.
- **Environments:** dev (local, §W), staging (real GCP dev project, real Jev key, seeded test tenant), production — staging is what the pre-release smoke suite (§V) runs against.

---

## Y. Database migrations

- Prisma migrate, one migration per meaningful schema change, committed to `apps/api/prisma/migrations/`.
- RLS policies and the `audit_event` `GRANT` restrictions (§C, §N) are added as raw SQL appended to their corresponding migration file (Prisma supports arbitrary SQL in migrations) — kept in the same migration as the table they protect, so a table is never live without its RLS policy for even one deploy.
- **No destructive migrations without a preceding backfill/dual-write step** — e.g. adding a `NOT NULL` column to `email` (a table with production data from day one of launch) always ships as (1) nullable column + backfill job, (2) a later migration adding the `NOT NULL` constraint once backfill is confirmed complete.
- Migrations run as a deploy-time step before the new `api`/`worker` images start serving traffic, not on-demand from application code.

---

## Z. MVP implementation order

Each phase is independently testable per §V before the next begins — this ordering exists specifically so that "does the state machine actually hold" can be proven with a fake Gmail/Jev long before real credentials are involved.

1. **Foundation:** repo scaffold (§A), Prisma schema + first migration (§C, incl. RLS), `tenancy` module, empty `apps/web` shell hitting a health endpoint.
2. **Ingestion skeleton (fixture-driven):** `ingestion` module + preprocessing pipeline, tested entirely against canned raw-message fixtures — no real Gmail yet. Proves the untrusted-input defenses (§3 threat table) before any live traffic touches them.
3. **State machine + audit:** `Email` state transitions + `audit` module wired end-to-end using the fixtures from step 2, manually driven through every state (no Jev/rules/destinations yet — just the skeleton transitions and their logging).
4. **Jev integration (faked, then real):** `jev` module against a fake server first (full retry/timeout/malformed-response test matrix from §V), then a single manual real call to confirm the actual `api.typesafe.ai` contract matches assumptions before building further on top of it.
5. **Rule engine:** condition evaluator (pure-function unit tests first, §V), then wired to consume real `AnalysisResult` rows from step 4, producing `RuleEvaluation` rows — testable with zero destinations yet (assert correct match/no-match against fixtures).
6. **Destinations + Human Review:** all four channel adapters (§L) against fake targets first (a local fake SMTP catcher, a local webhook receiver), then real email/webhook delivery; Human Review queue and manual resolution flow.
7. **Gmail OAuth + real ingestion:** `mailbox` module, OAuth flow, `sync-mailbox` against a real test Gmail account — this is the first point real Gmail data flows through the entire pipeline built and tested in isolation in steps 1–6.
8. **Pub/Sub + reconciliation:** `pubsub-consume` pull worker, `reconcile` cron, `watch-renew` cron — proving push+poll coexistence and idempotency (§G) against the real test mailbox with deliberately duplicated/delayed notifications.
9. **Dashboard:** frontend pages (§S) wired to the by-now-fully-functional backend API (§R) — deliberately last, since every page is a read/action view over data the backend already correctly produces by this point.
10. **Health checks + observability:** `health` module, structured logging/redaction, alerting, cron heartbeats (§U) — closing the loop on "nothing can go wrong invisibly" as the final hardening pass before staging/production deploy.
11. **Staging smoke suite + production deploy:** real-credential end-to-end tests (§V) against staging, then the deployment architecture (§X) for production.
