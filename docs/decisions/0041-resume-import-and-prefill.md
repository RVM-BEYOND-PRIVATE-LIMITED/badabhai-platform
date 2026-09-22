# ADR-0041: Résumé import — parse an uploaded document, route it, and prefill the profile

- **Status:** **Accepted and signed** — owner rulings taken 2026-09-10, the person-name ruling
  in §3.3 taken 2026-09-11, signed 2026-09-11. Signature block at the foot.
- **Date:** 2026-09-10
- **Owner:** CEO / Prakash
- **Amends, narrowly and only as scoped in §3:** [CLAUDE.md](../../CLAUDE.md) §2 _Privacy First_
  (_"Raw PII must never appear in LLM prompts"_) and the owner ruling of **2026-08-28** recorded
  at [packages/db/src/schema/employment.ts:31-32](../../packages/db/src/schema/employment.ts)
  (employer names _"never through the AI service"_). Every other clause of both stands unchanged.
- **Relates:** [ADR-0029](0029-voice-audio-at-rest-and-upload-seam.md) (the upload seam this
  copies) · [ADR-0032](0032-worker-profile-photo.md) (the confirm-step and dormancy idiom) ·
  [ADR-0007](0007-resume-render-node-boundary.md) (résumé _generation_, which this does not
  touch) · [ADR-0005](0005-metadata-driven-multi-profile-profiling.md) (the capture/match split)
- **Implemented by:** phases **RI-1 … RI-7** (see §7)

---

## 1. Context

A worker arriving at BadaBhai starts from nothing. After `/consent → /name` — one screen taking
his name, city and state — he lands in the chat and is asked his trade from scratch. A worker who
already owns a résumé re-types, one bubble at a time, everything he has already written down.

That is not only a courtesy problem. The interview has a hard budget:
`MAX_ENGINE_ASKS = 28` ([apps/api/src/profiling/next-question.ts:71](../../apps/api/src/profiling/next-question.ts)),
of which `qp_universal@2` always spends 8, and the ask-budget audit records a senior CNC turner
already spending 23. Every question a résumé could have answered is a question the engine cannot
afford to spend on his trade depth — which is the half that actually differentiates him to an
employer.

> **SUPERSEDED IN PART (owner policy 2026-09-18, PR #1582).** The paragraph above is the budget as
> it stood when this ADR was written. `MAX_ENGINE_ASKS` was then raised 28 → **48** ("budget is
> NOT a constraint; app feel is paramount"), `MAX_ASKS_PER_QUESTION` 2 → 4, and the Layer A
> elicitation (`qp_universal@4`, a further 8 asks) landed on top of it; the worst-case walk is
> now 36 with headroom 12. The motivation this section states — a résumé saving the engine asks it
> can spend on trade depth — remains true; the hard ceiling it cites is not.

**What makes this cheap to build.** The form-versus-chat decision this feature needs already
exists, and it is already deterministic.
[`routeToTradeForm()`](../../apps/api/src/profiling/trade-form-router.ts) takes two free-text
labels the model produced — `domain_label` and `role_label` — and decides against a closed table
with a two-tier evidence rule and a conflict veto. A résumé feeds the same two labels into the
same function. **No new decision logic, and no new authority for the model**, which keeps §3 of
CLAUDE.md ("AI never owns business decisions") intact by construction rather than by review.

**What makes it delicate.** A résumé is the densest single artefact of personal data a worker
owns: name, address, email, employers, dates, past salaries, and not rarely an Aadhaar or PAN
number. Every existing path into this platform was built so that document never had to exist.

---

## 2. Decisions

Nine, taken 2026-09-10. The reasoning attached to each is the reasoning that was actually used.

| #      | Decision                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Résumé upload is covered by the existing `profiling` consent purpose.** No tenth purpose is minted.                                               |
| **D2** | **Facts are prefilled; capability claims are suggested UNTICKED.**                                                                                  |
| **D3** | **PDF, DOCX and photo/scan (OCR) are all accepted.**                                                                                                |
| **D4** | **Résumé text never prints on a BadaBhai résumé.** The upload is a draft-filler, never evidence.                                                    |
| **D5** | **The résumé is sent to the LLM entirely unmasked** — employer names, and (amended 2026-09-10) government identifiers, phone and email too. See §3. |
| **D6** | **The uploaded file is retained permanently.**                                                                                                      |
| **D7** | **A stored answer always wins.** A résumé value that disagrees is offered, never applied.                                                           |
| **D8** | **Sign-up only** in v1 — no upload from the profile tab.                                                                                            |
| **D9** | **An unreadable file is said so plainly**, and the worker continues in Hinglish. **Amended 2026-09-22 (#1654):** the identity summary survives a parse failure that was OURS — see §10.           |

**D1 — why not a tenth purpose.** The `voice_processing` precedent
([packages/types/src/index.ts:56-74](../../packages/types/src/index.ts)) minted a separate purpose
on the argument that _"consenting to be profiled is consenting to ANSWER QUESTIONS, not to be
RECORDED"_, and the same argument extends to handing over a document. The owner ruled the other
way: a résumé is a profiling input, the worker is volunteering it for exactly the purpose he
already consented to, and a tenth purpose would make the feature unusable until DPDP notice copy
that does not yet exist gets written — the state `employer_sharing`, `whatsapp_messaging`,
`agent_activity_visibility` and `voice_processing` are all in today. **`CURRENT_CONSENT_VERSION`
is NOT bumped** and no client requests anything new. A `security-engineer` gate runs before merge.

**D2 — why capability chips arrive unticked.** The trade form is mostly closed-option _capability_
claims: 15 of `qp_cnc_turning`'s 18 items are questions like which controller, which workholding,
what tolerance band. §5.3 of the résumé guideline calls an unclaimed capability upgrade _"the most
damaging failure available to us"_ — it surfaces at the machine trial, in front of the employer,
with the worker holding the sheet, and it is the failure the transcript veto
([apps/api/src/resume/resume-transcript-veto.ts](../../apps/api/src/resume/resume-transcript-veto.ts))
was built to prevent. A pre-ticked box that a worker taps past is a claim he never made. So: years,
city, education, trade and work history prefill normally; capability chips render highlighted and
**unticked**, and a tick remains what it has always been — the worker's own claim.

**D4 — why résumé text cannot print.** §8 of the résumé guideline is not a review habit, it is an
executable gate
([apps/api/src/resume/resume-fabrication.gate.test.ts](../../apps/api/src/resume/resume-fabrication.gate.test.ts)):
every printed string is a closed-vocabulary label, a number the worker stated, or his own words
verbatim — _"there is no fourth source"_. An uploaded résumé is a fourth source. Rather than amend
§8, the import is scoped as a **draft-filler**: what prints is what the worker confirmed, which is
already a first-class source. Every existing gate stays intact and meaningful. (#1350's
`work_done_polished` remains the sole §8 override, for one field, and is not widened here.)

**D7** falls out of D2's mechanism for free — see §5.

---

## 3. The privacy override (D5) — exact scope and conditions

This is the one place this ADR deliberately crosses a line the codebase currently enforces in
running code. It is written out in full so that nobody later rediscovers it as a defect.

### 3.1 What is overridden

Two statements, both of which hold on `main` today:

1. **CLAUDE.md §2** — _"Raw PII must never appear in: LLM prompts…"_
2. **The 2026-08-28 owner ruling**, recorded in the schema at
   [employment.ts:31-32](../../packages/db/src/schema/employment.ts): an employer name arrives
   _"from a question the WORKER TYPES, written straight to Postgres, never through the AI
   service."_

The owner was shown the cost twice, including an alternative that delivers the identical
worker-facing outcome (the model sees `[EMPLOYER_n]` and cites a line index; the API server
recovers the real name from that line locally, so the model never sees it) and reaffirmed the
direct reading. That alternative is recorded here as **considered and declined**, not as
unexamined.

### 3.2 The scope, stated as narrowly as it can be

The override applies to **one task type, one route, one input class, behind one flag**:

- Task type `resume_parse` only. No other route's masking changes in any way.
- Input = text extracted from a document **the worker himself uploaded in this session**. It does
  not extend to transcripts, chat turns, voice notes, or any value already stored.
- Behind `RESUME_PARSE_RAW_TEXT_ENABLED`, default `false`. With the flag unset the route runs
  fully masked or not at all.

  **Amended 2026-09-15 (owner ruling): the flag is reachable, default off.** Until then the name
  was absent from every compose file, which made it unarmable rather than merely off — compose
  forwards only declared names, and no service has `env_file:`. It is now declared on the
  `ai-service` service only, in `docker-compose.staging.yml`, as
  `${RESUME_PARSE_RAW_TEXT_ENABLED:-false}` (`:-false`, because pydantic rejects `""` for the
  bool and the service would not boot). **Arming:** the owner sets it in the box's `.env` after a
  security check and **re-runs the deploy job** — compose interpolates the box `.env` for any name
  ci.yml does not bridge (measured on the production box 2026-09-11 with `RESUME_UPLOADS_BUCKET`).
  Never a manual `docker compose up` on the box: on 2026-09-11 that bypassed the CI secret bridge,
  baked a wrong `REDIS_URL` into the api container and took production login down. **Never a
  ci.yml bridge:** it would be a second arming path that overrides the box value.
  `test_the_flag_is_armed_in_no_committed_file` (apps/ai-service/tests/test_resume_parse.py)
  permits exactly that one compose line and is red for a truthy or empty default, a literal, a
  declaration on another service or in another compose file, an env-file assignment, or any
  occurrence under `.github/`; `real-call-posture-compose.guard.test.ts` pins the same line from
  the api side.

  **Amended 2026-09-16 (security review): closed a case-sensitivity gap in both guards, before
  either landed on `main`.** `Settings` never sets `case_sensitive`, so pydantic-settings reads
  `resume_parse_raw_text_enabled` (or any other case) as the identical field as the SCREAMING_CASE
  name — a committed line spelled that way, sitting beside the correct declaration, would have
  armed the flag while `test_the_flag_is_armed_in_no_committed_file` reported `hits == []`, because
  its own membership test compared the uppercase name against file text as written, and
  `compose-env.ts`'s key regex (`[A-Z_][A-Z0-9_]*`) could not even produce a map entry for a
  lowercase key. Both scans are now case-insensitive on detection while staying byte-exact on the
  one line they allow, proven with a case-variant fixture that is red against the pre-fix code and
  green after. The `ai-service` leg of `ci.yml`'s path filter also now includes
  `docker-compose*.yml`, so a compose-only PR runs the Python scan at all — before this it did not,
  which is the shape the vulnerable line above would have taken. **Residual, stated rather than
  hidden:** both scans read only files matching a known config-file shape (`.yml`/`.yaml`/`.env`/
  `.example`/`.sh`/`.toml`/`.dockerfile`, or an `.env`-prefixed or `Dockerfile`-prefixed name, or a
  path containing `.env.`); a declaration in a file shape outside that list, or a homoglyph
  spelling of the key, is not caught by this PR and is not claimed to be.

  **A second, independent lock (noted, not new):** arming `RESUME_PARSE_RAW_TEXT_ENABLED` alone
  does not send anything unmasked to a real provider. `AIRouter` gates every call, `resume_parse`
  included, on `Settings.real_call_enabled_for(task_type)` — `AI_ENABLE_REAL_CALLS` (default
  `false`, `docker-compose.staging.yml`) AND the task type named in `AI_REAL_CALL_TASKS` (default
  `profiling_chat_turn` only, which does not name `resume_parse`). With either lock closed, a raw
  résumé built by this flag still goes to the mock path, not Gemini or Claude.
- **Nothing is masked. The document goes to the model exactly as extracted** — amended by owner
  ruling **2026-09-10**, superseding this ADR's first draft, which held back government
  identifiers, phone numbers and email addresses. The owner's words: _"go fully raw no need to
  hide anything to the ai right now."_

**What that costs, recorded because an ADR that hides the cost is useless.** Engineering's
narrowing was argued on two grounds and both still stand — they were heard and overruled, not
missed:

1. _It buys nothing for parsing._ No form field is filled by a PAN, and the platform already holds
   the worker's phone. These identifiers are transmitted without a task that needs them.
2. _Aadhaar and PAN are not the same class of fact as a name or an employer._ Aadhaar in
   particular carries statutory handling constraints of its own (Aadhaar Act §29 on sharing and
   storage) that a name does not, so this is not simply "more of the same personal data".

Combined with ruling **D6** (permanent retention) the exposure is standing rather than transient:
the source document is kept indefinitely and every parse of it transmits whatever it contains.

**The `right now` in the ruling is load-bearing and is carried into the design.** This is the
alpha posture, not a permanent property. The masking policy therefore lives behind
`RESUME_PARSE_RAW_TEXT_ENABLED` rather than being compiled into the prompt builder, so tightening
it later is a config change plus a test, not a re-plumb. RI-3 implements the flag as a switch
between `default_masker` and `passthrough_masker`, and nothing else.

`passthrough_masker`
([apps/ai-service/app/profiling/parse_masking.py](../../apps/ai-service/app/profiling/parse_masking.py))
is the existing mechanism and is today reachable only under `AI_SYNTHETIC_PERSONA_MODE`. RI-3
extends it to this one production route. **That flag, and the masking policy above, is the whole
of what a security review needs to examine.**

### 3.3 What does NOT change, and ships as conditions of the override

- The Langfuse `mask=` hook stays on, so **traces are still pseudonymized**;
  `AI_CALL_TRACE_TEXT_ENABLED` stays `false`.
- **Events remain counts-only and `.strict()`.** No résumé text, no field values, no filename, no
  storage key in any payload, log, or `ai_jobs` row.
- The six parse gates still run, and still run **twice** — in the ai-service and again in Nest.
  Gate 6 (PII re-certification) is relaxed for this route's _inputs_; it is **not** relaxed for
  what leaves the request. **A consequence RI-3 must handle deliberately:** with unmasked input,
  the model can now return a real identifier inside a parsed value, so Gate 6 stops being a
  formality on this route and becomes the thing that decides what may be persisted and what may
  be shown back. An identifier the model echoes into a field is dropped, not stored — the
  document may reach the model, but a PAN must still never reach `worker_attributes`, an event, a
  log, or the sheet. **Both the value and the cited span are certified**; RI-3's security review
  found the span riding out uncontrolled, which is the failure this bullet used to describe
  incorrectly.

- **What Gate 6 refuses, stated exactly, because an earlier draft of this section overstated it.**
  The wall is `contains_hard_identifier`, and it refuses seven classes: PAN, Aadhaar, phone,
  email, cued credential ids (passport, voter, GSTIN, UAN, ESIC, PF, IFSC, account, DOB), digit
  runs of 14 or more, and bare GSTIN. **A person's name is NOT among them, and is knowingly not
  dropped.** This paragraph used to say a name was; it was not, and saying so made the document
  the least reliable thing in the review.

  **RULED 2026-09-11 (Prakash), option (a) of the open question this replaces: record it, do not
  gate on it.** The reasons, measured rather than assumed:

  | input | `pseudonymize()` returns |
  |---|---|
  | `Ramesh Kumar` | `Ramesh Kumar` — **unchanged** |
  | `My name is Ramesh Kumar` | `My name is [PERSON_1]` |
  | `1200000` | `[AMOUNT_1]` |

  The gateway's name detection is **cue-based**, and a résumé prints a bare name with no cue in
  front of it. Certifying résumé values through the full gateway would therefore refuse a worker's
  own stated salary while still admitting the name it was meant to catch. The gazetteer that would
  have caught a bare name is recorded measured-dead (R32 — 487 probes, 348 leaks). There is no
  reliable person-name detector in this codebase to narrow to, so the honest choice was between
  saying so and blocking the feature behind building one.

  **The exposure this leaves, stated plainly.** A worker's own name may survive into his own
  `role_label` or a suggestion staged against his own profile. It is his name, on his record,
  visible to him — and D5 already sends the whole document, name included, to the model, so this
  adds no new recipient. It is not a new egress path: the four conditions above are unchanged —
  traces stay pseudonymized, events stay counts-only, and the résumé never prints on the sheet
  (D4) — so a name reaches no sink it could not already reach. If a name detector is ever built,
  this bullet is where it gets wired in, and gate 6 is the single place that has to change.
- A test that fails if the raw path is reachable with the flag unset. It must fail loudly and must
  not arm vacuously on an empty string — the `AI_INTERNAL_TOKEN` lesson (TD67).
- `security-engineer` gate before RI-3 merges.

### 3.4 Why it had to be recorded rather than just done

`docs/agent/BUILD_RULES.md` makes code that contradicts a signed ruling a full stop, and holds
that a signed ruling is overridden only by another signed ruling. Without this ADR the next
engineer opens `employment.ts`, finds running code doing the opposite of its docblock, and
correctly halts. **The docblock is amended in the same change that lands this ADR**, pointing here.

### 3.5 The cost, stated plainly

D5 combined with D6 (permanent retention) means the entire contents of every
imported résumé are transmitted to a third-party model provider, and the source document is
retained indefinitely. Account deletion is therefore **the only erasure path**, and its coverage
becomes load-bearing in a way it was not before — hence the explicit erasure test in RI-1. This is
a deliberate, signed trade, not an oversight.

---

## 4. Architecture

The upload seam is ADR-0029's and ADR-0032's, route for route, and is not redesigned:

```
POST /profiling/resume-import/upload-url   → { storage_path, upload_url, expires_in }
        (503 while RESUME_UPLOADS_BUCKET is unset — fail-closed dormancy)
client PUTs directly to the private bucket
POST /profiling/resume-import              → minted-key regex, mime + size via getObjectInfo,
                                             row + BullMQ enqueue
   ai-service  POST /resume/parse          → downloadObject → extract → mask per §3.2
                                             → one LLM call (cite or null) → gates
   Nest                                    → gates again → OccupationService.resolve
                                             → routeToTradeForm() → stage suggestions
GET  /profiling/resume-import/:id          → { status, route: 'form' | 'chat', counts }
```

**Amended 2026-09-15: the parse and the route settle in ONE write.** The first cut wrote
`status = 'parsed'` from the parse step and `route` / `form_kind` / `suggestions_enc` from the route
step in a second UPDATE. A client polling between the two read a terminal `parsed` beside a null
route — which it treats as chat — and form-routed workers were sent to the chat. Now
`ResumeImportRepository.settleParsed` is the only writer of every parse-derived column: one UPDATE
sets status, route, form kind, the staged token and the extraction facts together,
`WHERE status = 'parsing'`. `markFailed` carries the same guard. A successful parse writes no
status; `extraction_method` is narrowed to the closed set, and a success without one is recorded
as `parse_output_invalid`. A pack registry that cannot load degrades to the chat route with
nothing staged (D9). A suggestion payload that cannot be built or encrypted is a fault, not an
outage: it throws and nothing is settled (CLAUDE.md §3). No migration was needed — the single
UPDATE satisfies every `wri_*` CHECK.

`GET :id` is deliberately **not** purpose-gated, following the reasoning already written at
[voice.controller.ts:77-84](../../apps/api/src/voice/voice.controller.ts): withdrawal must stop
new processing, not hide from a worker what he already owns.

**OCR runs locally.** Tesseract (`eng` + `hin`) inside the ai-service container — no cloud vision,
no Document AI, no new sub-processor. `Message = dict[str, str]` in
[apps/ai-service/app/ai/router.py:40](../../apps/ai-service/app/ai/router.py) stays text-only:
**no multimodal content blocks are added.** Order: PDF with a usable text layer → read directly;
PDF with an empty or garbage text layer → rasterize and OCR; image → OCR; DOCX → `python-docx`.
Below an OCR confidence floor the import degrades to the ordinary flow and says so (D9), matching
the _"DEGRADES, NEVER FAILS"_ posture `/profile/parse` already holds.

---

## 5. Suggestions are staged, never written as answers

D2 requires that a parsed value is never persisted as a claim before the worker confirms it. So
parsed values are held on `worker_resume_import.suggestions` and merged into the form response as
a new, additive field beside the existing one:

```ts
{ type: "question", question, ui,
  answer:     SavedAnswer | null,                                  // unchanged
  suggestion: { values, source: "resume", confidence } | null }    // NEW
```

Four consequences, all of them good:

- **No migration to `worker_pack_answer` at all.** Its `source` enum (`chat | chip | form | ops`)
  is untouched, because nothing is written there until the worker acts.
- An abandoned import leaves **zero** claims behind.
- A confirmed answer flows through the existing `POST /profiling/form/answer` with
  `source: 'form'`, so every downstream projector, gate and event is untouched.
- **D7 is free**: a question that already carries an `answer` keeps it, and the résumé's value
  simply appears as the `suggestion` beside it. Nothing the worker told us is ever silently
  overwritten — the same rule `PARSE_SYSTEM_PROMPT` already states as _"NEVER CHANGE AN ANSWER"_.

---

## 6. What this does and does not supersede

**Does:**

- CLAUDE.md §2, for the `resume_parse` task only, on the terms in §3.2.
- The 2026-08-28 employer-name ruling, for résumé-derived employer names only. Employer names
  arriving by any other path are still worker-typed and still never reach the AI service.

**Does not:**

- §8 of the résumé guideline. D4 keeps all three sources; #1350 remains the only override.
- ADR-0036's rank tuple, the month bucket, the feed order, or any matching input.
- The masking of any existing route, the closed `notes` vocabulary, or the double-wall gate
  discipline.
- The rule that an LLM never produces, chooses or approves a canonical ID. The model selects among
  option keys **supplied to it from the pack**; canonicalization stays with `canonicalize_skill`
  and `OccupationService`.
- `CURRENT_CONSENT_VERSION`, or the purposes any client requests.

---

## 7. Consequences

- **Additive throughout.** One new table (`worker_resume_import`), one new bucket, one new
  controller, one new ai-service route, one additive field on an existing response. The
  "no résumé" door is the path that ships today, byte for byte — pinned by a test.
- **Dormant on arrival.** `RESUME_UPLOADS_BUCKET` defaults to `""` and the three processing
  routes 503 until it is armed, exactly as voice and photo do.
- **The raw-text switch is reachable but off (amended 2026-09-15).** One additive compose line on
  the `ai-service` service resolves to `false`, identical to the behaviour before it; arming is
  the box `.env` plus a deploy re-run, and a commit cannot arm it (§3.2).
- **New dependencies** in the ai-service: `pypdf`, `python-docx`, `pytesseract`, `Pillow`,
  `pypdfium2`, plus the `tesseract-ocr` binary and `eng`/`hin` traineddata in the image.
  **`pypdfium2` rather than the `pymupdf` an earlier draft named**: PyMuPDF is AGPL-3.0, which a
  closed-source service cannot take on, while pypdfium2 is Apache-2.0/BSD-3. Same job —
  rasterizing a page so Tesseract can read it — with a licence we can actually ship.
- **Erasure is load-bearing** (§3.5): `deleteByPrefix("resume-uploads/{workerId}/")` in
  `AccountDeletionService`, with its own test.
- **Prefill coverage is unmeasured and must not be claimed.** 15 of 18 CNC-turning items are
  capability claims a real worker résumé rarely carries; and only **9 of 21** declared roles have
  a form at all, so most workers route to chat regardless. RI-7 measures per-field coverage and
  error rate over a real corpus before any worker-facing claim about time saved is made.
- **Events are exactly-once per import (amended 2026-09-15).** `profile.resume_parsed` and
  `profile.resume_parse_failed` are emitted on the same transaction as the guarded status write,
  only when that write matched a row, and with idempotency keys
  `profile.resume_parsed:<importId>` / `profile.resume_parse_failed:<importId>`. The
  `resume_parsed` payload is validated before the transaction opens, so a schema bug never holds
  a row lock; `resume_parse_failed` carries only closed enums and ids and is validated by `emit`
  inside the transaction. Payload shapes are unchanged (additive only).
- **Retries never re-bill, and can strand a row (amended 2026-09-15).** A throw after the AI call
  (a failed seal, a database error inside the settle) rolls back to `parsing` with no event. The
  BullMQ redelivery sees a row past `uploaded`, does not read the document again, and completes
  with `route: null`. The row stays `parsing` until a sweep marks stale rows
  `parse_deadline_exceeded` — **that sweep does not exist yet and is owed before real traffic.**

## 8. Open

1. ~~**Fully raw, or raw-except-identifiers?**~~ **RULED 2026-09-10: fully raw.** Kept as a record
   of what was asked rather than as an open item — see §3.2 for the ruling, the two arguments it
   overruled, and the `right now` that makes it the alpha posture rather than a permanent property.
2. ~~**A person name is not dropped, and §3.3 said it should be.**~~ **RULED 2026-09-11: it is
   knowingly not dropped, and §3.3 now says so.** Raised by the RI-3 security review; kept here as
   a record of what was asked rather than as an open item. The measurement that decided it, and
   the exposure it leaves, are in §3.3 beside the wall itself rather than here, so the next reader
   hits them where the decision is enforced.

3. **DPDP notice copy.** D1 blocks nothing, but the notice a worker reads still does not mention
   handing over a document. Best written in one pass alongside the outstanding `employer_sharing`
   and E4 copy.

## 9. Amendment 2026-09-15 — the universal append is removed from trade forms (#1503)

**What changed.** `f455bb36` (2026-09-12) made §5 work for résumé facts by appending all eight
`qp_universal@2` questions (`primary_trade`, `experience_years`, `current_city`,
`salary_expected`, `preferred_locations`, `availability`, `education`, `shift_preference`) to every
trade form, so a suggestion keyed to one had a question to sit beside. Five of those were facts the
same form already asked: the tier question, and the Preferences and Qualifications pages served a
few screens later. Workers answered them twice, and the page's write raced the question's. #1503
removes the append. `GET /profiling/form` serves the trade pack's visible questions and the marker
pages again, exactly as before `f455bb36` — except `contextFor`'s résumé-import fallback and the
resulting nullable `session_id` (both from `f455bb36`) are deliberately **kept**, fixed forward
rather than reverted, so a worker routed to a form by his résumé still reaches it with no chat
session behind it.

**Owner rulings (2026-09-15)** that bind this:
- Résumé facts live on the pages that **own** them (Preferences, Qualifications, Work History).
  They never get extra question screens.
- The pages own shift, preferred city, salary and education.
- `primary_trade` is removed from trade forms.
- `f455bb36` is fixed forward, not reverted.

**The legacy-key shim.** An app holding a pre-deploy schema can still `POST /profiling/form/answer`
with one of those eight keys. A 400 would strand the worker on that screen, because skipping POSTs
the same key (CLAUDE.md §3). Those eight keys, and only those, are accepted from a frozen literal
(`legacy-universal-answer.ts`). Each is answered 200 with `schema_stale: true` so the app re-fetches.
The row is stored where `f455bb36` stored it, under the trade pack id. The shim writes **no**
`worker_attributes` row and runs **no** completion evaluation. It logs the key slug and counts,
never the value. Remove it once that log reads zero across a release window.

**Numbers.** Form number fields now accept exactly one numeric token. The old digit-strip stored
"pata nahi" as 0 and "5 se 7 saal" as 57. Trade questions 400 on anything else; the shim declines.

**The gap, recorded rather than implied away.** §5's "suggestion beside the question" no longer
holds for the universal facts. **On current app builds, a worker routed to a form by his résumé sees
none of his résumé's experience, city, salary, education or availability anywhere** until the owning
pages render suggestions. That work is tracked on #1503/#1504. Suggestions keyed to his trade pack's
own questions are unaffected. A worker-fact registry (`apps/api/src/profiling/facts/`) now names
every spelling of each fact across packs, pages and tables. It is the foundation those pages build on.
That exhaustiveness is held over alias **names**, not per kind: `trade`, `experience`,
`current_city`, `salary_expected`, `education` and `availability` are RFS crosswalk fields that
never produce a `worker_attributes` row, so they are registered only under `target_field` /
`worker_column`, and a reader of the registry must not assume every fact settles under
`attribute_key`.

## 10. Amendment 2026-09-22 — D9: the identity line survives OUR failure, not the document's (#1654)

**Owner ruling (2026-09-22), option C on #1654.** The "Kya ye aap hi hain?" identity summary must
survive a failed parse **only when the failure was ours, not the document's**. The closed set is
exactly two `worker_resume_import.failure_reason` values:

| Reason | Why it is OURS |
| --- | --- |
| `parse_output_invalid` | The document was read. The model's reply failed its contract — or named an extraction method outside the closed set. |
| `parse_deadline_exceeded` | The document was read. The reply never arrived in time. |

On both, extraction SUCCEEDED and only our own model reply was unusable, so the summary pipeline
stands on **exactly the text a clean parse would have stood on**. A worker whose CV we read
perfectly well no longer loses his first bubble to our defect.

**The other six stay silent, and are silent twice over.** `no_text_layer`, `encrypted_document`,
`empty_document`, `unsupported_document`, `ocr_below_floor` and `parse_unavailable` are not
filtered out by anything except the set above — and they would still stage nothing if they were,
because the summary pipeline runs its **own** `extract()` over the same object and degrades inside
it. The closed set is therefore not what makes them silent; it is what stops us paying a storage
fetch and a second model call to rediscover that they are. Recorded here because the next reader
will otherwise try to simplify the set away.

**What moved: the failure settle, not the failure.** `ResumeParseService.fail()` ran `markFailed`
(status `failed`) and emitted `profile.resume_parse_failed` in one transaction and only then
returned the draft — so the row was already **terminal** before the summary was even considered.
The worker-app's `_pollToTerminal` returns on `hasFailed`, the cubit emits `done`, the screen
navigates to the chat and its first turn calls `identityForChat` — all while the summary's LLM
call is still in flight. Widening the gate alone would have shipped a bubble that never rendered.

For those two reasons only, `parse()` now returns `{ status: "failed", …, settled: false }` and
writes **nothing**; `ResumeImportProcessor` stages the summary while the row is still `parsing`
and then calls `ResumeParseService.settleFailure()`, which runs the **identical** transaction —
same `markFailed`, same `WHERE status = 'parsing'` guard, same
`profile.resume_parse_failed:<importId>` idempotency key. That is the same order the parsed path
has always had (`settleParsed` follows the summary), and it is the order the client can observe.

**What did NOT move.**

- Still exactly **one** `profile.resume_parse_failed` per import, still in one transaction with
  the row, still guarded on `parsing`, still keyed the same way. No new event, no event version.
- A redelivery still finds a row past `uploaded`, answers `already_settled`, and **never re-reads
  the document or re-bills** — it does not reach the summary or the settle at all.
- The summary stays **best-effort**: a throw inside it is caught, logged PII-free and ignored, and
  the settle is deliberately outside that catch. A worker never loses his failure record to it.
- `saveIdentitySummary`'s `status IN ('parsing','parsed')` guard is **unchanged** — the row is
  still `parsing` when the line stages, so `failed` was not added to it.
- No schema change, no migration, no change to `GET /profiling/resume-import/:importId`.
  `identityPrompt`, `RESUME_IDENTITY_OPTIONS` and `readIdentityReply` are reviewed copy and are
  untouched.
- **The Haan handover has no failed-import branch, on purpose.** A failed row never settled a
  route, so `routeForImport` yields `route: null`, no form handover is built, the
  identity-answered event is still recorded, and the worker falls through to ordinary selection
  in the same bubble. No crash, no stranded route — the tap simply has no visible consequence,
  and no consolation path was invented.

**The deferral's cost, stated rather than implied.** A process that dies between the parse and
`settleFailure` leaves the row `parsing` with no event, exactly as a throw on the parsed path
already does. The redelivery does not re-bill; the row waits for a sweep (§7). The window widens
by one summary call and by no new behaviour.

**Reader change.** `ResumeSuggestionReader.identityForChat` now serves a `failed` row as well as a
`parsed` one. It does **not** repeat the closed reason set: a document-level failure never had the
summary called for it, so its three identity columns are null and the existing staged-columns
check does the real gating. `uploaded`, `parsing` and `discarded` stay excluded — a `parsing` row
genuinely can carry a staged line, and serving it would spend the offer on a client still polling.

**The client half is #1661 and must ship alongside.** The worker app must reach the chat on a
`failed` import instead of treating it as a dead end; until it does, this server change is
correct and invisible.

---

```
Signed (CEO / Prakash): Prakash Kantumutchu          Date: 2026-09-11
```

## 11. Amendment 2026-09-22 - the alpha posture is ARMED, and the wall's output is not a fact (#1658)

**Owner ruling (2026-09-22): the resume parse runs with `RESUME_PARSE_RAW_TEXT_ENABLED` ARMED in
alpha.** D5 has permitted this since 2026-09-10; what was missing was a statement of which state
the feature is actually *expected* to run under. It is armed, via the arming procedure already
recorded in section 3 - the box environment file plus a deploy re-run, never a ci.yml bridge.

**Why the masked posture is not a safe default here, only a quieter one.** With the flag off,
`default_masker` runs over every line before the model sees it, and `_EMPLOYER_RE`/`_PERSON_RE`
over-fire on ordinary trade vocabulary. Measured on a real CNC-turner CV:

```
[20] '[PERSON_1], Micrometer & Bore Gauge'     <- "Vernier, Micrometer & Bore Gauge"
[21] '[PERSON_1], Grooving & Boring'           <- "Threading, Grooving & Boring"
[62] '[PERSON_1], rough/finish turning, ...'   <- "Facing, rough/finish turning, ..."
```

`Vernier`, `Threading` and `Facing` are instruments and machining operations - precisely what the
`machines` target field and the capability chips exist to capture. Flag-off asks the model to read
machines off a document whose machine nouns have been replaced with `[PERSON_1]`. That is not a
conservative posture; it is a posture that quietly produces a worse profile and reports success.

**The output wall is tightened regardless of the flag, and that half is not a ruling.**
`resume_value_certifier` now refuses any value carrying a pseudonymization placeholder
(`[A-Z]+_<n>` in brackets - matched by SHAPE, so a prefix added to the masker tomorrow is covered
the day it ships). Under the armed flag this is a no-op; under flag-off it stops
`[EMPLOYER_1] & [EMPLOYER_2].` being staged as an employer, offered to the worker, and written to
`employer_name_enc` and the resume sheet.

That was never a privacy failure - the wall held and nothing leaked. It was **the wall's own
output being recorded as a fact the worker asserted**, which is a correctness failure of a kind no
privacy control would ever have caught. The refusal sits beside the existing wall and takes no
policy argument, so it can never be pointed at the input masker.

**Not fixed by either half:** the masker's over-firing itself. `certified_clean_skill_labels`
exists because of it and the `parse_policy` docblock already names it. Arming the flag routes
around it for this one task; it does not repair it.

