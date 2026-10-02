# AI Safety — Pseudonymization Gateway

The single most important AI-safety control in Phase 1. It lives in the FastAPI
service (`apps/ai-service/app/pseudonymize.py`) and runs **before any LLM call**
while `AI_RAW_PII_ENABLED` is off — see
[Input policy switch (ADR-0047)](#input-policy-switch-adr-0047) for what the switch
moves and what it never touches.

## Contract

- Detects & replaces likely PII with request-scoped placeholder tokens:
  phone → `[PHONE_n]`, person → `[PERSON_n]`, employer → `[EMPLOYER_n]`,
  ID (PAN / Aadhaar / cued roll-registration-certificate ids) → `[ID_n]`,
  money amount → `[AMOUNT_n]`.
- The original↔token **mapping is never persisted or returned** — callers only
  see labels.
- Numbering is per call by default. A caller that masks several strings for ONE
  model request and needs the model to correlate them may pass one `TokenScope`
  (`pseudonymize(text, scope=...)`, keyword-only): the same original then gets the
  same token in every call, and different originals never share one. The scope
  holds keyed-BLAKE2b digests under a random per-scope key, never the originals, and refuses
  pickling/copying. Only the companion edit parser uses it (ADR-0046: the message
  and the worker's stored values must name the same employer with the same token).
  Rules, fail-closed paths and the `[PREFIX_n]` grammar are identical either way,
  and only the egressed reader-view pass uses the scope: the #1738 spaced-view
  detector pass keeps its own private numbering.
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
  after it must be closed vocabulary: curated trade/education words, whole
  gazetteer city names, state / region names and UPPERCASE listed state
  abbreviations (the detector's own tables), and the connecting words a location
  list is written with (and / or / ya / aur / etc / anywhere / near / nearby /
  india); an empty rest passes. `"Welding, grinding"`, `"Fanuc, tool offset"`,
  `"Pune, welding"`, `"Pune, Mumbai"`, `"Pune, Maharashtra"` and
  `"Pune, ya Mumbai"` pass; `"Welding, Anil Kumar"`,
  `"Pune, Ramesh Kumar"`, `"Diploma, Anil Sharma"`, `"Turner, Suresh"`,
  `"Operator, Ramesh sir ke under"`, `"Pune, Ramesh sir ke under"` and a name in
  ANY script (`"Welding, रमेश कुमार"`, Tamil, fullwidth) are withheld — the rest
  must be printable ASCII, and the vocabulary and the gazetteer are all-ASCII, so
  a non-Latin word fails the label closed. The cost, stated: a locality in no
  closed list after a city (`"Pune, Chakan"`) is withheld too. And the city
  gazetteer is now also an ALLOWLIST for these gates: a city that is also a common
  given name or surname ("Kota", "Surat") passes after a released word, so adding a
  city to `cities.json` needs that check. The same holds for `states.json` (names,
  regions and abbreviations) and the connecting-word list in `pseudonymize.py`: a
  new entry in any of them widens these three gates, not only the detector. "Survived only by a
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

### Employers written in capitals (issue #1875, risks-register R48)

`_COMPANY_SUFFIX` is case-sensitive, so before this fix `pseudonymize("  TATA MOTORS LTD")`
returned the text unmasked, and `certified_clean_skill_labels(["TATA MOTORS LTD"])` kept it as
a skill. A second, separate rule (`_EMPLOYER_CAPS_RE`) now runs after the title-case rule and
both name rules, on their output (rule 4b in `_mask`). The full rationale and measurements are in
the comment above `_CORPORATE_FORM_CAPS`.

- **Who reads the result, by posture.** Whatever `AI_RAW_PII_ENABLED` says, every consumer that
  calls `pseudonymize()` directly: the at-rest masked copies (the growth queue, the training
  corpus, the job-posting draft), the embedding input (`app/ai/embeddings.py`, SG-2;
  ADR-0047 §4 keeps it masked) and the clean-or-withhold certifiers. Only with the flag off:
  the prompt, and the trace sinks. `trace_mask(raw=settings.ai_raw_pii_enabled)` follows the
  flag, so the Langfuse export and `ai_call_traces` re-mask through this function only while it
  is off. Armed, they record the raw text the provider was sent.
- **Rule order.** The rule runs after `_EMPLOYER_RE`, `_NAME_CUE_RE` and `_LEADING_NAME_RE`,
  so each of them reads exactly main's input. It never shortens a title-case match and never
  eats a name cue, and within a view it only masks what they left raw. The first cut ran it
  before the name rules, and it ate the cue: `"MY NAME IS CO Ramesh"` →
  `"[EMPLOYER_1] Ramesh"`, where main gives `"MY NAME IS [PERSON_1]"` (security review F2).
  Now `"MERA NAAM RAMESH HAI TATA MOTORS LTD"` → `"MERA NAAM [PERSON_1] [EMPLOYER_1]"`.
  Re-measured after the move: no output in the corpus below changed.
- **The rule.** In capitals, a span is an employer only when it **ends in a corporate form**:
  LTD, PVT, CORP (each with or without a dot), LIMITED, CORPORATION, INDUSTRIES, ENTERPRISES,
  LLP, LLC, W.L.L, and, with guards, PRIVATE, COMPANY, INDUSTRY and CO. INC is not a form: in
  pay talk it means "incentive" or "including" (`"OT AUR INC MILTA THA"`).
- **Its own word grammar.** Up to 4 name words come before the form, as in title case. A name
  word may start with digits (`"3M INDIA LTD"`) and may carry `&`, `.` or a dash
  (`"TATA-MOTORS LTD"`). One joiner may follow each word without counting toward the 4: a bare
  `&` or `(P)`, `(I)`, `(PVT)`, `(INDIA)`, `(OPC)`. So `"LARSEN & TOUBRO LIMITED"`,
  `"SHARMA & CO."` and `"XYZ (P) LTD"` mask whole. A word that holds a run of 7 or more digits
  is never a name word, so `"X12345678 LTD"` still blocks on the residual-digit net, as on main.
  Each word is bounded at 64 characters and matched possessively (see Cost).
- **Compounds are not forms.** A dash after PRIVATE, COMPANY, INDUSTRY or CO makes a compound
  (`"PRIVATE-SECTOR"`, `"QUALITY CO-ORDINATOR"`, and the Unicode-dash spellings). A dash after
  any other form is a place or a unit: `"BHARAT FORGE LTD-CHAKAN"` →
  `"[EMPLOYER_1]-CHAKAN"`. CO also compounds across a space or a dot, from a closed list:
  `"QUALITY CO ORDINATOR"`, `"CO OPERATION"`, `"PUNE CO OP SOCIETY"`, `"CO WORKER"`,
  `"CO CURRICULAR"`, `"MIG CO 2 WELDING"`. `"XYZ & CO OPERATIONS MANAGER"` still masks.
- **Trade words never end a capitals span.** In capitals, the 17 trade words in the suffix
  list (STEEL, AUTO, TOOLS, PRECISION, ENGINEERING, …) are ordinary shouted speech:
  `"MAIN STEEL PLANT MEIN THA"` stays unmasked. Measured over 31,907 distinct strings of the
  repo's own text (question packs, lexicons, job-domain corpus, ai-service test strings),
  all upper-cased: a case-insensitive suffix list would newly mask 1,521 of them (9,442
  words). This rule masks 380 (1,966 words).
- **Title case is byte-identical to main** (as of #1875; #1891 later bounded the title-case
  name word without moving any of these outputs, see the next section). As written, the same
  corpus changes in 6 strings, and each one contains a capitals corporate form. Neither as
  written nor upper-cased does a string leave a word unmasked that main masked, or stop
  blocking where main blocked. No certifier outcome changes over 4,765 lexicon labels (as
  written, UPPER and Title).
- **The two views (R49, #1890).** The one place where more masking can mean less protection
  is the #1738 two-view check. It counts a spaced-view region as covered when the region merely
  overlaps a reader-view mask. In `"my name is<U+200B>Ramesh Kumar CO"` the reader view merges
  `"isRamesh"`, so the cue misses and this rule masks `"Kumar CO"`. The spaced view masks
  `"Ramesh Kumar"` as a name. The two overlap on `"Kumar"`, so the turn passes as
  `"my name isRamesh [EMPLOYER_1]"`, where main blocked it. Main already passes the
  title-case twin (`"…Ramesh Kumar Steel"`). This rule extends that shape to the capitals forms.
  It is pinned as a `KNOWN_RESIDUAL` and tracked as R49 / #1890; the fix is in the two-view
  check, not here. Measured with the property test's generator (4,000 seeded samples with
  invisible separators and name cues), main blocks 28 turns on this check that the branch
  passes:
  - 10 are this partial-overlap shape (11 with the rule still ahead of the name rules);
  - 18 are full cover: the reader view now masks, as an employer, every kept offset that the
    spaced view masked. The check, as designed, has nothing left to block. Every word these
    turns release was also raw in main's reader view.
- **Boundary, under.** These stay raw, each pinned by a `KNOWN_RESIDUAL` test. The lower-case,
  M/S, 5+ word and title-case-twin rows are tracked as #1892:
  - a capitals employer with no corporate form (`"BAJAJ AUTO"`, `"GUPTA & SONS"`, an M/S firm
    such as `"M/S SHARMA TRADERS"`);
  - an employer in lower case (`"tata motors ltd"`);
  - a form not on the list (`"ACME INC"`, the Gulf `"EST."`);
  - a dash after a guarded form (`"MARUTI COMPANY-PUNE"`);
  - the leading words of a name with 5 or more words before the form
    (`"RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD"` → `"RAMESH [EMPLOYER_1] LTD"`). A
    6-word window would mask the long names, but it would mask 474 more words over 228
    strings of the upper-cased corpus;
  - the title-case twins `"Sharma & Co."`, `"Xyz (P) Ltd"` and `"Acme Llp"`.
- **Boundary, over.** A corporate word used as ordinary speech is masked
  (`"MAIN PRIVATE COMPANY MEIN THA"` → `"[EMPLOYER_1] MEIN THA"`), just as its title-case twin
  already is on main. 343 of the 452 spans the rule adds in the upper-cased corpus end in
  PRIVATE, COMPANY or INDUSTRY, and 292 of the 380 strings change only through one of those
  three. Dropping them as end forms would leave `"MARUTI COMPANY"` raw. That is a privacy
  decision that has not been taken.
- **Cost.** Measured on 2026-10-01: a typical line costs 2–10 µs more per call. On the worst
  20,000-character input tried, the rule alone costs 42 ms. The first cut reused title case's
  unbounded word and cost 1,575 ms on `"A." * 10000`, which doubled `pseudonymize` from
  1,576 ms to 3,131 ms. The 1,576 ms that remained was the title-case rule's own unbounded
  `[\w&.]*`, since bounded the same way (#1891, next section).

Pinned by `tests/test_pseudonymize_allcaps_employer.py` (165 tests). Each of 14 mutations of the
rule turned it red, with 2 to 69 failures each: the rule removed; the dash guard on every form,
or on none; the CO list removed; trade words allowed to end a span; the rule folded into
`_COMPANY_SUFFIX`; joiners removed; the 7-digit refusal removed; the word unbounded; INC put
back; a 6-word window; title case's word grammar; every guard removed; and the rule moved back
ahead of the name rules.

### The title-case employer rule does bounded work (issue #1891, risks-register R48)

`_EMPLOYER_RE`'s name word was `[A-Z][\w&.]*`, unbounded. On a run with many word boundaries
and no whitespace that is O(n²): every letter after a `.` or `&` opens a match, and each one
scanned to the end of the run for the whitespace a suffix needs. Found by the security review of
#1875. `/profiling/respond` and `/profile/extract` call `pseudonymize()` inline inside
`async def`, so one such input stalled the event loop for every worker. The clean-or-withhold
walls run the same rule whatever `AI_RAW_PII_ENABLED` says.

- **The fix.** The name word is `_TITLE_NAME_WORD`: a capital, then at most 63 more of
  `[\w&.]`, matched possessively. That is the capitals rule's `_CAPS_NAME_WORD_MAX` bound,
  reused so the two cannot drift. Possessive changes no match: a word is always followed by
  `\s+`, which `[\w&.]` excludes.
- **No other copy exists.** `profiling/signals.py` and `resume_import/parse_policy.py` name the
  rule only in comments. `contains_hard_identifier` (gate 6, `resume_value_certifier`) never ran
  it. Every `pseudonymize()` caller and the three walls (`is_certified_clean`, `certify_value`,
  `certified_clean_skill_labels`) use the one compiled pattern. The only other
  `(?:\w+\s+){m,n}` window in `apps/ai-service/app` is the job-posting chat's vacancy count
  (`_VACANCY_ARMS`). It starts only at a 1–4 digit number and scans at most three words from
  there. Measured on six 20,000-character adversarial inputs, it takes 1–16 ms.
- **Measured** on 2026-10-03 at 20,000 characters. Main's and the bounded rule were interleaved
  in one process, with Windows power throttling switched off for it. Times are the minimum of 5
  runs.

  | Input | `pseudonymize`, main | bounded | the rule alone, main | bounded |
  |---|---|---|---|---|
  | `"A." * 10000` | 2,134 ms | 37 ms | 2,119 ms | 8 ms |
  | `"A." * 9999` + one ZWSP | 4,306 ms | 82 ms | 2,573 ms | 10 ms |
  | `"A&" * 10000` | 2,016 ms | 37 ms | 1,981 ms | 8 ms |
  | `"Ab." * 6666` | 1,242 ms | 26 ms | 1,217 ms | 5 ms |
  | `"A." * 9990 + " Steel"` | 4 ms | 37 ms | 0.2 ms | 8 ms |
  | a typical 68-character line | 27.1 µs | 26.8 µs | | |

  The `" Steel"` row is the price, and it is linear: main matched that run from its first
  letter, and the bounded rule scans 64 characters from each start.
- **Over-masking, re-measured with #1875's harness.** The corpus is 31,984 distinct strings:
  #1875's 31,907 plus the 77 ai-service test strings added since. Each runs as written and
  upper-cased. The certifiers run over 4,765 lexicon labels, as written, UPPER and Title.
  - Main against the fix: 0 outputs changed, 0 changes in blocked status, 0 certifier outcomes
    changed. The two result files are byte-identical.
  - The upper-cased half is 0 by construction: the title-case suffix list is case-sensitive.
  - A fidelity run, main's pattern swapped into the fixed module, reproduces main byte for byte.
  - A sensitivity run with an 8-character bound changes 148 strings as written and 4 certifier
    outcomes, so the harness does detect a bound that bites.
- **The boundary.** Only a title-case name word over 64 characters behaves differently.
  - An undotted one no longer opens a span: `"<65 letters> Steel"` stays raw, and so does a
    name in front of it. A bare name is raw on main too.
  - A dotted one masks from the first boundary within 64 characters of its end:
    `"A." * 40 + " Steel"` → `"A." * 8 + "[EMPLOYER_1]"`. The capitals rule has always worked
    this way.
  - No employer has such a word. The corpus's longest capital-led `[\w&.]` run is 43 characters
    as written. Upper-cased it is 64, and those are SHA-256 hex digests in test fixtures.

Pinned by `tests/test_pseudonymize_title_employer_bound.py` (25 tests):
- the structural bound and possessive quantifier;
- the issue's inputs and the three walls under a 750 ms timing backstop;
- real employers masking exactly as on main;
- a seeded property test: no output moves while every name word is 64 characters or shorter;
- the boundary itself, pinned as `KNOWN_RESIDUAL`.

Each of six mutations of the rule turned the file red: main's word; possessive but unbounded;
bounded but not possessive; a 65-, 32- or 8-character bound.

## Input policy switch (ADR-0047)

[ADR-0047](../decisions/0047-lift-pii-restriction.md) lifts, for now, the ban on raw PII in
model prompts. In code that is ONE switch, `AI_RAW_PII_ENABLED`, read by both services and
**off by default**. Off, everything in this document holds exactly as written.

- **What it moves: the INPUT side only.** Every prompt-side call site goes through
  `apps/ai-service/app/llm_input_policy.py`, whose gate and per-line masker take a
  keyword-only `raw` argument the ROUTE passes from its settings. `raw=False` is
  `pseudonymize()` and nothing else. `raw=True` returns the text unchanged but keeps the
  size caps (20,000 characters per message, `PARSE_MESSAGE_MAX_CHARS` = 4,000 per transcript
  line) and the non-string refusal — those bound cost and denial of service, not PII.
- **The résumé import routes** take `raw` from `RESUME_PARSE_RAW_TEXT_ENABLED` OR
  `AI_RAW_PII_ENABLED` and keep ADR-0041 D5's own pass-through; the two flags roll back
  independently.
- **The traces follow it.** The Langfuse `mask=` hook and the `ai_call_traces` text pass
  values through while it is on, so a trace records what the provider was actually sent.
- **The api's half.** Companion v2 skips its `/pseudonymize` hop (its Redis memory then holds
  raw text, TTL-bound). The worker's own name does not move: `redactKnownName` runs whatever
  the flag says in profile extraction and on both `/profiling/turn` callers, the classic
  interview turn and the skills stage (ADR-0047 §6, G2).
- **What it never touches.** `pseudonymize()` itself — it also certifies stored values,
  masks the at-rest growth queue and de-identifies the training corpus, so a switch inside it
  would disable all three. Every output wall (`certify*`, `certified_*`,
  `contains_hard_identifier`, gate 6, `resume_value_certifier`, the placeholder refusals):
  model output stays untrusted under both postures. The at-rest masked copies (the payer
  job-posting draft, `unresolved_phrase` through the embed path, the corpus). STT, event
  schemas and log lines.
- **The hard-identifier output floor** (ADR-0047 §6, G1). Phase C's `_certified*` walls and
  the work-history polish wall (`pseudonymize(polished).blocked`) refuse only what this
  gateway would BLOCK, and a phone is masked, not blocked — safe while the model read masked
  text, not once it reads raw. So a model-produced value that contains a hard identifier
  (`contains_hard_identifier` / `HARD_IDENTIFIER_CLASSES`) is dropped at the four measured
  gaps: Phase C's stored values, the polished line, the classic `/profiling/turn` labels and
  `/profile/parse`'s `evidence.quote` — and at three outputs found by probing armed:
  `/profile/extract`'s stored rich draft, companion v2's edit rows (the api drops the same row
  again) and the `/resume/generate` summary. Inside an experience it works per field, so an
  honest dashed year range costs `duration_text`, not the job. The floor reads no flag; off it
  is a near no-op. Section 6 of `tests/test_llm_input_policy.py` pins each output.

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
- **Gateway:** the interview turn route (`/profiling/turn`,
  `apps/ai-service/app/routers/profiling.py`) masks the current message (a blocked
  message returns an empty, silent turn) and **every prior turn** through
  `parse_masking.mask_transcript_lines`, one line at a time, before either enters
  `messages`; a line the gateway refuses is dropped (fail closed). With
  `AI_RAW_PII_ENABLED` armed both go through the input policy switch above.
- **LLM Adapter / Router:** The `LlmAdapter` / `AIRouter` seam (
  `apps/ai-service/app/ai/router.py`) receives messages the endpoint has already
  passed through the input policy in force (ADR-0047); it masks nothing itself.
  Only its trace sinks re-mask, through `langfuse_tracing.trace_mask`, which follows
  the same switch. Real calls require `AI_ENABLE_REAL_CALLS=true` **and**
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
  - **Both are moot while `AI_RAW_PII_ENABLED` is armed** (ADR-0047): each describes PII slipping past a masker that is then deliberately not masking. With the switch off they stand as recorded.
  - **R48 — employers in capitals (issue #1875).** Fixed for a capitals span that ends in a listed corporate form. Still open: no corporate form (`"BAJAJ AUTO"`, M/S firms), lower case, INC/EST., a dash after a guarded form, 5+ name words, and the title-case joiner twins (lower case, M/S, 5+ words and the twins are #1892); see the section on employers in capitals. The title-case `_EMPLOYER_RE` stall found there is fixed (#1891): its name word now has the capitals rule's 64-character bound, and no corpus output moved. Unlike R30/R32, this is NOT moot while the switch is armed. The at-rest masked copies, the embedding input (SG-2, ADR-0047 §4) and the certifiers run `pseudonymize()` under both postures. The Langfuse and `ai_call_traces` sinks follow the flag (`trace_mask`), so they are covered only while it is off.
  - **R49 — the two-view check accepts a partial overlap (#1890).** Pre-existing (#1738). A name hidden by an invisible character next to a masked employer span egresses unblocked: `"my name is<U+200B>Ramesh Kumar CO"` → `"my name isRamesh [EMPLOYER_1]"`. Main already does this with title-case suffixes, and #1875's capitals rule extends the shape. OPEN; the fix is to count a spaced-view region as covered only if every kept offset is inside the reader-masked regions.
