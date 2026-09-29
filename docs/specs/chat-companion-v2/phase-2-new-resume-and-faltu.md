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

- The worker's text is never echoed, logged or put in an event.
- Cool-down blocks **free text only**. Chip taps (v1 and task-chip keys) are still served, so a worker
  can always reach the résumé and jobs. Order in code: chip keys → cool-down → v1 text resolver →
  lexicon → classifier.
- Redis failure: no strike counted, redirect still served.

## 3. Tasks

### Backend — API
- [ ] **N1** `v2/handlers/new-resume.handler.ts` + consent read + verbatim menu redo turn.
- [ ] **N2** `v2/faltu.store.ts` (strikes, cooldown) on the BullMQ connection.
- [ ] **N3** `v2/handlers/faltu.handler.ts`; orchestrator ordering as in §2; `cooldown_until` on the turn.
- [ ] **N4** Event `chat.companion_faltu_strike` v1 (contracts §4).
- [ ] **N5** Flags `CHAT_COMPANION_V2_NEW_RESUME_ENABLED`, `CHAT_COMPANION_V2_FALTU_ENABLED` wired.
- [ ] **N6** Task chip `companion_task:new_resume` shown when its flag is on.

### Backend — AI service
- [ ] **A1** Extend the classifier eval set with ≥ 40 faltu lines (abuse, flirting, jokes, random
      topics, cricket/film talk) and ≥ 30 new-résumé lines. No new endpoint.

### Frontend — worker app (GitHub issue)
- [ ] **F1** Honour `cooldown_until`: composer disabled with a countdown; chips stay tappable.
- [ ] **F2** Render the `companion_task:new_resume` chip.

## 4. Tests

| Test | Proves |
|---|---|
| `new-resume.handler.test.ts` | served turn equals `resolveResumeMenu(REDO)` byte-for-byte; consent off → fallback |
| `faltu.handler.test.ts` | strike 1–2 redirect; strike 3 starts cool-down; counter resets next UTC day |
| `faltu.order.test.ts` | chips served during cool-down; free text blocked during cool-down; lexicon hit skips the model |
| `faltu.privacy.test.ts` | abusive text never appears in events, logs or memory |
| flag-off tests | each new flag off ⇒ Phase 1 behaviour unchanged |

## 5. Acceptance

- "Naya resume banana hai" → the résumé menu's redo turn; tapping "Chat se resume banayein" starts a
  redo interview.
- Three abusive messages in a day → third reply is the cool-down line; next 30 minutes free text gets
  the cool-down line; chips still work.
- Classifier eval still ≥ 90 % overall with the new lines.

## 6. Open questions

_None open._
