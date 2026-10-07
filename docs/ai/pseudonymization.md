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
- **The two views (R49, #1890 — fixed; these turns now block, see "The two-view check requires
  containment" below).** The one place where more masking could mean less protection
  was the #1738 two-view check. It counted a spaced-view region as covered when the region merely
  overlapped a reader-view mask. In `"my name is<U+200B>Ramesh Kumar CO"` the reader view merges
  `"isRamesh"`, so the cue misses and this rule masks `"Kumar CO"`. The spaced view masks
  `"Ramesh Kumar"` as a name. The two overlap on `"Kumar"`, so the turn passes as
  `"my name isRamesh [EMPLOYER_1]"`, where main blocked it. Main already passes the
  title-case twin (`"…Ramesh Kumar Steel"`). This rule extends that shape to the capitals forms.
  It was pinned as a `KNOWN_RESIDUAL` and tracked as R49; #1890 fixed it in the two-view
  check, not here, and the pins now assert the block. Measured with the property test's generator (4,000 seeded samples with
  invisible separators and name cues), main blocks 28 turns on this check that the branch
  passes:
  - 10 are this partial-overlap shape (11 with the rule still ahead of the name rules);
  - 18 are full cover: the reader view now masks, as an employer, every kept offset that the
    spaced view masked. The check, as designed, has nothing left to block. Every word these
    turns release was also raw in main's reader view.
- **Boundary, under.** These stayed raw under this rule, each pinned by a `KNOWN_RESIDUAL` test.
  #1892 has since masked most of the lower-case, M/S, 5+ word and title-case-twin rows (see
  "Employer shapes the capitals rule left raw" below); its own residue is listed there:
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
  `certified_clean_skill_labels`) use the one compiled pattern.
- **Other stalls of the same kind (survey, 2026-10-03).** The first version of this section said
  the job-posting vacancy count was the only other `(?:\w+\s+){m,n}` window in
  `apps/ai-service/app`. The #1891 review showed that was wrong, so it was replaced by a
  measurement. None of the stalls below is fixed on this branch. Each one predates #1891 and
  none copies this rule.
  - **Method** (`apps/ai-service/scripts/regex_growth_survey.py`). Every compiled pattern
    reachable from an `app/` module's globals (351) was timed at two input sizes on 22 input
    shapes. The shapes are runs of spaces, mixed whitespace, word windows, dotted runs, and runs
    of digits, commas and dashes, each after a cue word taken from the pattern itself. Each
    pattern that grew faster than linear was then timed through its real entry point, on the
    inputs quoted below. A pattern compiled inside a function body is not covered. Times are
    ranges over two or three runs on a shared machine; the growth per doubling is the stable
    signal. Under load the screen also flags patterns near its 1 ms floor: two runs flagged 31
    and 41 patterns, and every one was checked through its entry point.
  - **In the gateway**, the capitals rule already had this bound. The two cued-ID rules had a
    different stall: three whitespace quantifiers in a row. A cue followed by a whitespace run
    that then fails to match cost O(k³), about 8× per doubling. **Fixed by #1933** (R54, resolved;
    see the section on the cued-ID connector below).
    - `_CREDENTIAL_ID_RE` runs in every `pseudonymize` call, whatever `AI_RAW_PII_ENABLED` says.
      `pseudonymize("reg" + " " * 800 + "!")` took 1.7–4.0 s, against 0.2–0.5 s at 400 spaces.
      With 300 repeats of `" \t\n"` it took 3.6–7.5 s.
    - `_RESUME_CUED_ID_RE` runs only in `contains_hard_identifier`.
      `contains_hard_identifier("passport" + " " * 800 + "!")` took 3.6–5.9 s.
  - **Outside the gateway**, six stalls were live through their entry point:
    - The job-posting role cue (`_ROLE_CUE_RE`), when the role question is on screen.
      `detect_answers("need" + " " * 10000 + "5", "role_title")` took 748–801 ms. R53 (a),
      mitigated by #1934 (2.8 ms).
    - The job-posting phrase splitter (`_PHRASE_SPLIT_RE`), when skills or benefits are on
      screen. Requirements uses the same splitter. Any run of 10,000 spaces took 730–800 ms.
      R53 (b), mitigated by #1934 (2.0 ms).
    - Found by the #1934 review: the job-posting label tail (`_LABEL_TAIL_RE`), after a role
      or location cue matched. `detect_answers("need welder" + " " * 10000 + "x",
      "role_title")` took 547 ms. R53 (d), mitigated by #1995 (2.3 ms).
    - Found by the #1934 review: the job-posting pay-clause splitter
      (`_PAY_CLAUSE_BOUNDARY_RE`), on any turn with a pay figure. `detect_answers("salary 20k
      bonus" + " " * 10000 + "x", None)` took 463 ms. R53 (e), mitigated by #1995 (2.0 ms).
    - The job-posting pay-range parser (`_PAY_RANGE_RE`), on every turn that carries a money
      cue, whatever topic is on screen. `detect_answers("salary 20k 5" + " " * 10000 + "!",
      None)` took 1.9 s, and 0.5 s at 5,000. R53 (c), mitigated by #1995 (5.3 ms).
    - The profiling experience matcher (`_EXPERIENCE_RE`), in `/profile/extract`'s heuristic
      pass over the worker's own text. `"adhai" + " " * 5000 + "5"` took 1.4 s, and 6–24 s at
      10,000 spaces. R55.
    - The profiling salary matcher (`_SALARY_RE`), in the same pass. It needs no cue: any run of
      spaces that no digit follows is enough. `"hello" + " " * 8000 + "world"` took 1.0 s, and
      25 s at 16,000. R55.
    - The salary detector's credential guard (`_CREDENTIAL_BEFORE_RE`), the same shape as the
      gateway's. `"reg" + " " * 800 + "!5000"` took 2.6–2.7 s in the same pass. R54, fixed by
      #1933 with the gateway's rules.
  - **Flagged alone, not live through their entry point:**
    - The other job-posting patterns it flags (pay type, currency, experience, timeline, label
      tail) run on text whose whitespace is already collapsed, or start at a figure. On the
      shapes tried, `detect_answers` stayed under 30 ms at 10,000 characters for every topic
      those patterns serve.
    - `is_hardship` is cubic on a run of digits (9.2 s at 10,000), but nothing in this service
      calls it in production: `classify_utterance` serves the parity corpus only. Its
      TypeScript twin in `packages/profiling-lexicon` was not measured.
    - `_SKILLS_PLACEHOLDER` reads model output only.
    - The capitals rule's flag was noise. `_EMPLOYER_CAPS_RE.sub` on `"WELD " + "A&" * 8000`
      takes 22 ms and grows linearly. So do the other profiling patterns flagged (city,
      relocation cues, first-person claim, don't-know, job question) through their functions at
      8,000 units.
  - The vacancy count (`_VACANCY_ARMS`) and the location cue (`_LOCATION_CUE_RE`) are linear on
    every shape tried. On six 20,000-character adversarial inputs the vacancy count takes
    1–16 ms.
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
- **Reproduce** every number in this section with
  `apps/ai-service/scripts/measure_title_employer_bound.py`:
  - `timing` prints the table above;
  - `overmask` gives the over-mask counts below, and `overmask --against bound8` the
    sensitivity run;
  - `longwords` gives the distances to the boundary.

  Its "main" is the module with the pre-#1891 `_EMPLOYER_RE` swapped back in. The tests in
  section 5 of the test file keep the script in step with the rule.
- **Over-masking, re-measured with #1875's harness.** The corpus is 31,984 distinct strings:
  #1875's 31,907 plus the 77 ai-service test strings added since. Each runs as written and
  upper-cased. The certifiers run over 4,765 lexicon labels, as written, UPPER and Title.
  - Main against the fix: 0 outputs changed, 0 changes in blocked status, 0 certifier outcomes
    changed. The two result files are byte-identical.
  - The committed script reads tracked files only. On this commit it finds 32,006 distinct
    strings and the same 4,765 labels, with the same zeros. Main's tests have moved since:
    6 #1875 fixtures are gone and newer test strings arrived.
  - The upper-cased half is 0 by construction: the title-case suffix list is case-sensitive.
  - A fidelity run, main's pattern swapped into the fixed module, reproduces main byte for byte.
  - A sensitivity run with an 8-character bound changes 148 strings as written (1 of them in
    blocked status) and 4 certifier outcomes, so the harness does detect a bound that bites.
- **The boundary.** Only a title-case name word over 64 characters behaves differently.
  - An undotted one no longer opens a span: `"<65 letters> Steel"` stays raw, and so does a
    name in front of it. A bare name is raw on main too.
  - A dotted one masks from the first boundary within 64 characters of its end:
    `"A." * 40 + " Steel"` → `"A." * 8 + "[EMPLOYER_1]"`. The capitals rule has always worked
    this way.
  - No employer has such a word. The corpus's longest capital-led `[\w&.]` run is 43 characters
    as written. Upper-cased it is 64, and those are SHA-256 hex digests in test fixtures. A scan
    of every tracked `.py`, `.json`, `.yaml` and `.csv` file under `apps/ai-service` and
    `packages` (617 files when measured, 620 on this commit) finds no run over 64. The
    longest is 48.
  - Under the #1738 two views, a word that reaches 65+ characters only because an invisible
    joins two shorter words behaves in one of two ways:
    - It is the span's only name word. The span then blocks: the spaced view masks a region that
      the reader view left raw. `"A" * 40 + ZWSP + "B" * 40 + " Steel"` is blocked. Main
      returned `[EMPLOYER_1]`.
    - Another name word stands before the form. The reader view then masks that tail. Before
      #1890 the partial overlap R49 accepted let the text through as the reader view
      (`"A"*40 + "B"*40 + " [EMPLOYER_1]"`); since #1890 counts only full cover, it blocks as
      well.

Pinned by `tests/test_pseudonymize_title_employer_bound.py` (30 tests):
- the structural bound and possessive quantifier;
- the issue's inputs and the three walls under a 750 ms timing backstop;
- real employers masking exactly as on main;
- a seeded property test: no output moves while every name word is 64 characters or shorter;
- the boundary itself, pinned as `KNOWN_RESIDUAL`;
- the boundary under the two views: both shapes block (the second since #1890);
- the measurement script: its "main" is the test's oracle, and its `boundN` is the shipped rule
  with only the bound changed.

Each of six mutations of the rule turned the file red: main's word; possessive but unbounded;
bounded but not possessive; a 65-, 32- or 8-character bound. The two-view tests fail on main, on
both unbounded mutations (3 of 3) and on the 32- and 8-character bounds (the blocking case).

**Sign-off.** #1891 changes title case, so the issue asked for the owner's sign-off before it
merges. Divyanshu Pant gave it on 2026-10-03: he is the issue's author and assignee and the
signer of ADR-0047, and he directed that #1891 be solved and merged. The basis is the measured
zero real-world impact. No output, blocked status or certifier outcome moves over the corpus.
No tracked file under `apps/ai-service` or `packages` holds a capital-led run over 64
characters. Under the two views, a word that only an invisible joins past 64 either blocks
(fail-closed) or egresses exactly as the word written without the invisible. #1892 (lower case, M/S, 5+ name
words, the title-case twins) was not part of this change; it landed separately (next section).

### Employer shapes the capitals rule left raw (issue #1892, risks-register R48)

Before this change, `pseudonymize("tata motors ltd")`, `"Sharma & Co."` and `"M/S SHARMA TRADERS"`
came back unmasked and certified clean. Two more were half-masked: `"Larsen & Toubro Limited"`
became `"Larsen & [EMPLOYER_1]"`, and `"RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD"` became
`"RAMESH [EMPLOYER_1] LTD"`.

Five separate passes now handle these shapes. The long pass runs just ahead of the capitals rule
(rule 4a in `_mask`); the other four run after it, on its output (rules 4c–4f). The full rationale
and every measurement are in the comment above `_EMPLOYER_STOPWORDS`.

- **Lower and sentence case** (`_EMPLOYER_LOWER_RE`). Up to 4 name words of any case before a
  form that stays corporate in lower case: LTD, LLP, LLC, W.L.L, PVT LTD / PRIVATE LIMITED, their
  glued spellings (`"pvt.ltd"`, `"(P)LTD"`) and "& CO".
  - After two or more name words the form may also be INDUSTRIES, ENTERPRISES, CORPORATION or
    "CO.".
  - "limited", "company", "pvt" and "private" are never forms on their own: in worker Hinglish
    they are ordinary words.
  - Left raw as a kind of company: a span of sector words (`"auto ancillary industries"`,
    `"automobile pvt ltd company"`) and a lone generic adjective (`"korean pvt ltd company"`).
    Before a strong form only sector words count, so a brand stays a firm (`"siemens ltd"` masks).
  - A stopword can neither open nor sit inside the span, a job word sits nowhere in it, and a
    role, a department, a city or a form word never opens it:
    `"machine operator xyz pvt ltd"` → `"machine operator [EMPLOYER_1]"`,
    `"quality inspector bharat forge ltd"` → `"quality inspector [EMPLOYER_1]"`,
    `"pune tata motors ltd"` → `"pune [EMPLOYER_1]"`.
- **Title-case twins** (`_EMPLOYER_TITLE_FORM_RE`, `_EMPLOYER_ABSORB_RE`). The capitals grammar
  with title-case forms masks `"Sharma & Co."`, `"Xyz (P) Ltd"` and `"Acme Llp"`. Pvt and Private
  count only before Ltd or Limited, so `"Govt & Private Jobs"` stays raw. Like main's title-case
  and capitals rules, it takes a leading city.
  - The absorb pass folds into an existing token what the title-case rule left beside it: a
    trailing form (`"Tata Motors LTD"`), one or two name words before a joiner (`"Larsen &"`), a
    digit-led word (`"3M"`) or a word glued on by a dash (`"Hero-"`). It mints no token.
  - It leaves alone trade and sector words (`"Welding &"`), a city (`"Pune-"`), a duration
    (`"3Yrs"`) and any word holding 7 or more digits, so `"AB12345678-Tata Steel"` still blocks.
- **The M/S cue** (`_EMPLOYER_MS_CUE_RE`). "M/S", "M/s.", "M / S", "M/S:" or "M/S:-", then a firm
  that ends on a word naming a business.
  - "M/S" also abbreviates mild steel and metres per second, and a payer's verb or a locality
    often follows the firm. So the cue never follows a measurement, a number of one to three
    digits or a decimal up to three spaces before (`"3 m/s submersible pumps"`),
    and the firm never opens on mild-steel stock, a material, a unit, a role or a city. It ends
    on its firm word and leaves what follows raw: `"M/S SHARMA TRADERS BHOSARI ME HELPER"` →
    `"M/S [EMPLOYER_1] BHOSARI ME HELPER"`, `"M/S SHARMA TRADERS-BHOSARI"` →
    `"M/S [EMPLOYER_1]-BHOSARI"`, and `"M/s ABC Engineering Pvt Ltd requires CNC operators"` keeps
    "requires CNC".
  - A strong firm word (traders, fabricators, transport, sons, …) is enough. A generic one
    (works, parts, tools, engineering, …) is not, after mild-steel stock or, in lower case, after
    nothing but sector words: `"m/s truck body works"` and `"m/s power tools"` stay raw,
    `"M/S SHREE SAI ENGINEERING WORKS"` and `"M/s Precision Components"` mask.
  - A "firm" made of nothing but curated trade vocabulary is a skill (`"M/S PIPING SYSTEMS"`). A
    firm an earlier rule masked takes only a firm word right after its token (a joiner may come
    between), never words past it. A year may stand before the cue:
    `"2016-2019 M/S XYZ TRADERS"` masks.
- **Five or six name words** (`_EMPLOYER_LONG_RE`), only before a strong form: PVT LTD, PRIVATE
  LIMITED, LTD, LLP or LLC. "and" and the parenthesised joiners do not count as words.
  - It runs ahead of the capitals rule, whose 4-word window would leave the first word raw.
  - So it never holds a word where the capitals or title-form rule would end, and its form ends
    where that rule would not take the next word (a joiner costs no word, as in that rule). Either
  would let it cut a capitals span and
    leave that span's name raw (`"Hero Traders INDUSTRIES-PUNE …"`,
    `"…works LTD-patil MOTORS LTD"`).
  - No job word sits in it: `"MACHINE OPERATOR SHREE GANESH ENGINEERING WORKS PVT LTD"` →
    `"MACHINE OPERATOR [EMPLOYER_1]"`.
- **Shared rules.** Every span opens at a real word start and uses horizontal space only. Each
  pass is skipped on a text that lacks its mandatory piece (`_RULE_GATES`), which never changes an
  output. A pass that leaves a match as it is keeps that text's source offsets, so a later pass
  that masks it is seen by the two-view check.

**Measured** with every pass on against off, each string as written, upper-cased, lower-cased and
sentence-cased, after each of four review rounds:

- 50,918 repo strings (#1875's 31,984 plus 18,934 it lacked): 7 change as written, 7 upper, 72
  lower, 72 sentence. No string loses a mask, stops blocking or newly blocks. No certifier outcome
  moves over 5,507 labels in four casings. What changes is employers, public bodies and one line
  of NCO prose.
- 1,324 fabricated negative lines built to trip the passes: 7 over-mask as written (12 words), 6
  upper-cased, 3 lower-cased.
- 590 fabricated employers in 576 lines, caught as written before → after: lower case
  1% → 75%, title-case twins 32% → 99%, M/S firms 16% → 95%, five or more name words 27% → 78%.
- Two corpora the reviewers wrote to break the passes, firms bracketed: the third review's 804
  lines and the fourth's 678. Lines with a word main kept now inside a token fell from 243 to 94
  and from 162 to 30 over the last two rounds' fixes. What remains is the OVER list below (the
  industry shape: 28 of 30 and 11 of 36 lines built for it; generic company talk: 7 of 50 and 8
  of 61; mild steel: 10 of 78; 3 of 156 ordinary lines), firms the third corpus left
  unbracketed, and forms folded into a token. On the fourth corpus units, payer ads and roles are
  at 0, and the curated mild-steel skill labels certify as on main. Bracketed firms left raw fell
  from 98 to 60 lines, most of them M/S firms with no firm word.

**Declined on those numbers:** lower-case "limited" alone (+10 worker lines such as
`"programming ka knowledge limited hai"`), lower-case "company" (+12 repo and +11 worker lines),
weak forms after one word (+22 lines of NCO prose), an M/S cue without the mild-steel guard (+8
worker lines), an M/S cue with no firm word (71 of 125 mild-steel lines and 17 of 20 payer ads
over-masked), a weak form after an "-ing" word left raw (it cost `"sharma trading co."`), and an
8-word window (it bought nothing).

**Reviewed** by security, code, performance, red-team, mutation, claims and sweep passes over four
rounds and a final check:

- The first round's blocker: absorb leads had no 7-digit refusal, so a turn main blocked passed.
- The long pass could take part of a capitals span five ways: a form word inside it, a form with
  a dash after it, and its own form ending inside a capitals word (three times, the last one
  through a joiner the final check found).
- The M/S rule over-masked mild-steel talk, payer ads and localities until the firm-word rule
  replaced its never-after-a-number and next-cue guards. That re-opened `"M/S TOOL CRAFT"` (UNDER
  below), and the fourth round narrowed the number guard back to measurements.
- A pass that left a match as it is dropped that text's source offsets, so an invisible could hide
  a firm the visible text masked. It now keeps them, and those turns block.
- The worst cost on dotted text was ×5.3 its base; it is now ×1.1–1.4.

**Boundary, under.** Each case is a `KNOWN_RESIDUAL` test unless marked:

- a firm with no form and no cue (`"BAJAJ AUTO"`);
- lower-case `"bharat forge limited"`, `"omkar engineering company"`, `"gupta industries"`, and a
  strong form after nothing but sector words (`"precision engineering pvt ltd"`, unpinned);
- a stopword inside a firm (`"xyz and sons ltd"` → `"xyz and [EMPLOYER_1]"`, as title case does);
  a job word inside one loses the words before it (`"sharma fitter works ltd"` →
  `"sharma fitter [EMPLOYER_1]"`, unpinned);
- an M/S firm with no firm word (`"M/S TOOL CRAFT"`, `"M/S SIEMENS"`), opening on a stopword, a
  mild-steel word, a role word or a city (`"M/S PUNE SHARMA TRADERS"`), after a small number
  (`"1 M/S SHARMA TRADERS"`), before a dot or a slash (`"M/S SHARMA TRADERS.PUNE"`), generic in
  lower case (`"m/s precision components"`, unpinned), ending on a generic firm word after
  mild-steel stock (`"M/S BALAJI STRUCTURE WORKS"`), or with
  name words between a half-masked firm's token and its firm word
  (`"M/S Hanuman Steel Om Sai Traders"` → `"M/[EMPLOYER_1] Om Sai Traders"`, as main);
- in lower case, a weak form after nothing but sector words or curated vocabulary
  (`"water tech industries"`); a long name with a dot glued after its form
  (`"…PVT LTD.CHAKAN"` → `"RAMESH [EMPLOYER_1]CHAKAN"`, as main);
- 7 or more name words, 5 before a non-strong form, or 4 and a joiner
  (`"SRI SAI IRON AND STEEL PVT LTD"` → `"SRI [EMPLOYER_1]"`; main leaves "SRI" raw too);
- two spaces in "& co", a slash-glued first word, a firm wrapped across two lines, a city as a
  firm's first word (`"pune industrial gases pvt ltd"` → `"pune [EMPLOYER_1]"`), and a city glued
  on by a dash, dot or "&" (`"pune-tata motors ltd"` → `"pune-tata [EMPLOYER_1]"`).

**Boundary, over.** Each case is an `ACCEPTED` test:

- the absorb pass extends an over-mask the title-case rule already makes:
  `"Walk-In Interview For Quality Co-ordinator"` → `"[EMPLOYER_1]-ordinator"`;
- the long rule widens a capitals span on telegraphic text before PVT LTD;
- a weak form after two ordinary words or a product noun: `"garbage removal corporation"`,
  `"rice mill industries me loader"`, `"agarbatti making industries"` are masked;
- a city other than a span's first word is masked with it, as the capitals and title-case rules
  do (`"Pune Sharma & Co."` → `"[EMPLOYER_1]."`), and a locality outside the gazetteer or a job
  the lists lack opens a lower-case span (`"chakan bharat forge ltd"`,
  `"forklift tata motors ltd"` → `"[EMPLOYER_1]"`);
- a payer's benefit before "pvt ltd company": `"bus facility pvt ltd company"` →
  `"[EMPLOYER_1] company"`;
- trade talk ending on a generic firm word, unless a name word is mild-steel stock or, in lower
  case, every name word is a sector word: `"m/s hand tools se kaam"` →
  `"m/s [EMPLOYER_1] se kaam"`.

**The two views (R49, #1890).** `"Larsen &<U+200B>Toubro Limited"` now blocks; main passed it with
"Larsen" raw. Before #1890 these passes also extended R49's partial overlap, the way #1875 did:

- with an invisible character right after a name cue, `"my name is<U+200B>Ramesh Kumar Llp"` passed
  as `"my name isRamesh [EMPLOYER_1]"` (and the "& Co.", "(P) Ltd", "W.l.l", absorb and long
  lower-case shapes);
- with one that merges a word into a dash-glued run, `"Sharma Motors<U+2060>A-ONE Motors"` passed as
  `"Sharma [EMPLOYER_1]"`.

Main blocks every one of these, and since #1890 the branch does too: the 10 shapes, once
pinned as `KNOWN_RESIDUAL`, now assert the block. On the third
review's generator, 20,000 lines that each carry an invisible, main's own R49 name egress is 208
lines; these passes add 194 that main blocked (0.97%) and close 46 of main's. With invisibles in
2% of lines they add 3 in 20,000. Those turns reach the at-rest copies (corpus, growth queue,
payer draft) and the embedding input; the clean-or-withhold walls still withhold them. The
security review ruled SHIP with this residual registered and acknowledged by the owner; Divyanshu
Pant acknowledged it on 2026-10-03 (R49). #1890 fixed it in the two-view check (next section).

**Cost.** A typical worker turn costs 1–5 µs more on average; a line holding a lower-case employer
costs about 2.5–3× (25 → 64–70 µs). On the worst 20,000-character inputs the work is linear: every
word is a span start and each start reads at most six words. The reviewers' dotted shapes cost
×1.1–1.4 the gateway without these passes. The largest shares are one-letter words before a form
(`"b " × 9,990 + " ltd"`: 7 → 40 ms) and joiners (`"Ab (P) " × 2,850 + " ltd"`: 9 → 46 ms). No
input found adds more than about 37 ms. Load-proof tests pin each pass alone, the dotted shapes
within 2.5× + 20 ms of the base, and every worst input under 750 ms.

Pinned by `tests/test_pseudonymize_employer_residuals.py`, with shared helpers in
`tests/employer_masking_helpers.py`.

### The two-view check requires containment (issue #1890, risks-register R49)

`pseudonymize()` masks two views when an input carries an invisible format character or a Latin
combining mark (#1738 F1): the reader view, which deletes them and is what egresses, and the
spaced view, where each becomes a space. It fails closed when a spaced-view region is not covered
by the reader view's masks. Until #1890, "covered" meant the region merely OVERLAPPED a reader
mask. In `"my name is<U+200B>Ramesh Kumar Steel"` the reader view merges `"isRamesh"`, the cue
misses, and only `"Kumar Steel"` masks; the spaced view's name `"Ramesh Kumar"` overlaps that on
`"Kumar"`, so the turn passed as `"my name isRamesh [EMPLOYER_1]"`.

**The rule (`_is_covered`).** A spaced-view region is covered only when every offset of it the
reader view KEPT lies inside a reader mask, and (as before) it overlaps one. The offsets the
reader view deleted (the invisibles) are exempt, so a phone split by an invisible still masks as
one token. The overlap clause stays so the new check is never looser than the old one: it only
ever blocks more.

**Measured 2026-10-05, origin/main against the branch** (a scratch harness that loads both
modules; every input runs through both `pseudonymize()`s):

- **No invisible character: byte-identical.** The repo corpus (32,825 distinct strings, each as
  written, UPPER, lower and Sentence: 96,121) and every sampled line without an invisible
  (56,639): 0 results differ. This holds by construction: such text takes the fast path and never
  reaches the check.
- **With an invisible: only new blocks.** No turn stops blocking, no blocked turn changes its
  reason, and no turn that still passes changes its output.

  | input | with an invisible | newly blocked |
  | --- | ---: | ---: |
  | repo corpus x4 casings | 190 | 12 |
  | #1875 property sampler (seed 1875, 4,000) | 1,511 | 46 |
  | #1892 property sampler (seed 1892, 6,000) | 3,232 | 40 |
  | #1875 sampler, 40,000 more | 15,442 | 463 |
  | #1892 sampler, 40,000 more | 21,366 | 286 |
  | #1891 bound sampler, 20,000 | 11,894 | 517 |
  | corpus lines with one injected invisible, 40,000 | 39,916 | 31 |

- **Every newly blocked turn is the R49 shape.** The uncovered spaced region overlaps a reader
  mask and holds kept characters the reader view left raw. In 1,393 of 1,395 the invisible sits
  inside or right next to that masked span. In the other two it splits a name cue a few characters
  away (`"ke<U+2060>I AM CORPORATION STEEL"`: the spaced view reads the cue "I AM" and masks
  `"CORPORATION STEEL"`; the reader view masks only `"AM CORPORATION"`, so `" STEEL"` was raw), or
  it changes where a match ends (a trailing ".").
- **The price: over-blocks.** In 66 of the 1,395 the uncovered characters are only separators (a
  space, `-`, `.` or `&` between two reader masks), so nothing identifying was raw: for example
  `"Tata Steel industries<U+200C>pvt ltd"`. The rule follows the issue (every kept offset); it
  does not exempt punctuation. None of the 12 repo-corpus turns is of this kind. A blocked turn is
  withheld from the model, as every two-view block was before.
- **Cost:** within noise (about 150–170 µs a turn either way over 3,247 invisible-bearing lines);
  the new work is set arithmetic on the regions both passes already record.

Pinned by `test_a_name_hidden_by_an_invisible_beside_a_capitals_form_fails_closed` and
`test_r49_title_case_twin_that_predates_the_capitals_rule_fails_closed`
(`tests/test_pseudonymize_allcaps_employer.py`), `test_r49_shapes_the_1892_passes_reach_fail_closed`
(`tests/test_pseudonymize_employer_residuals.py`) and
`test_a_word_joined_past_64_blocks_beside_a_second_name_word`
(`tests/test_pseudonymize_title_employer_bound.py`). The #1875 and #1892 property tests now
assert that no "partial" turn passes.

### The cued-ID connector is linear (issue #1933, risks-register R54)

Three rules read the gap between a credential cue and its value with one connector:
`_CREDENTIAL_ID_RE` (every `pseudonymize` call, under both `AI_RAW_PII_ENABLED` postures),
`_RESUME_CUED_ID_RE` (in `contains_hard_identifier`, the G1/G2 floor of ADR-0047 §6) and the
salary detector's credential guard (`signals._CREDENTIAL_BEFORE_RE`, lexicon `credentialBefore`).
The API's TypeScript wall (`resume-parse-gates.ts`) ports the first two.

- **The defect.** The connector was `\s*(?:no\.?|number|num|#)?\s*[:\-]?\s*` (the résumé rule
  adds an `id` word). That is three whitespace quantifiers with only optional tokens between
  them. When a cue was followed by a whitespace run that then failed the digit lookahead, every
  split of the run was tried: O(k³). After a "no" word two quantifiers remained, so that branch
  was O(k²). The inputs are far under `DEFAULT_MAX_LENGTH`, and the calls run inline in
  `async def`.
- **The fix.** Each whitespace quantifier is folded into the optional token it follows:
  `\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]\s*)?`. The "no" word and the separator never start
  with whitespace, so after the leading `\s*` there is one reading of a run. It needs no
  possessive quantifier, so all five copies carry the same text: both Python rules, both lexicon
  copies (`[:-]`, the JavaScript u-mode spelling) and both TypeScript ports.
- **Why no match can move, on any input.** The two connectors accept the same strings. A
  backtracking engine tries the value's start positions in the same priority order under both;
  the old form only adds repeats of starts it already tried, or starts on whitespace, where the
  value's first character `[A-Za-z0-9]` can never match. What follows the connector reads only the
  start position. So the whole match, the value span, and therefore the mask, the G1/G2 verdict
  and the salary guard's verdict are unchanged.
- **Measured, not assumed** (`apps/ai-service/scripts/measure_cued_id_linear.py parity`). MAIN
  is each shipped rule with main's connector put back and nothing else touched. Every match is
  compared, whole span and value span, plus the guard's verdict on every slice the salary
  detector hands it.
  - 36,536 distinct strings of the repo's git-tracked text (service code and tests, the lexicon
    and its parity corpus, the shared hard-identifier fixture, the question packs and the
    job-domain corpus; `.jsonl` comment lines skipped), as written, with whitespace runs
    stretched, with separators spaced and upper-cased: 0 move. The corpus readers are
    `measure_title_employer_bound.py`'s, imported, so an untracked local file never enters it.
  - 60,000 seeded fuzzed cue lines: 0 move.
  - End to end over the 7,791 cue-bearing texts in those three views: 0 changes in
    `pseudonymize`, `contains_hard_identifier` or `signals.detect`.
  - The sensitivity run (`--against loose`, the `\s*` after the "no" word dropped) moves 22–26
    strings per view, 6,494 fuzz samples and 46–55 end-to-end results, so the harness does see
    a connector change.
  - `contains_hard_identifier` keeps exactly its verdicts, which is the G1/G2 requirement.
- **Timing**, `timing 3`: minimum of 3 interleaved runs on 2026-10-03, in ms. Main was not run
  at 20,000; its cubic cost there would not finish.

  | Entry point | Input | main | linear |
  |---|---|---|---|
  | `pseudonymize` | `"reg"` + 800 spaces + `"!"` | 1,599 | 0.2 |
  | `pseudonymize` | `"reg"` + 19,996 spaces + `"!"` | — | 5.8 |
  | `contains_hard_identifier` | `"passport"` + 800 spaces + `"!"` | 3,537 | 0.2 |
  | `contains_hard_identifier` | `"passport"` + 19,991 spaces + `"!"` | — | 6.4 |
  | `profile_extractor.extract` | `"reg"` + 800 spaces + `"!5000"` | 2,925 | 16.9 |
  | the TypeScript ports (V8, regex alone) | cue + 1,600 spaces + `"!"` | 1,891–1,960 | < 0.1 |

  `profile_extractor.extract` still takes about 7 s at 20,000 spaces. None of that is this
  connector, which costs 5.6 ms there. It is the salary matcher's own quadratic scan,
  risks-register R55 (b), which this change does not touch.
- **Pinned** by `tests/test_pseudonymize_cued_id_linear.py` (48 tests: the connector text in all
  three Python-read copies; a 750 ms timing backstop on `pseudonymize`, `contains_hard_identifier`,
  the three walls and the extractor; the corpus and fuzz differentials; the end-to-end run; the
  known cases and the four R56 shapes, pinned as residuals until #1950 and now masked; and the
  script, including its sensitivity variant, its shared corpus readers and a probe that an
  untracked file stays out of the corpus).
  `apps/api/src/profiling/resume-import/resume-parse-gates.linear.test.ts` and
  `packages/profiling-lexicon/src/values/salary-credential-guard.test.ts` do the same for V8.
  The tests were seen to fail on main's connector, on two semantic mutations and, with the rules
  intact, on a changed oracle. The counts are in the test file's docstring.
- **R56, fixed by #1950: a dot after the cue, a ":-" separator and the "regn" cue.** #1933 kept
  main's spans exactly, so it left the common certificate spellings unread: no connector token
  started with ".", the separator was one character, and "regn" was no cue. `"Reg.No.:- 123456"`,
  `"Reg.No.: MH2019CN4471"`, `"Regn. No. …"`, `"Roll.No-…"` and `"Passport.No: …"` never reached
  their value. The gateway left the ID raw (it has no seven-digit run for the residual net), G1/G2
  admitted the text, and the salary detector recorded the ID's digits as pay (123456, and 4471
  from `MH2019CN4471`). `pseudonymize()` builds the at-rest copies and the embedding input under
  both `AI_RAW_PII_ENABLED` postures, so this was not moot while the switch is armed.
  - **Three additive tokens, in all five copies** (`_CREDENTIAL_ID_RE`, `_RESUME_CUED_ID_RE`,
    lexicon `credentialBefore` and its mirror, both TypeScript ports): `\.?` straight after the
    cue word, "regn" among the credential cues, and `-?` after the separator (":-" and "--" read
    as ":" and "-"). None of them is whitespace and each is followed by a different class, so a
    run still has one reading and the rules stay linear.
  - **Every verdict only grows.** The accepted language is a superset, so no G1/G2 refusal, no
    certifier refusal and no salary-guard drop can be lost, and per cue every identifier character
    the old rule masked is still masked. The dot is TRANSPARENT: "Cue." decides exactly as "Cue"
    wherever the cue already ended on a boundary. So a number written straight after a
    sentence-final "certificate." masks, or is dropped as pay, exactly as one after "certificate"
    always was (pinned as `DECIDED`).
  - **The masked text is not monotone across cues (R62).** Found by the #1950 security review.
    The gateway's `sub` is non-overlapping and the cued-ID rule runs before the phone rule, so a
    cue's value runs to the end of its token. A newly read dotted cue can therefore take a later
    cue glued on by "/" (`"Cert. NAPS/2020/reg: 445566"` was `"… reg: [ID_1]"` and is now
    `"Cert. [ID_1]: 445566"`), or the first group of a spaced phone (`"Licence. 098765 43210"` was
    `"Licence. [PHONE_1]"` and is now `"Licence. [ID_1] 43210"`). The undotted spelling did exactly
    this already, so the dot extends an existing class rather than adding one. Only the masked
    text is affected: G1/G2 and the certifiers still refuse every such text. About 1 in 40,000
    multi-cue fuzz strings; none in the corpus. The candidate fix is to mask the union of the
    values matched from every cue start.
  - **Measured** (`scripts/measure_cued_id_dot.py`, 2026-10-06, on the rebased branch). PRE is
    each rule as #1933 shipped it.
    - `overmask` (#1875's method): 38,187 distinct strings of the git-tracked corpus, 2,646
      cue-bearing. In each of the four views (as written, whitespace stretched, separators spaced,
      upper-cased), 0 strings change in `pseudonymize`, `contains_hard_identifier` or
      `signals.detect`. 0 of 4,843 certifier labels change outcome. The corpus holds none of the
      new shapes, so the widening touches nothing it already held.
    - `fuzz`: 60,000 seeded cue lines. 0 decide less than PRE. 6,296 move, every one holding a new
      shape. In 15, a run of connector text PRE had swallowed into the value ("NO--" before an
      ID) is now read as the connector, so only the ID itself is masked; no digit is ever
      unmasked. The twin checks hold: 51,370 dot, 19,690 separator and 1,739 "regn" cases decide
      as their plain form.
    - `timing 3` (minimum of 3 runs, local, Python 3.14): at 20,000 characters on the new tokens'
      worst shapes, `pseudonymize` takes 5.9–16.5 ms, `contains_hard_identifier` 3.1–7.2 ms and
      the salary guard 1.4–3.5 ms; `profile_extractor.extract` is unchanged (4.2–4.4 ms either
      way at 1,000 characters).
  - **Pinned** by `tests/test_pseudonymize_cued_id_dot.py` (the shapes, the near misses decided
    as on PRE, the two `DECIDED` cases, the corpus and fuzz properties, timing at the size cap and
    the residuals). The V8 copies are pinned in `resume-parse-gates.linear.test.ts` and
    `salary-credential-guard.test.ts`; those #1933 differentials now compare against the unfolded
    connector carrying `-?`, so they still isolate the folding.
  - **Residuals, still open** (`KNOWN_RESIDUAL`): a SPACED dot (`"Reg . No . 123456"`) and a dot
    after "Num" / "Number" are not read, and neither shape is in the corpus. Reading `\s*\.` would
    put a whitespace quantifier in front of a token, a new #1933-class review. Nor are four
    pre-existing separator spellings the security review named: `"Reg No: - 123456"`, an en dash
    (`"Reg. No. – 123456"`, which Word's autocorrect produces), `"Reg No #123456"` and
    `"Reg.No.=123456"`. Each leaves the ID raw, G1/G2 admits it and its digits are pay, on the #1933
    rules and here alike. Separately, the
    salary guard holds the credential cues only, so a passport number G1/G2 refuses
    (`"Passport No. M123456"`) is still recorded as pay. #1950 reads the dot in the guard but adds
    no cue to it; the owner split that out as #2043 (2026-10-06), because "account" and "a/c" can
    sit right before a real wage. The sentence-end transparency was confirmed by the owner the
    same day.

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
  - **R48 — employers in capitals (issue #1875).** Fixed for a capitals span that ends in a listed corporate form. #1892 then masked lower case, M/S firms that end on a firm word, 5–6 name words and the title-case twins (see "Employer shapes the capitals rule left raw"). Still open: no corporate form and no cue (`"BAJAJ AUTO"`), INC/EST., a dash after a guarded form (`"MARUTI COMPANY-PUNE"`), and the residue the #1892 section lists; the R49 two-view shapes #1892 extended block since #1890. The title-case `_EMPLOYER_RE` stall found in the #1875 section is bounded by #1891: its name word now has the capitals rule's 64-character bound, and no corpus output moved. The owner signed off on 2026-10-03 (see #1891's sign-off and R48). Unlike R30/R32, this is NOT moot while the switch is armed. The at-rest masked copies, the embedding input (SG-2, ADR-0047 §4) and the certifiers run `pseudonymize()` under both postures. The Langfuse and `ai_call_traces` sinks follow the flag (`trace_mask`), so they are covered only while it is off.
  - **R49 — the two-view check accepted a partial overlap (#1890).** Pre-existing (#1738); extended by #1875 and #1892. A name hidden by an invisible character next to a masked employer span egressed unblocked: `"my name is<U+200B>Ramesh Kumar CO"` → `"my name isRamesh [EMPLOYER_1]"`. MITIGATED by #1890: a spaced-view region now counts as covered only when every offset of it the reader view kept is reader-masked, so those turns block. Text with no invisible character is byte-identical (it never reaches the check). See "The two-view check requires containment".
  - **R54 — the cued-ID rules stalled on a whitespace run. RESOLVED by #1933.** Pre-existing; found by the #1891 survey. `_CREDENTIAL_ID_RE` and `_RESUME_CUED_ID_RE` put three whitespace quantifiers in a row, so a cue followed by a whitespace run that failed to match cost O(k³): `pseudonymize("reg" + " " * 800 + "!")` took 1.7–4.0 s over three runs, whatever `AI_RAW_PII_ENABLED` says. Each quantifier is now folded into the optional token it follows, in both rules, the salary guard's lexicon copy and the API's TypeScript ports: 0.2 ms on that input, with 0 span differences over the corpus and the fuzz. See the section on the cued-ID connector. The `"Reg.No."` shape the connector never read stays a pinned residual, tracked as R56.
  - **R56 — the cued-ID rules never read a dot after the cue. MITIGATED by #1950.** Pre-existing; found by the #1933 parity work. No connector token started with "." and "regn" was no cue, so `"Reg.No.: MH2019CN4471"`, `"Reg. No. …"`, `"Roll.No. …"`, `"Cert. No. …"`, `"Passport.No. …"` and `"Regn. No. …"` never reached their value: `pseudonymize()` left the ID raw, `contains_hard_identifier` (G1/G2) admitted it and the salary detector recorded its digits as pay. Unlike R30/R32, this was NOT moot while `AI_RAW_PII_ENABLED` is armed: the at-rest copies, the embedding input and the walls run `pseudonymize()` under both postures. #1950 reads `\.?` after the cue word, "regn" and `-?` after the separator, in all five copies. Every verdict only grows, and 0 of 2,646 cue-bearing corpus strings change, in four views. The masked text is not monotone across cues (R62, pre-existing on the undotted spelling). A spaced dot, four separator spellings and the salary guard's missing résumé cues (#2043) remain; see the section on the cued-ID connector and R56.
