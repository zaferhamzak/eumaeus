# Eumaeus — Product & Technical Architecture

> Status: pre-implementation design document. No code has been written yet, per instruction. This is meant to be reviewed and argued with before a single line of implementation starts.

---

## 0. Framing

The product philosophy stated is correct and should be defended aggressively during implementation:

> "A control layer that makes sure every incoming email is understood, accounted for and routed appropriately."

That sentence is the actual product. Jev, Gmail, rules, Slack — all of that is plumbing in service of one guarantee: **no email enters a black hole.** Every design decision below is judged against that guarantee first, and against "is this useful" second.

I will be explicit below about where I think the brief is strong, and where I think it is weak, over-scoped, or technically risky. Sections marked **⚠️ Critique** are places where I disagree with or want to modify the brief as given.

---

## 1. Jev AI — what matters for this product specifically

(Full general research is in `jev-ai-rehberi.md`. This section extracts only what's load-bearing for Eumaeus's design.)

| Property | Value | Implication for Eumaeus |
|---|---|---|
| Request shape | one `state` + up to **32 typed questions**, evaluated in parallel, single call | We can get spam/category/customer/opportunity/collaboration/response-needed/urgency/review-needed all from **one Jev call per email** |
| Token budget | 64K total request budget; ~32K for state+questions combined | Long threads/HTML emails must be normalized and truncated before being sent — this is a required preprocessing step, not optional |
| Choice cardinality | up to 64 options per Choice question | Category enum has huge headroom; not a real constraint |
| Score levels | 2–10 ordered levels | Fine for urgency (e.g. low/medium/high/critical) |
| Latency | 70–500ms typical | Fits comfortably inside a background worker's per-email budget; does **not** need to be synchronous with the webhook that triggered ingestion |
| Rate limits | ~1,200 requests/min, ~250K tokens/sec per TypeSafe's current published limits, subject to change; **429** on excess | A single high-volume mailbox (or many tenants) can hit this. Requires a queue + worker pool with backoff, not a direct webhook→Jev call |
| Output cost | input $0.042/M tokens, output free | Classification-at-scale is cheap; do not over-engineer caching for cost reasons in v1 |
| No rationale | probabilities + confidence only, no explanation text | Human Review UI must reconstruct "why" from the probability distribution (e.g. show top-3 categories with their probabilities) rather than expect a natural-language justification |
| Not adversarially robust | confirmed: injected/misleading text in `state` can shift decision probabilities meaningfully | **This is the single biggest technical risk for an email product**, because email is the most adversarially-optimized input class that exists (spam/phishing is literally designed to fool filters). See §9. |
| Data handling | US-only processing, no HIPAA BAA, ZDR (zero data retention) available for enterprise, DPA w/ SCCs for GDPR | No HIPAA-regulated customers in v1. ZDR should be a configurable per-tenant setting we expose once we're selling to security-conscious buyers. EU customers need the DPA in place contractually, not a technical blocker. |

**⚠️ Critique of the category list in the brief:**

`spam, customer, sales, business_opportunity, collaboration, invoice, support, job_offer, marketing, personal, other` is a single flat enum, and it mixes three different axes that don't belong in one field:

1. **What is this, structurally** (invoice, job_offer, support request, marketing blast) — a *document type* axis.
2. **What relationship does the sender have to us** (customer, prospect, partner, unknown) — a *sender-relationship* axis.
3. **Is it adversarial/noise** (spam) — a *trust* axis.

Forcing these into one `Choice` produces ambiguous cases constantly: a cold outbound pitch from a vendor is simultaneously "sales-ish," "marketing-ish," and borderline "spam-ish." A single-label classifier will flip-flop between these on near-identical emails, which will erode user trust in the product faster than almost anything else.

**Recommendation:** keep `category` as one Choice question for backward-compatible simplicity in rules, but **also** emit it alongside independent Noul/Score questions that don't force a single bucket — which the brief's own example question list already gestures at (is_spam, is_customer, is_business_opportunity, is_collaboration, requires_response, urgency, needs_human_review). Treat `category` as a convenience default and treat the boolean/score signals as the real power-user surface for rule conditions. Section 6 below defines the exact question set.

---

## 2. Product concept — critical assessment

**Strong:**
- "Every email accounted for" is a sharp, defensible, non-generic promise. It's a control/ops product, not a chatbot wrapper, and that's the right positioning — it survives the "is this just a thin GPT wrapper" objection.
- Separating decision (Jev) from execution (rule engine) is the correct architecture. It also happens to be the *only* safe architecture, given Jev's documented lack of adversarial robustness — if Jev directly executed actions, a crafted email could manipulate an AI model into archiving itself, forwarding itself somewhere, or suppressing review. Keeping Jev advisory-only is not just clean design, it's a security requirement.
- Destination-as-abstraction (not literally "an email address") is correct and should not be simplified away — it's what lets the product grow into Slack/CRM/ticketing without a rewrite.

**⚠️ Weak or risky as specified:**

1. **Threshold-only rules are commercially thin.** `category == X AND confidence >= Y` is a good default but will not survive contact with real users. The first thing any operations-minded buyer will ask for is: *"anything from this specific domain always goes here, regardless of what the AI thinks."* Pure AI-gated rules with no deterministic override is a weaker product than one that supports both. **Recommendation:** the rule engine's condition language must support AI-derived fields (category, confidence, is_spam, urgency, etc.) **and** classic deterministic fields (sender domain/address, subject regex, has-attachment, recipient alias) in the same rule, combinable with AND/OR. This is a small addition to the data model and a large increase in how trustworthy the product feels.

2. **Rule Simulator "test against historical emails" is more expensive than it sounds**, and it's in direct tension with the "don't store email bodies indefinitely" security guidance. A true historical backtest requires the raw (or near-raw) body of every historical email to exist and be re-evaluable — which means either (a) we retain bodies longer than we'd otherwise want to, purely to support this feature, or (b) the simulator can only "backtest" against already-computed classifications, not against a *new, not-yet-existing* rule's conditions on AI fields that weren't captured before. **Recommendation:** ship a cheaper, equally convincing v1 substitute — **shadow/dry-run mode** (§10) — and defer true historical backtesting to post-MVP, once retention policy is a deliberate, paid-tier decision rather than an implicit side effect of a demo feature.

3. **CRM and ticket-system destinations as native integrations are scope creep for v1.** Each one (Salesforce, HubSpot, Jira, Zendesk, Linear...) is its own auth flow, its own field-mapping UI, its own failure semantics. **Recommendation:** v1 ships a generic **Webhook destination type** (signed, retried, logged) as the universal escape hatch. Native CRM/ticket connectors become post-MVP additions built on the same adapter interface, prioritized by which one paying customers actually ask for.

4. **"Forward to a destination" is not as simple as it sounds technically.** True email forwarding (re-sending the original message so it lands in someone else's inbox looking like the original) runs into SPF/DKIM/DMARC alignment problems when done via API rather than native mail-server forwarding — the forwarded message can get flagged as spam or fail authentication at the recipient side, and it requires a broad `gmail.send` scope on the user's own mailbox, which is a meaningfully bigger permission ask (and bigger blast radius if the token leaks) than read + label/archive. **Recommendation:** default destination delivery method is **notify, not impersonate** — send a new email *from a Eumaeus system address* that contains the original message as a quoted/attached copy plus a link back to the full thread in the dashboard, rather than trying to forward-as-the-user. True inbox-native forwarding can be a later, explicitly-scoped-and-consented feature per destination.

5. **Human Review dashboard is not optional polish — it's the load-bearing safety net for the entire "never silent" promise**, and the brief slightly under-specifies it relative to its importance. It needs to be treated as a first-class queue with SLA visibility (how long has this been sitting?), not just a filtered email list. See §7.

---

## 3. MVP scope decision

**In scope for MVP:**
- Gmail only (OAuth, push watch + reconciliation poll)
- One Jev analysis call per email, fixed question set (§6)
- Rule engine: AI fields + deterministic fields (sender/subject/attachment), AND/OR, priority ordering, first-match-wins with explicit conflict logging
- Destinations: Email address, Slack channel (webhook), generic outbound Webhook, Archive, Human Review — all built on one adapter interface
- Human Review queue with manual classify + manual route
- Full audit trail / decision history per email
- Inbox overview dashboard
- Shadow/dry-run mode for new rules (cheap simulator substitute)
- Tenant isolation, encrypted OAuth tokens, minimal Gmail scopes

**Explicitly out of MVP (post-MVP, see §14):**
- Microsoft 365/Outlook
- Native CRM/ticket-system connectors
- True historical rule backtesting against stored bodies
- Multi-step / multi-stage rule chains
- Team roles & granular permissions beyond single-tenant-admin
- Custom Jev question authoring by end users (v1 question set is fixed and product-defined, not user-editable — user-editable Jev prompts is a support/quality nightmare before the product has proven the fixed set works)

---

## 4. Data model

Core entities (Postgres, relational, JSONB for flexible/rule-shaped fields):

```
Tenant
  id, name, plan, retention_policy, zdr_enabled, created_at

MailboxConnection
  id, tenant_id, provider (gmail|outlook), email_address,
  oauth_refresh_token (encrypted), scopes[], watch_expiration,
  status (active|reauth_required|disabled), last_synced_history_id

Email
  id, tenant_id, mailbox_connection_id, provider_message_id (unique w/ tenant),
  thread_id, from_address, to_addresses[], cc_addresses[], subject,
  received_at, body_normalized (truncated/cleaned text used for analysis),
  body_ref (pointer to encrypted blob storage, nullable per retention policy),
  has_attachments, raw_headers_ref,
  state  -- see §8 state machine
  ingested_at, state_updated_at

AnalysisResult
  id, email_id, jev_model_version, requested_questions (jsonb snapshot),
  answers (jsonb: per-question value/probabilities/confidence),
  derived_category, derived_confidence, latency_ms,
  status (ok|timeout|error|skipped), created_at
  -- immutable once written; a re-analysis creates a NEW row, never overwrites

Rule
  id, tenant_id, name, priority, is_active, is_shadow,
  conditions (jsonb condition tree: AND/OR of AI-field and deterministic-field leaves),
  destination_id, actions (e.g. label, archive, notify),
  version, created_by, created_at, deactivated_at

RuleEvaluation
  id, email_id, rule_id, matched (bool), reason (jsonb: which leaves passed/failed),
  evaluated_at
  -- one row per active rule per email, always written, even on non-match —
  -- this is what makes "no rule matched" a provable state, not an assumption

Destination
  id, tenant_id, name, description, created_at

DestinationChannel
  id, destination_id, type (email|slack|webhook|archive|human_review),
  config (jsonb: address / slack webhook url / target url+secret / labels),
  is_active

Action
  id, email_id, rule_id, destination_id, destination_channel_id,
  type, status (pending|success|failed|retrying),
  attempt_count, last_error, executed_at

AuditEvent
  id, email_id, tenant_id, event_type, payload (jsonb), actor (system|user_id),
  created_at
  -- append-only. This table IS the "complete decision trail" feature.
  -- Every other table's writes also emit one row here.

HumanReviewItem
  id, email_id, tenant_id, reason (low_confidence|unmatched|ambiguous|failed),
  status (open|resolved), assigned_to, resolved_action, resolved_at
```

**Design notes:**
- `AnalysisResult` and `RuleEvaluation` are append-only and versioned. Rules change over time; if we let a rule edit rewrite history, the audit trail lies retroactively. A changed rule gets a new `version`, and past `RuleEvaluation` rows keep pointing at the rule version that was active when the email was processed.
- `body_ref` is separated from `body_normalized` specifically so retention policy can delete/expire the full body independent of keeping the lightweight analyzed text and the permanent classification metadata. This directly implements "don't store bodies indefinitely without a clear reason."
- `RuleEvaluation` being written for every active rule against every email (not just the winner) is what makes "zero rules matched" a **queryable fact** instead of an inferred absence — this is the concrete mechanism behind "no silent unknown state."

---

## 5. Email ingestion architecture

**⚠️ Critique of "continuous monitoring" as literally push-only:** Gmail's push mechanism (`users.watch` + Pub/Sub) is not a complete delivery guarantee on its own — watch subscriptions expire (max 7 days, must be renewed), individual push notifications can be dropped, and a `historyId` can become stale if the gap between notifications is too large (Gmail returns a 404 on history queries older than the retention window, requiring a full resync). A push-only design **will** silently miss emails under real-world conditions — a mailbox add-on going momentarily down, a missed Pub/Sub delivery, a renewal that fails silently. Building the flagship "every email accounted for" claim on a mechanism that can silently drop messages is the single most important thing to fix before implementation.

**Design: push for speed, poll for correctness.**

```
Gmail account
   │
   ├─ users.watch() → Cloud Pub/Sub push  ──▶  Webhook receiver
   │                                              │
   │                                              ▼
   │                                     enqueue "check mailbox" job
   │                                              │
   └─ Reconciliation poller (every N min) ────────┤
      (users.history.list since last_synced_history_id;
       falls back to messages.list by date if history gap detected)
                                                   ▼
                                     diff against Email table by provider_message_id
                                                   │
                                                   ▼
                                     new messages → insert Email(state=received)
                                                   │
                                                   ▼
                                          enqueue "analyze" job
```

- The push path gives near-real-time behavior (the product *feels* always-on).
- The poll path is the actual correctness guarantee — it's what makes the "always ends up in a known state" promise true even if push infrastructure has a bad day. It should run frequently enough to be invisible (e.g. every 2–5 minutes) and must be resilient to `historyId` gaps by falling back to a bounded `messages.list` scan.
- All ingestion writes are idempotent on `(tenant_id, provider_message_id)` — webhook redelivery or overlapping poll/push must not create duplicate `Email` rows or double-process a message.
- Watch renewal is itself monitored: if a mailbox's watch is within 24h of expiring, proactively renew; if renewal fails, flag `MailboxConnection.status = reauth_required` and surface it in the dashboard rather than degrading silently to poll-only forever unnoticed.

---

## 6. Jev decision layer

**One Jev call per email**, using a fixed, product-defined question set (well within the 32-question limit, leaving headroom):

| Key | Type | Purpose |
|---|---|---|
| `is_spam` | Noul | Trust-axis signal, independent of category |
| `category` | Choice | Convenience bucket: `sales, business_opportunity, collaboration, invoice, support, job_offer, marketing, personal, customer_message, other` |
| `is_business_opportunity` | Noul | Independent of category, for rules that don't want to hang off a single bucket |
| `is_collaboration_proposal` | Noul | Same reasoning |
| `sender_is_likely_customer` | Noul | Relationship-axis signal |
| `requires_response` | Noul | Drives SLA/urgency-adjacent workflows |
| `urgency` | Score (low/medium/high/critical) | Drives Human Review ordering |
| `needs_human_review` | Noul | Jev's own uncertainty flag — used as an *additional* signal into the routing decision in §8, never as the sole gate |

**⚠️ Critique of the brief's category list itself:** `other` and `personal` will absorb a large fraction of real inbox traffic and tell the rule engine nothing actionable — that's fine and expected (not every email needs automation), but the dashboard needs to visibly report "N emails routed to default/no-op" as a normal, non-alarming outcome, or users will think the product is failing when it's actually correctly doing nothing.

**Preprocessing before the Jev call (required, not optional given the 32K token budget):**
1. Strip HTML to text, drop tracking pixels/boilerplate signatures.
2. Strip quoted reply chains beyond the newest message in a thread (keep a short "thread context" summary field instead of the full quoted history).
3. Hard-truncate to a token budget with the truncation fact recorded in `AnalysisResult` (so a low-confidence result on a truncated email is explainable, not mysterious).

**Reliability wrapper around the Jev call:**
- Timeout (e.g. 5s) — Jev's own latency is 70–500ms, so a 5s timeout is generous headroom, not aggressive.
- Retry with backoff on 429/5xx, respecting the published rate limits; queue-based worker pool naturally smooths bursts instead of hammering the API synchronously per webhook.
- On persistent failure (see §9), the email does **not** stay in limbo — it is explicitly routed to Human Review with `reason = failed`.
- `AnalysisResult` is written even on failure (`status=error`), so the audit trail shows *that analysis was attempted and failed*, not nothing.

---

## 7. Rule engine design

**Condition model** (JSON tree, AND/OR of leaves, each leaf one of):
- AI-derived: `category == X`, `confidence >= Y`, `is_spam == true`, `urgency >= high`, etc.
- Deterministic: `sender_domain in [...]`, `sender_address == ...`, `subject matches /regex/`, `has_attachment == true`, `recipient_alias == ...`.

**Evaluation semantics (deterministic, by design):**
1. On `AnalysisResult` completion, load all `is_active` rules for the tenant, ordered by `priority`.
2. Evaluate every rule's condition tree against the `AnalysisResult` + email metadata; write a `RuleEvaluation` row for **every** rule regardless of outcome (not just the winner — this is what makes the "why didn't this match" question answerable later).
3. First matching rule by priority wins (**first-match-wins**, not "all matching rules fire") — this avoids the far more complex and error-prone problem of resolving conflicting actions from multiple simultaneously-matching rules, and matches how most non-technical users mentally model "rules," e.g. mail filters they've used before.
4. If **zero** rules match → `HumanReviewItem(reason=unmatched)`.
5. If the matching rule's confidence threshold is met but `needs_human_review` (Jev's own signal) is also true → still route normally, but additionally flag it as `awaiting_confirmation` rather than blocking — Jev's self-flagged uncertainty is informative, not an automatic veto over an otherwise-confident, deterministic-condition-backed rule.

**Shadow/dry-run mode (MVP substitute for the full historical simulator):** a rule created with `is_shadow = true` is evaluated against every new incoming email exactly like a live rule (writing `RuleEvaluation` rows, computing "would have matched") **but never triggers Actions.** After a few days, the dashboard shows: *"this rule would have matched N emails, would have missed M borderline cases (confidence within 5% of your threshold), here they are."* This is cheap (no new storage requirements, uses infrastructure that already exists for live rules) and arguably more trustworthy than a historical backtest, because it's validated against real, currently-arriving traffic rather than a potentially stale historical sample.

---

## 8. Destination model & email lifecycle

**Destination = named bundle of one or more channels**, each channel independently executed and independently logged:

```
Destination "Partnerships"
 ├─ Channel: email → partnerships@company.com
 └─ Channel: slack → #partnerships webhook
```

A single matched rule can fan out to multiple channels under one destination; each channel's `Action` succeeds/fails independently, so "Slack delivery failed but email delivery succeeded" is a representable, visible partial-failure state rather than an all-or-nothing pass/fail.

**State machine** (this is the mechanism that makes "every email ends in a known state" literally true, not aspirational):

```
received
   │
   ▼
analyzing ──(Jev timeout/error, retries exhausted)──▶ awaiting_review (reason=failed)
   │
   ▼ (AnalysisResult written)
rules_evaluating
   │
   ├─(a matching rule found)──▶ routing ──▶ executing_actions ──▶ completed
   │                                              │
   │                                              └─(any channel action fails after retries)──▶ failed → awaiting_review (reason=failed)
   │
   └─(no rule matched OR low confidence)──▶ awaiting_review (reason=unmatched | low_confidence)
                                                    │
                                            (human classifies + picks destination)
                                                    ▼
                                              routing → executing_actions → completed
```

Every transition writes an `AuditEvent`. There is no terminal state reachable without either `completed`, `awaiting_review` (open), or `failed` (which itself always resolves into `awaiting_review` after retry exhaustion, never a dead end). "Ignored" from the brief's state list is really `completed` with a no-op action (e.g. category=personal, no destination configured) — it should be visually distinct in the UI but is not a structurally different state.

---

## 9. Security model

- **OAuth scopes, minimal:** `gmail.readonly` + `gmail.labels` (for archive/label actions) as the v1 default. `gmail.modify`/`gmail.send` only requested if/when a tenant explicitly enables native-forward-as-user (see §2.4's critique) — default delivery uses the system relay address instead, so most tenants never need to grant send access at all.
- **Token storage:** OAuth refresh tokens encrypted at rest with envelope encryption (KMS-managed key per tenant or per-region), never logged, never returned to the frontend. Frontend never touches the Jev API key or the Gmail token directly — all provider calls go through the backend.
- **Tenant isolation:** every table keyed by `tenant_id`, enforced at the query layer (and via Postgres row-level security as a second layer, not just application code) — a bug in one tenant's rule/destination config must be structurally incapable of leaking into another tenant's data.
- **Webhook security:** Pub/Sub push endpoint verifies the JWT from Google; outbound webhook destinations get a per-destination signing secret (HMAC on payload) so receivers can verify authenticity, plus replay protection (timestamp + nonce).
- **Audit logs:** `AuditEvent` covers not just email processing but also admin actions (rule created/edited/deactivated, destination changed, mailbox connected/disconnected, OAuth re-consent) — this is both a security control and a support/debugging tool.
- **Adversarial input (the Jev-specific risk):** because Jev has documented sensitivity to injected/misleading content in `state`, and email is an adversarially-optimized input surface (this is *the* medium phishing and spam were built for), the rule engine must never treat a Jev output alone as sufficient authorization for a high-trust action. Concretely:
  - Deterministic conditions (verified sender domain, SPF/DKIM/DMARC pass/fail — pulled from headers independent of Jev) should be available as first-class rule leaves precisely so users can build rules that don't rely solely on AI judgment for anything sensitive (e.g. "route to Accounting" for invoice-looking mail should probably require *both* `category==invoice` from Jev *and* a known-vendor sender domain).
  - No destination should be able to trigger an irreversible or externally-visible action (e.g. auto-reply, auto-forward to a third party) purely off a single AI signal without either a confidence floor well above the rest of the system's defaults or a human-in-the-loop step — this should be a product-level default, not left to user configuration to discover the hard way.
- **Data minimization:** `body_ref` is only populated if a tenant's retention policy calls for it; default retention (proposed) is a configurable window (e.g. 30/90 days) after which body blobs are purged while `AnalysisResult`, `AuditEvent`, and email *metadata* (sender/subject/timestamps/classification) persist indefinitely as the permanent record — this is what lets "show me the decision trail" keep working forever without keeping sensitive content forever.
- **Compliance posture, stated plainly:** with Jev's current data handling (US-only processing, no HIPAA BAA), Eumaeus cannot credibly market itself as HIPAA-ready in v1, and EU customers need contractual coverage (DPA + SCCs) rather than technical data-residency — this should be an explicit, known limitation in sales conversations, not discovered during a security review.

---

## 10. Failure modes & retry strategy

| Failure | Detection | Behavior |
|---|---|---|
| Jev unavailable / timeout / 429 | timeout or non-2xx on call | retry w/ backoff (respecting rate limit headers); after N attempts → `awaiting_review(reason=failed)`, never silently drop |
| Jev returns malformed/unexpected schema | response validation | treat as failure, same path as above; log payload for debugging (with PII-scrubbing) |
| Gmail push notification missed | reconciliation poller diff | poller catches it within its interval; no user-visible failure, but logged as a "recovered via reconciliation" audit event for observability |
| Gmail `historyId` gap (>7 days or invalid) | 404 from `history.list` | fall back to bounded `messages.list` scan by date range to resync, then resume history-based sync |
| Gmail OAuth token revoked/expired | 401 on API call | `MailboxConnection.status = reauth_required`; dashboard shows a blocking banner; ingestion pauses (not silently — visibly) until re-auth |
| Destination delivery fails (SMTP bounce, Slack API down, webhook target unreachable) | non-2xx / bounce | retry w/ backoff per channel; after exhaustion, `Action.status = failed`, email flips to `awaiting_review(reason=failed)` even if it was already "routed" — a failed delivery must be able to re-open review, not just log an error nobody sees |
| Duplicate delivery (webhook redelivered, poll+push race) | idempotency key check on `provider_message_id` | no-op, already processed |
| Rule engine misconfiguration (e.g. overly broad rule swallowing everything) | — | shadow mode (§7) is the primary defense — encourage/require new rules to run in shadow before going live; also expose a "this rule matched X% of all mail in the last 24h" warning if a live rule's match rate spikes |
| Runaway cost / rate-limit exhaustion under burst (e.g. mailbox import backfill) | queue depth monitoring | worker pool respects Jev's published rate limits with backoff; backfill jobs are explicitly lower-priority than live traffic in the queue |

The unifying principle: **every failure path terminates in a visible state** (`awaiting_review`, `reauth_required`, or a retried-then-surfaced `failed`), never in "the job errored and nobody noticed." This is enforced structurally by the state machine in §8, not by hoping error handling code is written correctly everywhere — a job that throws and isn't caught still leaves the `Email` row sitting in a non-terminal state, which the dashboard should itself alert on (a background health check flags any email stuck in `analyzing`/`routing`/`executing_actions` past a time threshold as an anomaly, independent of whether the code "knew" it failed).

---

## 11. Dashboard / UI structure (confirming & refining the brief's 7 areas)

1. **Inbox / Overview** — counts (monitored, processed, awaiting review, routed, failed) + a live activity feed. Add: mailbox connection health (watch expiring soon / reauth required) surfaced here, since a silently-degrading connection is the scenario that most directly threatens the core promise.
2. **Email Detail** — as specified, plus the top-3 category probabilities (not just the winning one) so users can see *how close* a decision was, partially compensating for Jev not providing rationale text.
3. **Rules** — builder for the AND/OR condition tree (AI fields + deterministic fields), priority ordering/drag-to-reorder, live/shadow toggle, per-rule match-rate stats.
4. **Destinations** — channel management as specified; add a "test delivery" button per channel (send a synthetic test payload) so misconfigured Slack webhooks/addresses are caught at setup time, not on the first real email.
5. **Human Review** — queue with reason filter (low_confidence/unmatched/failed), age/SLA indicator (oldest item flagged), one-click "classify + route," and — important — a "promote this to a rule" shortcut, since Human Review is where users will discover the patterns that should become new rules.
6. **Rule Simulator** — v1 = shadow-mode results view (§7), explicitly labeled as forward-looking ("since you turned this on N days ago"); a true historical-corpus backtester is post-MVP and gated behind retention policy already being long enough to support it.
7. **Settings** — mailbox connections, retention policy, ZDR toggle, audit log export.

---

## 12. Example end-to-end workflow

**Happy path** (matches the brief's example):
```
Email received (push notification) → Email row inserted (state=received)
  → enqueue analyze job → Jev call (state + 8 questions, ~300ms)
  → AnalysisResult: category=collaboration, confidence=0.94, urgency=medium
  → RuleEvaluation against active rules → "Business Collaboration" rule matches
    (category==collaboration AND confidence>=0.80)
  → Destination: Partnerships (email + Slack channels)
  → Action: email sent (success), Slack posted (success)
  → state=completed
  → AuditEvent trail: received → analyzed → rule_matched → routed → action_executed(email) → action_executed(slack) → completed
```

**Degraded path** (Jev down):
```
Email received → state=received → enqueue analyze job
  → Jev call times out → retry x3 with backoff → still failing
  → AnalysisResult(status=error) written
  → state=awaiting_review(reason=failed)
  → surfaced in Human Review queue immediately, not after some later audit
  → user manually classifies as "sales" and picks destination "Sales"
  → Action executed → state=completed
  → AuditEvent trail: received → analysis_failed → awaiting_review → human_classified → routed → completed
```

Both paths terminate in `completed`. Neither one requires the code to have "known in advance" that Jev would fail — the state machine makes the safe outcome the default outcome.

---

## 13. Recommended technology stack

Bias toward boring, operationally simple choices — this product's value is reliability, not novelty, so the stack shouldn't be a source of surprises.

- **Backend:** TypeScript (Node) or Python — either is fine; pick whichever the team is stronger in. TypeScript has a slight edge if the frontend is also TS, for shared types on the rule-condition/destination schemas.
- **Database:** PostgreSQL — relational core (Tenant/Email/Rule/Destination/Action) with JSONB columns for the rule condition tree and Jev answer payloads. Postgres row-level security for tenant isolation as defense-in-depth.
- **Queue/workers:** Redis + BullMQ (or SQS if already on AWS) for the analyze/route/deliver job pipeline; this is what absorbs Jev/Gmail rate limits and makes retries/backoff structural rather than ad hoc.
- **Blob storage:** S3-compatible object storage for `body_ref`, encrypted, with lifecycle rules implementing the retention policy automatically (no cron job "remembering" to delete things).
- **Secrets:** cloud KMS (AWS KMS / GCP KMS) for envelope-encrypting OAuth tokens; secrets manager for API keys (Jev key, signing secrets) — never in application config files or frontend bundles.
- **Email ingestion:** Gmail API + Cloud Pub/Sub for push; a scheduled worker (e.g. every 2–5 min) for reconciliation polling.
- **Frontend:** React/Next.js — dashboard-heavy product, server-rendered where it helps initial load, client-rendered for the live activity feed / queue views.
- **Observability:** structured logging + the `AuditEvent` table doubling as an internal audit/debug tool; a basic "stuck email" health check (alert if anything sits in a non-terminal state past a threshold) is cheap and directly protects the core promise — build it early, not as a later nice-to-have.

---

## 14. MVP vs Post-MVP — final list

**MVP (V1):**
- Gmail ingestion (push + reconciliation poll)
- Fixed 8-question Jev analysis per email
- Rule engine: AI + deterministic conditions, priority, first-match-wins, shadow mode
- Destinations: email, Slack, generic webhook, archive, human review
- Human Review queue with manual classify/route
- Full audit trail per email
- Inbox overview dashboard incl. mailbox connection health
- Encrypted credentials, minimal scopes, tenant isolation, configurable retention

**Post-MVP:**
- Microsoft 365/Outlook ingestion
- Native CRM/ticket-system destination connectors (Salesforce, HubSpot, Jira, Zendesk...)
- True historical-corpus rule backtesting (once retention policy deliberately supports it)
- Native inbox-forwarding-as-user (broader `gmail.send` scope), as an opt-in per destination
- Multi-step/chained rules, per-tenant custom Jev question sets
- Team roles & granular permissions
- ZDR and enterprise compliance packaging as a distinct plan tier

---

## Open questions for you before implementation starts

1. Default retention window for `body_ref` — 30 days? 90 days? Configurable from day one, or fixed for v1 and configurable later?
2. Is single-tenant-admin (no roles/permissions) acceptable for v1, or is there a known first customer that needs multi-user access control on day one?
3. For the "notify, not impersonate" forwarding default (§2.4) — confirm this is acceptable, since it changes the recipient's experience (they get a Eumaeus-branded notification with the original quoted, not a literal forward) versus a native forward.
