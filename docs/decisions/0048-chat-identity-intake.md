# ADR-0048: The chat identity intake — first name, surname, state and city asked in the onboarding chat

- **Status:** **Accepted — owner rulings 2026-09-30; signatures pending** (see the foot). The backend ships
  OFF behind `CHAT_IDENTITY_INTAKE_ENABLED`; production flag-ON is coupled to the worker-app release that unroutes
  `/name` (§7).
- **Date:** 2026-09-30
- **Owner:** product owner (rulings relayed by Divyanshu, 2026-09-30); raised by Rishi as #1858
- **Supersedes:** the rule in the worker app's `name_screen.dart` docstring — the name "is never asked for again in
  the chat flow, which stays identity-free". The chat now asks it.
- **Relates:** [ADR-0041](0041-resume-import-and-prefill.md) (the résumé "is this you?" turn now follows the
  intake) · [ADR-0045](0045-general-road.md) (general-road arming is preserved exactly) ·
  [ADR-0047](0047-lift-pii-restriction.md) (the owner's PII-in-prompts policy lift — this design is correct under both
  settings, §4.5)
- **Flag:** `CHAT_IDENTITY_INTAKE_ENABLED` (default off; production-environment secret)

---

## 1. Context

A new worker meets a form at `/name` — first name, last name, state and city — before the onboarding chat. The CEO
wants those asked **inside the chat, as chat turns**, and `/name` unrouted. The pieces that decide it are
server-side: the chat's question sequence is owned by the orchestrator, and `workers.full_name` / `current_state` /
`current_city` have exactly one write path each (`WorkersService.setFullName` / `setLocation`), neither reachable
from the chat until now.

Four claims in the issue were checked against `main` and corrected:

1. **Every résumé upload already goes to the chat** (`resume_upload_cubit.dart`, since #1611). The `tradeForm` arm
   in `resume_upload_screen.dart` is dead code, so the issue's options (a), (b) and (c) are unnecessary: opening the
   intake at session start covers both doors.
2. **The "is this you?" turn carries no name** — role, experience and summary only — and the résumé parse extracts
   no person name, so extending it (option b) would have been a new parse field and an ADR-0041 amendment.
3. **`{{worker_name}}` is filled in by the API**, post-emit, from `workers.full_name`. `reply-closure.ts`'s
   placeholder assertion guards the shared pre-rendered TTS set; it is not a rule that the chat never holds a name.
4. **The shipped app already renders the turns**: it always sends `confirm_first: true`, shows any server
   `opening_text` as the first bubble, and renders `answer_type: "text"` turns.

## 2. Rulings (owner, 2026-09-30)

| #   | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Not mandatory.** After 2 invalid or declined asks a step settles as skipped. The record keeps its gap, so the next NEW chat session asks again.                                                                                                                                                                                                                                                                                      |
| D2  | **Hold the first name as a `PiiCryptoService` ciphertext in the Redis session state only**; write `full_name` once, when the name steps finish. A skipped surname writes the first name alone.                                                                                                                                                                                                                                         |
| D3  | **First name, then surname.** If the first answer — after stripping the CLOSED cue list (the sentence a name is said inside, Hinglish and Devanagari: "mera naam", "my name is", "naam", "hai", "ji", "main"/"mai", "I am"/"I'm", "hoon"/"hun"/"hu", "मेरा नाम", "है", "मैं", "हूँ" …; case-insensitive, whole words) — has 2+ words, it is the full name and the surname step is skipped. Validated with `SetMyNameSchema`, imported. |
| D4  | **Intake copy is name-free static strings**, in `CONSTANT_REPLIES` with Devanagari TTS twins. No `{{worker_name}}` in intake copy.                                                                                                                                                                                                                                                                                                     |
| D5  | **Location: state, then city, both `answer_type: "text"`**; the app shows its pickers for `worker_state` / `worker_city`. Unrecognised values are accepted verbatim, exactly as `setLocation` does.                                                                                                                                                                                                                                    |
| D6  | **The intake runs BEFORE the résumé "is this you?" turn**; the last intake reply serves the next opening (résumé identity turn, else batch-confirm, else the handoff line).                                                                                                                                                                                                                                                            |
| D7  | **General-road arming and city seeding are preserved exactly** as if the interview began at the handoff.                                                                                                                                                                                                                                                                                                                               |
| D8  | **Add `profile.identity_intake_answered` v1** (`.strict()`, ids + closed enums, idempotency key per session + step); reuse `worker.name_recorded` / `worker.location_recorded` unchanged.                                                                                                                                                                                                                                              |
| D9  | **Any worker with a gap** (`full_name` / `current_state` / `current_city` null) gets the intake on their next NEW session while the flag is on; a worker with no gap is never asked.                                                                                                                                                                                                                                                   |
| D10 | **Intake lines are stored verbatim** in `chat_messages` with `metadata {identity_intake: true}` and **excluded** from the model-bound history, the extraction input and the résumé quote/veto reader.                                                                                                                                                                                                                                  |

And, with them: intake turns do not bump `turnCount`; the record write lands **before** the turn's CAS and fails
closed; a returning worker is decided from the `workers` row at session open; the flag defaults off and off is
byte-identical; `StartSessionResponse` gains two additive optional fields; logs carry ids and step names only; no
migration, and no `apps/worker-app` or `packages/types` change in this slice.

## 3. Decision

### 3.1 A deterministic pre-interview state machine

`identity-intake.ts` (pure) plans, reads and advances; `IdentityIntakeService` seals the held first name and performs
the writes and the funnel event; the orchestrator wires both. The state is `ProfilingEnvelope.identityIntake`
(`pending | settled`, the step on screen, the steps remaining, asks per step, the sealed first name, a held state) —
**Redis only**: it is deliberately absent from `toConversationStatePatch`, so neither the checkpoint, the flush nor
the abandon sweep can carry the ciphertext into `chat_sessions.conversation_state`.

While the intake is pending, `decide` answers the turn **first**, before capture, cross-question fill, identify, the
skills lane and Phase A's model call. A name that went down the ordinary path would be read as a trade phrase (an
identify attempt spent, possibly queued to the growth corpus) and sent to the provider as history.

### 3.2 The wire contract

| Step       | `question_key`      | `answer_type` | `input_mode` | Options | Served as                                                                      |
| ---------- | ------------------- | ------------- | ------------ | ------- | ------------------------------------------------------------------------------ |
| first name | `worker_first_name` | `text`        | `text`       | none    | `opening_text` on `POST /chat/session`, or a reply's `asked_question_id` after |
| surname    | `worker_last_name`  | `text`        | `text`       | none    | the reply to the first-name answer                                             |
| state      | `worker_state`      | `text`        | `text`       | none    | `opening_text` when it is the first gap, else a reply                          |
| city       | `worker_city`       | `text`        | `text`       | none    | `opening_text` when it is the first gap, else a reply                          |

- Only the gaps are asked, name → state → city. `full_name` null ⇒ first name then surname; `current_state` null ⇒
  state; `current_city` null ⇒ city.
- `POST /chat/session` (new session, flag on, `confirm_first: true`, a gap) returns `opening_text`,
  `opening_tts_text`, and the additive **`opening_question_key`** and **`opening_answer_type`** — absent, never
  null, on every other opening. No `resume_pending`.
- Every later step is an ordinary `POST /chat/message` reply: `question_kind: "ask"`, `asked_question_id` = the key,
  `answer_type: "text"`, no chips, `lookahead: null`, `tts_text` = the Devanagari twin.
- A re-ask (the step's retry line, the why-then-question after a question back, or the fixed de-escalation line after
  abuse) keeps the same `asked_question_id`.
- **Error case:** a failed record write returns today's retryable unavailable reply with nothing advanced; the
  client resends and the step is asked again. A duplicate submit replays the previous reply unchanged.
- The last intake answer's reply is the next opening (§3.5): the "is this you?" turn (two chips), the batch-confirm
  (two chips), or the handoff line `"Shukriya. Aap kaun sa kaam karte hain, aur kitna tajurba hai?"` with
  `asked_question_id: null`.

### 3.3 Reading an answer

The conversational class comes from the shared lexicon (`classifyUtterance`): empty, abusive, "pata nahi", a
question back and hardship are non-answers. A name has the closed cue list stripped (D3) and edge punctuation
trimmed — combining marks count as part of a word, so a Devanagari name keeps its final vowel sign ("सीता", not
"सीत") — and is title-cased the way the app's `/name` screen did (`titleCaseName`, raising a lowercase first letter
only), then must pass `SetMyNameSchema.shape.full_name`. A place passes `SetMyNameSchema.shape.state` / `.city` and
is kept verbatim; `setLocation` canonicalises what the gazetteer knows. A non-answer is re-asked once; a second
settles the step as skipped (D1). A skipped first name asks no surname.

**What D1 counts as declined or invalid.** `SetMyNameSchema` bounds a value's shape and accepts any words, and the
lexicon's `dont_know` class covers only "pata nahi" — so without more, "nahi batana" was written as a full name,
"surname nahi" as a surname and "nahi" as a state, after which the record has no gap and D9 never asks again. Three
closed word lists in `identity-intake.ts`, matched as whole words on every step (after the cue list, for a name),
make a reply a non-answer instead:

| List                   | Makes the reply                     | Examples                                                 |
| ---------------------- | ----------------------------------- | -------------------------------------------------------- |
| `INTAKE_WHY_WORDS`     | a question back — the why, then ask | kyu, kyun, why, kya, kaun, क्यों, क्या                   |
| `INTAKE_REFUSAL_WORDS` | declined                            | nahi, no, skip, baad, later, dont, नहीं                  |
| `INTAKE_FILLER_WORDS`  | unreadable                          | haan, ok, hi, hello, a stray "mera" / "my" / "name", हाँ |

Every entry is a word no name or place is made of; "nai" ("Nai Dilli"), "sahi" (a surname) and "ho" are left out on
purpose. A reply carrying one is re-asked, never trimmed to what is left — stripping stays the closed cue list's job.
The words a name is SAID inside — "main Ramesh hoon", "Ramesh hu", "I'm Ramesh", "मेरा नाम रमेश है", "मैं रमेश हूँ",
"mera surname Kumar hai" — are in the cue list and stripped, so each reads as the name rather than being re-asked
twice and skipped. The lists may be widened later (§4.4).

**A surname answer that opens with the first name** ("Ramesh Kumar" to "Aapka surname kya hai?") has that word
dropped before joining, so the name is not written as "Ramesh Ramesh Kumar".

### 3.4 Writes and events

The record write runs in `takeTurn` **before** `saveWithCas`. A throw returns `unavailable` and writes nothing to
Redis, so the question is asked again; a lost CAS re-runs `decide` and re-issues the same UPDATE. Both writes pass a
per-session idempotency key (`worker.name_recorded:identity_intake:<session>`,
`worker.location_recorded:identity_intake:<session>`) through a new optional `opts` field, so a re-issued write
records one event; the two HTTP routes pass none and are unchanged. The location is written once, when the last
planned location step settles. A held first name that cannot be unsealed (a rotated key) writes no name — the gap
stays and the next session asks — never a surname stored as a whole name.

`profile.identity_intake_answered` v1 — `{worker_id, session_id, step: first_name|last_name|state|city,
outcome: answered|skipped, recognized: boolean|null}`, `.strict()`, `recognized` set only for an answered state or
city (the gazetteer verdict). Emitted after the CAS win, never throws, keyed
`profile.identity_intake_answered:<session>:<step>`. No value of any kind is on the spine.

### 3.5 The interview behind it is today's

- **No turn is spent.** Intake turns append their lines and stamp the reply cache but leave `turnCount` and
  `engineAsks` alone, so `min_turn` windows, `MAX_ENGINE_TURNS` and the 28-ask budget are exactly what they are
  without an intake, and the first real message is turn 1.
- **The city is asked once.** A city already on file is seeded when the intake opens; a city the intake captures is
  seeded into the pack's `current_city` (`seedFromWorkerRecord`, marked prefilled) on the turn it is answered.
- **The general road (D7).** The stamp runs only on a fresh envelope, which the intake's opening write consumes; it
  is therefore taken at the handoff. A handoff onto the opener arms exactly as today's first message arms; a handoff
  onto a résumé turn stays unarmed, as a session that opens on one does today.
- **The handoff (D6)** reuses `openTurn`'s selection and builders: the staged identity line (not yet asked) →
  `resumeIdentity` pending, one ask; else a pending batch-confirm with facts → `resumeConfirm` pending, one ask;
  else the handoff line. A form-routed "Haan" then hands over to the form after the name is already captured.
- **Reopen.** `openTurn` and `viewSession` re-serve a pending intake question with no write; `openResumeConfirm`
  serves no opening beneath an intake, pending or settled.

### 3.6 What stays out of the model (D10)

Intake lines are buffered with `intake: true` and flushed with `metadata {identity_intake: true}`. They are dropped
from `transcriptOf` (before numbering, so evidence indices agree with the extraction's input), from the extraction
processor's input on both its Postgres and Redis branches, and from `WorkerTranscriptRepository.loadWorkerTurns`.
The worker still sees his own answers when the thread is redrawn.

**The alias miner is filtered too** (`packages/db/src/mine-chat-aliases.ts`, `db:mine:aliases`). It mines every
inbound row that does not resolve to an occupation, and an intake answer never resolves — so without the same
`NOT (metadata @> '{"identity_intake": true}')` predicate, bare names and towns would have been printed to the
operator's console and review file as alias candidates.

## 4. Consequences

1. **No migration.** `metadata` is an existing JSONB column; the envelope field is Redis-only; the event is additive.
2. **Release coupling.** Flag off with `/name` gone captures nobody's name; flag on with `/name` still routed asks
   only what `/name` left blank (usually the state or city). The flag must be on by the app release (§7); the owner
   turned it on in production on 2026-09-30, ahead of that release. Unrouting `/name` must update
   `WORKER_APP_SCREEN_TEMPLATES` in `packages/types` in the same PR, or the API's screen-template contract goes red.
3. **Legacy workers (D9).** Any worker with a gap — an old account, a skipped name — is asked on the next new session.
4. **Known limits and follow-ups.** The owner turned the flag on for production on 2026-09-30, alongside this build;
   none of these blocks it. Each is listed with what the code does today.
   - **The D1 word lists and D3 cue list (§3.3).** Their membership is the shipped engineering choice; widening or
     narrowing them is a normal reviewed change.
   - **"No surname".** "surname nahi hai" is a decline, so under D1 as written it is re-asked once ("Kripya sirf apna
     surname likhiye.") before the step is skipped and the first name is written alone. Settling it on the first
     reply would spare a worker with no surname that re-ask, but it departs from D1.
   - **A trade said beside a name.** "main welder hoon" reads as the first name "Welder", and "Ramesh welder" as a
     two-word full name. A trade-word check cannot fix it: Indian surnames are often trade words (Mistry, Lohar,
     Darzi, Sonar), and refusing them would refuse real names. The worker can correct it on the Profile screen.
   - **The opener reply after a seeded city.** A city on `current_city` — seeded at the intake's open, or answered in
     it — makes `isOpenerReplyTurn` false, so while Phase A leads, a total stated in reply to the handoff's "… aur
     kitna tajurba hai?" is not cross-filled (Phase A's settlement still sums the job entries later). This is
     inherited unchanged from today's `/name` path, where a `/name` city has the same effect, and D7 keeps the
     interview behind the intake identical to it; the fix (`isOpenerReplyTurn` ignoring `prefilledKeys`) belongs to
     both paths and changes flag-off behaviour, so it is a separate change.

   - A Redis expiry mid-intake loses the intake state; the next answer is read as the interview's first message.
   - A message typed at the app's canned bubble before the served opening arrives (#344) is read as the first name.
   - Two different answers racing one step: the loser's write can land before its CAS is lost; the winner's
     decision stands in the conversation, and the record holds whichever UPDATE landed last.

5. **Under [ADR-0047](0047-lift-pii-restriction.md) (the PII-in-prompts lift).** With masking on, this design keeps
   the name out of every prompt, event and log by construction; with it lifted, nothing changes — the exclusions are
   kept for correctness, since neither the model nor the résumé quote block has any use for a name or a town typed
   into a form question.
6. **Payer-side masking is untouched.** The disclosure masker reads the same encrypted `workers.full_name`,
   whichever surface wrote it.

## 5. Out of scope

The app changes (unrouting `/name`, the State/City pickers keyed on `worker_state` / `worker_city`, reading
`opening_question_key`, retiring the #1660 "no details from your résumé" inference for an intake opening, disabling
the composer until the opening arrives) are the worker-app owner's, filed against #1858.

**A limit the app must plan for: a cold reopen mid-intake carries no question key.** Every cold open reattaches, the
reattach response serves no opening, and the `GET /chat/sessions/:sessionId/messages` redraw carries bubbles only —
so after a reopen the app cannot tell that the last bubble is the `worker_state` or `worker_city` question and falls
back to the keyboard, which the server accepts (D5). If the pickers must survive a reopen, the fix is an additive optional
redraw field while an intake step is pending (for example `pending_question_key` / `pending_answer_type`, ABSENT
otherwise, the way ADR-0045 added `gate_kind`). That is a contract addition and is not in this slice.

## 6. Verification

`identity-intake.test.ts` (the rulings on the pure machine, the D1 word lists row by row, Devanagari names kept
whole, the repeated first name), `identity-intake.orchestrator.test.ts` (steps, re-ask → skip, a refusal never
written, the why served, a Devanagari name round-tripped through the seal, CAS loss, write failure, replay, handoff,
arming, turn numbering, the city asked once, a never-opened session identical to an intake-less orchestrator,
model/skills history, no value in any event or log line), `chat-identity-intake.wire.test.ts` (flag off
byte-identical on both `POST /chat/session` and `POST /chat/message`, the opening fields, degrade, the flush flag),
the extraction and transcript-reader filters, and the event schema tests.

## 7. Rollout

1. Backend merged dark (this ADR). Nothing changes while the flag is off.
2. Worker-app release: `/name` unrouted (with the `packages/types` screen-template update in the same PR) and the
   pickers wired for `worker_state` / `worker_city`.
3. In the SAME release: set the GitHub `production` environment secret `CHAT_IDENTITY_INTAKE_ENABLED=true`
   (`--env production`; a repository secret of the same name is shadowed) and redeploy; verify a new worker end to
   end on a device, with and without a résumé upload.
4. Rollback: unset the secret. New sessions open as today; a session already mid-intake finishes its intake.

---

```
Owner rulings D1–D10 taken 2026-09-30; production flag-ON requires these signatures and a ruling on each §4.4 open item.
Signed (CEO / Prakash): ______________________          Date: __________
Signed: Divyanshu (Backend Platform; relayed the owner's rulings)          Date: __________
```
