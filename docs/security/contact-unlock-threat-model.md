# PII-Disclosure Threat Model — Contact Unlock + Reveal (ADR-0010, Phase-0 DESIGN)

- **Date:** 2026-06-15
- **Author:** security-engineer agent (mandatory PII-disclosure threat model, required by
  [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) §Risks "THREAT MODEL" and §STOP item 2).
- **Status:** **DESIGN-ONLY threat model.** No unlock code, migration, or table exists yet.
  Findings are framed as *"the design must guarantee X; here is the control to mandate at
  build + the test that must exist."* This artifact is a **gate on proceeding to BUILD**, not
  a review of shipped code.
- **Scope:** the Contact Unlock + routed Reveal spine designed in ADR-0010 — the **single
  highest-risk PII path in BadaBhai**, and the only feature that deliberately discloses a
  worker's contact channel to a paying party. It is the one place the cardinal invariant
  (CLAUDE.md §2 invariant 2 — raw PII never leaves the `workers` boundary) is *intentionally
  bent at exactly one server-side step* and must not break anywhere else.
- **Grounded against (verified in-repo, 2026-06-15):**
  [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md),
  [ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) (live
  `jobs`/`applications`, `ConsentGuard`, `WorkerAuthGuard`),
  [ADR-0004](../decisions/0004-pii-at-rest-and-rls.md) (PII-at-rest + RLS),
  the [pseudonymization contract](../ai/pseudonymization.md), CLAUDE.md §2.
- **Verdict (companion bb-security-review):** see the security-engineer's review handed back
  with this artifact. Headline: **CONCERNS — Phase-0 sign-off may proceed with documented
  must-fix-before-build items; two findings (T2-b, T5-a) are BUILD-blockers until their
  controls + tests are mandated.** No finding blocks Phase-0 *sign-off* of the ADR; several
  block *build authorization*.

---

## Build verification (2026-06-17) — Stream A BUILT + re-verified PASS

This design-time threat model has since been **built and independently re-verified** against
the merged code (`apps/api/src/unlocks/*`, the web ops/payer unlock UI, `packages/config`). A
fresh bb-security-review returned **PASS (alpha posture), no must-fix**:

- All **9 non-tradeable invariants** (§5) are upheld in code, each mapped to a test.
- All **BUILD conditions BC-1…BC-8** (§6) and the build-blockers **F-1/F-2** have a present,
  correctly-asserting test (unit + schema + boot + config, plus the opt-in `RUN_E2E=1`
  `tests/e2e/contact-unlock.e2e.test.ts` for the live-DB concurrency / idempotency / no-PII proofs).
- **T2-a (already_unlocked) — STRUCTURALLY CLOSED.** The model is per-`(payer_id, worker_id)`
  with a unique index; `findByPayerWorker` is scoped to the requesting payer, so a payer can
  only ever observe its **own** row — a grant held by another payer is invisible and collapses
  to the identical neutral body (the weekly-distinct-payers cap also denies via the neutral path).
- **T2-c (timing) — confirmed an OFF LAUNCH GATE (RR-4 / LC-7).** The body+status oracle is
  closed (every neutral branch is HTTP 200 `{status:"unavailable"}`; reveal returns the neutral
  body, **not** a classifiable 404). Latency-normalization remains deferred to before any real
  per-payer surface.

**Residuals / launch gates unchanged:** RR-1…RR-4 and LC-1…LC-7 remain open and tracked
(TD33 PayerAuthGuard / TD34 mock payments / TD35 retention-erasure + the LC items). Two §6
*static* regression guards are not yet present and are logged as **TD39** (BC-8 structural
sole-writer assertion; BC-5 single-decrypt-site assertion) — the runtime/behavioural guarantees
they back ARE covered (sentinel-phone-absent, decrypt-called-once, module non-export + verified
grep showing no outside importer), so these are tracked tech-debt, **not** build-blockers.

---

## 1. Methodology

Each threat below is enumerated, rated for **severity** (Critical / High / Medium / Low —
Critical = forces a raw-PII leak, a fail-open gate, or an auth bypass; never downgradable to
tech-debt per CLAUDE.md), tied to the **ADR-0010 mechanism** that mitigates it (or flagged as
a **GAP / under-specified**), and given the **control to mandate at build** plus **the test
that must exist** before the path can ship. Severity is rated **as-designed** (does the
ADR-0010 contract, if built exactly as written, mitigate it?) — a "GAP" means the ADR does not
yet pin the control tightly enough and a build could comply with the ADR while still leaking.

We assume a **hostile payer** (the party we are disclosing to is the primary adversary: they
want to de-anonymize, scrape, or over-contact workers beyond what they paid for), a **hostile
caller of the shared secret** (alpha rides `InternalServiceGuard`), and a **curious
insider/DB-reader** (the ADR-0004 blast-radius model).

---

## 2. Assets (what we are protecting, ranked by sensitivity)

| # | Asset | Where it lives (design) | Sensitivity | Notes |
|---|-------|--------------------------|-------------|-------|
| A1 | Worker **raw phone** (`phoneE164`) | `workers` only, AES-256-GCM at rest (ADR-0004); read transiently at reveal step [5] | **Critical** | The crown jewel. In scope for unlock at **exactly one** server-side step, never persisted/returned/logged. |
| A2 | Worker **raw full name** (`fullName`) | `workers` only (nullable, to be encrypted TD21) | **Critical** | Not needed by unlock at all — unlock must never read it. |
| A3 | The **routing-token to contact mapping** (`routing_token_ref -> worker_id, channel kind, expiry`) | server-side only (`unlock_routing` or provider) — **must never contain a phone** | **Critical** | If this ever stores the number, it becomes a second PII surface and defeats the whole design. |
| A4 | The **worker <-> payer linkage** (who unlocked / contacted whom) | `unlocks` (`payer_id` + `worker_id`), `unlock.*`/`contact.*` events | **High** | Behavioural PII about the worker; the linkage itself is sensitive even without the phone. |
| A5 | **Consent state** (`employer_sharing` granted/revoked) | `worker_consents` (append-only) | **High** | A worker's disclosure choice; leaking it (even as a deny reason) is an oracle and a DPDP concern. |
| A6 | **Credit balances / ledger** (`payer_credits`, `credit_ledger`) | new tables, amounts + ids only | **Medium** | Integrity asset (no double-debit / no grant-without-debit); not PII, but money-adjacent. |
| A7 | **Cap / behavioural counters** (reveal counts per window) | derived from `unlocks` + events | **Medium** | Leaking these to a payer is a re-identification oracle (T2). |

**Out of scope as assets (must never be created):** employer PII (`payer_id` is opaque,
"faceless rails"), any proxy/relay destination string in a durable store, any free-text field
on any unlock table or event.

---

## 3. Trust boundaries + where raw PII is in scope

```
 [ Worker app ]                       [ Payer surface ]
  consent opt-in                       (alpha: caller of the shared secret;
  (employer_sharing)                    production: PayerAuthGuard - LAUNCH GATE)
        |                                       |
        | TB-W                                  | TB-P  <-- weakest boundary in alpha
        v                                       v
 +-------------------------------------------------------------+
 |                      NestJS API (backend)                   |
 |   UnlockGuardService  = the SINGLE chokepoint (TB-G)        |
 |   [1] consent gate -> [2] caps -> [3] payment -> [4] grant  |
 |                                          |                  |
 |                                          v                  |
 |                              [5] ROUTED REVEAL handler      |
 |        <==== RAW PII IN SCOPE HERE, AND ONLY HERE ====>     |
 |        reads workers.phoneE164 (PiiCryptoService.decrypt)   |
 |        hands routing instruction to relay/provider          |
 |        discards plaintext; NEVER persists/returns/logs it   |
 +-------------------------------------------------------------+
        |  TB-DB (service role / BYPASSRLS)     |  TB-PROV
        v                                       v
 +------------------------+        +---------------------------------+
 |  workers (raw PII,     |        | routing / relay:                |
 |  AES-256-GCM, RLS)     |        |  alpha = in-app relay (no number |
 |  unlocks/payer_credits/|        |          leaves BadaBhai)        |
 |  credit_ledger/        |        |  prod  = telephony/proxy provider|
 |  unlock_routing        |        |          (HUMAN-GATED - gets the |
 |  (PII-FREE)            |        |          raw number) - NOT alpha |
 +------------------------+        +---------------------------------+
```

**Raw PII is in scope at exactly ONE place: trust-boundary-crossing step [5], server-side,
inside the reveal handler, for the duration of one decrypt -> route -> discard.** Everywhere
else — every table, every event, every log line, every API response, every relay handle
returned to the payer — is PII-free by contract. This is the single most important property
this threat model exists to defend.

- **TB-W (worker -> API):** worker grants `employer_sharing` consent. Existing
  `WorkerAuthGuard` + the consent write path; trusted as much as the rest of the worker app.
- **TB-P (payer -> API):** **the weakest boundary in alpha.** No per-payer identity exists
  (T7). Alpha rides `InternalServiceGuard` (shared secret = backend/ops only). A real payer
  surface requires `PayerAuthGuard` — a launch gate.
- **TB-G (chokepoint):** `UnlockGuardService` is the *only* writer of `unlocks` and the *only*
  resolver of `routing_token_ref`. The whole model's integrity rests on this being a true
  single chokepoint (T5).
- **TB-DB:** backend connects as `postgres`/BYPASSRLS over a direct connection; the effective
  control is REVOKE-from-all-client-roles (ADR-0004). New unlock tables join the RLS backlog
  (T9).
- **TB-PROV:** in alpha, the in-app relay keeps the number inside BadaBhai (no external
  provider sees it). In production, a telephony/proxy provider would receive the raw number —
  a new, human-gated trust boundary (T8).

---

## 4. Threats

### T1 - Raw PII leaking into events / ai_jobs / audit_logs / logs / error responses

The cardinal invariant (CLAUDE.md section 2 #2). Severity: CRITICAL (this is the one thing
this feature must never do).

As-designed assessment: MITIGATED by contract, with two named build-time controls that must
be enforced (the ADR states the rule but cannot enforce it - code can).

- Events: ADR-0010 section 6.2 makes every payload ids/enums/counts only. Critically,
  contact.revealed carries channel: enum(in_app_relay | proxy_number) and reveal_count -
  channel KIND only, never the number/destination. Verified against the existing spine: the
  feed.* / application.* payloads (packages/event-schema/src/payloads.ts ~L437) are exactly
  this PII-free shape, and EventsService.emit (apps/api/src/events/events.service.ts)
  validates against the registry before any write, so an accidental extra field is rejected,
  not stored.
- Logs: verified nuance - EventsService.emit logs event_name, subject_type:subject_id, and
  correlation_id ONLY (events.service.ts L52-60). For unlock events subject_id is
  unlock_id/worker_id/job_id - all opaque UUIDs - so the events logger stays PII-free
  automatically. The risk is NOT the events logger; it is ad-hoc logging inside the reveal
  handler (step [5]), where the decrypted phone is a live local variable.
- Error responses: a decrypt failure, a provider error, or an unhandled exception at step [5]
  must not serialize the phone (or a stack frame containing it) into the HTTP response or an
  error log.

Controls to mandate at build:
1. Step [5] is the ONLY site that may call PiiCryptoService.decrypt on this path. The
   decrypted value is assigned to a narrowly-scoped local, handed to the relay/provider call,
   and never (a) returned, (b) put in an event payload, (c) put in any logger.* call, (d)
   placed in an exception message/cause. Mandate a code-review checklist item + a lint/grep
   gate: no decrypt( outside the reveal handler; no logging of the phone variable.
2. The reveal handler wraps step [5] in a try/catch that maps ALL failures to the neutral path
   (T2) and logs ONLY unlock_id + an error CLASS - never the exception's raw message if it
   could embed the number. Fail closed.
3. unlock_routing (and any provider mapping record) is schema-asserted PII-free: a token id,
   unlock_id FK, channel enum, expiry - and a test that the table has NO text/phone column.

Tests that must exist (privacy-critical - explicit no-PII assertions, per CLAUDE.md quality bar):
- A test that drives a full granted reveal and asserts the worker's raw phone string appears in
  NONE of: the contact.revealed payload, any emitted event row, the HTTP response body,
  ai_jobs, audit_logs. (Use a sentinel phone value and assert-absent everywhere.)
- A test that forces the relay/provider call to throw WITH the phone in the error message and
  asserts the phone does not reach the response or any captured log; the caller sees the
  neutral "unavailable".
- A schema test asserting no unlock-family table (unlocks, payer_credits, credit_ledger,
  unlock_routing) has any column that could hold a phone/name/contact string.

### T2 - Re-identification / behavioural ORACLES (the no-oracle rule)

A hostile payer infers a worker's identity, choices, or behaviour from differences in status
codes, timing, cap responses, deny reasons, or error shapes. Severity: HIGH (re-identifies the
worker / leaks consent state A5 + counters A7 without ever seeing the phone).

As-designed assessment: PARTIALLY MITIGATED - the intent is correct and explicit, but the
contract is UNDER-SPECIFIED in three places that a build could get wrong while still
"complying" with the ADR. Two of these are BUILD-blockers.

ADR-0010 section D4 mandates a single neutral "unavailable" that is indistinguishable across
no_consent, capped, and unknown_worker, and section 6.2/6.3 keep deny_reason INTERNAL only
(never echoed). That correctly closes the response-BODY oracle for the three named states.
Verified: the response contract (section 6.3) returns { status: "unavailable" } identically for
all three, and deny_reason lives only in the row + the internal unlock.denied event.

Gaps (where a compliant build could still leak):

- T2-a - already_unlocked is not in the no-oracle set. Severity: HIGH. GAP. The task brief
  explicitly calls out "capped vs non-consented vs unknown vs already-unlocked". The ADR's
  neutral set is {no_consent, capped, unknown_worker} and the GRANTED path returns a distinct
  { status: "granted", expires_at, reveal_endpoint }. A payer who already holds a grant for a
  worker gets a different, richer response than a payer probing an unknown/capped/non-consented
  worker - so "do I already have this worker?" is answerable, and more subtly, a second distinct
  payer must not be able to tell "this worker exists and is unlockable" apart from "unavailable".
  The design must specify: the only states a payer may distinguish are (i) I successfully
  got/own a grant and (ii) unavailable - everything else (no consent, capped, unknown worker,
  exists-but-not-mine) collapses to identical "unavailable". payment_required is a fourth
  legitimately-distinct state but it is only reachable AFTER consent + caps pass (ordering [3]
  follows [1],[2]) - see T2-b.

- T2-b - payment_required is an oracle because it is positioned AFTER the consent + cap gates.
  Severity: HIGH. BUILD-BLOCKER. ADR-0010's ordering is [1] consent -> [2] caps -> [3] payment.
  A payer therefore learns: "I got payment_required" => the worker DID consent to employer
  sharing AND is under their caps (otherwise the request would have stopped at [1] or [2] with a
  neutral "unavailable" BEFORE payment was attempted). With zero credits, a payer can probe the
  entire worker base and read off exactly which workers have granted employer_sharing consent and
  are not capped - a mass consent/availability oracle, for free, with no payment. This is the most
  serious oracle in the design and it is a DIRECT consequence of the documented gate ordering.
  The design must resolve this, e.g. one of: (a) require a non-zero credit balance as a
  precondition checked BEFORE [1] so a zero-balance payer gets a neutral/payment_required
  REGARDLESS of worker state (collapse the distinction for zero-balance callers); or (b) make
  payment_required reachable ONLY after a balance precheck that is independent of the specific
  worker, so the response cannot be used to read worker state; or (c) return neutral "unavailable"
  for ALL deny states including insufficient credits and surface balance only via the separate
  GET /payers/:id/credits ops endpoint. The ADR currently lists payment_required as a DISTINCT
  response - that must be reconciled with no-oracle before build. (Note: this does NOT mean
  "debit before consent"; debit still follows consent+caps, T5/T6. It means a balance
  PRECONDITION must gate whether the caller can probe at all.)

- T2-c - Timing / side-channel oracle. Severity: MEDIUM. GAP (ADR is silent). The neutral paths
  differ in work done: unknown_worker is a fast miss; no_consent does a consent lookup; capped
  does a consent lookup + a cap aggregation; the granted path does all of that + a decrypt + a
  relay call. Response TIMING (and DB-load patterns) can re-introduce the oracle the response
  body closed. The /unlocks/:id/reveal route's "404 if unknown" (section 6.3) is itself a
  distinguishable signal from a neutral "unavailable" - an inconsistency the ADR should reconcile
  (a 404 on an unknown unlock id vs a neutral body on a known-but-denied one lets a caller classify
  ids). Control to mandate: the neutral path returns a constant response shape AND a normalized
  latency; reveal returns the same neutral body - not a bare 404 - for unknown/denied/expired/
  over-cap alike. Timing-hardening can be a documented residual for alpha (the alpha caller is the
  trusted shared-secret holder, T7) but must be a LAUNCH GATE before any real per-payer surface.

Controls to mandate at build:
- A single neutral-response constructor used by every deny/neutral branch (consent, cap, unknown
  worker, already-owned-by-other, expired, over-attempt, and - per T2-b resolution - zero-balance),
  guaranteeing byte-identical bodies and status codes. No branch may build its own response.
- deny_reason enum NEVER crosses the HTTP boundary (compile-time: the response DTO has no
  reason/deny_reason field at all).
- /unlocks/:id/reveal returns the SAME neutral body for unknown/expired/over-cap/revoked - not a
  distinguishable 404 vs 200-unavailable.

Tests that must exist:
- A table-driven test asserting the HTTP response is byte-identical (same status, same body)
  across: no-consent, capped, unknown-worker, exists-but-owned-by-another-payer, and (zero-balance,
  per T2-b). The granted response is the ONLY distinguishable success.
- A test asserting a zero-credit payer cannot distinguish a consented-uncapped worker from a
  non-consented one (the T2-b regression test).
- A test that reveal on an unknown/expired/revoked unlock returns the neutral body, not a
  classifiable 404.
- (Launch gate) A timing-variance check on the neutral paths.

### T3 - Routing-token / relay abuse (guessing, replay, reuse-after-expiry, recover-the-number, over-attempt)

Severity: HIGH (a recovered or replayed token can reach a worker beyond consent/caps, or - worst
case - recover the raw number A1/A3).

As-designed assessment: PARTIALLY MITIGATED - the reference design (opaque UUID pointer, resolved
server-side, phone never in the token record) is sound, but the token's format/storage/lifecycle
is explicitly left "an implementation detail" (section 6.1) and is the single most under-specified
high-risk element in the ADR.

ADR-0010 section D2/6.1 get the core right: routing_token_ref is an opaque UUID pointer, the
mapping is server-side only, the phone is resolved at reveal time and NEVER persisted in the token
record, and each reveal re-checks consent [1] + caps [2] (section 6.3 reveal ordering) so a token
is "permission to attempt, not a standing right to spam". Reveal is also capped at reveal_count <
cap (<=3) and bounded by expires_at.

Gaps:
- T3-a - Token format/entropy/storage under-specified. Severity: HIGH. GAP. A gen_random_uuid()
  v4 is 122 bits - unguessable, good. But the ADR does not MANDATE it (says "uuid (nullable)") nor
  forbid a guessable/sequential alternative, nor specify that the token is NEVER exposed to the
  payer (the payer gets a relay_handle/proxy_ref, not the routing_token_ref itself - this must be
  explicit so the token cannot be harvested and replayed against another endpoint). Mandate:
  routing_token_ref is a 122-bit random UUIDv4, server-internal only, never returned in any response
  or event; the payer-facing relay_handle/proxy_ref is a SEPARATE short-lived opaque handle bound
  to the unlock + attempt, not the routing token.
- T3-b - Token does not resolve to a raw number for the payer, ever (alpha). Severity: CRITICAL if
  violated. Mostly mitigated. The in-app relay (alpha) means the token resolves to a relay session,
  not a number - strong. The control to mandate: even the relay_handle/proxy_ref returned to the
  payer must be non-reversible to the number and expire with the unlock window / attempt; resolving
  it is itself a server-side op behind the chokepoint.
- T3-c - Reuse after expiry/revocation. Severity: HIGH. Mitigated by re-check, must be tested.
  Reveal re-checks status=granted, not expired, reveal_count < cap, AND re-checks consent (immediate
  revocation, T4). The control: these re-checks are inside UnlockGuardService (the chokepoint),
  atomic with the reveal_count++, and there is NO other code path that can resolve a token.

Controls to mandate at build: UUIDv4 routing_token_ref, server-internal only; a separate expiring
payer-facing relay handle that is non-reversible to the number; all token resolution + reveal_count++
happen atomically inside the chokepoint with consent + cap + expiry re-checks; the token mapping
record is schema-proven phone-free (T1 control 3).

Tests that must exist:
- A test that the routing_token_ref value never appears in any HTTP response or event (server-internal
  only).
- A test that a reveal after expires_at, after reveal_count == cap, or after consent revocation returns
  the neutral body and does NOT resolve a channel / increment the count.
- A test that the relay handle/proxy ref cannot be replayed after the window (expires) and is not
  reversible to the phone.
- A concurrency test that N parallel reveals on one unlock cannot exceed the attempt cap (atomic
  reveal_count).

### T4 - Consent bypass / revocation race (reveal after revoke; profiling-consent misused as disclosure-consent)

Severity: CRITICAL (a reveal without active employer_sharing consent is a DPDP violation and a
fail-open of invariant 6).

As-designed assessment: MITIGATED in shape (separate purpose + fail-closed gate + re-check-on-reveal),
with ONE race window the ADR acknowledges but does not pin tightly.

ADR-0010 section D3 gets the architecture right and it is the cleanest part of the design:
employer_sharing is a SEPARATE consent purpose (already reserved in packages/types/src/index.ts L26 -
verified), captured in a SEPARATE explicit worker action, enforced by a purpose-scoped sibling of
ConsentGuard (assertWorkerConsentedFor(workerId, "employer_sharing")) reading the latest
worker_consents row and requiring the purpose present AND revokedAt IS NULL. The existing ConsentGuard
(apps/api/src/auth/consent.guard.ts) is the exact verified pattern: it reads the latest append-only row
and fails closed on missing/revoked. Profiling consent CANNOT stand in for disclosure consent because
the gate checks for the specific employer_sharing string - a worker with profiling but not
employer_sharing is correctly undiscoverable (neutral "unavailable", T2).

Gaps:
- T4-a - Revoke-vs-reveal race window. Severity: HIGH. GAP (acknowledged, not pinned). The ADR says
  "revocation is immediate" and re-checks consent at each reveal - correct. But a worker revoking
  CONCURRENTLY with an in-flight reveal at step [5] (consent checked at [1]/re-check, then the
  decrypt+relay happens) has a TOCTOU window: consent passes the re-check, the worker revokes, the
  relay opens. Mandate: the consent re-check is the LAST gate before the decrypt, inside the same
  chokepoint transaction as the reveal_count++ and the contact.revealed emit, minimizing the window to
  the relay-open latency; and revocation writes are immediately visible to that read (same DB,
  latest-row read - not a cache). The residual window (re-check -> relay open) is irreducible-to-zero
  for an external relay but must be documented as a residual and kept to a single in-transaction step.
  For the alpha in-app relay, the relay session itself should re-validate consent at open so a revoke
  during the window still closes the channel.
- T4-b - Consent version / copy coupling. Severity: MEDIUM (DPDP). GAP. The ADR recommends bumping
  CURRENT_CONSENT_VERSION when disclosure copy is introduced (good) but the lawful-basis wording is
  deferred to legal (T10). Build must not enable the gate against placeholder copy in any non-mock path.

Controls to mandate at build: consent re-check is the final pre-decrypt gate, in the same chokepoint
transaction as the reveal write + emit; revocation is a latest-row DB read (no caching); the in-app
relay re-validates consent at session open.

Tests that must exist:
- A test: worker with profiling but not employer_sharing -> unlock denied (neutral).
- A test: worker revokes employer_sharing after a grant but before reveal -> reveal denied (neutral),
  no channel resolved, no contact.revealed emitted.
- A concurrency test approximating the revoke-vs-reveal race (revoke committed between the re-check and
  the relay open) asserting fail-closed behaviour at the relay layer.
- A test that the gate keys on the exact employer_sharing purpose string (not any consent).

### T5 - Cap bypass (concurrency race; non-chokepoint paths; caps after payment)

Severity: HIGH (over-cap contact = worker harassment + the anti-scrape spine defeated).

As-designed assessment: MITIGATED in shape (single chokepoint, caps before payment), with ONE
concurrency gap that is a BUILD-blocker.

ADR-0010 section D4 is architecturally right: one UnlockGuardService chokepoint that EVERY grant and
reveal traverses, caps derived from the unlocks/event state (not a drift-prone side counter), caps
BEFORE payment (ordering [2] precedes [3] - so a capped worker is never charged), and no bypass (no
other code may write unlocks or resolve a token).

Gaps:
- T5-a - Cap atomicity under concurrency. Severity: HIGH. BUILD-BLOCKER. Caps derived from the count
  of granted reveals in the window via a read-then-check-then-write are a classic race: K concurrent
  POST /unlocks (or /reveal) for one worker each read count = 4 < 5, all pass, all grant -> cap
  exceeded. The ADR names the chokepoint but does NOT specify the concurrency-control mechanism.
  Mandate one of: a serializable / SELECT ... FOR UPDATE transaction over the worker cap window, an
  atomic conditional insert/update with a DB-enforced constraint, or an advisory lock keyed on
  worker_id, such that the cap check + the grant/reveal write are ONE atomic operation. Counts being
  derived-not-separate prevents DRIFT but does NOT by itself prevent the RACE - the ADR conflates the
  two.
- T5-b - Single-chokepoint enforceability. Severity: HIGH. GAP (must be made structural). "No other
  code path may write unlocks or resolve a token" is a RULE; build must make it STRUCTURAL:
  UnlockGuardService is the ONLY class with the repository write methods for unlocks/unlock_routing,
  the repository does not expose a public unguarded insert, and a test asserts no other module
  imports/calls them. Otherwise a future feature adds a second writer and silently bypasses caps +
  consent.
- T5-c - Per-attempt cap on reveal. Severity: MEDIUM. Mitigated. reveal_count < cap (<=3) re-checked
  per reveal (T3) - same atomicity requirement as T5-a applies to the increment.

Controls to mandate at build: the cap-check-and-write is one atomic DB operation (FOR UPDATE /
serializable / advisory lock on worker_id); UnlockGuardService is the sole writer (structurally -
private repository, no other caller); caps precede payment in code, not just in the doc.

Tests that must exist:
- A concurrency test firing N simultaneous unlock/reveal requests for one worker and asserting the cap
  is never exceeded (and no credit debited beyond granted unlocks).
- A test asserting payment is NOT attempted/debited when the cap is exceeded (ordering [2] before [3]).
- A structural test / lint asserting unlocks + unlock_routing have no writer outside
  UnlockGuardService.

### T6 - Payment / credit integrity (double-debit; debit-without-grant or grant-without-debit; negative balance; mock-as-real)

Severity: MEDIUM (money-adjacent integrity; not PII, but a grant-without-consent via a broken payment
path could chain into a disclosure).

As-designed assessment: MITIGATED in shape, with the atomicity of debit+grant under-specified.

ADR-0010 section D5/6.1/6.3 get the shape right: a mock credit ledger (payer_credits materializes the
append-only credit_ledger), debit keyed on the unlock idempotency key (retry never double-debits), the
unique (payer_id, worker_id, job_id) index (a retried unlock returns the same grant),
PAYMENTS_ENABLE_REAL = false default mirroring AI_ENABLE_REAL_CALLS (invariant 5), and real_call: false
on every payment.* event - the honesty flag that lets ops prove no real money moved (verified analogue:
AiCostRecordedPayload.real_call).

Gaps:
- T6-a - Debit + grant atomicity. Severity: MEDIUM. GAP. Step [3] debit and step [4] grant must be ONE
  transaction: a crash between them yields either debit-without-grant (payer charged, no unlock) or
  grant-without-debit (free unlock). Mandate: [3]+[4] in a single DB transaction, with the ledger insert
  + balance update + unlocks row write committed atomically; the idempotency key makes the RETRY safe,
  the transaction makes the PARTIAL-FAILURE safe.
- T6-b - Negative balance. Severity: LOW. GAP. The balance check (balance >= 1) and the decrement must
  be atomic (same race family as T5-a) so concurrent debits cannot drive balance negative. Mandate: a
  DB CHECK (balance >= 0) and an atomic conditional decrement.
- T6-c - real_call honesty. Severity: MEDIUM (audit). Mitigated, must be tested. A test must assert
  every payment.* event in alpha carries real_call: false and that PAYMENTS_ENABLE_REAL defaults false
  and cannot be flipped without the documented human gate.

Controls to mandate at build: [3]+[4] atomic transaction; idempotency key on the debit; balance >= 0
CHECK + atomic decrement; PAYMENTS_ENABLE_REAL=false default with a config fail-closed assertion (mirror
assertPiiCryptoConfig).

Tests that must exist:
- A retry test: the same unlock request twice -> one debit, one grant (idempotent).
- A partial-failure test: a fault injected between debit and grant leaves a consistent state (both or
  neither).
- A test asserting real_call: false on all payment.* events and the default flag value.

### T7 - Payer-auth gap (alpha rides InternalServiceGuard; no per-payer identity)

Severity: HIGH as an alpha posture (contained); CRITICAL for any client-facing surface (any holder of
the shared secret can unlock ANY worker as ANY payer_id).

As-designed assessment: CORRECTLY IDENTIFIED + FLAGGED as a launch gate; the residual must be made
explicit and non-negotiable.

Verified: InternalServiceGuard (apps/api/src/common/guards/internal-service.guard.ts) is a fail-closed
shared-secret check (no secret configured => deny all; constant-time compare) - but it establishes NO
per-payer identity. ADR-0010 section 6.3 is honest about this: payer_id is supplied IN THE REQUEST BODY,
and the guard cannot verify the caller IS that payer or is authorized to act for it. So in alpha, the
secret-holder (backend/ops) can mint an unlock for ANY (payer_id, worker_id, job_id) - i.e. unlock any
consenting worker as any payer.

What this exposes (alpha, contained): because the only caller is the trusted backend/ops secret-holder,
this is the same interim posture R11/R1/TD4 already accept for the resume PII routes. The
worker-protection caps + consent gate + no-oracle still apply, so even the secret-holder cannot exceed
caps or reach a non-consenting worker. The exposure is ops-can-act-as-any-payer - acceptable for a
mock-credits alpha with no external payers.

Why no production payer surface may ship on the shared secret (CRITICAL if violated): a payer-facing
surface on InternalServiceGuard means EVERY payer shares one secret and can spoof any payer_id - total
cross-payer compromise + the ability to attribute unlocks/credits to other payers. PayerAuthGuard
(per-payer identity, authz that the authenticated payer owns the payer_id in the request/unlock) is a
hard LAUNCH GATE.

Controls to mandate: alpha routes InternalServiceGuard only, documented as interim; the body payer_id is
trusted ONLY because the caller is the secret-holder; a comment + register entry binding no-production-
payer-surface-on-the-shared-secret; PayerAuthGuard designed + the body payer_id replaced by the
authenticated payer identity before any client-facing payer access. The reveal rule must-own-the-unlock-
payer_id (section 6.3) is UNENFORCEABLE under InternalServiceGuard (no identity) - it becomes real only
with PayerAuthGuard; flag this explicitly so it is not assumed-enforced in alpha.

Tests that must exist:
- (Alpha) A test that unlock routes deny without the internal secret (fail closed).
- (Launch gate) Once PayerAuthGuard lands: a test that payer A cannot unlock/reveal/read credits for
  another payer payer_id (no horizontal authz bypass).

### T8 - Provider trust boundary (a real telephony/proxy provider receives the raw number)

Severity: HIGH (a real provider is a new external party that DOES see A1) - but out of alpha by design.

As-designed assessment: CORRECTLY HUMAN-GATED + avoided in alpha by the in-app relay.

ADR-0010 section D2 selects the in-app relay (candidate 2) as the alpha default precisely because it
discloses no number to any external party - the number never crosses TB-PROV. The masked-number provider
(candidate 1) is the PRODUCTION routed channel and is explicitly human-gated like real LLM/OTP/payment
keys (section D2, EXPLICITLY OUT, STOP). This is the right call: alpha ships the full consent -> caps ->
grant -> reveal spine end-to-end WITHOUT a human-gated provider key, and the provider trust boundary
simply does not exist in alpha.

Controls to mandate (for if/when a provider is added - HUMAN-GATED, not alpha): a real provider
integration is a separate, human-approved, staging-first change behind a flag (mirror invariant 5); a
DPA / data-processing agreement with the provider; the number handed to the provider is still never
logged on our side (T1) and the provider mapping is treated as the sensitive boundary; the channel:
proxy_number event still carries KIND only.

Tests that must exist (when added): a test that the provider path still emits proxy_number KIND only
(no number in event/log/response); a flag-default test that the provider path is off by default.

HUMAN-GATED ESCALATION: selecting/funding a real telephony/proxy provider -> STOP and escalate
(CLAUDE.md section 7). Not in alpha.

### T9 - RLS / at-rest posture for the four new tables

Severity: MEDIUM (matches the current Phase-1 service-role posture; the gap is the known, tracked
RLS-not-finalized gap R1/TD4/TD20).

As-designed assessment: CONSISTENT with ADR-0004 + tracked; one hard requirement on unlock_routing.

ADR-0010 section 6.1/R-2 put unlocks, payer_credits, credit_ledger, unlock_routing on the service-role
posture (backend connects as postgres/BYPASSRLS; effective control is REVOKE-from-client-roles per
ADR-0004) and add them to the RLS backlog (TD20). Verified: the existing spine is RLS-ENABLE+FORCE+REVOKE
(ADR-0004, migration 0009 per the prior review), and workers (the only identity join, unlocks.worker_id)
is RLS-locked. The new tables are PII-free, so the blast radius of a DB read is ids + amounts + enums -
not contact.

Gaps / hard requirements:
- T9-a - unlock_routing must NEVER persist a phone. Severity: CRITICAL if violated. This is asset A3.
  The table is a token id -> worker_id + channel enum + expiry, and NO phone column may ever exist (T1
  control 3). This is the one new table whose mis-design would create a second PII surface.
- T9-b - New tables join RLS+REVOKE when RLS lands. Severity: MEDIUM. Tracked. Add all four to
  infra/supabase/rls-plan.md; until then they ride the service role exactly like applications (ADR-0009
  OQ-3). payer_credits/credit_ledger carry no PII but are money-adjacent -> REVOKE from client roles
  regardless.

Controls to mandate: schema-prove unlock_routing (and all four) PII-free; add the four tables to the RLS
plan; REVOKE-from-client-roles when RLS is enabled spine-wide.

Tests that must exist: the T1 schema test (no phone column anywhere); when RLS lands, the ADR-0004-style
regression (SET ROLE anon/authenticated/service_role -> denied on the new tables).

### T10 - DPDP / lawful basis + retention

Severity: HIGH (disclosure to a third party is a distinct DPDP purpose; shipping it without lawful basis
+ notice is a launch-blocking compliance failure).

As-designed assessment: CORRECTLY framed as a launch gate; retention policy is a GAP the threat model
must surface.

ADR-0010 section D3/R-3 correctly make disclosure a separate employer_sharing purpose with its own
consent + notice, versioned + append-only + revocable, and defer the lawful-basis wording + production
notice copy to the legal track as a launch gate (CLAUDE.md section 8). This is the right separation:
architecture fixes the MECHANISM, legal owns the COPY/BASIS.

Gaps:
- T10-a - Retention / expiry policy for routing tokens + reveal records. Severity: MEDIUM. GAP (named in
  the brief, not in the ADR). Routing tokens expire with the unlock window (expires_at, ~14d) - good for
  the TOKEN. But the ADR does not state a RETENTION policy for: the unlock_routing mapping after expiry
  (should be purged/tombstoned, not kept), the unlocks rows (the worker-payer linkage A4 - how long
  retained?), and the contact.* / unlock.* events (the audit spine is append-only by design - reconcile
  with DPDP data-minimization/erasure). Mandate: a retention/expiry policy - expired unlock_routing
  records purged; a documented retention window for unlocks/credit rows; and a DPDP erasure/crypto-shred
  story for the worker-payer linkage that is consistent with the append-only events spine (the events
  carry no PII, so they can persist; the linkage via worker_id is erasable by the existing
  crypto-shred-the-worker model, TD22). This must land with the legal track.
- T10-b - Disclosure notice copy is a launch gate. Severity: HIGH. Tracked. No non-mock disclosure until
  the employer_sharing consent copy lands with the production DPDP legal-copy stream (R-3).

Controls to mandate: a written retention/expiry policy (token purge-on-expiry; linkage retention window;
erasure via worker crypto-shred); disclosure notice copy gating any non-mock disclosure.

HUMAN-GATED ESCALATION: production DPDP legal copy + lawful-basis wording -> human/legal, launch gate.

---

## 5. Non-tradeable invariants (NEVER relax - a violation is Critical, never tech-debt)

These are the lines that, if crossed, mean the feature must not ship - they are not negotiable to
unblock work and are never downgraded:

1. Raw PII (phone, name) never enters events, ai_jobs, audit_logs, logs, or any HTTP response. The
   phone is read at exactly one server-side step ([5]) and discarded. (T1, T9-a)
2. contact.revealed and every unlock/payment event carry channel KIND + ids/enums/counts only - never
   the number, proxy ref, or relay destination. (T1)
3. No routing/relay record ever persists a phone. routing_token_ref is an opaque pointer;
   unlock_routing has no contact column. (T3, T9-a)
4. The disclosure gate fails closed and uses the separate employer_sharing purpose. No reveal without
   active, unrevoked employer_sharing consent; profiling consent never substitutes; revocation is
   immediate. (T4)
5. No oracle. A payer can distinguish only "I got/own a grant" from "unavailable" (+ a
   worker-state-independent payment/balance signal). No deny reason, consent state, cap state, or worker
   existence leaks via body, status, or timing. (T2)
6. Caps + consent are checked at the single UnlockGuardService chokepoint, atomically, before payment,
   with no bypass writer. (T5)
7. No LLM call anywhere on this path, ever. Pure deterministic CRUD + events + routing (invariants 3, 4
   trivially held - and must stay that way). (whole design)
8. Alpha is in-app-relay + mock-credits only. No raw-phone reveal; no real telephony provider; no real
   payment keys/spend - each is a hard human-gated STOP. (T6, T7-prod, T8)
9. No production payer surface on the shared InternalServiceGuard secret - PayerAuthGuard is a launch
   gate. (T7)

---

## 6. Residual risks + conditions to clear them

### Residuals acceptable for Phase-0 sign-off (documented, tracked)
- RR-1 (payer auth): alpha rides InternalServiceGuard; ops can act as any payer_id. Contained because
  the only caller is the trusted secret-holder + caps/consent/no-oracle still apply. Clear before
  client-facing payer access: PayerAuthGuard (T7). Launch gate.
- RR-2 (RLS not finalized): new tables ride the service role (R1/TD4/TD20). Contained by
  REVOKE-from-client-roles + PII-free tables. Clear when RLS lands: add the four tables to the RLS plan +
  the ADR-0004 regression (T9).
- RR-3 (revoke-vs-reveal residual window): irreducible-to-zero for any relay (T4-a). Kept to one
  in-transaction step + relay-layer re-validation. Documented residual, acceptable for alpha.
- RR-4 (timing oracle, alpha): alpha caller is trusted (T2-c). Clear before any real payer surface:
  latency-normalize the neutral path. Launch gate.

### Conditions that MUST be cleared before BUILD (the controls above are mandated + tested)
- BC-1 (T2-b, BUILD-BLOCKER): the payment_required-after-consent+caps oracle is resolved in the design
  (balance precheck independent of worker state) BEFORE the API contract is built, with the regression
  test specified in T2.
- BC-2 (T5-a, BUILD-BLOCKER): the cap check + grant/reveal write is specified as ONE atomic operation
  (FOR UPDATE/serializable/advisory lock) with the concurrency test in T5.
- BC-3 (T2-a / no-oracle contract): the exact no-oracle response contract - the single neutral-response
  constructor covering no-consent / capped / unknown / already-owned-by-other / expired / over-cap (+
  zero-balance per BC-1), and reveal returning the neutral body not a classifiable 404 - is pinned in the
  contract with the byte-identical-response test.
- BC-4 (T3-a): routing_token_ref format (UUIDv4, server-internal-only, never in response/event) + a
  separate non-reversible expiring payer handle is pinned, with the token-never-leaves-the-server test.
- BC-5 (T1): the decrypt-only-at-step-[5], never-logged/returned/serialized control is a mandated
  review-gate + the no-PII-anywhere reveal test + the schema-PII-free test exist.
- BC-6 (T9-a): unlock_routing (+ all four tables) schema-proven phone-free.
- BC-7 (T6-a): debit+grant atomicity (single transaction) + idempotency + real_call:false honesty test
  specified.
- BC-8 (T5-b): UnlockGuardService is the structurally-sole writer (private repository, no other caller)
  with the structural test.

### Conditions that MUST be cleared before LAUNCH (human-gated)
- LC-1: PayerAuthGuard + horizontal-authz test (T7) before any client-facing payer surface.
- LC-2: production DPDP employer_sharing notice + lawful-basis copy (T10-b) - HUMAN/legal.
- LC-3: retention/expiry policy for tokens + linkage + erasure story (T10-a) - with legal.
- LC-4: if a real telephony/proxy provider is ever chosen - STOP + human escalation + DPA + staging-first
  + flag-gated (T8) - HUMAN. (Not needed if alpha in-app relay remains the channel.)
- LC-5: if real payments are ever enabled - STOP + human escalation, PAYMENTS_ENABLE_REAL staging-first
  (T6) - HUMAN.
- LC-6: if raw-phone reveal is ever wanted - separate higher-tier consent + team decision + a fresh
  threat-model addendum (OQ-E) - HUMAN. Default: never in alpha.
- LC-7 (timing): latency-normalize the no-oracle path (RR-4) before a real payer surface.

---

## 7. HUMAN-GATED escalations (surface these at sign-off)

These are not engineering calls - they STOP at the human/RVM per CLAUDE.md section 7:
- Real telephony / proxy provider selection + funding (T8 / LC-4).
- Real payment keys / real money (PAYMENTS_ENABLE_REAL) (T6 / LC-5).
- Raw-phone reveal (post-alpha, separate consent + new threat model) (OQ-E / LC-6).
- Production DPDP legal copy + lawful-basis wording for employer_sharing (T10 / LC-2).

---

## 8. Conclusion

ADR-0010 architecture - routed-not-raw, separate fail-closed disclosure consent, a single cap
chokepoint, mock-credits with a flag-gated real seam, a PII-free event family with the phone touched at
exactly one server-side step, and explicit human gates on the real provider/payment/raw-reveal - is
SOUND and, if built exactly as specified with the controls mandated above, can satisfy CLAUDE.md section
2 invariants 1-8. The cardinal invariant (no raw PII outside workers) is preserved by design: raw PII is
in scope at one step and never persisted, returned, or logged.

The design is NOT yet build-ready: the no-oracle response contract (T2-a/T2-b), cap atomicity (T5-a), the
routing-token format/storage (T3-a), and the decrypt-only-at-[5]-never-logged control (T1) are
UNDER-SPECIFIED in ways a compliant build could still leak through (especially the T2-b payment_required
consent-oracle, which is a direct consequence of the documented gate ordering and is the most serious
gap). These are the BUILD-blockers in section 6 - each is closable by pinning the control in the contract
and mandating the named test, none requires re-architecting the feature.

Phase-0 SIGN-OFF of the ADR may proceed with these documented as must-fix-before-build.
