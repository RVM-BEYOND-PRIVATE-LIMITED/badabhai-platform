# E-chain design — a filterable candidate list for the first paying employer

**For:** Prakash (owner)
**Date:** 2026-09-05
**SHA:** `f72a7a79093de19b41a894eb3bae18a338427c3a` — `origin/main`, tree clean at branch point
**Scope:** a DESIGN session. No feature code was written. No database was touched (P-017).
**Companion ADR:** [0040-candidate-search-filter-behaviour.md](0040-candidate-search-filter-behaviour.md) — unsigned
**Briefs:** `docs/agent/phases/E1_BUILD.md` … `E4_CHECK.md`

---

## 0. What changed after measuring, before you read the briefs

Five of this plan's premises did not survive measurement. None invalidates the plan; two
change a phase's shape and one changes its size by an order of magnitude. They are first
because they are the reason to read the rest.

| # | Premise | Measurement |
|---|---|---|
| ① | **E3 is a build** — "packs credit the account with no gateway" | **It ships, and it is the default.** `POST /payer/credits` resolves a pack from config, mock-purchases it (`real_call:false`) and credits the ledger, while `POST /payer/credits/order` (the real gateway) answers a neutral 404 with `PAYMENTS_ENABLE_REAL` off — [apps/api/src/payer-portal/payer-unlocks.controller.ts:134-142](../../apps/api/src/payer-portal/payer-unlocks.controller.ts). The two are mutually exclusive **by construction**. E3 is not a build; it is a re-point plus one owner ruling. |
| ② | **(c) something is missing between an unlock and a résumé** | **Nothing is, on the applicants page.** The path is live end to end: `POST /payer/resume-disclosures` ([apps/api/src/payer-portal/payer-disclosure.controller.ts:52](../../apps/api/src/payer-portal/payer-disclosure.controller.ts)) → `maskedResumeAction` → `MaskedResumeCard` in payer-web ([apps/payer-web/src/app/(portal)/postings/\[id\]/applicants/actions.ts:77](../../apps/payer-web/src/app/(portal)/postings/[id]/applicants/actions.ts)). The premise is **inverted**, not wrong: the résumé today is **free and masked**; your flow has it **paid and full**. That is an amendment to two signed ADRs, not a wiring gap. |
| ③ | **(b) `unlock_credit` is a locked billable object** | **No such object exists**, in any spelling. The billable objects are `payer_credits`, `credit_ledger` and `unlocks` ([packages/db/src/schema/payer.ts:266](../../packages/db/src/schema/payer.ts), `:287`, `:225`). `free_unlock_credits` is a `match_config` **key**, not a table ([packages/db/src/schema/match.ts:249](../../packages/db/src/schema/match.ts)). The substance of the premise — a billable credit, and a `denied` unlock state — is **true**; only the name is not. |
| ④ | **E1 "send `tradeKey`"** | `job_postings` **has no `trade_key` column.** That column belongs to the legacy `jobs` table ([packages/db/src/schema/job.ts:397](../../packages/db/src/schema/job.ts), inside the `jobs` table that opens at `:391`). Under ADR-0036 §3 the posted **match skill *is* the role**, so adding `trade_key` mints a **second role vocabulary on the same row**. E1 is briefed to send the match skills and **not** `trade_key`. That is Q1. |
| ⑤ | *(unstated, and it decides the sequencing)* | **R-E1 is ruling R7, option (a), verbatim.** The worksheet's own words for R7(a): *"same candidate set, same count; matching candidates lead; badge reads '14 of 62 match Fanuc.' Never scored, never ranked, never removes anyone"* — [RVM_TAXONOMY_WORKSHEET_2026-09.md:786](RVM_TAXONOMY_WORKSHEET_2026-09.md). The R7 signature slot at `RVM_TAXONOMY_WORKSHEET_2026-09.md:794` is **blank**, and `docs/agent/phases/P5_BUILD.md:1` is HALTed on it. See §5 and Q6. |

---

## 1. The survey — E1 to E4 against `f72a7a79`

Each phase lands in one of the four categories. Every claim is a file path plus a line;
nothing here is inferred from a document outside this repository.

### E1 — posting form · **PARTLY BUILT**

**ALREADY BUILT.**

- A posting form with a trade `<select>`, ordered ₹ pay bands and bounded experience-year
  inputs: [apps/payer-web/src/app/(portal)/postings/new/posting-form.tsx:40-49](../../apps/payer-web/src/app/(portal)/postings/new/posting-form.tsx)
  declares all nine fields, `tradeKey`, `payMin`/`payMax` and
  `minExperienceYears`/`maxExperienceYears` among them.
- A **server-served closed skill vocabulary**: `GET /payer/match/skills` under
  `PayerAuthGuard` — [apps/api/src/match/match-skills.controller.ts:29](../../apps/api/src/match/match-skills.controller.ts)
  and `:34`. The payload is built at
  [apps/api/src/match/match-skills.service.ts:97-106](../../apps/api/src/match/match-skills.service.ts)
  and carries `skill_id`, `label`, `industry_id`, `related_skill_ids`.
- **Role-relevant skills already arrive pre-ticked.** `MatchSkillPicker` renders the
  curated related set and a live reach count from `POST /payer/match/reach-preview`
  ([apps/payer-web/src/app/(portal)/postings/new/match-skill-picker.tsx:8-33](../../apps/payer-web/src/app/(portal)/postings/new/match-skill-picker.tsx)).
- The **wider PATCH already accepts** `city`, `pay_min`, `pay_max`, `shift`, `needed_by`,
  `match_skill_ids` and `unticked_related_ids` —
  [apps/api/src/job-postings/job-postings.dto.ts:122-172](../../apps/api/src/job-postings/job-postings.dto.ts).

**MISSING.**

- **The five collected fields are validated and then discarded.** The server action parses
  `tradeKey`, `payMin`, `payMax`, `minExperienceYears`, `maxExperienceYears`
  ([apps/payer-web/src/app/(portal)/postings/new/actions.ts:45-53](../../apps/payer-web/src/app/(portal)/postings/new/actions.ts))
  and hands the result to `toPayerJobPostingBody`, which builds a body of exactly
  `org_label` + `role_title` + `vacancies` + two optional labels
  ([apps/payer-web/src/lib/payer-api.ts:1036-1046](../../apps/payer-web/src/lib/payer-api.ts)).
  The comment that admits it is at
  [apps/payer-web/src/lib/payer-api.ts:1029-1033](../../apps/payer-web/src/lib/payer-api.ts):
  *"trade/pay/exp are NOT included … Those three stay collected-for-parity but unsent
  here … trade/exp are accepted by neither schema."*
- **The create schema is narrower than the update schema.** `PayerCreateJobPostingSchema`
  is seven fields ([apps/api/src/job-postings/job-postings.dto.ts:95-107](../../apps/api/src/job-postings/job-postings.dto.ts));
  every worker-visible field arrives only on PATCH. The publish call sends nothing but
  `match_skill_ids`, `unticked_related_ids` and `status`
  ([apps/payer-web/src/lib/payer-api.ts:1226-1233](../../apps/payer-web/src/lib/payer-api.ts)),
  so pay, city and shift genuinely require reopening Edit. The shape is stated in the
  action's own docblock —
  [apps/payer-web/src/app/(portal)/postings/new/actions.ts:17-19](../../apps/payer-web/src/app/(portal)/postings/new/actions.ts):
  *"TWO CALLS, ONE BUTTON (ADR-0036)."*
- **The role dropdown is a client constant that disagrees with the server.** `TRADE_KEYS`
  is fifteen values compiled into payer-web
  ([apps/payer-web/src/lib/contracts.ts:70-86](../../apps/payer-web/src/lib/contracts.ts));
  `MATCH_SKILLS` is eighteen and is what the backend actually matches on
  ([packages/taxonomy/src/match-skills.ts:68](../../packages/taxonomy/src/match-skills.ts)).
  Neither list is derived from the other.
- **`job_postings` carries no experience window.** Those columns exist on the legacy `jobs`
  table only ([packages/db/src/schema/job.ts:429-430](../../packages/db/src/schema/job.ts)).
  Adding them needs a migration — additive and nullable, **written but not applied**
  (`docs/agent/BUILD_RULES.md:21`).
- **The skill picker is not role-scoped.** It renders all eighteen. `MatchSkillDto` drops
  the `domainId` that `MATCH_SKILLS` carries
  ([apps/api/src/match/match-skills.service.ts:16-22](../../apps/api/src/match/match-skills.service.ts)
  against [packages/taxonomy/src/match-skills.ts:42-50](../../packages/taxonomy/src/match-skills.ts)),
  so the server cannot express "these skills belong to that role" today.

**BLOCKED BY A SIGNED RULING.** No. ADR-0036 §3 *supplies* the answer rather than blocking
it. Q1 is a scope question, not a block.

### E2 — candidate search · **NOT BUILT**

**NOT BUILT — and this is what was searched for.**

- Every `@Controller` / `@Get` / `@Post` / `@Patch` / `@Delete` in `apps/api/src` was
  enumerated: **320 route decorators across 69 controllers**. Eighteen controllers carry
  `PayerAuthGuard`. Their complete route list contains no candidate search of any kind.
- A case-insensitive regex for a route path containing `search`, over every
  `*.controller.ts`, returns exactly one hit —
  [apps/api/src/jobs/jobs.controller.ts:47](../../apps/api/src/jobs/jobs.controller.ts),
  `GET jobs/search`, which is **worker-facing** (`WorkerAuthGuard, ConsentGuard` at `:48`)
  and searches **jobs**, not workers.
- The only payer→worker surfaces that exist are
  `GET /payer/reach/jobs/:jobId/applicants` — one posting, no query parameter
  ([apps/api/src/payer-portal/payer-reach.controller.ts:63](../../apps/api/src/payer-portal/payer-reach.controller.ts))
  — and `GET /payer/agency/workers`, agency-only under ADR-0022
  ([apps/api/src/agency/agency-workers.controller.ts:39](../../apps/api/src/agency/agency-workers.controller.ts)).
- payer-web has no `/candidates` route. The portal directory is `account`, `agency`,
  `capacity`, `credits`, `dashboard`, `plans`, `postings`, `profile`, `team`.

**The audit's "zero" is confirmed**, by enumeration rather than by keyword sampling.

**ALSO BLOCKED BY A SIGNED RULING** — twice, and both are on `E2_BUILD.md`'s STATUS line:

1. **R7 is unsigned** (`docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:794`) and R-E1
   settles it. `docs/agent/BUILD_RULES.md:31` makes settling R1–R7 a full stop *for a
   builder* — so the ruling has to arrive as a signed ADR, which is what ADR-0040 is for.
2. **ADR-0036:61** closes the rank tuple: *"Nothing else may enter the rank — not
   education, age, gender, caste, religion, RVM affiliation, attributes, or money."*
   "Matches lead" is a new leading order term, and `docs/decisions/0036-matching-algorithm-v1.md:75`
   routes any such change through a new `engine_version`, CEO sign-off and its own ADR.

### E3 — credits and unlock · **ALREADY BUILT**, except one half that is an owner ruling

**ALREADY BUILT.**

| Deliverable | Where it ships |
|---|---|
| A pack credits the account with **no gateway** | [apps/api/src/payer-portal/payer-unlocks.controller.ts:143](../../apps/api/src/payer-portal/payer-unlocks.controller.ts) (`POST /payer/credits`); mutual exclusion with the real path at `:134-142` |
| Idempotent under retry, scoped to the session payer | `:157-186` — `RequestIdempotency.runOnce`, keyed on the session payer |
| Balance + append-only ledger, balance never negative | [packages/db/src/schema/payer.ts:266](../../packages/db/src/schema/payer.ts), `:287`, CHECK at `:280` |
| Free tier of 50 credits at signup, exactly once under retry | [apps/api/src/match/free-tier.service.ts:7-22](../../apps/api/src/match/free-tier.service.ts) |
| Credits **decrement on unlock**; caps precede payment; one transaction | [apps/api/src/unlocks/unlocks.service.ts:67-78](../../apps/api/src/unlocks/unlocks.service.ts) — the fail-closed ordering F-1 → [4] |
| A `denied` unlock state with an internal-only reason | [packages/db/src/schema/payer.ts:239-241](../../packages/db/src/schema/payer.ts), CHECK at `:261` |
| A payer can already reach a résumé | [apps/api/src/payer-portal/payer-disclosure.controller.ts:52](../../apps/api/src/payer-portal/payer-disclosure.controller.ts) + [apps/payer-web/src/app/(portal)/postings/\[id\]/applicants/applicant-actions.tsx:11](../../apps/payer-web/src/app/(portal)/postings/[id]/applicants/applicant-actions.tsx) |
| A payer-web credits page with live-catalog packs | [apps/payer-web/src/app/(portal)/credits/page.tsx:47](../../apps/payer-web/src/app/(portal)/credits/page.tsx) |

**MISSING.**

- **A "full profile" view does not exist anywhere.** No payer-facing route, DTO or page
  returns a worker's profile. The unlock buys a **routed contact relay**
  ([apps/api/src/unlocks/unlocks.service.ts:409](../../apps/api/src/unlocks/unlocks.service.ts)
  — `const channel: RoutingChannel = "in_app_relay"`), and the résumé is delivered
  **masked to initials**
  ([apps/api/src/disclosures/resume-disclosure.service.ts:235](../../apps/api/src/disclosures/resume-disclosure.service.ts)).
- All of it is reachable **only from a posting's applicants page**. There is no
  search-page equivalent, because there is no search page.

**BLOCKED BY A SIGNED RULING.** Yes — Q3. *"Holding view credits, they unlock a profile and
see the full profile and the résumé"* reprices two signed decisions: ADR-0010 (a credit
buys routed contact) and ADR-0013 C.3 (*"Resume download is FREE but is a PII
DISCLOSURE"*, [packages/db/src/schema/payer.ts:500-502](../../packages/db/src/schema/payer.ts)).
Unmasking is a §2 privacy call on top.

### E4 — worker opt-out · **PARTLY BUILT**, and gated on work that is not engineering

**ALREADY BUILT.**

- `wants` exists, defaults **true**, and is in the reach driver index:
  [packages/db/src/schema/match.ts:59](../../packages/db/src/schema/match.ts), with the
  partial index at `:79-81` (`ON (skill_id) WHERE wants`). **R-E2 is already the shipped
  default** — nothing to build for it, only something not to break.
- The safe half of the toggle is written and deliberately throws:
  [apps/api/src/match/worker-skills.service.ts:157-165](../../apps/api/src/match/worker-skills.service.ts),
  with a test asserting it fails rather than silently no-ops
  ([apps/api/src/match/worker-skills.service.test.ts:482](../../apps/api/src/match/worker-skills.service.test.ts)).
- `employer_sharing` is a real consent purpose and a real fail-closed gate:
  [packages/types/src/index.ts:32](../../packages/types/src/index.ts), enforced at
  [apps/api/src/unlocks/unlocks.service.ts:71](../../apps/api/src/unlocks/unlocks.service.ts).

**MISSING.** Enumerated exactly in (d) below.

**BLOCKED** — not by a *ruling*, but by a **launch gate that a builder cannot clear**. The
DPDP notice copy for `employer_sharing` is outstanding legal/owner work. The enum's own
docblock says so ([packages/types/src/index.ts:29-31](../../packages/types/src/index.ts)),
and the consent-version policy says why it matters
([packages/types/src/index.ts:83-96](../../packages/types/src/index.ts)): *"Bumping the
version while the app shows the old words would record, on every consent row, a claim about
what the worker read that is simply false."*

---

## 2. The specific questions

### (a) `listSignalRows` — does E2 extend it, or must it replace it?

**Replace it. E2 must not touch it.** Four independent reasons; any one is sufficient.

1. **It is the retiring engine's pool.** It reads `worker_profiles` —
   [apps/api/src/reach/reach.repository.ts:81-101](../../apps/api/src/reach/reach.repository.ts)
   — and feeds `rankWorkersForJob` from `packages/reach-engine`, which ADR-0036 retires
   outright. Building the first paying employer's search on it is building on the half you
   already retired.
2. **Its missing `WHERE` is a load-bearing invariant, not an omission.** Its docblock states
   it at [apps/api/src/reach/reach.repository.ts:43-48](../../apps/api/src/reach/reach.repository.ts):
   *"SORT-NEVER-BLOCK (D8): there is NO relevance `WHERE` … so `count in == count out` over
   the eligible pool stays structural, not policed."* Adding a consent join, a status filter
   or a `LIMIT` **deletes that invariant on a surface that still serves it**, and the blast
   radius is not one route: PACE reads the same pool
   ([apps/api/src/pace/pace.service.ts:193](../../apps/api/src/pace/pace.service.ts)).
3. **The leak is real, and extending would make it E2's.** `ApplicantRowDto.components[].reason`
   is returned to the payer verbatim
   ([apps/api/src/reach/reach.dto.ts:18-24](../../apps/api/src/reach/reach.dto.ts), `:35`),
   and the engine writes exact numbers into those strings:
   [packages/reach-engine/src/scoring.ts:199](../../packages/reach-engine/src/scoring.ts)
   (`` `${y}y — in range` ``), `:201`, `:202`, and `:213`
   (`` `expects ~${Math.round(over * 100)}% above the offer` ``), plus `:177`–`:181`
   (`` `~${Math.round(d)}km` ``). For a **masked** worker that is exact tenure, an exact
   salary-expectation ratio and a distance from the job's location. On a small pool those
   are re-identifying. **It is a live payer-facing surface today**, independently of E2.
4. **The V1 pool is already the right shape.** `worker_skill` carries the closed skill id, a
   denormalized industry, bucketed months and `wants`, with a partial index built for exactly
   this read ([packages/db/src/schema/match.ts:34-81](../../packages/db/src/schema/match.ts)).

**Consequence for the briefs.** `E2_BUILD.md` sources from `worker_skill` ⋈
`worker_industry_tenure` ⋈ `worker_consents`, never from `worker_profiles`, and
`E2_CHECK.md` **FAILs on any diff under `apps/api/src/reach/` or
`packages/reach-engine/`**. The `reason`-string leak is **named and not fixed**: it is a
defect on the legacy route, it predates E2, and repairing it inside E2 is exactly the
"while I was here" change `docs/agent/BUILD_RULES.md:33-35` forbids. It is Q4.

### (b) Credits — new build, or wiring?

**Neither. It is a re-point.** Every billable object, the mock purchase, the ledger, the
free tier, the debit-on-unlock and the `denied` state ship; the table in §1/E3 cites each.
The name `unlock_credit` matches nothing in this repository.

What E3 actually owes is to **surface the existing pack purchase and balance beside the
candidate list**, and to get a ruling on what a credit buys (Q3). Briefing E3 as a build
repeats PX exactly.

### (c) Résumé on unlock — what is missing?

**Between an unlock and a payer seeing a résumé: nothing.** The path is live and wired end
to end, and has been since ADR-0019 Phase 1.

Three things are missing between that and the flow you described, and none of them is
plumbing.

1. **The résumé is not credit-gated.** It is free by signed decision — *"Resume download is
   FREE but is a PII DISCLOSURE"*
   ([packages/db/src/schema/payer.ts:500-502](../../packages/db/src/schema/payer.ts)) — and
   it rides the consent-and-caps spine, not the credit spine. It does not even require an
   unlock: `POST /payer/resume-disclosures` takes a `worker_id` directly.
2. **The résumé is masked.** The name is reduced to initials at render
   ([apps/api/src/disclosures/resume-disclosure.service.ts:235](../../apps/api/src/disclosures/resume-disclosure.service.ts));
   the real name is decrypted once, server-side, and never leaves.
3. **There is no full-profile view to reveal.** No route, no DTO, no page.

### (d) E4 — exactly what must be built

Six items. Only the first four are code.

1. **Implement `setWants`.** Replace the throw at
   [apps/api/src/match/worker-skills.service.ts:157-165](../../apps/api/src/match/worker-skills.service.ts).
   Its own docblock specifies the hard part: the write must reconcile `job_reach` **in the
   same breath**, or a worker keeps seeing — and can keep applying to — jobs for work he has
   just declined. It must stamp `source='interview'`, the one source the coarse
   re-derivation is forbidden to overwrite
   ([packages/db/src/schema/match.ts:26-30](../../packages/db/src/schema/match.ts)).
2. **A worker-authed endpoint and DTO**, registered in
   [apps/api/src/common/guard-contract.test.ts](../../apps/api/src/common/guard-contract.test.ts),
   which imports every controller in `apps/api` and asserts its guard chain.
3. **The Flutter UI** in `apps/worker-app`. CLAUDE.md §6 makes this a **GitHub issue to the
   mobile owner**, not backend work. E4's brief raises the issue and stops there.
4. **A "turn everything off" affordance.** R-E3's stated reason is that a visible-by-default
   worker whose `setWants` throws *"has no exit but account deletion"*. Per-skill toggles do
   not fully answer that: a worker with eight derived rows would tap eight times, and a
   partial failure leaves him half-visible. One call clears them all, because the exit has to
   be as easy as the entry was.
5. **Add `employer_sharing` to the purposes the worker app requests.** It requests exactly
   three today — `profiling`, `resume_generation`, `voice_processing`
   ([apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart:52-56](../../apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart)).
   **No client requests `employer_sharing`, so every worker in production has it false.**
6. **The DPDP notice copy, and a `CURRENT_CONSENT_VERSION` bump with it.** This is the gate,
   and the precedent is written into the code: `voice_processing` was *"added 2026-08-28
   (#1270, approved in #1269) alongside the DPDP voice notice copy landing in
   `consent_screen.dart` — the purpose is only requested once the worker has actually been
   shown what it means"* (same file, `:49-51`). **A builder cannot write this copy.**

**The consequence, stated plainly, because it decides the whole chain's order.** Until (5)
and (6) land, a consent-gated candidate search returns **zero rows for every worker on any
database** — not few, zero. R-E3's "E4 ships before E2" is therefore not a courtesy to
workers; without it E2 has nothing to show. It is the correct order, and it is the only
order that works.

### (e) Does any candidate-search route exist? — **Verified: no.**

Method and controls are in §1/E2. The enumeration was exhaustive over
`apps/api/src/**/*.controller.ts`, not a keyword sample.

### (f) Migrating worker data from another project — **SCOPE ONLY**

Not a design. These are the questions that must be answered before anyone estimates it.

**A. Identity, and it is the hard one.** `workers.phone_hash` is a **keyed** HMAC-SHA256
over a server pepper, and it carries the uniqueness constraint
([packages/db/src/schema/worker.ts:33-35](../../packages/db/src/schema/worker.ts), `:42`,
unique index at `:100`). The name is encrypted with a non-deterministic scheme
([apps/api/src/common/pii-crypto.service.ts:26](../../apps/api/src/common/pii-crypto.service.ts)).
So: does the source project hold **raw phone numbers**? If it does, the migration is a
re-hash under our pepper and a re-encrypt — and the raw numbers exist in a file somewhere
for the duration, which is a DPDP handling question before it is an engineering one. If it
holds only its own hashes, **de-duplication against existing workers is impossible** and the
import is append-only with unavoidable duplicates.

**B. Consent has no import path, and cannot honestly have one.** `worker_consents` records
`consent_version`, `purposes`, `accepted_at`, `ip_hash`, `user_agent`
([packages/db/src/schema/worker.ts:117-129](../../packages/db/src/schema/worker.ts)). A
consent row asserts *this worker read this notice on this date*. Whatever the source
project's workers agreed to, it was not our notice. **Does an imported worker arrive with no
consent — and therefore invisible to every payer surface — or is there a re-consent flow?**
There is no third answer that is truthful. This question alone can decide whether the
migration is worth doing at all.

**C. Which supply representation is imported?** Three are possible and they are not
equivalent. (i) `worker_profiles` — the retiring engine's shape; importing into it feeds
nothing under ADR-0036. (ii) `worker_skill` + `worker_industry_tenure` — the V1 shape, but
every skill must map onto the closed eighteen-value vocabulary, and *"Letting an LLM produce
canonical IDs"* is a dead idea (`docs/agent/BUILD_RULES.md:15`), so the map is human work.
(iii) `worker_attributes` — requires the source's fields to map onto the 137 authored
`target_field` keys. **The mapping table is the deliverable, and nobody has drafted one.**

**D. What is the source's role vocabulary, and who maps it?** This repository already
carries four disagreeing role lists — `TRADE_KEYS` (15), `MATCH_SKILLS` (18),
`ROLE_FORM_DESCRIPTORS` (5, at
[apps/api/src/profiling/roles/role-registry.ts:39-45](../../apps/api/src/profiling/roles/role-registry.ts))
and the payer Flutter app's hardcoded six (parked as P-013). A fifth arriving from outside,
mapped by anyone but RVM, is how a wrong `skill_id` becomes permanent — and `skill_id`s are
permanent by declaration
([packages/taxonomy/src/match-skills.ts:54-56](../../packages/taxonomy/src/match-skills.ts)).

**E. Résumés, and the thing that makes them not optional.** A résumé here is generated from
an interview this platform ran. An imported worker has no transcript, so the fabrication and
transcript-veto gates have nothing to check against
(`apps/api/src/resume/resume-fabrication.gate.test.ts`,
`apps/api/src/resume/resume-transcript-veto.ts`). **Do imported workers get no résumé until
they complete a form here?** If so they are unsellable on the flow you described, because
step 5 ends in a résumé.

**F. Erasure and provenance.** Every PII-adjacent table already carries a DSAR posture
(`onDelete: "set null"` on `unlocks` and `resume_disclosures`). An imported worker's DSAR
request must be answerable **including at the source**. Is there a `source_system` /
`source_worker_id` provenance column, or is the origin lost on import? Nothing in the
current schema records it.

**G. The unknown that gates the estimate.** Nobody has stated the **row count**, the
**source schema**, or the **legal basis for transfer**. Until those three exist the work
cannot be sized, only shaped — which is all this section does.

---

## 3. The filter parameter set

**The rule this section applies:** a filter is offered only when a column exists, a
*shipping* code path writes it, and its coverage is knowable. *A filter over an empty column
is worse than no filter* — and this repository already says so, in the worksheet's own cost
analysis of R7(a): *"A worker whose `controller` is simply unrecorded is indistinguishable
from one who does not match, so on a sparsely-filled attribute '14 of 62' understates the
real pool and reads as scarcity that is not there"*
([RVM_TAXONOMY_WORKSHEET_2026-09.md:786](RVM_TAXONOMY_WORKSHEET_2026-09.md)).

### 3.1 SHIP IN E2 — a real column, a real writer, a real index

| Filter | Column | Why it is safe |
|---|---|---|
| **Roles sought** | `worker_skill.skill_id`, with `wants` | The closed 18-value vocabulary, already served to the payer by `GET /payer/match/skills`. The index `worker_skill_reach_idx ON (skill_id) WHERE wants` ([packages/db/src/schema/match.ts:79-81](../../packages/db/src/schema/match.ts)) *is* this query. |
| **Skills** | the same column, a second parameter | See §3.4 — under ADR-0036 §3, "role" and "posted skill" are one vocabulary. One filter, two UI affordances; not two filters. |
| **Years of experience** | `worker_skill.months_bucketed` | A real integer with a non-negative CHECK ([packages/db/src/schema/match.ts:83](../../packages/db/src/schema/match.ts)). **Must be offered as buckets, never a free integer**: the column is bucketed to 6 months by config (`:50-52`), so a "4 years exactly" control would promise precision the data does not have. |
| **Industry** | `worker_skill.industry_id` | Denormalized onto the row *precisely so this filter needs no join* ([packages/db/src/schema/match.ts:46-48](../../packages/db/src/schema/match.ts)). |
| **Years in the industry** | `worker_industry_tenure.calendar_months` | PK `(worker_id, industry_id)` ([packages/db/src/schema/match.ts:100](../../packages/db/src/schema/match.ts)); interval-merged and E8-clamped, so it is honest about overlap. |

### 3.2 ALWAYS IN THE WHERE CLAUSE — never a payer-visible control

These are not filters. They are membership. R-E1's reorder-and-count must **not** apply to
them: a non-consenting worker does not "rank lower", he is not in the population.

| Predicate | Source | Authority |
|---|---|---|
| `employer_sharing` consent, not revoked | `worker_consents.purposes` / `revoked_at` ([packages/db/src/schema/worker.ts:125](../../packages/db/src/schema/worker.ts), `:129`) | ADR-0010; the same gate enforced at `apps/api/src/unlocks/unlocks.service.ts:71` |
| `wants = true` on the matched skill | `worker_skill.wants` | ADR-0036 §1 — half the visibility rule |
| not pending deletion | `workers.deletion_scheduled_at IS NULL` ([packages/db/src/schema/worker.ts:95](../../packages/db/src/schema/worker.ts)) | ADR-0031 payer-surface freeze, ruling (b) |

### 3.3 TOO SPARSE TO FILTER ON — measured, not assumed

| Named filter | What is actually there | The measurement |
|---|---|---|
| **Location** — your first-named filter | **`workers` has no city column at all.** The only worker-side location is `worker_profiles.location_preference`, an unindexed JSONB blob ([packages/db/src/schema/profile.ts:61](../../packages/db/src/schema/profile.ts)) | Its only writer is the extraction processor ([apps/api/src/profiles/profile-extraction.processor.ts:402](../../apps/api/src/profiles/profile-extraction.processor.ts), `:1347`). `current_city` is asked in **2 of 148** packs — `qp_universal` and `qp_universal@2` — and in **none** of the five packs the shipping roles use (`qp_cnc_turning`, `qp_vmc_milling`, `qp_cnc_grinding`, `qp_cam_programming`, `qp_cad_drafting`; declared at [apps/api/src/profiling/roles/cnc-turner.role.ts:14](../../apps/api/src/profiling/roles/cnc-turner.role.ts) and its four siblings). **A trade-form worker has no stored city by any path.** |
| **Expected salary** | `worker_profiles.salary_expectation` JSONB, same writer | `salary_expected` is likewise `qp_universal`-only |
| **Availability / notice period** | `worker_profiles.availability` JSONB, same writer | same |
| **Shift preference** | no column | `shift_preference` is `qp_universal`-only |
| **Last worked / currently working** | `worker_skill.started_at` / `ended_at` | Both are **NULL at launch by design** — *"COARSE history — no per-job stints yet"* ([packages/db/src/schema/match.ts:54-56](../../packages/db/src/schema/match.ts)). A filter here matches nobody, always. |
| **Worker activity** | no per-worker column | `worker_devices.last_seen_at` ([packages/db/src/schema/worker.ts:177](../../packages/db/src/schema/worker.ts)) is the only candidate; it is per **device**, so it needs a `MAX()` aggregate and has no supporting index. CLAUDE.md §2.4 calls engagement a first-class ranking signal; the schema does not yet carry it as one. |
| **Trade attributes** (controller brand, night work, forklift…) | `worker_attributes` — and the index already exists: `wa_key_bool_idx ON (attribute_key, value_bool)`, whose docblock reads *"the matcher's read is 'which workers have attribute X with value Y'"* ([packages/db/src/schema/profiling.ts:132-136](../../packages/db/src/schema/profiling.ts)) | **Blocked, not sparse in principle.** ADR-0036:65 says attributes are *"shown on the card, never matched, never ranked"* — in direct tension with that index's stated purpose. **R7 is the ruling, and R-E1 settles it.** Coverage remains the real problem: 137 distinct `target_field` keys across 148 packs, of which 5 packs ship. See §3.5. |

**The location finding, stated as a decision rather than a fact.** Giving a trade-form
worker a city requires adding a question to the trade form — and the trade form question
flow is on this session's DO NOT TOUCH list. So **location cannot be delivered by E2 as
specified, by any route available to a builder.** E2 is briefed to ship without it and to
label its absence on the screen rather than render a control that filters on nothing.

**Owner ruling, 2026-09-05: ship E2 without it; the trade-form boundary holds.** What filling
it would actually require — and why "add a column and backfill it" is not the fix, because the
missing piece is the QUESTION rather than the column — is parked at `PARKED.md` **P-018**, so
that the next person does not rediscover it.

### 3.4 "Roles sought" and "skills" are one axis, not two

ADR-0036 §3 is explicit: *"V1's 'Skill' is what a company posts a job for (CNC Turner, VMC
Operator) — role-level"*, while the operation-level corpus (turning, Fanuc, GD&T) *"is
exactly what V1 calls an **Attribute**"*. So your two named filters map to:

- **roles sought** and **skills** → the same `mskill_*` axis (§3.1); and
- the *other* reading of "skills" — operation-level attributes → §3.5, R7 territory.

E2 is briefed for the first reading, because it is the one the schema serves today. If the
second was meant, that is Q5, and it roughly doubles E2.

### 3.5 Additions I argue for, each from what the schema serves today

1. **Match tier — posted skill versus related skill — when the search is scoped to a
   posting.** Free: `job_reach.match_tier` is already materialized and already surfaced with
   the E18 badge ([apps/api/src/match/match-candidates.service.ts:22-27](../../apps/api/src/match/match-candidates.service.ts)).
   Argued because a payer who opted into curated breadth should be able to see the narrow
   set again without editing the posting.
2. **Skill count** — how many of the payer's posted skills a worker holds. Free: a `COUNT`
   over rows already being read. Argued because it is the most honest "how good a fit" number
   available and it needs no new column, no new writer and no ruling.
3. **Attribute facets — as ORDERING only, and only with coverage shown.** Legal the moment
   R7(a) is signed. Two hard conditions, both carried into the ADR: a facet is offered only
   for an attribute the searched role's pack actually asks, and the badge shows the
   **unrecorded** count beside the match count — *"14 match · 9 unrecorded · of 62"*. Without
   that third number the badge lies in exactly the way the worksheet predicted.
4. **NOT recommended: distance or radius.** No coordinate exists on the worker side and
   `job_reach` has no radius concept. A radius filter would have to invent its own geography.

### 3.6 The null-safety rule, and the precedent that already ships

Every filter must treat *unrecorded* as *not excluded*. This is not a new invention — the V1
worker feed already does it, and the pattern is copy-ready:

```sql
AND (:city::text IS NULL OR jp.city IS NULL OR lower(jp.city) = lower(:city::text))
```

[apps/api/src/match/match-feed.repository.ts:152-155](../../apps/api/src/match/match-feed.repository.ts),
with its reason stated at `:150-152`: *"Each is INERT unless he supplied it, and a NULL
column on the posting never excludes it: a job with no city/shift/pay band matches every
filter rather than vanishing from a feed it belongs in."* E2 applies the same rule in the
other direction, for workers.

---

## 4. What each phase owes, in one line

| Phase | Category | Ships |
|---|---|---|
| **E0** (first — owner ruling 2026-09-05) | NOT BUILT | The relay resolves. A `relay_handle` currently dials nothing (`RESUME_DISCLOSURE_DECISION_2026-09.md` §1b), so a credit buys an entitlement and a dead string. Item 0 of that brief — correcting payer-web's live-and-false *"Use it in-app to reach the candidate"* — ships **separately and immediately**, ahead of the rest. |
| **E4** (then, per R-E3) | PARTLY BUILT / gated | `setWants` implemented and reconciling `job_reach`; a worker endpoint; a clear-all affordance; a Frontend issue for the UI; `employer_sharing` requested **only once the notice copy exists** |
| **E1** | PARTLY BUILT | One call carries pay, city, shift, needed-by and the experience window to the row; role-scoped skills served from the server; the client `TRADE_KEYS` constant retired in favour of the served vocabulary |
| **E2** | NOT BUILT | `POST /payer/candidates/search` — masked, pseudonymised, paginated; consent and `wants` **in the WHERE clause**; R-E1 ordering; sourced from `worker_skill`, never from `worker_profiles` |
| **E3** | ALREADY BUILT (re-point) | The existing credits, unlock and résumé surfaces beside the search results. **No new billing object.** |

---

## 5. Recommendation on P0–P12

**Close the chain formally. Do not leave it in the repository as a second, contradictory
plan.** Four grounds, in increasing order of force.

1. **Its entry gate is red.** `docs/qa/evidence/P0/VERDICT.md` line 1 is `FAIL`, and
   `docs/agent/README.md:47` says *"Did the last VERDICT.md say PASS? If not, do not start
   the next phase."* On the repository's own rule, **no phase in either chain may start
   today.**
2. **Its entry gate is now red for a reason that is correct.** P0's invariant is *"the
   worksheet contains zero decisions"*, and check item 3 is *"Confirm every VERDICT and
   signature column is empty"* (`docs/agent/phases/P0_CHECK.md:2`, `:9`). You **signed** R1
   and R4-d on 2026-09-05. A worksheet that accumulates signatures is the worksheet working;
   a gate that fails because of it is a gate measuring the wrong world. PR #1424 already
   carries the STATUS correction — cited here, not restated.
3. **The chain contradicts itself exactly where it meets the E-chain.** `P5_BUILD.md` **is**
   R7 option (a), and it is HALTed because R7 is unsigned. **E2 is also R7 option (a)**,
   ruled by you as R-E1. Two live briefs for one deliverable, one blocked and one proceeding,
   is the precise condition that produced the 67 errors: a builder follows whichever file
   they opened.
4. **Ten of eleven briefs were recorded as containing false statements about this codebase**
   ([PHASE_SURVEY_2026-09.md](PHASE_SURVEY_2026-09.md)). Rewriting them (#1416) fixed the
   statements; it did not make the plan correct, because the plan is the wrong plan rather
   than a mis-ordered one.

**Owner ruling, 2026-09-05: CLOSE THEM FORMALLY, in this PR.** Done — every `P*_BUILD.md`
and `P*_CHECK.md` now carries a closure block at the top, in the form `P4_BUILD.md` already
used, naming what no E-phase covers. The files are NOT deleted: the survey's value is that it
can be diffed against them.

### CORRECTION TO THIS DOCUMENT — it said three phases; it is nine. That was my error.

The paragraph that stood here named **P1, P3 and P9**. **That was wrong, it was mine, and the
cause was a partial read** — four of the fourteen brief pairs, generalised to all fourteen.
It erred in the direction that loses work, which is the expensive direction. Recorded here in
full so the count is not re-litigated later: **nine, not three**, and the six that were
refuted are listed nowhere precisely so they cannot creep back.

A full pass over all twenty-eight briefs produced twenty-two candidate survivors. Each was
then attacked on three lenses — *it already ships* / *an E-phase covers it* / *a signed ruling
already deleted it* — with instructions to refute rather than confirm. **Six were refuted and
are deliberately not listed anywhere.** Sixteen survived, across **nine** phases:

| Phase | Survives | The one that matters most |
|---|---|---|
| **P1** | 3 | The `matching_catalog` table, the publish-time validator (its INVARIANT), and taxonomy-as-published-config. Built on `origin/p1-matching-catalog` (a454fac0) — whose PR **#1387 is CLOSED and unmerged**, 2026-09-04. |
| **P2** | 1 | `tier-parity.test.ts`, pinning the three SQL writers of `job_reach.match_tier` to `matchTierFor`. The duplication is deliberate; the test keeping the copies honest was never written. |
| **P3** | 1 | The four `function` / `collar_tier` columns and their no-backfill guard, still gated on R1. |
| **P5** | 1 | The attribute **facet** as running code. ADR-0040 Decision 7 now *permits* it; `E2_BUILD.md` puts *building* it out of scope. The ruling is covered; the build is not. |
| **P6** | 2 | The `weekly_payers` cap-pinning test, and boost supply eligibility resolved at the **offer** rather than at purchase (where it also fails **open**). |
| **P8** | 3 | The disposition of `payer_form_drafts` — closing P8 leaves a **signed ADR-0035 amendment pointing at a dead brief**. Plus optimistic concurrency for the chat draft, and the checkpoint table. |
| **P9** | 3 | **The verification visibility gate.** Ruled by you as a GATE on 2026-09-04, still unbuilt, and no E-phase touches verification. Also: `POST /job-postings/:id/verify` is reachable from no human surface. |
| **P11** | 1 | The posting-chat provenance gate — every value written into a draft must be a literal substring of the message the model saw. |
| **P12** | 1 | The in-app-purchase dependency guard test. The invariant holds by convention; nothing enforces it. |

**P0, P4, P7, P10 and PX close clean** — every deliverable is shipped, deleted by a signed
ruling, or carried by an E-phase.

### Two of the nine are NOT closed — owner rulings, 2026-09-05

**P9 — REOPENED, standalone, sequenced after E4.** Closing it would have dropped a trust
property by filing error: it was swept up because no E-phase covers it, which is a fact about
the E-chain rather than a judgement about P9. Its ruling is already signed, the gate is
unbuilt, and an unverified posting is visible to every worker today. It does not compete with
the E-chain for scope — it competes for sequence.

**P8 — REOPENED, standalone.** A signed decision may not be left pointing at a dead brief.
The owner offered two ways out: keep P8 open as the amendment's home, or write the
amendment's retirement into ADR-0035. **I chose to keep P8 open**, for three reasons, in
increasing order of force: retiring the amendment does not rehome P8's other two survivors;
it would trade a dangling pointer for a dangling table, since `payer_form_drafts` is real,
shipped, unclaimed, and ADR-0035's own §Consequences asks that such a table "be reconsidered
rather than left as speculative surface"; and the brief is not stale — #1416 rewrote it
against ADR-0036, its store question is RULED and its Half A is buildable. Retiring the
amendment remains available, but it is then an ADR supersede *and* a disposition of the
table, not a one-line edit.

**So seven of the nine close as briefed; two reopen.** Neither reopened phase is part of the
E-chain, and neither blocks it.

### One thing that closing P0 does NOT do

`docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md` stays **live**. R1 and R4-d are signed, six
rulings are still open, and R7's blank slot at `:794` is E2's gate. Closing P0 retires the
**brief**, not the worksheet. Each P0 file says so in its own closure block.

**One thing to fix in the same act, because it is a live false PASS.** `P5_CHECK.md:18` on
`main` reads `sed -n '774p' …RVM_TAXONOMY_WORKSHEET_2026-09.md` and calls a blank line proof
that R7 is open. Line 774 of the worksheet is `### The question` — prose. The signature slot
moved to `:794` when #1423 landed the R1 and R4-d signatures. So when you sign R7, **that
check cannot observe it**: it will certify R7 as open forever. The repoint is already
committed as `d79f22f3` on the open PR **#1425**, and is deliberately not duplicated on this
branch, which would only create a conflict. **Merge #1425, or the P5 check goes on lying in
the one direction nobody investigates** (PARKED.md, P-016).

---

## 6. Ruling coverage — which brief implements which ruling

| Ruling | Implemented by | Where it is written down |
|---|---|---|
| **R-E1** reorder-and-count by default; opt-in strict; **the count renders before the narrowed list** | **E2** | [ADR-0040](0040-candidate-search-filter-behaviour.md) Decisions 1–5; `E2_BUILD.md` build items 3, 4 and 5; `E2_CHECK.md` **item 6**, which exercises the zero-match case explicitly — "0 of 62 match" appearing *before* an empty list is the whole point of the ruling, and it is the clause most likely to be dropped as cosmetic. (E2's INVARIANT is the consent gate, not this: a leaked worker is unrecoverable, a missing count is not.) |
| **R-E2** `wants` defaults true | **E4** guards it; it is already true at HEAD | `packages/db/src/schema/match.ts:59`; `E4_CHECK.md` item 1 FAILs on any change to that default |
| **R-E3** E4 ships before E2 | Brief order, plus a hard gate | `E2_BUILD.md` STATUS refuses to start until E4's endpoint exists; `E2_CHECK.md` item 2 checks for it and FAILs if E2 shipped first |
| **R-E4** no E-phase can prove itself against real supply | **All four** | Every `E*_CHECK.md` carries the seeded-data sentence **in its own text**, not in a footnote, and every item that would need live rows is recorded NOT EXECUTABLE rather than as a PASS |

---

## 7. Questions

1. **`trade_key` on `job_postings` — mint it, or is the match skill the role?** ADR-0036 §3
   says the posted match skill *is* the role. Adding `trade_key` gives one posting two role
   vocabularies. **I recommend not adding it**, and E1 is briefed that way with the question
   on its STATUS line. Reversing this adds a migration plus a `TRADE_KEYS` (15) →
   `MATCH_SKILLS` (18) mapping that nobody has drafted.
2. **Location — ship E2 without it, or open the trade form?** There is no worker city column,
   and the only question that would produce one lives in `qp_universal`, outside the five
   shipping packs. Adding it means editing the trade form question flow, which this session
   was told not to touch. E2 is briefed to ship without a location filter and to label its
   absence.
3. **What does a credit buy?** Today: a routed contact (ADR-0010), with the résumé free and
   masked (ADR-0013 C.3). Your flow says a credit unlocks the full profile and the résumé.
   That is an amendment to two signed ADRs plus a §2 unmasking call. E3 is briefed to the
   **shipped** meaning and HALTs on the change.
4. **The `reason`-string leak on the legacy applicants route.** Exact experience years, an
   exact salary-expectation ratio and a distance in kilometres reach the payer for a masked
   worker, today, on a live route
   ([packages/reach-engine/src/scoring.ts:199](../../packages/reach-engine/src/scoring.ts),
   `:213`). E2 neither inherits nor fixes it. **Park it, or fix it now as its own change?**
5. **"Skills" — the eighteen match skills, or the operation-level attributes?** E2 is briefed
   for the first. The second is R7 territory and roughly doubles the phase.
6. **Sign R7 at `docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:794`** — or have ADR-0040
   carry it and point the worksheet at the ADR. R-E1 settles R7; while that slot is blank,
   `P5_BUILD.md:1` stays HALTed on a question you have already answered, and any builder
   implementing E2 is settling an open ruling, which `docs/agent/BUILD_RULES.md:31` makes a
   full stop.
7. **PR #1425 (M1) is E2's supply.** On `main` today the only caller of `rebuildQuietly` is
   the extraction processor
   ([apps/api/src/profiles/profile-extraction.processor.ts:501](../../apps/api/src/profiles/profile-extraction.processor.ts)),
   and the trade-form handover switches extraction off — so **a completed trade form derives
   zero `worker_skill` rows on main**. Until #1425 lands, E2's result set is empty for form
   workers regardless of consent, filters or ordering. Is #1425 a prerequisite of E2, or does
   E2 build and wait?
