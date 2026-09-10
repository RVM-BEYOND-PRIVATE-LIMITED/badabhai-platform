# ADR-0041: Résumé import — parse an uploaded document, route it, and prefill the profile

- **Status:** **Accepted** — owner rulings taken 2026-09-10. Signature block at the foot.
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

| #      | Decision                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------- |
| **D1** | **Résumé upload is covered by the existing `profiling` consent purpose.** No tenth purpose is minted. |
| **D2** | **Facts are prefilled; capability claims are suggested UNTICKED.**                                    |
| **D3** | **PDF, DOCX and photo/scan (OCR) are all accepted.**                                                  |
| **D4** | **Résumé text never prints on a BadaBhai résumé.** The upload is a draft-filler, never evidence.      |
| **D5** | **The résumé is sent to the LLM with employer names intact.** See §3.                                 |
| **D6** | **The uploaded file is retained permanently.**                                                        |
| **D7** | **A stored answer always wins.** A résumé value that disagrees is offered, never applied.             |
| **D8** | **Sign-up only** in v1 — no upload from the profile tab.                                              |
| **D9** | **An unreadable file is said so plainly**, and the worker continues in Hinglish.                      |

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
- **Government identifiers, phone numbers and email addresses remain masked**, flag or no flag.
  Parsing needs none of them: the platform already holds the worker's phone, and a PAN number
  cannot fill a form field. What passes through raw is names, employers, dates, places, salaries
  and free prose.

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
  what gets persisted.
- A test that fails if the raw path is reachable with the flag unset. It must fail loudly and must
  not arm vacuously on an empty string — the `AI_INTERNAL_TOKEN` lesson (TD67).
- `security-engineer` gate before RI-3 merges.

### 3.4 Why it had to be recorded rather than just done

`docs/agent/BUILD_RULES.md` makes code that contradicts a signed ruling a full stop, and holds
that a signed ruling is overridden only by another signed ruling. Without this ADR the next
engineer opens `employment.ts`, finds running code doing the opposite of its docblock, and
correctly halts. **The docblock is amended in the same change that lands this ADR**, pointing here.

### 3.5 The cost, stated plainly

D5 combined with D6 (permanent retention) means employer names, dates and prose from every
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
- **New dependencies** in the ai-service: `pypdf`, `python-docx`, `pytesseract`, `Pillow`,
  `pymupdf`, plus the `tesseract-ocr` binary and `eng`/`hin` traineddata in the image.
- **Erasure is load-bearing** (§3.5): `deleteByPrefix("resume-uploads/{workerId}/")` in
  `AccountDeletionService`, with its own test.
- **Prefill coverage is unmeasured and must not be claimed.** 15 of 18 CNC-turning items are
  capability claims a real worker résumé rarely carries; and only **9 of 21** declared roles have
  a form at all, so most workers route to chat regardless. RI-7 measures per-field coverage and
  error rate over a real corpus before any worker-facing claim about time saved is made.

## 8. Open

1. **Fully raw, or raw-except-identifiers?** §3.2 masks government IDs, phone and email. The owner
   ruled "employer names included"; masking IDs is engineering's narrowing of that and is
   reversible in one line.
2. **DPDP notice copy.** D1 blocks nothing, but the notice a worker reads still does not mention
   handing over a document. Best written in one pass alongside the outstanding `employer_sharing`
   and E4 copy.

---

```
Signed (CEO / Prakash): .......................  Date: .................
```
