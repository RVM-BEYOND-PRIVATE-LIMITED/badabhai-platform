# Phase 2 — New résumé + Faltu (trash talk)

**Prerequisite:** Phase 1 merged (router, orchestrator, handler registry, memory store, events v2).

Contracts: [`contracts.md`](contracts.md). Why: [ADR-0046](../../decisions/0046-chat-companion-v2-llm-task-router.md)
O1, O11.

## 1. New résumé (branch 4 of the chat-flow notes)

The redo flow already exists; this phase only routes free text into it.

- v1 already catches the résumé menu's own aliases ("dobara", "phir se", the chip labels). The
  `NewResumeHandler` only sees phrasings v1 missed ("naya resume chahiye", "resume shuru se banao").
- **Validation** (deterministic, in the handler):
  - worker is in companion mode (guaranteed upstream: confirmed profile, no pending form handover —
    ADR-0044 §2.1 rules 2–4);
  - consent names `resume_generation` (read, fail closed → `V2_FALLBACK`).
  - The résumé daily cap is **not** consumed here. It is enforced where generation happens, as today.
- **Reply:** the résumé menu's redo turn served **verbatim** — `resolveResumeMenu` with
  `RESUME_MENU_REDO_KEY` (`apps/api/src/chat/resume-menu.ts`). Import it; do not edit it. Its
  options (form / "Chat se resume banayein" / upload) lead into the existing flows.
- **Back to chat:** the app already sends `POST /chat/session {redo: true}` from
  "Chat se resume banayein" (PR #1769). No new client work.
- **Previous logs kept:** old `chat_sessions` are untouched; ADR-0043 history keeps the newest three
  résumés. Nothing to build.

## 2. Faltu (branch 5)

```
message
  cooldown:{w} set → V2_FALTU_COOLDOWN (+ cooldown_until), no model call, outcome "cooldown"
  v1 resolver hit → v1 answer
  isAbusive(text) (packages/profiling-lexicon predicates) → faltu (intent_source "lexicon")
  else classifier → faltu (intent_source "llm")
faltu:
  n = INCR strikes:{w}:{utcDay}
  n >= FALTU_STRIKES → SET cooldown:{w} EX FALTU_COOLDOWN_MINUTES*60; V2_FALTU_COOLDOWN
  else → V2_FALTU_REDIRECT + task chips
  emit chat.companion_faltu_strike {strike_count: n, cooldown_started}
```

- The worker's text is never echoed, logged, put in an event or stored in memory — on the lexicon
  path and on the classifier path alike (a message the classifier calls `faltu` passes no memory
  pair).
- A retried send (same `submission_id`) replays the turn already served: it is ONE strike.
- A running cool-down also rides the open turn (`GET /chat/companion`), so the composer lock
  survives an app restart.
- Cool-down blocks **free text only**. Chip taps (v1 and task-chip keys) are still served, so a worker
  can always reach the résumé and jobs. Order in code: chip keys → cool-down → v1 text resolver →
  lexicon → classifier.
- Redis failure: no strike counted, redirect still served.

## 3. Tasks

### Backend — API
- [x] **N1** `v2/handlers/new-resume.handler.ts` + consent read + verbatim menu redo turn.
      `resolveResumeMenu` takes TEXT, not a key, so the handler calls it with
      `RESUME_MENU_REDO_LABEL` (the same call the menu makes for its own chip); `v2MenuTurn`
      mirrors v1's `menuTurn` field-for-field. Consent is `hasActiveConsent(..., "resume_generation")`,
      fail closed to the v1 FALLBACK line with the open chips.
- [x] **N2** `v2/faltu.store.ts` (strikes, cooldown) on the BullMQ connection.
      `countStrike` (INCR + 24 h TTL on the first), `startCooldown` (SET EX), `cooldownUntil`
      (PTTL). Fails OPEN on Redis, deliberately: no counter → redirect still served; no flag →
      no cool-down.
- [x] **N3** `v2/handlers/faltu.handler.ts`; orchestrator ordering as in §2; `cooldown_until` on the turn.
      The order is implemented across the two layers that already own those branches — see the
      "Order in code" note below. The cool-down turn carries `cooldown_until` and the open chips.
- [x] **N4** Event `chat.companion_faltu_strike` v1 (contracts §4).
- [x] **N5** Flags `CHAT_COMPANION_V2_NEW_RESUME_ENABLED`, `CHAT_COMPANION_V2_FALTU_ENABLED` wired.
      The registry gates `new_resume` and `faltu`; both flags are already deploy-bridged (#1820).
      Flag off is asserted per flag (service gate, lexicon, registry).
- [x] **N6** Task chip `companion_task:new_resume` shown when its flag is on.
      AND the deterministic step the §2 order implies: exact label/key recognition for the three
      task chips, routed to their handlers BEFORE the cool-down gate and before v1 (see the
      "chip keys" note below).

### Backend — AI service
- [x] **A1** Extend the classifier eval set with ≥ 40 faltu lines (abuse, flirting, jokes, random
      topics, cricket/film talk) and ≥ 30 new-résumé lines. No new endpoint.
      46 faltu + 30 new-résumé lines added (set now 234 cases); pytest and ruff green.

### Order in code (N3) — where the §2 pipeline actually lives

The pipeline spans the service and the orchestrator because the branches it orders already do:

```
ChatCompanionService.message
  1. resolveCompanionTaskChip(text) → orchestrator.handleTaskChip       (chip keys)
  2. FALTU on && !isCompanionChipTap(text) && cooldownUntil(...)       (cool-down)
       → orchestrator.handleCooldown   [intent_source "guard", outcome "cooldown"]
  3. resolveCompanionText → v1 answer                                   (v1 text resolver)
  4. fallback → CompanionV2Orchestrator.handleMessage
       a. FALTU on && isAbusive(raw) → faltu handler                     (lexicon; no gateway)
       b. pseudonymize → classify → handler                              (classifier)
```

Two consequences stated rather than discovered:

1. **The cool-down blocks free text, including text v1 would have answered.** That is what
   "chip keys → cool-down → v1 text resolver" says; chip taps (v1's and the task chips') skip
   the gate, so the résumé and jobs stay reachable.
2. **Task-chip taps are routed deterministically, before v1 — but only while that chip's phase
   flag is on.** Without this step v1 would answer a tapped chip itself: its weak "resume" signal
   answers "Resume badlo" with the digest, and its résumé-menu alias "naya resume" answers
   "Naya resume" with the redo menu (not the digest, as this note first said). Exact label/key
   match only; typed sentences stay free text. **Corrected 2026-09-30:** the step originally ran
   whenever the master flag was on, so with NEW_RESUME (or EDIT / CAREER) off a worker typing
   "naya resume" got the phase-off line instead of v1's redo menu — a v1 regression. A chip is
   now recognised only while it can be shown (`companion-task-chips.ts`, one table for both);
   with its flag off the label is typed text and takes the v1-first path exactly as before.
3. **A tap names a task, not a request (2026-09-30).** "Resume badlo" and "Career ki baat" are
   answered with fixed ask lines (`V2_EDIT_ASK`, `V2_CAREER_ASK` — drafts, contracts §8) and never
   sent to a model; "Naya resume" goes to its handler with the SERVER-authored label. The next
   message still takes the normal order (no pending-intent bypass — an owner decision).

### Frontend — worker app (GitHub issue)

- [ ] **F1** Honour `cooldown_until`: composer disabled with a countdown; chips stay tappable.
- [ ] **F2** Render the `companion_task:new_resume` chip.

## 4. Tests

| Test | Proves |
|---|---|
| `new-resume.handler.test.ts` | served turn equals `resolveResumeMenu(REDO)` byte-for-byte; consent off → fallback |
| `faltu.handler.test.ts` | strike 1–2 redirect; strike 3 starts cool-down; counter resets next UTC day |
| `faltu.order.test.ts` | chips served during cool-down; free text blocked during cool-down; lexicon hit skips the model |
| `faltu.privacy.test.ts` | abusive text never appears in events, logs or memory — lexicon path AND classifier path (any confidence, faltu phase on or off) |
| flag-off tests | each new flag off ⇒ Phase 1 behaviour unchanged — incl. `companion-v2.flag-off.test.ts`: each task chip's label/key with its phase off gets v1's turn byte-for-byte (or the Phase 1 router for a v1 miss), never the chip route |
| `faltu.order.test.ts` (open) | a running cool-down rides the `GET /chat/companion` turn as `cooldown_until` (V2 + FALTU on only); a Redis that never answers (command or connection) still returns the open within the 150 ms bound, with no `cooldown_until`, and free text is served by v1 |
| `companion-v2.orchestrator.test.ts` (retry) | a replayed `submission_id` is one strike, one model call, one memory pair |

## 5. Acceptance

- "Naya resume banana hai" → the résumé menu's redo turn; tapping "Chat se resume banayein" starts a
  redo interview.
- Three abusive messages in a day → third reply is the cool-down line; next 30 minutes free text gets
  the cool-down line; chips still work.
- Classifier eval still ≥ 90 % overall with the new lines.

## 6. Open questions

_None open._
