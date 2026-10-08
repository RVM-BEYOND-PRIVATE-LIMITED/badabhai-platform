# ADR-0047: The PII restriction is lifted — model-prompt masking becomes one switch

- **Status:** **Accepted — signed 2026-10-01** (see the foot). Owner decision of 2026-09-30, relayed by Divyanshu
  Pant (Backend Platform). The owner instructed a direct merge of the implementing change (#1870); the signature was
  recorded after it. The switch
  defaults **off** in code. The output-side gaps the implementing change measured are decided and closed in the same
  change (§6, G1 and G2). Arming it in production is the `production` secret plus a redeploy (§5). **The secret
  already reads `true`, so merging the implementing change arms production** on the deploy that follows. A
  `security-engineer` review of that change ran before the merge (§8).
- **Date:** 2026-09-30
- **Owner:** CEO / Prakash (decision relayed by Divyanshu Pant, Backend Platform)
- **Amends:** [CLAUDE.md](../../CLAUDE.md) §3 _Privacy First_, §11 _Remove PII_ and §14 _Privacy maintained_ ·
  [ADR-0001](0001-mvp-infra-decision.md) D5 · [ADR-0008](0008-litellm-to-direct-providers.md) _Invariants held_ ·
  [ADR-0041](0041-resume-import-and-prefill.md) §3.2 (_"No other route's masking changes in any way"_) and the
  traced-text condition of §3.3 · [ADR-0046](0046-chat-companion-v2-llm-task-router.md) O13, O17 and §3 _Privacy_ ·
  [ADR-0039](0039-work-history-polish-section-8-override.md) _Privacy_ (the input half) ·
  [ADR-0030](0030-embedding-skill-canonicalization.md) SG-1 (its premise). Each is set out in §7.
- **Relates:** [ADR-0048](0048-chat-identity-intake.md) (#1858, the identity intake in the chat — §7) ·
  [ADR-0025](0025-admin-ops-portal.md) (a PII→LLM path is never an admin-portal toggle — honoured) ·
  [RESUME_DISCLOSURE_DECISION_2026-09](RESUME_DISCLOSURE_DECISION_2026-09.md) and
  [ADR-0004](0004-pii-at-rest-and-rls.md) (unchanged) · [ADR-0018](0018-model-training-corpus-and-finetune.md) (the
  training corpus stays de-identified)
- **Flag:** `AI_RAW_PII_ENABLED` (read by both the api and the ai-service; default off; a GitHub `production`
  environment secret)

---

## 1. Context

CLAUDE.md §3 said raw PII must never appear in LLM prompts, logs, events, audit records or analytics, and that only
pseudonymized data may cross an AI boundary. Two things had already moved away from that text:

- **ADR-0041 D5** sends an uploaded résumé to the model unmasked, behind `RESUME_PARSE_RAW_TEXT_ENABLED` — armed in
  alpha since 2026-09-22.
- **The gateway does not stop a bare name.** Name detection is cue-based, so a worker's un-cued name already reaches
  Gemini and Anthropic (R32, accepted by the owner 2026-08-01). Meanwhile masking costs the model real vocabulary
  (`Vernier` → `[PERSON_1]`, ADR-0041 §11) and makes companion v2 drop every edit whose value came back masked
  (ADR-0046 O17).

ADR-0046 O17 recorded the owner's intent to remove masking platform-wide and said it needs its own ADR, a security
review and a CLAUDE.md §3 update. This is that ADR.

**Where masking lives in code.** Only the AI path actively masks. The ai-service masks text on its way into a model
prompt (`pseudonymize()` and the `parse_masking` maskers, called per route) and re-masks every traced value for
Langfuse and `ai_call_traces`. The api masks in two places in front of a model: companion v2's `/pseudonymize` hop and
profile extraction's `redactKnownName`. Logs, events, audit records and analytics have **no masking code at all** —
events are closed `.strict()` schemas carrying ids, counts and enums, and the loggers log ids. So the code half of this
decision is one switch, and the rest of it is policy.

## 2. Decision

| #      | Decision                                                                                                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | **The ban is lifted, for now** (owner, 2026-09-30). Raw PII MAY appear in LLM prompts, logs, events, audit records and analytics.                                                                                                                                                                        |
| **L2** | **One reversible switch for the code:** `AI_RAW_PII_ENABLED`, one env var read by both services, default **off**. Off, every prompt is masked as today; the G1 and G2 floors read no flag and hold either way.                                                                                           |
| **L3** | **On, text reaches model prompts and AI traces unmasked** (§3), except the worker's own name on the three api paths G2 names, **and companion v2's Redis memory holds raw turns** (TTL-bound, §3) — a persisted copy, named here so the decision covers it (§8). Nothing else in code moves on the flag. |
| **L4** | **Logs, events, audit records and analytics are lifted as policy only.** They have no masking code to switch. No event schema is mutated, and this decision adds PII to no sink by itself.                                                                                                               |
| **L5** | **Everything in §4 stays**, whatever the flag says.                                                                                                                                                                                                                                                      |
| **L6** | **Arming and rollback are the environment secret plus a redeploy** (§5) — never a commit, never the admin portal.                                                                                                                                                                                        |
| **G1** | **A hard-identifier output floor that reads no flag** (owner, 2026-09-30; §6). A model-written value that carries a phone, PAN, Aadhaar, email or credential ID is dropped at the four measured gaps and the three outputs found by probing armed.                                                       |
| **G2** | **Profile extraction, the classic interview turn and the skills stage run `redactKnownName` whatever the flag says** (owner, 2026-09-30; §6). None of those models needs the worker's own name.                                                                                                          |

The owner named no end date and no reversal trigger for "for now", and none is invented here. Reversing it is §5's
rollback for the code, and a new ADR (or an amendment to this one) for the policy.

## 3. The switch, exactly

**ai-service** — `ai_raw_pii_enabled: bool = False` in `apps/ai-service/app/config.py`, beside
`resume_parse_raw_text_enabled`.

- **One shared input-policy module**, `apps/ai-service/app/llm_input_policy.py`, generalises
  `resume_import/parse_policy.input_masker` and `profiling/parse_masking.passthrough_masker`. Its gate and its
  per-line masker take a **keyword-only `raw` argument that the route passes explicitly from its settings** — never
  read off a settings singleton inside the policy, so the security question "who can turn masking off, and from where"
  keeps the answer "the route that calls it".
- **Every prompt-side input masking call site** goes through that module. "Prompt-side" means text on its way into a
  model call and used for nothing else; a call site whose masked text is also stored is not prompt-side (§4). The
  switched sites are the interview turn (message and history), Phase C extraction, `/profile/extract` and
  `/profile/parse`, the work-history polish input, résumé generation, companion v2's three tasks, and the voice
  translate leg. `apps/ai-service/tests/test_llm_input_policy.py` lists them.
- **The résumé import routes** pass `raw = settings.resume_parse_raw_text_enabled or settings.ai_raw_pii_enabled` into
  D5's own pass-through, exactly as D5 alone always has. `RESUME_PARSE_RAW_TEXT_ENABLED` stays its own flag, so
  ADR-0041's posture can be rolled back on its own.
- **On, the new pass-through keeps the size caps** — 20,000 characters per message, 4,000 per transcript line — **and
  still rejects non-string input.** Those bound cost and denial of service, not PII; a refused input reads exactly as
  the gateway's own refusal.
- **The traces follow the flag.** Langfuse's `mask=` hook and `masked_trace_text` (the `ai_call_traces` text) both
  take their hook from `trace_mask(raw=...)` in `app/ai/langfuse_tracing.py`, with `raw` read by whoever builds the
  sink. On, it passes values through; off, it is `_mask`, unchanged. One hook for both, so the two sinks can never
  disagree about what was sent — and the flag moves the provider and the trace together.
  `RESUME_PARSE_RAW_TEXT_ENABLED` alone never unmasks a trace.

**api** — `AI_RAW_PII_ENABLED: booleanFromString` (default false) in `packages/config/src/server.ts`.

- **Companion v2** does not call `/pseudonymize` before its model tasks; it sends the worker's text as typed. Its Redis
  memory then holds raw text — still Redis only, still trimmed to the last `CHAT_COMPANION_V2_MEMORY_TURNS` turns,
  still expiring on `CHAT_COMPANION_V2_MEMORY_TTL_SECONDS` (1,800 s). Never Postgres. That memory is a persisted copy
  ADR-0046 O13 required masked; unmasking it is part of L3, not a side effect. The alternative — prompt raw, remember
  masked — keeps a `/pseudonymize` hop on every armed turn and was not taken. An edit row whose value carries a hard
  identifier is dropped by the api as well as by the ai-service (G1, §6).
- **The worker's own name is not switched.** `redactKnownName` runs whatever the flag says (G2, §6) on profile
  extraction's transcript, on the `/profile/parse` call's copy of the answer map (whose records carry the worker's
  words: `value_raw`, `value_normalized`, the correction history and the evidence quotes), and on the message and
  history that both `/profiling/turn` callers send — the classic interview turn (`LlmTurnService`) and the general
  road's skills stage (`SkillsTurnService`) — so none of those prompts carries the worker's own name.

**Conditions the implementing change meets** (the discipline of ADR-0041 §3.3):

- Default off in both services, and every existing test passes unchanged with it off.
- Per switched route, a test that the text is masked with the flag off and raw with it on.
- A test that `pseudonymize()` and every output wall return the same result whichever way the flag is set.
- The four gap tests in `apps/ai-service/tests/test_llm_input_policy.py` §6 pass with the flag armed — first written
  as strict xfails, now plain tests (G1) — as do the tests for the three outputs found by probing armed, and the
  api's own drop of a companion edit row carrying a hard identifier (`companion-edit.validate.test.ts`); and
  extraction, the classic interview turn and the skills stage redact the known name with the flag on (G2).
- A `security-engineer` review before merge (§8). The merge arms production while the secret reads `true` (§5), so
  that review is the last check before arming.

## 4. What does NOT change

These never read the flag:

- **`pseudonymize()` itself.** It also backs the output walls, the occupation growth queue and the training corpus; a
  switch inside it would disable all three.
- **Every output and storage wall** — `certify*` / `certified_*`, `contains_hard_identifier`, gate 6 and
  `resume_value_certifier`, the placeholder refusals. AI output stays untrusted and is validated before anything stores,
  shows or emits it (CLAUDE.md §11). None of them takes a policy argument. Written against masked input, they did not
  stop an echo of what the worker typed once the model reads it raw, so the same change adds the G1 floor under them —
  which reads no flag either (§6).
- **`redactKnownName`** in profile extraction, the classic interview turn and the skills stage (G2, §6).
- **Persisted masked copies** — the payer job-posting chat's draft text; the occupation growth queue
  (`unresolved_phrase`, fed through `/privacy/pseudonymize` by `apps/api/src/profiling/identify.service.ts`); the
  training corpus (`apps/ai-service/app/corpus/deidentify.py`, ADR-0018).
- **Embedding inputs** (ADR-0030 SG-2). An embedding is not a prompt.
- **PII encryption at rest** — `workers.full_name` and `workers.phone_e164` stay AES-256-GCM (ADR-0004), as do the payer
  contact and agency KYC columns.
- **Employer-side disclosure masking** — the masked profile until a credit unlock, the name as initials on the employer
  copy (RESUME_DISCLOSURE_DECISION_2026-09). A monetization and disclosure rule, not a rule about the model. Unchanged
  in code, and G2 keeps the worker's own name out of the two model paths measured to reach that copy — extraction and
  the interview turn whose `role_label` becomes `primary_role` — whatever the flag says (§6).
- **Consent** — `ConsentGuard` before any profiling or AI processing, the append-only `worker_consents` ledger. No
  consent version bump and no new purpose.
- **Event schemas** — none is mutated. PII in an event means a **new versioned event**, never a changed one (CLAUDE.md
  §3 _Backward Compatibility_). The loggers are unchanged.
- **Secrets and credentials are never logged** — not in a log, an event, a trace or an error message.
- **STT** — audio goes to Sarvam exactly as before; it could never be masked.
- **The real-call gates** — `AI_ENABLE_REAL_CALLS`, the per-task allow-list, the spend caps and
  `AI_REAL_CALLS_KILL_SWITCH`. Arming this flag sends nothing to a provider that those gates would not already send.
- **AI never decides** (CLAUDE.md §3), and ADR-0035 §3's payer org name is still never asked for, so it reaches no
  prompt either way.

## 5. Arming and rollback

**Merging is arming.** The owner decided on 2026-09-30 and instructed a direct merge of the implementing change. The
`production` secret already reads `true` (created 2026-09-30; a secret's value cannot be read back, so it is treated as
`true`), and the deploy job exports it on every run, so the first deploy after the merge arms production. G1 and G2
(§6) ship in that change, and a `security-engineer` review of it ran before the merge (§8). The change merged as #1870
and armed production on 2026-10-01; the signature on the foot was recorded the same day, ratifying the decision
([production-release-runbook.md](../ops/production-release-runbook.md) P0 #13).

**Recommended owner follow-ups, not gates** (the decision accepts the §6 consequences as they stand): sign the Gemini
and Anthropic DPAs, or re-waive in writing for raw identity data; record Langfuse as a processor with its retention
terms; confirm Sarvam's terms cover the translate leg's raw transcript; the DPDP notice copy (R4).

**Arm:** the `production` secret plus a redeploy — `gh secret set AI_RAW_PII_ENABLED --env production --body true`,
then re-run the deploy. The secret side is already done, so the merge's own deploy is the redeploy. The
`deploy-lightsail` job in `.github/workflows/ci.yml` bridges it (its `env:` block and the appleboy `envs:` list), and
`docker-compose.staging.yml` declares `AI_RAW_PII_ENABLED: ${AI_RAW_PII_ENABLED:-false}` on both the `api` and the
`ai-service` service. Accepted values are `true`, `false`, `1`, `0` or empty; unset or empty resolves to off.

**A value the api cannot parse fails the deploy, not the api.** The secret cannot be read back, and the deploy
recreates the ai-service before it replaces the api, with no automatic rollback. The api's parser throws at boot on
anything outside that list, where pydantic's own bool would also read `True`, `yes` or `on` — so a mis-typed secret
could have booted the ai-service armed and crash-looped the api. Three things close it: the ai-service narrows the field
to the api's grammar, so the two boot or refuse together; `scripts/deploy/staging-deploy.sh` checks the value before
any prune, pull or recreate and fails the job with every running container untouched; and re-setting the secret to the
literal (`gh secret set AI_RAW_PII_ENABLED --env production --body true`) just before the merge removes the one way
that check can turn the merge's own deploy red.

**One arming path.** The bridge exports the secret on every deploy, and a bridged value takes precedence over the box's
`.env` (ADR-0041 §3.2), so the box file is not an arming path for this flag. This deliberately differs from
`RESUME_PARSE_RAW_TEXT_ENABLED`, which is armed in the box `.env` and never bridged (ADR-0041 §3.2); the two stay
separate flags.

**Verify:** after the redeploy, the deploy job is green (its preflight and both services' health gates passed), the
ai-service's boot log carries the `AI_RAW_PII_ENABLED is ON` warning, one interview turn's Langfuse trace shows the
worker's text unmasked except their own name, which reads `[NAME]` (G2), and no event payload carries text. If the
api is unhealthy, set the secret to `false` and re-run the deploy.

**Roll back:** `gh secret set AI_RAW_PII_ENABLED --env production --body false` (or delete the secret), then re-run
the deploy. Prompts are masked again from the next call. **Nothing already sent is recalled** — not from the model
providers and not from Langfuse. Two copies written while armed stay behind:

- **Companion v2's Redis memory.** Raw turns outlive the revert until newer turns trim them out or the TTL lapses
  after that worker's last turn; they are replayed masked meanwhile, so the residue is at rest only. For an immediate
  revert, delete the `companion:v2:mem:*` keys — a flush costs a worker a little context and nothing else.
- **`ai_call_traces` rows** (when `AI_CALL_TRACE_TEXT_ENABLED` was on) hold raw text and are kept indefinitely by
  owner ruling (`packages/db/src/schema/ai-trace.ts`), until the worker's erasure cascades them away.

**Emergency stop:** `AI_REAL_CALLS_KILL_SWITCH=true` cuts all provider traffic at once.

## 6. Consequences the owner accepts, and the two output floors

Stated plainly, because an ADR that hides its cost is useless (ADR-0041 §3). All are accepted by the owner's
decision; G1 and G2 are the ones the owner closed in code instead:

- **Langfuse Cloud receives raw prompts while the flag is armed.** Tracing is live in production (the `LANGFUSE_*`
  production secrets), and the compose default host is `us.cloud.langfuse.com` — US-hosted. No ADR records Langfuse as
  a processor, and account deletion does not reach its traces (observability-runbook §6.6).
- **Google (Gemini) and Anthropic process raw identity data**, not only pseudonymized text. The DPA waiver of
  2026-08-01 (runbook P0 #2) was argued on pseudonymized text; this decision accepts raw text on the same unsigned
  footing. Signing the DPAs, or re-waiving in writing for raw identity data, is a recommended follow-up (runbook
  P0 #13). Sarvam's translate leg receives the raw transcript too; it already hears the audio for STT (runbook P0 #1).
- **`ai_call_traces`** holds raw text when `AI_CALL_TRACE_TEXT_ENABLED` is also on — encrypted, super-admin only,
  kept indefinitely by owner ruling (so a row written while armed outlives a rollback, §5), and cascade-deleted with
  the worker, so erasure still reaches it. R47's retention question (its item 2) now concerns raw text, and R47 is
  **High** by its own condition ("High if the text were ever stored pre-boundary") whenever both flags are on.
- **The DPDP Act still applies:** consent before processing, and erasure on request. A new place PII is written must be
  reachable by the erasure path (account deletion), or the change that adds it names it as unreachable. Unreachable
  today: provider-side retention and Langfuse traces. The `events` and `audit_logs` spine survives account deletion
  _because_ it is PII-free (worker-account-deletion-runbook §1, §9), so an event version that carries PII ships with
  an erasure step for it or is named as retained PII.
- **Government identifiers ride too.** Aadhaar carries statutory handling constraints of its own (Aadhaar Act §29),
  recorded for the résumé at ADR-0041 §3.2. Armed, that concern covers every prompt.
- **The model sees what the worker typed, so it can echo it into a value it authors.** The implementing change
  measured two ways an echo got past the walls, and the owner decided both on 2026-09-30. Both are implemented in
  that change, so neither waits on arming:
  - **G1 — an echoed hard identifier: a floor that reads no flag.** Phase C's `_certified*` walls and the
    work-history polish wall (`pseudonymize(polished).blocked`) refused only what the gateway would _block_, and a
    phone is masked, not blocked; the classic `/profiling/turn` labels passed no wall in the ai-service at all; and
    `/profile/parse` certified the value but not the `evidence.quote` beside it. Armed, a phone or PAN the worker typed
    could be stored as an extracted value, settled into the answer map (apps/api reads the turn's `role_label` as
    `trade`), or printed on the sheet an employer reads (ADR-0039). **Decided:** a model-produced value that contains a
    hard identifier — phone, PAN, Aadhaar, email, credential ID (`contains_hard_identifier` / `HARD_IDENTIFIER_CLASSES`
    in `app/pseudonymize.py`) — is dropped from every stored or printed field at those four gaps. The floor reads no
    flag. Off, the model reads masked text, so it is a near no-op and the existing suites stay green; the four strict
    xfails in `apps/ai-service/tests/test_llm_input_policy.py` §6 are now passing tests.

    **Three more outputs, found by probing every switched route armed, take the same floor** — a tightening, recorded
    here for the owner's acknowledgement rather than a new decision: `/profile/extract`'s stored `rich_profile_draft`
    (floored inside `merge_model_draft`, so an echo is skipped like a malformed field and never deletes what the
    heuristic read); companion v2's edit rows (an employer name or `work_done` line is stored and printed once the
    worker confirms the card, and armed no placeholder is minted for O17's drop to catch — dropped by the ai-service's
    `parse_edit_rows` and again by the api's `containsHardIdentifier` gate); and the `/resume/generate` `summary`,
    which nothing renders yet.

    **Per field inside an experience, not per entry.** The phone class reads an honest dashed year range as a phone
    (measured: `"2018-2021 (3 years)"`, `"2010-2012, 2013-2016"`), and armed the model copies `duration_text` in the
    worker's words, so dropping the entry would erase the job. A `duration_text` or `work_done` that carries one is
    blanked; only an echoed `role_label` drops the entry. The cost that remains: a blanked `duration_text` with no
    `duration_months` beside it leaves apps/api nothing to parse months from, so that entry's years stay unsettled.

  - **G2 — the worker's own name: `redactKnownName` stays, and reaches the interview turns.** Skipping it in
    extraction under the flag let the model write the worker's full name into a role label, a summary line or
    experience text that lands in `worker_attributes` and on the employer copy before any unlock — and no wall checks
    extraction output for a bare name (the certifiers and gate 6 refuse hard identifiers only; ADR-0041 §3.3, ruled
    2026-09-11). **Decided:** `redactKnownName` runs in profile extraction whatever `AI_RAW_PII_ENABLED` says. The
    extraction model never needs the worker's own name, so extraction cannot carry it onto the initials-only employer
    copy. That covers everything extraction sends a model: the transcript in both shapes, and the `/profile/parse`
    call's answer map — its records hold the worker's words (`value_raw` is the whole message an answer came from, and
    a trade settled from the worker's words is stored verbatim as `value_normalized`), and the parse prompt renders
    them. The api's second wall still checks agreement against the unredacted map, so a model that echoes a redacted
    value is vetoed and the captured value stands.

    **The interview turns, decided the same day.** `LlmTurnService.take` sent the classic interview's message and
    history to `/profiling/turn` without `redactKnownName` — before this change as well, where the gateway catches only
    a cued name; the [risks register](../registers/risks-register.md)'s R32 residual (2) recommended redacting it. The
    turn's `role_label` settles into the answer map as `trade` (`settleFromLlmDraft` in `orchestrator.service.ts`),
    which extraction's `projectProfile` writes to the profile's `primary_role` — past the extraction input, and the G1
    floor stops a phone on that label, not a name. **Decided:** the classic interview turn and the general road's
    skills stage (`SkillsTurnService`, the other `/profiling/turn` caller) redact the known name from the outbound
    message and history whatever the flag says, as extraction does, and fail safe the same way: a name that cannot be
    read sends the turn as typed rather than failing it. Off, that is a tightening: an un-cued own name the gateway
    missed (R32) no longer reaches either prompt. Only the outbound copy is redacted; the stored transcript keeps what
    the worker typed.

    **What G2 does not reach.** Beyond those three paths and the `knownNamePattern` screens on the résumé and
    general-form briefs, no wall detects a bare name in model output, and armed, the other switched routes' models
    also read the names the gateway would have masked by cue. Nor does G2 reach a value no model wrote: a trade
    settled from the worker's own sentence is stored verbatim, so "main Ramesh hoon, CNC operator" is projected onto
    `primary_role` as typed, flag on or off. Both residuals are outside G2's scope and are recorded in the risks
    register.

- **The DPDP notice** does not name the model providers. That notice is still owed legal copy (R4), which engineering
  does not draft.
- **R30, R32 and TD3 are moot while armed** — each describes PII slipping past a masker that is then deliberately not
  masking. **TD56 (Paid) is inert while armed**: the state-name masking it added no longer runs on a prompt. With the
  flag off all four stand exactly as recorded.

## 7. What this amends, and #1858

The older documents are annotated where they are read as gates; their text is otherwise left as the record of its
date. From 2026-09-30 each clause below reads against this ADR.

| Document                                                   | Clause                                                                                   | Now                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [CLAUDE.md](../../CLAUDE.md)                               | §3 _Privacy First_                                                                       | Rewritten as _Privacy — PII restriction lifted (ADR-0047)_                                                                 |
| [CLAUDE.md](../../CLAUDE.md)                               | §11 "Remove PII"; §14 "Privacy maintained"                                               | "Apply the masking policy in force (ADR-0047)"; "Privacy policy (ADR-0047) followed"                                       |
| [ADR-0001](0001-mvp-infra-decision.md)                     | D5: the gateway is "mandatory before every LLM call"; identity data "never reach an LLM" | Prompt masking follows `AI_RAW_PII_ENABLED`; the gateway itself and its fail-closed paths are unchanged                    |
| [ADR-0008](0008-litellm-to-direct-providers.md)            | "no raw PII reaches any provider, event, `ai_jobs`, `audit_logs`, or logs"               | Lifted (L1); the other invariants in that sentence stand                                                                   |
| [ADR-0041](0041-resume-import-and-prefill.md)              | §3.2 "No other route's masking changes in any way"                                       | Other routes change when `AI_RAW_PII_ENABLED` is armed; D5 keeps its own flag                                              |
| [ADR-0041](0041-resume-import-and-prefill.md)              | §3.3 "traces are still pseudonymized"                                                    | Holds while `AI_RAW_PII_ENABLED` is off, whatever `RESUME_PARSE_RAW_TEXT_ENABLED` says; armed, traces carry raw text       |
| [ADR-0046](0046-chat-companion-v2-llm-task-router.md)      | O13 "Memory … pseudonymized"; §3 _Privacy_                                               | Prompts, memory and traces follow the switch; worker text in logs and events is unchanged in code                          |
| [ADR-0046](0046-chat-companion-v2-llm-task-router.md)      | O17                                                                                      | Settled by this ADR                                                                                                        |
| [ADR-0039](0039-work-history-polish-section-8-override.md) | "The input is pseudonymized before the model"                                            | The input follows the switch; the output is re-certified, and the G1 floor drops an echoed hard identifier (§6)            |
| [ADR-0030](0030-embedding-skill-canonicalization.md)       | SG-1's premise ("§2 #2 (no raw PII)")                                                    | The premise is lifted; the growth queue still stores pseudonymized text, and SG-2 (pseudonymize before embed) is unchanged |

Updated in the same change, because they are read as gates or runbooks: the security checklist, the PR template, the
agent specs under `.claude/agents/`, `docs/ai/pseudonymization.md`, the architecture overview, the environment
reference, the risks and tech-debt registers, the production-release, observability and account-deletion runbooks,
the companion v2 contracts and phase specs, and the places that restated the old rule as current (the root README,
`tests/security/README.md`, `.claude/project-memory.md`, `.claude/team-memory.md`, a `security-scan.yml` comment).
Historical reviews and audits (`docs/audit/`, `docs/ai/phase-1-ai-privacy-review.md`, `docs/reference/`) are records
of their date and are not rewritten; the phase-1 AI privacy review, which the security checklist cites, carries a
pointer here.

**#1858 does not depend on this ADR.** [ADR-0048](0048-chat-identity-intake.md)'s identity intake asks the name and
location in deterministic turns that keep them out of the model path, so it works with the switch off or on
([ADR-0048 §4](0048-chat-identity-intake.md#4-consequences), item 5). This ADR neither blocks it nor is required by
it.

## 8. Security review

O17 asked for one. A `security-engineer` review ran on the implementing change before the merge, because the merge
arms production (§5), against §3's conditions and §4's list. Its charter escalates any relaxation of privacy to a
human; this ADR is that escalation, decided by the owner. The gaps the implementing change measured were escalated
with it and the owner decided them the same day (§6, G1, and G2 with its interview-turn extension); the review
checked them as implemented, together with the three outputs the floor was extended to.

Security-engineer review (2026-09-30, before merge): **fix-then-ship → both majors fixed, then shipped.** The switch
does what L1–L6 decide. Flag off is byte-identical to today except the flag-independent G1 floor, the G2 own-name
redaction and a closed boolean on trace metadata; no schema, migration, event-schema or encryption-at-rest change, and
nothing new is logged beyond ids, counts and one boot WARNING. Flag on, every model output that can reach a stored or
printed field drops a phone, PAN, Aadhaar, email or credential ID. The two majors, both fixed before merge: G2 now
also redacts the worker's own name in the `/profile/parse` `answer_map`; and the deploy preflight now refuses an
`AI_RAW_PII_ENABLED` value the api cannot parse (only empty/true/false/1/0), failing the deploy with the old containers
serving instead of crash-looping the api. Recorded minors, not blocking: a model echo of the literal `[NAME]` in a
classic reply is not refused; a floor-refused turn is read by the api as "model unavailable" and the session falls back
to the deterministic engine; `voice_notes.transcript_english` holds the provider's translation of the raw transcript
while armed; the two services arm a few seconds apart during a deploy.

A new prompt-side call site simply goes through the shared module. Widening what the switch unmasks — a persisted
copy beyond companion v2's memory (named in L3), an embedding input, an output wall or floor, the G2 name redaction,
a second switch — is a new relaxation and goes back to the owner.

---

```
Owner decision 2026-09-30, relayed by Divyanshu Pant (Backend Platform); G1 and G2 (§6) decided the same day and
implemented with the switch. The owner instructed a direct merge; the production secret reads true, so the merge
armed AI_RAW_PII_ENABLED (#1870, deployed 2026-10-01). The signature below was recorded after the merge and
ratifies the decision.

Signed: Divyanshu (Backend Platform; relayed the owner's decision)          Date: 2026-10-01
```

---

## Post-signature corrections (2026-10-08)

**THE SIGNED TEXT ABOVE IS UNCHANGED.** One identifier in §6 went stale when #2166 replaced the
helper it names. Dated, signed records stay as signed (the precedent in
`E0_RELAY_DECISION_2026-09.md`, "Post-signature corrections (2026-09-21)"), so this footnote is the
fix, not a rewrite:

| cited above                                                                                               | actual                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6, G2, "What G2 does not reach" — "the `knownNamePattern` screens on the résumé and general-form briefs" | `knownNameMatcher` (`apps/api/src/common/redact-known-name.ts`, #2166): the briefs read the worker's own name through the same matcher as `redactKnownName`. The decision is unchanged. |

Also recorded post-signature: #2166 changed how G2 READS the name — dotted, hyphenated, apostrophe,
invisible-character and non-NFC names now redact, and a throw fails closed — and its accepted
limits are in the [risks register](../registers/risks-register.md) (the ADR-0047 section). Neither
changes the rulings above.
