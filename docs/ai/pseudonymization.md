# AI Safety — Pseudonymization Gateway

The single most important AI-safety control in Phase 1. It lives in the FastAPI
service (`apps/ai-service/app/pseudonymize.py`) and runs **before any LLM call**.

## Contract

- Detects & replaces likely PII with request-scoped placeholder tokens:
  phone → `[PHONE_n]`, person → `[PERSON_n]`, employer → `[EMPLOYER_n]`,
  ID (PAN / Aadhaar / cued roll-registration-certificate ids) → `[ID_n]`,
  money amount → `[AMOUNT_n]`.
- The original↔token **mapping is never persisted or returned** — callers only
  see labels.
- **Fails closed:** returns `blocked=true` on oversize input, non-string input,
  parsing errors, or a residual long digit run (potential un-masked numeric PII).
  When blocked, the LLM is never called and a safe fallback is returned.

### What is deliberately NOT PII (owner ruling 2026-07-31)

The Master Context **DEAD LIST** is authoritative and says:

> ✗ cities as PII (→ a 20-point matching input; never redact)
> ✗ salary flagged as a phone number

So **cities and states are no longer masked.** They pass through verbatim.

- A city identifies nobody, and it is the strongest matching signal the product
  has. Masking it to `[CITY_n]` cost the field on every model-authored surface
  (the résumé's location line, the extraction transcript, the voice-translate
  leg) while protecting nothing.
- States followed the same reasoning: coarser geography cannot be more
  identifying than the city inside it. The old comment claimed states were masked
  "so they never reach the LLM (TD56)"; that rationale is retired.
- `KNOWN_CITIES` / `CITY_ALIASES` stay in `pseudonymize.py` because
  `app/profiling/signals.py` imports them for **detection** — reading the city off
  raw text locally. That use is unchanged. The state gazetteer that existed only
  for masking (`KNOWN_STATES` / `STATE_ABBREVS`) was deleted; `signals.py` has
  always carried its own.
- **Salary:** amounts stay tokenised as `[AMOUNT_n]` (digits never reach an LLM)
  and a salary must never be re-labelled `[PHONE_n]` or block the turn.
  Separator-written forms — `3,60,000`, `2.5 lakh`, `25 hazar`, `15000`,
  `12,00,000` — are regression-tested for exactly that.

**This narrows the definition of PII by two non-identity classes. It does not
relax the gate:** every identity class still masks and every fail-closed path is
byte-for-byte unchanged (pinned by
`tests/test_pseudonymize.py::test_the_city_ruling_did_not_move_any_fail_closed_path`
and `::test_the_city_ruling_did_not_touch_any_identity_class`). One qualification
on "every identity class": the no-cue leading-name guess (below) does not mask a
leading word that is a known city or, since 2026-09-25, a curated trade word —
neither is a person's name, and the cue rule ("mera naam X") still masks either.

### Trade vocabulary is not a name (owner ruling 2026-09-25, issue #1728)

The no-cue leading-name guess (`_LEADING_NAME_RE`, `^\s*([A-Z][a-z]+)\s*,`) masked
ordinary vocabulary that opens a list. Measured before the ruling:
`"Welding, grinding"` → `"[PERSON_1], grinding"`, `"Fanuc, tool offset"` →
`"[PERSON_1], tool offset"`. The payer's job-posting chat then silently stored a
bracketless `PERSON_1` remnant in place of the trade on the draft (no retype
prompt fired), and on the worker side the model never saw the trade named.

- **What it releases.** A leading word of **4+ letters** that the ONE curated
  vocabulary recognises — `signals.VOCABULARY_TOKENS`, consulted through
  `pseudonymize._is_known_trade_vocabulary` — is not masked as `[PERSON_n]`. That
  word only; nothing after it changes.
- **Fails closed.** Any error consulting the vocabulary returns False and the word
  is masked, exactly as before the ruling. The turn is not blocked.
- **The cue rule is untouched.** `"mera naam Welding hai"` still masks — explicit
  evidence of a name wins whatever the word is.
- **Global, not an exemption.** No route, flag or principal is exempted (ADR-0035
  §2/§3): the rule is the same for a worker's turn and a payer's.
- **The clean-or-withhold gates still require the WHOLE label.** A consumer that
  passes a string raw "because the gateway masked nothing" would otherwise release
  what follows the kept word. `pseudonymize.is_certified_clean` is the predicate
  the clean-or-withhold WALLS use — `certified_clean_skill_labels` (skill labels,
  education, certifications, at extraction and again at the résumé boundary), the
  work-history polish `<role>` gate, and gate 6 of `/profile/parse` (through
  `pseudonymize.certify_value`). When the leading word survived only by a
  carve-out — this one, or the 2026-07-31 city ruling (issue #1730) — everything
  after it must be closed vocabulary: curated trade/education words and whole
  gazetteer city names. `"Welding, grinding"`, `"Fanuc, tool offset"`,
  `"Pune, welding"` and `"Pune, Mumbai"` pass; `"Welding, Anil Kumar"`,
  `"Pune, Ramesh Kumar"`, `"Diploma, Anil Sharma"`, `"Turner, Suresh"`,
  `"Operator, Ramesh sir ke under"`, `"Pune, Ramesh sir ke under"` and a name in
  ANY script (`"Welding, रमेश कुमार"`, Tamil, fullwidth) are withheld — the rest
  must be printable ASCII, and the vocabulary and the gazetteer are all-ASCII, so
  a non-Latin word fails the label closed. The cost, stated: a locality in no
  closed list after a city (`"Pune, Chakan"`) is withheld too. "Survived only by a
  carve-out" is decided structurally, never by a second vocabulary lookup, so a
  lookup failure withholds. A leading stoplisted greeting (`"Hello, ..."`) is not a
  carve-out and is certified exactly as before (a stated residual: tightening it
  would reject real parse values like `"Yes, anywhere"`). Deliberately NOT routed
  through it: `parse_masking._publishable_normalized`, which only decides whether a
  deterministic value is shown to the model as a hint beside a transcript the same
  gateway already masked — withholding the hint would protect nothing.
- **Known residual — an owner decision, not a bug.** The 4-letter floor keeps
  name-shaped 3-letter vocabulary masked (`"Max, welder"`), and with it the
  title-cased trade acronyms a phone keyboard produces: `"Cnc, vmc"`,
  `"Iti, fitter"`, `"Mig, tig welding"`, `"Vmc, hmc operator"`, `"Cmm, vernier"`
  all still mask the acronym. Non-vocabulary openers (a benefit such as
  `"Canteen, PF"`, a locality outside the city gazetteer such as `"Chakan, Pune"`)
  also stay masked by design.
- **Changing the vocabulary is a privacy change.** A token added to
  `trades.json` / `education.json` that is also a first name or surname stops being
  masked in `"<Word>, ..."` position. The set is checksum-pinned by
  `tests/test_lexicon_parity.py::test_the_curated_vocabulary_is_pinned`.

Pinned by `tests/test_pseudonymize.py` (`test_a_leading_trade_vocabulary_word_is_not_masked_as_a_person`,
`test_the_vocabulary_carve_out_still_masks_a_leading_word_it_does_not_recognise`,
`test_the_vocabulary_carve_out_4_letter_floor_keeps_a_3_letter_token_masked`,
`test_KNOWN_RESIDUAL_a_title_cased_3_letter_trade_acronym_is_still_masked`,
`test_the_name_CUE_rule_is_untouched_by_the_vocabulary_carve_out`,
`test_the_vocabulary_carve_out_fails_CLOSED_when_the_vocabulary_cannot_be_consulted`)
and, through the real routes and gates, `tests/test_leading_name_vocabulary.py`
(payer job-posting chat, worker turn, `certified_clean_skill_labels`,
`POST /resume/generate`, the work-history polish `<role>`).

## Example

```
in:  "Rahul, phone 9876543210, worked at ABC Industries in Faridabad"
out: "[PERSON_1], phone [PHONE_1], worked at [EMPLOYER_1] in Faridabad"
```

## Current Implementation (2026-07)

- **Detection:** heuristic (regex + small gazetteers). Over-masking is the safe
  direction. Real NER / LLM-assisted detection comes later.
- **Names:** rely on cue phrases + a leading-name heuristic (`"<Word>, ..."`),
  which does not mask a leading known city or a 4+ letter curated trade word (see
  the two ruling sections above); will improve with NER.
- **Gateway:** `_pseudonymized_history()` in `apps/ai-service/app/main.py`
  pseudonymizes **every prior turn** (not just the current message) before it
  enters `messages`; any turn that can't be safely pseudonymized is dropped
  (fail closed).
- **LLM Adapter / Router:** The `LlmAdapter` / `AIRouter` seam (
  `apps/ai-service/app/ai/router.py`) calls pseudonymization **before** any
  provider dispatch. Real calls require `AI_ENABLE_REAL_CALLS=true` **and**
  `GEMINI_FLASH_API_KEY` (master) / optional `ANTHROPIC_API_KEY` (fallback).
  The LiteLLM adapter was never wired and is retired ([ADR-0008](../decisions/0008-litellm-to-direct-providers.md)).
- **Providers (direct, behind the router):**
  - **Primary:** Gemini 2.5 Flash (`gemini-2.5-flash`) / Flash-Lite (`gemini-2.5-flash-lite`) via REST (httpx)
  - **Fallback:** Claude Haiku 4.5 via Anthropic SDK
  - **Mock:** deterministic fallback used in CI and when real calls are gated off
- **Spend caps (TD27 paid):** Rolling per-UTC-day + cumulative INR caps enforced
  in `cost_tracker.SpendLedger` (Redis-backed, global across Uvicorn workers)
  + per-user/day cap + retry budget + independent kill-switch
  (`AI_REAL_CALLS_KILL_SWITCH`). All fail-closed → mock.

## Phase 1 Limitations / TODO

- Detection is **heuristic** (regex + small gazetteers). Over-masking is the safe
  direction. Real NER / LLM-assisted detection comes later.
- Names rely on cue phrases + a leading-name heuristic; will improve with NER. The
  heuristic defers to the city gazetteer and the curated trade vocabulary (see the
  two ruling sections above); title-cased 3-letter trade acronyms (`"Cnc, vmc"`)
  are a known residual that stays masked under the 4-letter floor.
- Known gaps (tracked as risks):
  - **R30 — STILL OPEN.** Separator-split phones bypassed the residual-digit net (narrowed 2026-07-17, PR #392: digit-count rule 9–13 digits joined by any separator run; 13/13 shapes covered). Two residuals remain and are **unchanged by the 2026-07-31 city ruling**, which touched no numeric path: (1) a 9–13 digit phone split by a WORD ("98765 aur 43210") is not detected — a proximity net would false-fire on "salary 15000 se 18000"; (2) an ASCII `/`- or `:`-split phone ("98765/43210") is excluded by the stated separator boundary. Both are recorded in `pseudonymize.py` beside the rule they qualify.
  - **R32:** Names without cue words can leak (e.g., "Chandrashekhar bol raha hu" — 3/4 natural forms unmasked on main). Narrowed, not closed — the gazetteer approach measured dead (487 probes / 348 leaks); known-name redaction shipped in `apps/api` instead (PR #524, ADR-0035).
  - Both tracked in [risks-register.md](../registers/risks-register.md) as Critical-if-live and both **still gate `AI_ENABLE_REAL_CALLS`**; invariant #5 holds today.