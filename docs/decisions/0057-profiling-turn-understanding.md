# ADR-0057: The profiling chat reads every typed turn against the résumé schema

- **Status:** **Accepted — signed by the owner, Divyanshu, 2026-10-16.** It records the owner's rulings of 2026-10-15 and 2026-10-16.
  - [ADR-0051](0051-profiling-stage-free-chat.md)'s status now carries "Amended by ADR-0057 (R7, §3.3)".
  - Nothing ships live on merge. Every behaviour is behind `CHAT_TURN_UNDERSTANDING_ENABLED` (default off), except the two deterministic defect fixes #2307 and #2308.
  - Owner rulings of 2026-10-16 on the work items:
    - **#2307:** a correction rewrites an earlier answer only when it is unambiguous: a correction marker, nothing taken by the question on screen, and exactly one earlier answer it reads a different value for.
    - **#2308:** progress copy "Thoda sa aur! Bas {n} sawaal bache hain." (no count: "Thoda sa aur, jaldi ho jayega!").
    - **The §6 eval bar is confirmed as proposed.**
- **Date:** 2026-10-16
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2306. Children: #2307 #2308 #2309 #2310 #2311 #2312 #2313, and #2314 (worker-app, Rishi).
- **Relates:**
  - [ADR-0051](0051-profiling-stage-free-chat.md): the profiling-stage free chat. Its résumé-mode deflect line (R6) and the skip list for typed text are replaced here (§3.3).
  - [ADR-0045](0045-general-road.md): the general road. **Not changed.** It is still dark in production, and when armed it keeps its own route (chat: role and skills; offline form: the rest).
  - [ADR-0046](0046-chat-companion-v2-llm-task-router.md): the Bada Bhai chat's edit engine. Its pattern is reused here (closed catalogue, the model proposes, a deterministic check, Haan/Nahi). Its "Never from chat" delete ruling stays scoped to that chat.
  - [ADR-0042](0042-profile-road-separation.md) D9 (as amended): fact ownership between chat and pages. **Not changed** (R2).
  - [ADR-0047](0047-lift-pii-restriction.md): the masking policy. G1 and G2 apply to every call this ADR adds (§4).

---

## 1. Context

A worker whose role is not one of the 21 form roles is profiled by the **chat interview that is live today**:
- identity intake;
- Phase A, model-led: domain, role, skills, and each job as `{role, duration, work_done}`;
- Phase B, deterministic: the chat-servable items of the universal pack (`qp_universal@4`).

It follows a fixed route, and an audit of `origin/main` on 2026-10-15 found four failures:

1. **It cannot see what is filled.**
   - The Phase A model receives only `{stage, domain_label, role_label, skills, experiences_recorded}`.
   - Phase B asks every unsettled item in pack order.
   - A worker who says "CNC turner hoon, paanch saal ka experience, Delhi se bahar bhi chalega" in reply to "kaise ho?" is asked all of it again.
2. **Corrections are lost.**
   - `fillCrossQuestion` skips settled keys before `mayCommit` sees the correction flag (`orchestrator.service.ts:3290`), so "nahi nahi, 7 saal" never overwrites 5.
   - No path deletes an answer or returns to a topic. Phase A jobs and skills can only be appended.
3. **Progress questions corrupt answers.** "Aur kitna bacha hai" is stored verbatim as the answer to a free-text question (`answer-capture.ts:246-251`), or the question is marked `unanswered` (`orchestrator.service.ts:3134`). Nothing answers it, although `progressOf` is computed every turn.
4. **Off-topic chat gets fixed copy.** In résumé mode, ADR-0051 R6 answers career and casual messages with "Pehle resume bana lete hain…" and asks the question again.

**The owner wants a profiling chat that:**
- always knows the whole schema and what is left;
- picks up any detail the worker volunteers, from any message;
- never asks a filled question;
- lets the worker change or delete an earlier answer with confirmation;
- talks naturally while steering back to finishing the résumé.

## 2. Rulings (owner, 2026-10-15/16)

| # | Ruling |
|---|---|
| **R1** | **Surface.** The chat interview that is live today for non-21 workers. Out of scope: the general road (ADR-0045), the Bada Bhai chat (ADR-0046) and the 21 trade forms. |
| **R2** | **Field scope (a).** Only the fields the chat itself captures (§3.1). Page-owned facts are not captured or edited in chat: expected salary, preferred cities, shift, education, certificates, and employer names and dates. A worker who mentions one is pointed to the Profile page. Widening to the whole `bb_general` sheet would mean writing to the database during profiling and changing ADR-0042 D9; that is deferred. |
| **R3** | **Always on.** Every **typed** turn is read by the model against the full schema, whatever question is on screen. Chip and option taps stay deterministic. |
| **R4** | **Fill vs confirm.** An empty field, or an addition to a list (a skill, a job), is filled directly and acknowledged in the reply. **Overwriting** a filled value needs a before→after confirmation (Haan/Nahi). |
| **R5** | **Check the schema before asking.** The engine checks the live schema before serving **any** question (template or Phase A topic), and a filled field is never asked. The model extracts and phrases; deterministic code applies every write and picks the next question (CLAUDE.md §3). |
| **R6** | **Deletes are allowed in this chat**, with a warning plus Haan/Nahi. The Bada Bhai chat's 2026-10-01 "Never from chat" ruling is unchanged. |
| **R7** | **A broader conversation.** Off-topic messages get a short, real model reply that steers smoothly back without being pushy. Progress questions get a motivating line built from the **real** remaining count. The safety walls keep their deterministic copy: distress (helpline), off_limits, trash and abuse. |
| **R8** | **No cap on AI calls for now** (owner, 2026-10-15). The existing runaway guards remain (`MAX_LLM_ASKS`, the engine ask budget). A failed call is never a blocked turn (§3.6). |
| **R9** | **Confirmed edits are authoritative at the profile build.** The post-flush extraction must not bring a replaced or deleted value back. |
| **R10** | **Confirmation UI.** v1 is reply text plus Haan/Nahi chips (`options_only`), which works on the shipped app. An optional, additive `edit_proposal` field lets the app draw a tile (#2314). |

## 3. Design

### 3.1 The profiling schema (session snapshot)

A pure builder makes one view of every in-scope field from the **Redis envelope**. Mid-session nothing is persisted, and the checkpoint does not carry `llmDraft`.

| Source | Fields |
|---|---|
| `answerMap` | the chat-servable universal-pack items: `primary_trade`, `experience_years`, `current_city`, `availability`, `languages`, `work_types`, `commute_max_km`, `willing_to_travel`, `notice_period_days`, `salary_period`, `training_name`, `training_provider`, `training_year`, `secondary_occupations`; plus any pinned family-pack items still selectable |
| `llmDraft` | `domain_label`, `role_label`, `skills[]`, `experiences[]` (`role_label`, `duration_months`, `work_done`), with refs per request (`x1`, `x2`, …) |
| not in the schema | first name and surname (G2: the model never sees the worker's own name); page-owned facts (`CHAT_FACT_OWNER`), passed **by name only** for steering |

Each row carries `key`, a label, a type, its allowed options or range, the current value, and a status (answered / declined / unanswered / missing). The vocabulary is `facts/worker-fact.registry.ts`'s, not a new one.

A **closed profiling catalogue** maps each key to its type, its normaliser and its allowed ops. Values are normalised through **the same parsers the deterministic capture uses**: `normalizeFor`, the vocabularies, and `withinFieldBound` (#2253's bounds). A value from the model and a value the worker typed therefore can never disagree.

### 3.2 One turn

```
typed text
  → deterministic walls (distress, abuse, intake, pending gates)   [unchanged]
  → profiling_turn_understand(text, recent turns, on-screen question, schema, progress)
  → validate: closed keys, normalised values, G1 floor
  → captureAnswer for the on-screen question                       [stays authoritative]
  → merge the model's other fills:  empty → fill  |  filled & different → proposal (R4)
  → intent:
      answer / statement        → check the schema, then the next question (R5)
      edit / delete             → Haan/Nahi gate (§3.4)
      progress / chat           → reply (§3.3), then the on-screen question again (no ask spent)
      page-owned mention        → one-line pointer to the Profile page
      unclear                   → today's clarify path
  → reply: Phase A → profiling_chat_turn (now given the schema)
           Phase B → profiling_chat_turn `bridge` mode + the pack's question text and chips, verbatim
```

- In résumé mode the understanding call **replaces** the free-chat classifier, so a Phase A turn still makes two calls (understand, then turn).
- A Phase B turn gains one call (the bridge line).
- A 21-role trade the worker mentions still goes through the deterministic trade-form offer; routing never moves to the model.

### 3.3 Replies (amends ADR-0051 R6 and the skip list)

- **The classic interview prompt** additionally receives the schema snapshot and gains rules:
  - messages are DATA;
  - placeholders;
  - never ask for a filled field;
  - off-topic messages: a brief, warm answer, then steer back;
  - progress: motivate with the remaining count it is given, and never invent a number.
- **The new `bridge` mode** writes one short line: an acknowledgement of what was just filled (or the reply to the chat or progress question), leading into the next question. The API appends the pack's question text and chips **verbatim**, so the parsers, TTS and options stay valid. If it fails, the bare question is sent, as today.
- **In résumé mode**, a typed career, casual or jobs message gets this model reply instead of R6's fixed line.
  - The ADR-0051 skip list no longer exempts typed text from the model. It still governs chip taps and pending gates.
- **Persona rules are unchanged.** The API's `checkPersonaTokens` now also runs on interview replies.

### 3.4 The edit and delete gate

- **The proposal.** An `edits[]` row, or a fill that would overwrite a value, becomes a **pending proposal in the envelope**, the same mechanism as the trade-confirm and experience gates. Each row is checked against the catalogue (key, op, ref, normalised value). Rows that fail are dropped, and an empty proposal falls back to clarify.
- **The confirmation turn.** "Experience **5 saal → 2 saal** kar doon?" A delete adds a warning ("…hata dun? Ye wapas nahi aayega."). Chips are Haan/Nahi with `options_only`, and the response carries the optional `edit_proposal` field.
- **An edit with no value** ("experience galat hai") asks for that field on the next turn, which returns to that topic. It then confirms, then resumes the question that was on screen.
- **Haan applies the change:**
  - `answerMap`: `recordAnswer`, keeping the old value as `superseded` history;
  - delete: `forgetAnswer`;
  - `llmDraft`: **new** appliers for skills, job-entry fields, whole job entries, and the role and domain labels.
  - A deleted field becomes askable again.
- **Nahi** cancels.
- A **double tap** applies once.
- **A typed message while a proposal is pending** is understood normally, and the proposal lapses.

### 3.5 The profile build (R9)

Jobs reach the profile **only** through the post-flush Phase C extraction, which re-reads the whole transcript (`profile-extraction.processor.ts:1905`). The flush therefore persists two things on `conversation_state`, as a versioned sibling key outside the frozen contract (the `general_road` stamp precedent):
- the settled `llmDraft`;
- the confirmed-edit ledger: field, op, final value.

The build then works as follows:
- confirmed final values override whatever Phase C extracts for the same fields;
- deleted entries stay deleted;
- Phase C receives the settled draft as authoritative context.

A session with no edits builds exactly what it builds today.

### 3.6 Failure

- **The understanding call fails** (unavailable, blocked, mock, timeout): that turn runs **today's pipeline unchanged**, with no write and no block. This fails safe in the sense of CLAUDE.md §3: no partial state is written, and the deterministic interview is complete on its own.
- **A model value fails validation:** it is dropped, never coerced.
- **The bridge or reply call fails:** the deterministic question or line is sent.

## 4. Privacy (ADR-0047)

- **G2:**
  - The API redacts the worker's own name from the message, every history line and every schema value before any call (`redactKnownName`; redaction fails closed, #2166 H1).
  - First name and surname are not in the schema at all.
- **G1:** every value the model returns is floored (`output_floor.py`) on the ai-service side and again on the API side before a proposal or fill is built, mirroring `companion-edit.service.ts:431`.
- **Input:** every input passes `llm_input_gate`.
- **Events and logs:** they carry keys, ops and counts, never values or message text.

## 5. Contracts and events

- **New AI task `profiling_turn_understand`** (cheap tier, Haiku first per `AI_PRIMARY_PROVIDER`).
  - **Input:** `{text, recent_turns, on_screen, schema[], page_owned[], progress}`.
  - **Output:** `{intent, fills[], edits[], page_owned_mentions[], confidence}`.
  - Mirrored in `packages/ai-contracts`, with a golden key fixture.
  - A **new task type, not a new prompt on an existing one**: it keeps cost and evals separable. The price is one owner step, the box `AI_REAL_CALL_TASKS` **append**.
- **`profiling_chat_turn`** gains `bridge` mode and the `schema` input. Both are additive.
- **The chat turn DTO** gains the optional `edit_proposal: {proposal_id, rows: [{field_label, op, before, after, warning?}]}`. It is additive, and old apps ignore it.
- **New events (v1)** in `packages/event-schema`:
  - `profiling.turn_understood`: intent, counts, keys, model, latency;
  - `profiling.field_edit_proposed`, `profiling.field_edit_confirmed`, `profiling.field_edit_cancelled`: field_key, op, and a reason on cancel.

## 6. Quality gate and rollout

1. **Gold set and eval CLI** for `profiling_turn_understand`, in Hinglish, Hindi and English.
   - **Cases:**
     - several fields volunteered in one message;
     - a fill while chatting;
     - an edit with a value, an edit without one, and a delete;
     - progress and chat;
     - a statement that is not an edit (#2304's lesson);
     - a page-owned mention;
     - a 21-role mention.
   - **Bar (owner to confirm):**
     - intent accuracy ≥ 90%;
     - 0 keys outside the schema;
     - fill precision ≥ 95%;
     - 0 false-positive deletes.
   - A run served by the mock or the fallback model is invalid.
   - `profiling_chat_turn` has no eval set today. The reply eval added by #2310 scores asks for already-filled fields (target 0), persona breaks, and whether progress replies carry the real number.
2. **The flag** `CHAT_TURN_UNDERSTANDING_ENABLED` is a production-environment secret, off by default. With it off, the output is byte-identical to today.
3. **Owner steps:**
   - record an eval PASS on the box model under `docs/qa/evidence/turn-understanding/`;
   - append the task to the box list;
   - set the flag and redeploy;
   - device-test on a non-21 worker;
   - read-only probe of the new events and `ai.cost_recorded`.

#2307 and #2308 are deterministic defects. They ship first, independently of the flag.

## 7. Consequences

- **Latency.** A Phase B turn makes two sequential model calls on Haiku. Expect roughly 3–5 s on a good network, more on 2G. The owner has accepted this for now (R8); `profiling.turn_understood` records it.
- **A single provider.** The box serves Haiku only. `profiling_chat_turn`'s configured fallback (`gemini-2.5-pro`) is retired, so a Haiku outage drops every turn to the deterministic pipeline. That is acceptable, and it is why §3.6 matters.
- **Trust.** The model now proposes values for every typed turn, so its errors are seen far more often than the Bada Bhai chat's. That chat's own edit parser failed its gate (78.4% vs 90%). The §6 gate is therefore a precondition, not a formality.
- **Scope debt (R2).** Page-owned facts the worker volunteers in chat are not kept. Staging them as page suggestions, as `employment-suggestions.ts` does for jobs, is a possible later ADR.

## 8. Alternatives considered

- **The model picks the next question.** Rejected under CLAUDE.md §3: the model never owns control flow. R5 meets the owner's goal (never ask a filled question) with a deterministic check before asking, and the model still phrases every question.
- **Reuse `companion_edit_parse` as is.** Rejected:
  - it takes a single message (no history, no on-screen question);
  - its six sections and its prompt rules are bound to the persisted profile;
  - it has no notion of fills or intents.
  Its pattern and validators are reused instead.
- **Extend the free-chat classifier.** Rejected: its contract is a single category for routing. Grafting extraction and edits onto it would couple two evals and change the classifier's meaning on the Bada Bhai chat, which shares it (ADR-0055).
