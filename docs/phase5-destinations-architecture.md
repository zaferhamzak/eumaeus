# Phase 5 — Destinations Architecture Proposal (Revision 2)

> Design-only document. No application code, Prisma schema, migrations, tests, or configuration were changed to produce this. Revision 2 re-reads the actual source a second time (`prisma/schema.prisma`, `modules/review/escalate.ts`, `modules/audit/record.ts`, `modules/rules/*`, `modules/jev/*`, `modules/mail-providers/imap/`, `queue/*`, `queue/workers/processEmail.worker.ts`, and the test tree) specifically to resolve five internal contradictions/underspecifications flagged in Revision 1. Where Revision 1 said one thing and re-reading the code contradicted it, this revision says so explicitly rather than quietly fixing it.

---

## 1. Current architecture understanding

Unchanged from Revision 1 — re-verified, nothing new found on the second pass except one detail that matters a lot for §5 below:

- **`RuleEvaluation` denormalizes `ruleVersion` onto itself even though `ruleId` alone already points at an immutable, versioned `Rule` row** (`ruleId String`, `ruleVersion Int`, both stored — `prisma/schema.prisma`). This is real, existing precedent for "denormalize the version number for query convenience even when the FK target is itself immutable-per-version" — Revision 1 argued *against* doing this for `ActionExecution` in one place while doing it in another; §5 below reconciles that inconsistency using this exact precedent.
- Everything else from Revision 1's §1 (state machine, `RoutingDecision` shape, Rule Engine's enforced zero-dependency-on-Jev boundary, `escalateToHumanReview`'s existing idempotency + generalized `reason` param, the two-queue BullMQ pattern, the `processEmail.worker.ts` insertion point, IMAP provider isolation, the total absence of an outbound-send capability, the Jev client's retry/error-classification shape, app-layer-only tenant isolation, "don't persist secrets" precedent) stands, confirmed again against source, not restated in full here.

---

## 2. Phase 5 scope

Unchanged from Revision 1: owns turning a `matched` `RoutingDecision` into real side effects and durably recording what happened; does not own deciding whether/where (Rule Engine), analysis (Jev), or ingestion.

---

## 3. Decision vs. Destination vs. Action vs. Execution

Unchanged in outcome (no separate `Action` table), but the *reasoning* in Revision 1 was wrong and is corrected here — see §5, which is where the real fix lives. Kept here for reference:

| Concept | Answers | Owned by | New in Phase 5? |
|---|---|---|---|
| **Decision** | "What should happen, and where (by label)?" | `RoutingDecision` (Rule Engine, exists) | No |
| **Destination** | "What is `destinationRef` configured to mean?" | `Destination` + `DestinationChannel` | **Yes** |
| **Action** | "What operation, on which channel?" | *No separate table — see §5* | — |
| **Execution** | "Did it happen, and can we tell?" | `ActionExecution` | **Yes** |

---

## 4. Destination abstraction — is it needed?

Unchanged from Revision 1, **with one correction driven by §7's resolution below**: Human Review is no longer counted among the "channel types sharing this abstraction" (it doesn't go through `DestinationExecutor` at all — see §7). The abstraction is still justified, now by **three** real implementations (Webhook, Email notification, Archive) rather than four — still comfortably past the "earned, not speculative" bar.

```ts
// modules/destinations/executors/types.ts — conceptual, not final
interface DestinationExecutor {
  readonly channelType: string;
  execute(ctx: ExecutionContext): Promise<ExecutionOutcome>;
}
```

`ExecutionOutcome` is `{ status: "succeeded" | "failed" | "ambiguous"; ...metadata }` — three outcomes, not two (§6/§12).

---

## 5. `ActionExecution` lifecycle — the contradiction, resolved

**Revision 1's error, stated plainly:** it called `ActionExecution` "append-only, mirrors `AnalysisResult`'s proven pattern" in §3/§17, then in §6 described writing a `pending` row and later updating it to a terminal status — those two statements cannot both be true. This revision picks one, explains why, and the "why" is *not* actually "mirror `AnalysisResult`" — that mirror was the wrong comparison.

**Why `AnalysisResult` was the wrong model to copy:** a Jev call has no external side effect — nothing happens in the world until a response comes back, so `AnalysisResult` can safely be written exactly once, only after the outcome is known. A destination execution is the opposite: the side effect (a POST landing on a real server, an IMAP flag being set) can happen *during* the gap where Eumaeus has no result yet. That gap is exactly what needs to be survivable across a crash, and surviving it requires a row to exist *before* the side effect is attempted — which `AnalysisResult`'s pattern structurally cannot provide, no matter how closely it's imitated.

**Resolved model:**

- **`ActionExecution` = one row per attempt, not a "logical execution" and not a summary.** It has its own small, two-phase lifecycle: created with `status = pending` *before* the external call, updated **exactly once** to a terminal status (`succeeded` | `failed` | `ambiguous`) after the call resolves (or is determined stale — §8). This single, narrow mutation is honestly described as a mutation, not miscategorized as "append-only."
- **Across attempts, it *is* append-only** — a retry never reuses or resets a prior row; it inserts a new one. "Append-only across attempts, single in-place finalization within one attempt" is the precise, non-contradictory description this revision uses everywhere below.
- **No separate "logical execution" row or table is needed.** The grouping identifier across an attempt sequence is `idempotencyKey` itself — deterministic, recomputable by any process with zero memory of prior attempts (§6, unchanged). `attemptNumber` on each row = `count(prior rows sharing this idempotencyKey) + 1` at creation time. This directly answers the prompt's question: **logical action, individual attempt, idempotency key, and BullMQ job are four distinct concepts, and exactly one of them (`idempotencyKey`) is persisted as an explicit column; the "logical action" is *represented*, not *stored*, by the set of rows sharing that key** — adding a dedicated table for it would be storing a fact that's already fully derivable, which is the unnecessary complexity the prompt warned against.
- **BullMQ job ≠ attempt ≠ idempotencyKey**, restated for clarity since Revision 1 blurred these: a BullMQ job is a *queue-level* unit of work (§7, `jobId = idempotencyKey` for cheap dedup); an *attempt* is one `ActionExecution` row; the *idempotencyKey* is the stable thread tying a sequence of attempts (and, usually, a sequence of job retries) together. A single BullMQ job retry (same `jobId`) typically corresponds to one new attempt row, but they are not the same concept and must not be treated as interchangeable — see §8 for exactly where this distinction matters (a stalled-then-redelivered job is *not* automatically a new logical attempt if the handler recognizes an in-flight `pending` row for the same key and waits instead of re-attempting).

---

## 6. Idempotency strategy

Unchanged mechanism from Revision 1 (deterministic key over `(emailId, destinationChannelId, routingDecisionId)`; check succeeded/pending-recent/pending-stale/none before attempting), restated using §5's corrected vocabulary: "write the pending *row*" (one attempt's own row), not "write the pending row, mirroring append-only `AnalysisResult`" (the incorrect framing removed). The per-channel ambiguity-policy table from Revision 1 (Human Review: no real ambiguity; Archive: safe to blind-retry; Webhook: not safe by default; Email notification: capped retry) is unchanged and correct on its own terms — carried forward as-is.

**Three distinct idempotency layers — explicitly separated, since the prompt is right that they're easy to conflate:**

| Layer | What it actually guarantees | What it does *not* guarantee |
|---|---|---|
| **BullMQ `jobId`** | The same logical job is not double-*queued* at the BullMQ level. Cheap, queue-internal, not DB-backed. | Does not prevent a second attempt if the job is legitimately retried; does not survive an operator manually re-triggering execution outside the queue; has no idea what "already succeeded" means. |
| **DB-level execution idempotency** (`ActionExecution` rows keyed by `idempotencyKey`) | The actual, authoritative boundary Eumaeus controls: before any external call, the code checks *this*, regardless of how it was invoked (queue job, manual script, a future admin "retry" button). This is what prevents Eumaeus's own code from initiating a redundant attempt. | Cannot resolve genuine ambiguity about whether the *remote* side effect occurred — an ambiguous prior attempt is still ambiguous no matter how carefully the DB is checked. |
| **Remote endpoint idempotency** | Nothing Eumaeus can guarantee. An idempotency key is *sent* (§10/§11) so a cooperating receiver *can* dedupe. | Whether the receiver actually honors it is entirely outside Eumaeus's control and must never be assumed. |

None of the three substitutes for either of the others. Layer 2 is the one this architecture is actually responsible for getting right.

---

## 7. Human Review — resolved as a built-in target, not a persisted `DestinationChannel`

**Revision 1's position ("useful as a uniform dispatch target... a `humanReviewExecutor`") is reversed here, based on a fact found by re-reading `modules/rules/evaluateRulesForEmail.ts` rather than assumed:**

Human Review is **already** reachable from the Rule Engine today, via a code path that has *nothing to do with* `RoutingDecision.destinationRef`, `Destination`, or any execution machinery — `evaluateRulesForEmail` calls `escalateToHumanReview` directly for `unmatched` / `human_review_forced` / `invalid_config` / `missing_analysis` outcomes, entirely separate from the `matched` → `destinationRef` path Phase 5 hooks into. If Phase 5 *also* modeled "route to a human" as a configurable `DestinationChannel` with its own executor, there would be two structurally different ways to arrive at the exact same underlying call, and a config-editable "Destination" row whose `config` JSON is, and will always be, empty — pure ceremony with no real configuration surface.

**Decision: Human Review is a reserved, code-level target, not a database row.**

- A rule's `destinationRef` may be the literal reserved string `"human_review"` (a named constant, not a magic string scattered around).
- `executeAction.ts`'s entry logic checks for this reserved value **before** attempting any `Destination`/`DestinationChannel` resolution, and — if matched — calls `escalateToHumanReview` directly (with a distinguishing `reason`, e.g. `"manual_review_requested"`, distinct from the Rule Engine's own `unmatched`/`ambiguous` reasons, so an operator reviewing later can tell "no rule matched" apart from "a rule *deliberately* routed this to a human").
- **No `ActionExecution` row is created for this path.** There is no external side effect and no ambiguity to survive a crash for — `escalateToHumanReview` is already, and remains, its own complete, idempotent, correctly-audited operation. Wrapping it in the execution/idempotency/queue machinery built for genuinely uncertain external operations would be modeling risk that doesn't exist here.
- This directly satisfies all three stated goals: `escalateToHumanReview` is called unmodified; there is exactly one review mechanism (now with two call sites — the Rule Engine's implicit safety net, and this explicit operator choice — sharing one implementation); no destination abstraction is built for something that isn't a destination in the executor sense.

**Consequence for the module structure (§16) and the MVP (§19):** `executors/humanReviewExecutor.ts` is removed from the plan entirely. This also means Phase 5A, as scoped in Revision 1 (Human Review as the *only* channel), would not exercise the `ActionExecution`/idempotency/queue machinery **at all** — see §19 for how the MVP boundary is corrected in response to this finding.

---

## 8. Pending-execution recovery — resolved end to end

The prompt's crash scenario, answered precisely, using mechanisms that already exist in this codebase plus one that doesn't yet:

**Who checks, and when — no new scheduler in Phase 5A:**

1. **On every invocation of the `execute-action` job handler** (including a BullMQ-driven retry of the *same* `jobId`), before doing anything else, it looks up `ActionExecution` rows for its own `idempotencyKey`. If it finds a `pending` row from a prior attempt that is now **stale** (§6), it finalizes that row as `ambiguous`, escalates, and does **not** start a fresh attempt in the same invocation — self-healing, no separate process involved.
2. **BullMQ's own stalled-job detection** (a standard `Worker` feature already implicitly relied on by this codebase's queue design, not something new being introduced) redelivers a job whose worker died mid-processing without heartbeating, up to a configured `maxStalledCount`. This is what guarantees the handler in (1) *gets invoked again* after a crash, without anything else having to notice the crash happened.
3. **If stalled-redelivery attempts are exhausted** (the job is ultimately marked `failed` by BullMQ), the *already-established* `worker.on("failed", ...)` pattern — the exact mechanism `process-email` uses today (`finalizeFailedProcessing`) — is the backstop: it checks for any `ActionExecution` still `pending` under that job's `idempotencyKey` and finalizes it as `ambiguous` if so, mirroring existing code shape exactly rather than inventing a new one.

**This is sufficient for Phase 5A and does not require a separate reconciliation scheduler.** A dedicated periodic sweep (mirroring Phase 2's `mailbox-sync` scheduler via `upsertJobScheduler`) is explicitly deferred to **Phase 5B**, as defense-in-depth once Webhook exists — reasoning: at 5A's scale (Archive only, an operation whose ambiguity policy is "safe to retry anyway," per §6's table), the incremental safety value of an independent sweep is low relative to the infrastructure cost; at 5B's scale (Webhook, where blind retry is explicitly *not* safe), an independent sweep that doesn't depend on any specific job's own lifecycle catches edge cases (a job manually deleted from the queue, Redis data loss) that (1)-(3) alone cannot.

**Staleness threshold — explicitly *not* copied from `MailboxConnection`'s 10-minute constant.** That number is answering a different question ("how long can a legitimate full IMAP sync take") than this one ("how long can a legitimate single destination-execution attempt take"). The correct basis is each executor's **own** per-attempt timeout budget (mirroring how `modules/jev/client.ts` derives its own internal timeout rather than reusing an unrelated constant): staleness = a small safety multiple (e.g. 3×) of the specific channel's configured per-attempt timeout. For Archive (a fast IMAP call, low single-digit seconds worst case), this yields a short threshold; a future Webhook channel with a longer configured timeout would derive a correspondingly longer one. Stated as a formula, not a borrowed number, because the two situations are not actually analogous.

**Determinism and idempotency of the `pending → ambiguous` transition itself:** finalizing a stale row is a single conditional `UPDATE ... WHERE status = 'pending' AND id = ...` — if two invocations race to finalize the same stale row, only one succeeds in changing its status (the other's `UPDATE` affects zero rows), exactly the same atomic-conditional-update pattern already proven for `MailboxConnection`'s sync lock. The subsequent escalation call is `escalateToHumanReview`, already idempotent (§1). No new idempotency mechanism is invented here — two existing, proven patterns are combined.

---

## 9. Destination versioning — execution provenance, resolved

Revision 1 asserted `channelType` should be denormalized "in case a later edit reinterprets history" while separately treating `channelVersion` as unnecessary — **inconsistent**, since `DestinationChannel` is proposed to be versioned exactly like `Rule` (edit = new row, old row `deactivatedAt`), meaning `destinationChannelId` alone already points at an immutable historical row either way. Re-reading `RuleEvaluation` (§1) resolves this: the codebase's real, working precedent is to denormalize the version number too, for query convenience, even though it's technically re-derivable via a join. Phase 5 follows that precedent rather than diverging from it.

**Minimum immutable provenance fields on `ActionExecution`, and why each is there — no full config snapshot (confirmed unnecessary, since the versioned `DestinationChannel` row already *is* the snapshot):**

| Field | Answers | Why not derive it some other way |
|---|---|---|
| `destinationChannelId` | Which channel (and, by extension, which `Destination`, via one join) | The stable FK; combined with versioning, this alone is enough for correctness |
| `channelType` | Which channel *type* | Denormalized per `RuleEvaluation.ruleVersion` precedent — query convenience, not a correctness requirement |
| `channelVersion` | Which channel *version* | Same precedent, same reasoning — kept consistent with `channelType` rather than denormalizing one and not the other |
| `routingDecisionId` | Which decision triggered this | `RoutingDecision` already stores `matchedRuleId`/`matchedRuleVersion` — "which Rule + which Rule version" is answered by **one join to `RoutingDecision`**, not by also copying `ruleId`/`ruleVersion` a second time onto `ActionExecution`. Denormalizing three levels deep (Rule → RoutingDecision → ActionExecution) would be redundant with data `RoutingDecision` already owns. |
| `idempotencyKey` | Which logical attempt-sequence this belongs to (§5) | The grouping identifier |
| `emailId`, `tenantId` | Direct scoping | Matches every other table's denormalization style |

**Decision on `channelVersion`: keep it, denormalized, for consistency with real precedent (`RuleEvaluation.ruleVersion`) — reversing Revision 1's inconsistent treatment.** No full config JSON snapshot is added — the versioned `DestinationChannel` row already serves that purpose exactly as the versioned `Rule` row does for `RuleEvaluation`.

---

## 10. Queue architecture

Unchanged from Revision 1 — the reasoning (external I/O justifies a separate queue, unlike Phase 4's in-process rule evaluation) holds independently of the changes above. One addition: since Human Review no longer goes through this queue at all (§7), **`execute-action` jobs are only ever enqueued for genuine `DestinationChannel` executions** — the fan-out-per-channel behavior described in Revision 1 is unchanged, just now provably only ever fires for Webhook/Email/Archive, never for the reserved Human Review target.

---

## 11. State-machine recommendation — `completed` deferred out of Phase 5A entirely

**Revision 1 added `completed` to Phase 5A. This revision removes it from 5A, based on working through the exact scenario the prompt poses:**

Trace it through: channel A succeeds, channel B succeeds, channel C is ambiguous → escalates → `Email.state = awaiting_review` (via `escalateToHumanReview`, unconditionally, as it does today for every other escalation reason) → an operator resolves the review item → execution is somehow re-attempted → channel C eventually succeeds. Two things fall out of tracing this:

1. **`awaiting_review → completed` must be a valid, expected transition**, not a dead end — the state machine cannot become a strict forward-only DAG where reaching `awaiting_review` is permanent, or it would misrepresent reality the moment a human fixes the underlying problem and a retry succeeds. This is stated here as the **correct principle**, but the mechanism that re-triggers execution after a human resolves a `HumanReviewItem` (a manual "retry" action) is not designed or built in this phase — it doesn't exist yet in any form, for any prior phase's failures either (a resolved `failed`/`unmatched` item today has no re-execution trigger). Building that is a distinct, real piece of work belonging to whichever phase first needs it, and is listed as an open question (§20), not silently assumed solved.
2. **The "aggregate state across multiple channels" computation has nowhere to live cheaply today, and doesn't need to.** Given (1), whatever decides "is this email `completed`" has to run at the moment the *last* pending channel for an email's destination resolves — this is a query at that moment ("are there any non-terminal `ActionExecution` rows left for this email's channels"), not a new stored aggregate field, consistent with the existing pattern of computing "is there a successful X" via a query rather than a maintained flag (`AnalysisResult`, `RoutingDecision` both already work this way).

**But: does Phase 5A actually reach a case where this matters?** No — and this is the deciding factor for removing `completed` from 5A specifically (not just narrowing its definition). Per §7, Human Review no longer produces any `ActionExecution` at all, and per §19 below, 5A's *only* real channel type is Archive. A destination in 5A realistically has exactly one channel (Archive) or zero — there is no multi-channel fan-out to aggregate over, and Archive's own single-channel "succeeded" case has no example query in this codebase that would actually consume a `completed` state yet (no dashboard, no API — per Revision 1's own §20, out of scope). Introducing a new `Email.state` value for a fact nothing in 5A queries, to represent an aggregation scenario 5A cannot even produce, is exactly the "grow the state machine because it sounds useful" the prompt warns against.

**Resolution: `completed` is deferred to whichever phase first introduces a second real channel type (5B, per §19) and/or a consumer that needs to query it.** The *semantics* are specified now (single-channel success today would simply have no distinct `Email.state` beyond what `ActionExecution.status = succeeded` already records; multi-channel aggregation is query-time, not stored) so 5B/5C build on a settled definition rather than re-deriving one — but nothing is implemented in 5A. `HumanReviewItem.reason` still gains `execution_failed` and `execution_ambiguous` (§13) — those apply as soon as Archive exists, independent of `completed`.

---

## 12. Audit trail — minimum event set

Unchanged core set from Revision 1, with two corrections following from §7/§11:

```
action_execution_started      (one per attempt, per channel — never fires for the reserved Human Review target)
action_execution_succeeded
action_execution_failed
action_execution_ambiguous
destination_resolution_failed (destinationRef isn't the reserved value AND doesn't resolve to an enabled Destination)
```

**`email_completed` is removed from this list** (§11 — not built in 5A, not specified as a stored/fired event until the state itself is). Human Review triggered via the reserved `destinationRef` continues to use the **existing** `email_processing_failed`/`email_routed_to_review` events emitted by `escalateToHumanReview` itself — no new event type needed for that path at all.

---

## 13. Security model

Unchanged from Revision 1 for Authentication/secrets and Email actions — both were already correct and don't depend on the five corrections above. **Webhook SSRF section rewritten below for Node-runtime realism, split into MVP vs. later hardening as requested.**

### Webhooks — SSRF, MVP boundary vs. later hardening

**Being honest about what plain `fetch` in Node actually gives you, and what it doesn't:**

**MVP (Phase 5B — achievable correctly with standard APIs, no exotic low-level networking code):**
- **Resolve DNS explicitly first** (`dns.promises.lookup`, requesting **both** `A` and `AAAA` records), and reject if **any** resolved address falls in a blocked range: RFC1918 private ranges, loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), the cloud metadata address (`169.254.169.254`) — **and explicitly, since this is a common real bypass**, IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1` and similar), which a naive check that only inspects the IPv4 or only the IPv6 form of an address will miss.
- **Disable automatic redirect following** (`redirect: "manual"` on `fetch`) and manually inspect/re-validate any `3xx Location` header through the *same* resolve-and-block check before following it, capped at ~2 hops. This part *is* cleanly achievable with the standard `fetch` API — no custom networking layer required.
- Enforce `https`-only, a response body size cap, and a per-attempt `AbortController` timeout, mirroring `modules/jev/client.ts`'s already-proven pattern exactly.
- Never set `rejectUnauthorized: false` or otherwise weaken TLS hostname verification — Node's default TLS behavior already performs correct certificate/hostname verification; the only risk here is a future change disabling it, which this is a standing rule against.
- **Honest limitation stated plainly, not glossed over:** this approach resolves DNS *once*, validates it, and then lets `fetch` perform its *own*, separate DNS resolution when it actually connects. Between those two resolutions, a sufficiently motivated attacker controlling the target DNS record could change what it points to (classic DNS rebinding) — this MVP boundary **raises the bar significantly and blocks the common cases** (direct private-IP literals, obviously-internal hostnames, naive metadata-endpoint access) but does **not** fully close a rebinding attack.
- Revision 1 also required "connect to the resolved, pinned IP directly while sending the correct `Host` header" as if it were part of the same MVP step. **On reflection, that specific mechanism is not something plain `fetch` supports** — it requires a custom `undici` `Agent`/dispatcher with a controlled `connect`/`lookup` implementation. Claiming it as MVP-achievable via ordinary `fetch` calls would have been exactly the "theoretically safe but wrong in the Node runtime" mistake this revision was asked to avoid.

**Later hardening (Phase 5C or beyond, not blocking 5B):**
- Connection-level IP pinning via a custom `undici` dispatcher (resolve once, connect to that exact IP, send the original `Host` header) — the only way to fully close the DNS-rebinding gap above.
- Per-destination network egress policy (e.g., outbound-proxy allowlisting) if the product ever needs a stronger guarantee than application-level validation can provide.

This split is now explicit in §19/§20 rather than implied.

---

## 14. Webhook payload proposal

Unchanged from Revision 1 (opt-in body, no attachments, `deliveryId` = `ActionExecution.id`, HMAC signature + timestamp, versioned envelope, curated `signals` subset) — none of §5-§11's corrections affect this design.

---

## 15. Failure/retry semantics

Unchanged from Revision 1's table and its stated limitation (timeout → always ambiguous for the MVP, precise pre/post-send disambiguation deferred) — restated here only to note it's now cross-referenced from §13's SSRF split rather than being its own isolated caveat.

---

## 16. Human Review integration

Superseded by §7 above (Human Review is a reserved target, not an executor) — the `reason` values `execution_failed` / `execution_ambiguous` from Revision 1 still apply, but only for genuine `ActionExecution` outcomes (Webhook/Email/Archive), not as a description of "how Human Review itself is invoked" (which is now `manual_review_requested`, per §7, for the explicit-destination-choice case, alongside the Rule Engine's pre-existing `unmatched`/`ambiguous`).

---

## 17. Multi-tenant isolation

Unchanged from Revision 1 — `resolveDestination(tenantId, destinationRef)` remains the single most security-critical new line of code, and its test (tenant A cannot resolve tenant B's destination via a colliding `destinationRef` string) is unchanged and listed again explicitly in §21.

---

## 18. Provider independence

Unchanged from Revision 1.

---

## 19. Recommended module structure

Revised: `executors/humanReviewExecutor.ts` removed (§7); `executeAction.ts`'s responsibility description updated to include the reserved-target short-circuit.

```
src/modules/destinations/
  types.ts                      — DestinationChannelType, ExecutionOutcome, ExecutionContext
  resolveDestination.ts         — tenantId + destinationRef -> Destination + enabled channels (tenant-scoped, §17)
  manageDestinations.ts         — CRUD + versioning, mirrors modules/rules/manageRules.ts's shape exactly
  idempotency.ts                — computeIdempotencyKey(), the succeeded/pending-recent/pending-stale lookup (§6/§8)
  errors.ts                     — DestinationError hierarchy w/ retryable flag, mirrors modules/jev/errors.ts
  ssrfGuard.ts                  — MVP-level outbound-URL validation (§13) — resolve+block, manual redirect re-validation
  secrets.ts                    — encrypt/decrypt against DestinationSecret, the ONLY code path allowed to read a secret's plaintext
  executeAction.ts              — entry point: reserved-target short-circuit (§7) -> OR -> resolve -> idempotency check (§6/§8) -> dispatch to executor -> persist ActionExecution -> audit -> escalate on terminal failure/ambiguity
  executors/
    types.ts                    — the DestinationExecutor interface (§4)
    webhookExecutor.ts          — uses ssrfGuard.ts, secrets.ts
    emailNotificationExecutor.ts — new outbound send, no IMAP dependency
    archiveExecutor.ts          — the one file importing modules/mail-providers/imap
```

| File | Responsibility | Depends on |
|---|---|---|
| `resolveDestination.ts` | Tenant-scoped lookup | `db` |
| `manageDestinations.ts` | CRUD/versioning | `db` |
| `idempotency.ts` | Key computation + pending/stale check | `db` |
| `executeAction.ts` | Entry point (incl. reserved-target short-circuit) | `db`, `audit`, `review`, `idempotency.ts`, `resolveDestination.ts`, `executors/*` |
| `executors/webhookExecutor.ts` | Signed POST | `ssrfGuard.ts`, `secrets.ts` |
| `executors/emailNotificationExecutor.ts` | Send notification | new send capability, `secrets.ts` (if per-tenant creds) |
| `executors/archiveExecutor.ts` | IMAP flag/label | `modules/mail-providers/imap/*` |

Boundary unchanged: nothing in `modules/jev/` or `modules/rules/` imports `modules/destinations/`; `modules/destinations/` imports nothing from `modules/jev/`; only `archiveExecutor.ts` imports `modules/mail-providers/imap`. `modules/review` and `modules/audit` are depended on directly, exactly as `modules/rules` already does.

---

## 20. Prisma schema proposal (conceptual — no migration written)

Revised per §5 (lifecycle wording corrected) and §9 (`channelVersion` added, reasoning made consistent):

```prisma
model Destination {
  id, tenantId, name, description?, createdAt, updatedAt
  channels DestinationChannel[]
}

model DestinationChannel {
  id, tenantId          // denormalized, matches Email.tenantId's pattern
  destinationId
  type                  // "webhook" | "email_notification" | "archive"   -- NOT "human_review": reserved target, never a row (§7)
  config          Json   // non-secret only: url, to-addresses, folder/label name, includeBody flag, etc.
  enabled         Boolean @default(true)
  version         Int     @default(1)   // same edit=new-row pattern as Rule
  deactivatedAt   DateTime?
  createdAt, updatedAt
}

model DestinationSecret {   // separate table — see §13: a secret must never be reachable via a broad SELECT * on the channel row
  id, tenantId
  destinationChannelId  @unique
  encryptedValue  Bytes   // AES-GCM ciphertext
  createdAt, rotatedAt?
}

// One row PER ATTEMPT (§5) — NOT append-only end-to-end, NOT a mirror of
// AnalysisResult. Created as pending BEFORE the external call; updated exactly
// once, in place, to a terminal status after. Across attempts sharing the same
// idempotencyKey, rows accumulate (append) rather than being reused/reset.
model ActionExecution {
  id, tenantId, emailId
  routingDecisionId          // -> RoutingDecision, which already carries matchedRuleId/matchedRuleVersion (§9 — not duplicated here)
  destinationChannelId
  channelType     String     // denormalized at execution time, per RuleEvaluation.ruleVersion's real precedent (§9)
  channelVersion  Int        // same precedent — kept consistent with channelType, not treated differently
  idempotencyKey  String     // the grouping identifier across an attempt sequence (§5) — NOT a separate logical-execution row
  attemptNumber   Int        // count(prior rows sharing idempotencyKey) + 1, at creation time
  status          String     // pending | succeeded | failed | ambiguous — the one field mutated post-creation
  errorClass      String?
  errorMessage    String?
  requestMetadata  Json?     // host, method — never secrets/signed headers
  responseMetadata Json?     // status code, truncated body, latency
  startedAt, completedAt?, createdAt

  @@index([idempotencyKey])
  @@index([emailId])
}
```

No full destination-config snapshot (confirmed unnecessary, §9 — the versioned `DestinationChannel` row already is one). No separate `Action`/`LogicalExecution` table (confirmed unnecessary, §5 — `idempotencyKey` already serves as the grouping identifier). Deletion: never hard-deleted, `deactivatedAt` only, same as `Rule`.

---

## 21. Testing strategy

Reorganized directly around the ten scenarios given, each mapped to the (now-corrected) architecture:

1. **Same execution job enqueued twice** — `jobId = idempotencyKey` dedup at the BullMQ layer (layer 1, §6); confirm the DB layer (layer 2) would independently prevent a duplicate even if BullMQ-level dedup were somehow bypassed.
2. **Same execution worker invoked twice** — call the job handler function directly, twice in a row (mirrors the existing pattern in `jevAnalysis.test.ts`/`retry.test.ts`), assert exactly one terminal `ActionExecution` results.
3. **Worker crashes after writing `pending`** — manually insert a `pending` row (mirrors `jevAnalysis.test.ts`'s existing "recovers correctly from a crash between Jev succeeding and the job being acknowledged" pattern), re-invoke the handler, assert correct recognition (not a blind duplicate attempt).
4. **Stale pending re-encountered** — insert a `pending` row with an old `startedAt`, invoke the handler (§8's self-check), assert it's finalized `ambiguous` exactly once even across repeated invocations (idempotent finalization, per §8's atomic-conditional-update argument).
5. **Two tenants share a colliding `destinationRef`** — `resolveDestination(tenantA, "sales")` vs. `resolveDestination(tenantB, "sales")` must resolve independently; tenant A must never receive tenant B's channel/secret.
6. **Disabled destination/channel** — excluded from resolution, results in `destination_resolution_failed` → escalation (mirrors the Rule Engine's existing "disabled rule ignored" test exactly).
7. **Destination config edited after an execution already happened** — create channel v1, execute (produces an `ActionExecution` pointing at v1 with `channelVersion=1`), edit → v2, assert the *original* `ActionExecution` row's `destinationChannelId`/`channelVersion` still resolve to v1's data (mirrors the existing Rule-versioning test almost line for line).
8. **Email content attempts to redirect the destination target** — mirrors `jevAnalysis.test.ts`'s prompt-injection fixture pattern: an email whose subject/body contains a URL, header-like syntax, or secret-shaped text must produce a request whose target/headers/auth are byte-for-byte identical to a control case with a benign body — only the curated JSON body fields (§14) may differ.
9. **Webhook timeout does not trigger a blind retry** — a timeout classifies as `ambiguous` (§15), not `failed`; assert no automatic re-attempt happens before escalation.
10. **Human Review escalation doesn't duplicate on a second trigger** — covers both the pre-existing `escalateToHumanReview` idempotency (already tested) and, specifically for Phase 5, the *new* reserved-target short-circuit call site (§7) — invoking it twice for the same email must not create a second `HumanReviewItem`.

**Additional unit coverage:** idempotency key determinism (same inputs → same key, always); SSRF guard, one test per blocked-range case including the IPv4-mapped-IPv6 bypass (§13); retry classification table (§15), one test per row; payload builder (body excluded by default, signature correctness).

**Architecture** (`test/architecture/destinationsModuleBoundary.test.ts`, mirroring the two existing ones): `modules/destinations` imports nothing from `modules/jev`; `modules/jev` and `modules/rules` import nothing from `modules/destinations`; only `archiveExecutor.ts` imports `modules/mail-providers/imap`.

---

## 22. Explicit out-of-scope items

- Rule-builder / destination-management UI or API (matches Phase 4's own scoping).
- Native Slack/CRM connectors (generic webhook covers them, `architecture-review.md` §8).
- Attachment forwarding (content never stored).
- Native forward-as-the-connected-mailbox (`architecture-review.md` §9, rejected again).
- Real KMS/envelope encryption for `DestinationSecret` — single-env-key AES-GCM is the MVP stopgap.
- RLS — application-layer isolation only, unchanged stance.
- Connection-level IP pinning for full DNS-rebinding closure (§13) — MVP relies on resolve-and-block only.
- Independent reconciliation scheduler (§8) — 5A relies on self-check + BullMQ stalled-job redelivery + `worker.on("failed")`; deferred to 5B.
- `completed` email state and any cross-channel aggregation logic (§11) — deferred until a second real channel type exists.

---

## 23. Open questions (genuinely blocking, not speculative "could do later" notes)

1. **What re-triggers execution after a human resolves a review item?** No mechanism exists today for *any* prior phase's failures, not just Phase 5's — this is the actual prerequisite for `awaiting_review → completed` (§11) ever being reachable, and needs an owner/phase before `completed` can be built.
2. **The exact staleness-threshold multiple** (§8 — "a small safety multiple, e.g. 3×, of the executor's own timeout") needs a concrete decision per channel type once Webhook's own timeout budget is chosen in 5B; not resolved here.
3. **`channelType`/`channelVersion` denormalization was reversed in this revision** (§9) based on `RuleEvaluation` precedent — confirm this reasoning is accepted before schema work starts, since it's a direct reversal of Revision 1's stated position.
4. **Timeout precision** (§15) — every timeout treated as ambiguous for the MVP; whether that proves too eager to escalate in practice is only knowable after real Webhook traffic exists (5B), not now.

---

```
IMPLEMENTATION STATUS: NOT STARTED
```
