# ADR-0051: The profiling-stage free chat — a greeting, a résumé lock, and per-category answers

- **Status:** **Accepted — signed 2026-10-06** (see the foot). The owner gave rulings R1–R20 on 2026-10-06
  in the design session, then approved the plan and the copy in §5. **Live on merge** (R18): no default-off
  gate. The only lever is the kill switch `CHAT_FREE_CHAT_DISABLED`.
- **Date:** 2026-10-06
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2027
- **Relates:**
  - [ADR-0046](0046-chat-companion-v2-llm-task-router.md): the post-profile companion. **Unchanged.** This ADR
    reuses its router pattern on a different surface.
  - [ADR-0048](0048-chat-identity-intake.md): the identity intake, which still runs first.
  - [ADR-0045](0045-general-road.md): the general road, armed when résumé mode is entered (§3.6).
  - [ADR-0047](0047-lift-pii-restriction.md): the masking policy; G1 and G2 stay enforced.
  - Persona v3.2 (`docs/specs/persona-system-v3.2.md`).
- **Kill switch:** `CHAT_FREE_CHAT_DISABLED`. The default is false, which means the feature is on.

---

## 1. Context

Most workers arrive without a résumé. Today the onboarding chat goes from the name/city intake (ADR-0048)
straight into the profiling interview. Anything off-script is either ignored (`off_topic` has no branch) or
capped (abuse, hardship). A worker who wants to chat first, ask a career question, or ask about jobs has nowhere
to go.

The owner wants a chat we control, like ChatGPT but scoped to BadaBhai, for the **profiling stage**:

- Every message is classified into a category.
- Each category has its own prompt, its own guardrails and its own variables.
- **Résumé creation is a locked mode**: once a worker is in it, they leave only when the résumé is done.
- After the profile is confirmed, the existing BadaBhai chat screen (companion v1/v2) takes over, unchanged.

## 2. Owner rulings (2026-10-06)

| # | Ruling |
|---|---|
| **R1** | **Scope.** Profiling stage only (`POST /chat/session`, `POST /chat/message`), before the profile is confirmed. The companion (`/chat/companion/*`) is untouched. |
| **R2** | **Categories:** résumé creation · career talk · jobs · casual/moody · trash. The engineering set (§3.2) adds `off_limits`, `distress` and `unclear`. |
| **R3** | **Start:** the identity intake first (when it runs), then a greeting that pushes toward the résumé, with **Haan / Baad mein**. |
| **R4** | **Entering résumé mode:** a typed résumé intent OR a "Resume banayein" chip. Résumé mode runs **today's interview**, unchanged. |
| **R5** | **The lock:** a worker leaves résumé mode only when the résumé is done. Someone who leaves and returns later is still locked. |
| **R6** | **In résumé mode** the model classifies every typed message. Off-topic gets "Pehle resume bana lete hain, phir kuch aur baat karenge." followed by the pending question again. If unsure, ask to clarify. Abuse goes to today's trash handling. |
| **R7** | **Mixed messages:** trash > résumé > career > casual > jobs. |
| **R8** | **Jobs:** a fixed line plus an offer to start the résumé. No job search in chat. **Re-affirmed 2026-10-08 (#2129):** jobs come only after the profile is confirmed, from the companion ([ADR-0044](0044-post-completion-chat-companion.md)). |
| **R9** | **Casual:** model-written and checked by code. The résumé chip is always shown, and a nudge is added every 3rd casual turn. |
| **R10** | **Distress:** a fixed line plus a helpline (Tele-MANAS 14416, checked 2026-10-06: toll-free, 24×7, Ministry of Health). The model never writes this reply. |
| **R11** | **Career:** model-written and checked by code. Refuses legal/medical/financial. **Typical ₹ ranges are allowed. Company names are allowed freely.** Encourage the worker but never rank them. Never promise a job; stay hopeful. |
| **R12** | **Live news:** phase 2 (web search, its own ADR). Until then a news request gets a fixed line. **Now [ADR-0054](0054-free-chat-live-news.md) (2026-10-08).** |
| **R13** | **Trash outside the lock:** 3 strikes in a day → a 30-minute block on typing. Chips still work. |
| **R14** | **Off-limits topics** (politics, religion, caste, romance, loans, health): a polite fixed deflect, with no strike. |
| **R15** | **Gibberish / unsure in free chat:** clarify plus chips, with no strike. |
| **R16** | **Prompt variables:** trade + experience (when captured) and recent turns. No name or city. |
| **R17** | **Persona:** the v3.2 bans stay (no bhai/yaar/beta, always "aap"). Voice input is on. Only fixed lines are read aloud. |
| **R18** | **Go-live: live on merge**, with no flag gate and no eval gate. A default-on kill switch is the only lever. |
| **R19** | **Release 1** ships without the cross-session conversation summary. **Release 2** adds it, carried across sessions and used by this chat only. |
| **R20** | **Testing:** unit tests plus a labelled set of about 60 lines, used as a baseline to improve against, not as a gate. |

## 3. Decision

### 3.1 Modes

```
open session → [intake, if gaps] → GREETING ("Shuru karein?"  Haan | Baad mein)
  Haan / "Resume banayein" chip / typed résumé intent ──► RESUME (locked; today's interview)
  Baad mein ──► FREE
A session that opens on a résumé-import turn (identity / batch-confirm) ──► RESUME directly
```

- The mode lives in the profiling Redis envelope (`freeChat`), protected by the CAS. No migration is needed.
- The **lock** is made durable by a sibling key in `chat_sessions.conversation_state`
  (`free_chat_lock: {v:1, locked_at}`), written by a jsonb merge and spread into every writer that replaces the
  column.
- A worker is locked when their newest session that is *ended or carries the lock key* is not ended. Any
  completion releases the lock: interview, voice form or trade form.

### 3.2 Categories and handling

**Free mode, per message (the first rule that applies wins):**

| # | Rule | Handling |
|---|---|---|
| 1 | distress word list (§5.2) | the distress line |
| 2 | a résumé import pending (an unanswered "is this you?" line, or a batch-confirm with facts to confirm) | enter résumé mode (`resume_import`) and serve the import's turn: an uploaded résumé is résumé intent |
| 3 | "Resume banayein" chip, or the greeting's Haan | enter résumé mode and serve the opener |
| 4 | the greeting's Baad mein | free mode, the later line |
| 5 | cool-down active | the cool-down line + chip, no model call |
| 6 | the per-session aside cap reached (§3.6) | the cap line + chip, no model call |
| 7 | abuse word list (`isAbusive`) | trash strike |
| 8 | classifier → `distress`, at ANY confidence (it bypasses the 0.6 floor) | the distress line |
| 9 | classifier → `resume` | enter résumé mode; a message that already describes the work becomes the first answer |
| 10 | → `career` | model reply (career prompt) → validator → served, or the fallback |
| 11 | → `casual` | model reply (casual prompt) → validator; chip always attached; nudge on every 3rd casual reply, never on the reply right after a résumé offer (R38's lines; #2172) |
| 12 | → `jobs` | the jobs line + chip |
| 13 | → `off_limits` | the off-limits line, no strike |
| 14 | → `trash` | strike; 3 in a day → 30-minute cool-down |
| 15 | → `unclear`, confidence below 0.6, or classifier **unavailable** | the clarify line + chips |

**Résumé mode, per message.**

These skip the classifier and go to today's interview:
- a tap on an offered option
- a typed answer to a number or yes/no question
- a pending offer (résumé update, identity, batch-confirm, form offer, skills gate)
- an abusive, empty, "pata nahi", hardship or question-back message, which goes to today's lexicon handling
- a double-tapped free-chat chip, which re-serves the pending question as a no-op (not captured,
  not classified, counted toward no cap)
- the turn cap

Everything else is classified:

| Verdict | Handling |
|---|---|
| `resume` (an answer) | today's interview |
| `career` / `casual` / `jobs` / `off_limits` (confident) | the deflect line + the pending question again. No turn or ask budget is spent. At most twice per pending question; a third off-topic answer passes through to the interview (stuck-loop guard). |
| below 0.6 | the clarify line + the pending question again — at most once per pending question; a second unsure answer passes through to the interview |
| `trash` | the abuse lexicon's hits take today's de-escalation path and count toward `MAX_ABUSIVE_TURNS`; a classifier-only `trash` verdict gets the de-escalation line and the pending question again but is NOT counted (CLAUDE.md §3: a model verdict never ends profiling) — at most twice per pending question; a third passes through to the interview, still uncounted |
| `distress` | the distress line, at ANY confidence (it bypasses the 0.6 floor) |
| **unavailable** (mock, timeout, blocked, error) | **today's interview.** An AI outage never degrades the live interview. |

A **real** verdict needs `ai_metadata.real_call === true` and `blocked === false`. Anything else counts as
unavailable.

### 3.3 Model calls

| Task | Route | Model | Temp / tokens | API timeout |
|---|---|---|---|---|
| `profiling_free_classify` | `POST /free-chat/classify` | cheap tier (`gemini-2.5-flash-lite`), fallback Haiku | 0.0 / 48 | ~2.5 s |
| `profiling_free_reply` | `POST /free-chat/reply` | `default_career_model` (Haiku), fallback `gemini-2.5-flash` | 0.5 / 512 | 10 s |
| `profiling_free_summary` (Release 2, §8) | `POST /free-chat/summarize` | cheap tier (`gemini-2.5-flash-lite`), fallback Haiku | 0.0 / 400 | ~8 s, off the request path |

- **The reply has two prompts on one task**, chosen by `category`. Both prompts:
  - write Latin Hinglish
  - use "aap"
  - stay within ≤4 lines of ≤20 words
  - use no "!" or emoji
  - avoid the persona's banned tokens
  - never address the worker by name
- **Casual** refuses `off_limits`, `distress` and `news`.
- **Career** refuses `legal_medical_financial` and `news`. Career allows "aam taur par" ₹ ranges and company
  names, never promises a job, and never ranks the worker.
- **Each call is memoised per `takeTurn`**, so a lost CAS never pays twice.
- **The API redacts the worker's own name** from every model input (G2), and the AI service applies the masking
  policy in force.
- **A task that is not armed returns its mock:** the classifier returns `unclear` / 0.0 (unavailable) and the
  reply returns `refuse` / `unsafe_other` (the fallback line). **Arming them is an env change on the box**
  (`AI_REAL_CALL_TASKS`, append, never replace). It is required before the API change goes live; otherwise free
  mode loops on the clarify line.

### 3.4 Validation (the model's reply is untrusted)

- The free-chat validator reuses the companion career validator's walls through an exported
  `screenAnswerWith(answer, walls)`. The companion keeps every wall on, so its behaviour is unchanged.
- Free chat turns **off** the money wall and the named-employer wall (R11). It keeps:
  - shape, Latin-only, no "!", no emoji, no format or control characters
  - persona tokens
  - promise, sensitive (legal/medical/financial), rating
  - PII
- It also rejects `{{` and `}}`, because replies are interpolated.
- Any failure serves `REPLY_FALLBACK`. A refusal topic serves its fixed line.

### 3.5 Transcript hygiene

- Every free-chat line carries a new `aside: true` buffer flag. Flushed rows get `metadata.free_chat = true`.
  This covers the greeting, the opener after Haan, free-mode turns, deflections and clarifies.
- The predicate `intake || aside` keeps these lines out of all of these:
  - the interview model's history (`transcriptOf`)
  - profile extraction
  - the résumé quote/veto readers
  - the alias miner
- **Casual talk never reaches a profile.** The chat thread still shows these lines.

### 3.6 Interactions

- **Free turns spend nothing:** no `turnCount`, no ask budget, no `MAX_ENGINE_TURNS`.
- **The general road stamp** (ADR-0045 D7) moves from the intake handoff to the moment résumé mode is entered. It
  arms exactly as today's first message would.
- **The `openResumeConfirm` gate** treats a free-chat envelope like an intake, so a reattach cannot open a résumé
  turn underneath the greeting.
- **The voice form** does not reattach to a greeting/free session.
- **About 60 aside turns per session** protects the 600-line buffer. At the cap, free mode serves only the cap
  line + chip.
- A throttled `touchSession` keeps a long free chat from being swept as abandoned.

### 3.7 Events (`.strict()`, ids and closed enums only, emitted after the CAS)

- **`chat.free_chat_turn_served` v1**, for every turn the free chat serves itself:
  - fields: worker_id, session_id, mode, category, decided_by, confidence_bucket, outcome, refusal_topic,
    strike_count, cooldown_started, nudge, submission_id
  - a résumé-mode pass-through emits nothing
- **`chat.free_chat_mode_changed` v1**: worker_id, session_id, from (nullable), to, trigger.
- The closed sets live in `@badabhai/types` (`FREE_CHAT_*`). The AI contract lives in
  `@badabhai/ai-contracts/free-chat`.

### 3.8 Wire

- **Additive fields:**
  - `read_aloud: false`, only on model-written turns.
  - Release 2, #2030: `free_chat_mode` (`greeting` | `free` | `resume`) on `POST /chat/message` replies, the
    `POST /chat/session` start response and replays. It carries the mode after the turn, and is ABSENT (never null)
    under the kill switch, with no mode, on the voice form and on an ended session. The app hides its "build my
    profile" CTA while it is `greeting` or `free`.
- The greeting uses the existing `opening_text` / `opening_options` fields, or the reply's `suggested_options`.
- **The app needs no release for release 1.** It draws server chips and posts the tapped label back as text.
- **App follow-ups** (frontend issue):
  - honour `read_aloud` and `cooldown_until` on the interview path
  - hide the "build my profile" button in free mode
  - restore chips after a reload
  - disable the composer during the cool-down
  - keep free-chat bubbles out of the #1316 analytics indices

## 4. Invariants

- **AI never decides.** The model classifies and phrases. Deterministic code picks the handler, applies the
  priority and the confidence floor, validates every line, and serves fixed copy for every non-model category. No
  ranking.
- **Fail closed, and the interview first.** In free mode, any model failure gets clarify or the fallback line. In
  résumé mode, an unavailable classifier passes the message to today's interview, which is the deterministic path.
- **Privacy (ADR-0047).** The masking policy in force applies at the AI service. The worker's own name is redacted
  before any model input (G2). Output carrying a hard identifier is dropped (G1, through the validator's PII
  wall). No worker or model text goes on the event spine.
- **The companion is unchanged.** Its routes, labels, prompts, events and validator results are unchanged; the
  validator refactor is behaviour-preserving and pinned by its existing tests.
- **Kill switch.** With `CHAT_FREE_CHAT_DISABLED=true`, every profiling response is byte-for-byte what it was
  before this ADR.

## 5. Copy

### 5.1 Fixed lines (approved 2026-10-06)

All lines follow persona v3.2: "aap", ≤20 words, ≤1 "?", no "!", none of the banned words. The only number in
any line is the helpline.

| Key | Latin (served) | Devanagari (read aloud) | Chips |
|---|---|---|---|
| GREETING | Namaste, main Bada Bhai hoon. Aapka resume banane mein madad karunga. Shuru karein? | नमस्ते, मैं बड़ा भाई हूँ। आपका रिज़्यूमे बनाने में मदद करूँगा। शुरू करें? | Haan, shuru karein · Baad mein |
| OPENER | Theek hai. Aap kaun sa kaam karte hain, aur kitna tajurba hai? | ठीक है। आप कौन सा काम करते हैं, और कितना तजुर्बा है? | — |
| LATER_ACK | Theek hai. Jab mann ho, resume bana lenge. Tab tak kuch bhi poochhiye. | ठीक है। जब मन हो, रिज़्यूमे बना लेंगे। तब तक कुछ भी पूछिए। | Resume banayein |
| LOCK_DEFLECT | Pehle resume bana lete hain, phir kuch aur baat karenge. | पहले रिज़्यूमे बना लेते हैं, फिर कुछ और बात करेंगे। | + pending question |
| LOCK_CLARIFY | Samajh nahi aaya. Ek baar phir bataiye. | समझ नहीं आया। एक बार फिर बताइए। | + pending question |
| FREE_CLARIFY | Samajh nahi aaya. Aap kya karna chahte hain? | समझ नहीं आया। आप क्या करना चाहते हैं? | Resume banayein |
| JOBS | Jab aapki profile ban jayegi, tab aapke kaam ki jobs dikhayenge. Resume banayein? | जब आपकी प्रोफ़ाइल बन जाएगी, तब आपके काम की जॉब्स दिखाएँगे। रिज़्यूमे बनाएँ? | Resume banayein |
| CASUAL_NUDGE | Waise, aapka resume bana dein? Kaam dhoondhne mein kaam aayega. | वैसे, आपका रिज़्यूमे बना दें? काम ढूँढने में काम आएगा। | Resume banayein |
| OFF_LIMITS | Is baare mein main baat nahi karta. Kaam ya resume ki baat karein? | इस बारे में मैं बात नहीं करता। काम या रिज़्यूमे की बात करें? | Resume banayein |
| NEWS | Taaza khabar abhi nahi bata sakta. Yeh suvidha jaldi aayegi. | ताज़ा ख़बर अभी नहीं बता सकता। यह सुविधा जल्दी आएगी। | Resume banayein |
| LEGAL_MED_FIN | Is baare mein kisi jaankar se salah lijiye. Main kaam aur resume mein madad karta hoon. | इस बारे में किसी जानकार से सलाह लीजिए। मैं काम और रिज़्यूमे में मदद करता हूँ। | Resume banayein |
| REPLY_FALLBACK | Is par abhi kuch keh nahi paunga. Kaam ya resume ki koi baat poochhiye. | इस पर अभी कुछ कह नहीं पाऊँगा। काम या रिज़्यूमे की कोई बात पूछिए। | Resume banayein |
| TRASH_WARN | Aisi bhasha theek nahi. Kaam ya resume ki baat karein. | ऐसी भाषा ठीक नहीं। काम या रिज़्यूमे की बात करें। | Resume banayein |
| TRASH_COOLDOWN | Thodi der ke liye baat rok rahe hain. Tab tak resume bana sakte hain. | थोड़ी देर के लिए बात रोक रहे हैं। तब तक रिज़्यूमे बना सकते हैं। | Resume banayein |
| DISTRESS | Aap akele nahi hain. Tele-MANAS 14416 par abhi baat kijiye, yeh muft hai. | आप अकेले नहीं हैं। टेली-मानस 14416 पर अभी बात कीजिए, यह मुफ़्त है। | — |
| ASIDE_CAP | Bahut baatein ho gayin. Ab aapka resume bana lete hain? | बहुत बातें हो गईं। अब आपका रिज़्यूमे बना लेते हैं? | Resume banayein |

**Reply-language lines (approved 2026-10-08, §11 R41).** `{Language}` is the requested language's display name:
English, Hindi, Marathi, Gujarati, Kannada, Telugu or Tamil. The Devanagari twins use अंग्रेज़ी, हिंदी, मराठी,
गुजराती, कन्नड़, तेलुगु, तमिल.

| Key | Latin (served) | Devanagari (read aloud) | Chips |
|---|---|---|---|
| LANG_ASK | Kya aage ki saari baat {Language} mein karein? | क्या आगे की सारी बात {Language} में करें? | Haan, {Language} mein · Nahi |
| LANG_YES | Theek hai, ab se {Language} mein baat karenge. | ठीक है, अब से {Language} में बात करेंगे। | — |
| LANG_NO | Theek hai. Aap jis bhasha mein likhenge, usi mein jawab dunga. | ठीक है। आप जिस भाषा में लिखेंगे, उसी में जवाब दूँगा। | — |

**Chips and their keys:**
- "Haan, shuru karein" → `free_chat_start`
- "Baad mein" → `free_chat_later`
- "Resume banayein" → `free_chat_resume`
- "Haan, {Language} mein" → `free_chat_lang_yes`, and "Nahi" → `free_chat_lang_no`. These are read only while an
  ask is pending (§11).

The app posts the label, so readers match the key or the label. Typed variants are also read: haan / ha / yes /
shuru / ok, and baad mein / baad me / later / abhi nahi.

### 5.2 Distress word list (closed; matched as whole phrases, case- and diacritic-insensitive)

- **Latin:** `suicide`, `khudkushi`, `khud khushi`, `aatmahatya`, `atmahatya`, `jeene ka mann nahi`,
  `jine ka man nahi`, `marna chahta`, `marna chahti`, `mar jaana chahta`, `mar jana chahta`,
  `mar jaana chahti`, `mar jana chahti`, `zindagi khatam karna`, `jaan de dunga`, `jaan de dungi`,
  `kill myself`, `end my life`.
- **Devanagari:** `आत्महत्या`, `खुदकुशी`, `ख़ुदकुशी`, `मरना चाहता`, `मरना चाहती`, `जीने का मन नहीं`.

Any widening of this list follows the same review as the copy.

- **Regional (§9, R28):** whole phrases in Marathi, Gujarati, Kannada, Telugu and Tamil (own script and Latin), plus
  word-start stems for "suicide" itself. The canonical list is `DISTRESS_PHRASES` and `DISTRESS_STEMS` in
  `apps/api/src/profiling/free-chat/free-chat.router.ts`.

## 6. Consequences

- **Latency and cost.** One classifier call per typed résumé-mode answer that the skip list does not settle.
  Today's companion classifier runs at p95 1.6–2.4 s. Free mode adds one reply call for casual and career. No
  per-worker cap; cost is recorded per call (`ai.cost_recorded`). On the admin dashboard,
  `profiling_free_classify` counts toward cost-per-profile and `profiling_free_reply` does not.
- **Known limits (accepted by the owner):**
  - ₹ ranges and company names are model knowledge and can be wrong or stale. The model may say a company "is
    hiring" (R11).
  - Until the app follow-up ships, a model reply shows a speaker that reads the Latin text, and chips are not
    restored after a reload.
  - The daily strike count lives in the session envelope, so a new session (after 6 hours idle) starts at zero.
- **Deferred:**
  - the cross-session summary (release 2)
  - live news (phase 2)
  - job search in chat. **Closed by owner ruling on 2026-10-08 (#2129): it stays out of the profiling
    chat (R8).** Before confirmation a worker has no skill rows to match on, so the deterministic feed
    would show either an empty deck (`MATCH_V1` on) or every open posting, unpersonalised (`MATCH_V1`
    off). The second breaks "never show irrelevant" and is the "every posting" fallback that ADR-0044
    R5 rules out. The worker gets jobs after confirmation, from the companion's `companion_job:` chips.
    The app's count of a job opened outside the companion (#2145, PR #2165) never fires here, because
    this chat serves no job chips.

## 7. Rollout

1. PR 0 (this ADR plus the shared contracts) merges.
2. PR A (ai-service: the two tasks) and PR B (api) are built in parallel.
3. PR A merges.
4. **Owner:** append `profiling_free_classify,profiling_free_reply` to the box's `AI_REAL_CALL_TASKS` and
   redeploy.
5. PR B merges. **The feature is live.**
6. Device test, then the improvement loop: event probes → labelled set → prompt revisions (§10).
7. **Rollback:** set the `production` environment secret `CHAT_FREE_CHAT_DISABLED=true` and redeploy.
   The switch writes nothing; sessions started while it was on keep their mode and lock.

## 8. Release 2 — the rolling conversation summary (owner rulings 2026-10-07)

Release 1 went live on 2026-10-07 (deploy run 37577845893; a read-only probe showed `real_call=true` for both
tasks). Release 2 adds the cross-session summary deferred by R19.

| # | Ruling |
|---|---|
| **R21** | **Rolling.** When free-chat lines age out of the reply's recent-turn window, they are folded into the summary. |
| **R22** | **Free-chat talk only.** Only free-mode casual and career exchanges are summarised. Interview answers already live in the profile and are never sent. |
| **R23** | **Kept indefinitely** until account erasure. It is read only by this chat; after confirmation the companion never reads it. |
| **R24** | **Reply only.** The casual/career reply prompt gets the summary. The classifier never does. |

**How it works:**
- **Model task.** `profiling_free_summary` (`POST /free-chat/summarize`) runs on the cheap tier, temperature 0.
  - **Input:** the previous summary plus the aged-out turns (1–24, own name redacted).
  - **Output:** the new summary or null. Its mock returns null, so an unarmed task stores nothing.
  - The summary is model-facing context in compact English notes and is never shown to the worker.
- **When it runs.** The fold runs **after** the reply is served (never on the worker's critical path), at most one
  per session at a time (a Redis NX lock). Turns carrying a G1 hard identifier are dropped before the call. If the
  worker's own name cannot be looked up, the fold is skipped (it retries on the next casual reply).
- **Validation.** The API validates the summary before storing it. Each of these rejects it:
  - empty
  - G1 `containsHardIdentifier` (a scanner error also rejects)
  - `{{` / `}}`
  - any line not shaped `- …`, or more than 10 lines
  - the abuse lexicon on any line
  - an injection cue: the prompt's own labels, "ignore/disregard/forget … rules/instructions/prompt", "system
    prompt", "you are now", "role-play"/"jailbreak"
  - more than 1200 characters after the worker's own name is redacted
- **Only real calls count.** A summary is stored only when `ai_metadata.real_call === true` and `success !== false`.
  - A REAL call that returns no summary, or whose summary is rejected, still CONSUMES its batch: `folded_lines`
    advances and the previous text is kept, so the same batch is never retried forever.
  - A transport failure (no metadata, a mock, `success: false`, a merge that did not write) leaves the count alone
    and retries.
- **Storage.** It is stored as a `free_chat_summary {v:1, text (nullable), updated_at, session_id, folded_lines}`
  sibling key in `chat_sessions.conversation_state`, by jsonb merge, with no migration. `text` is null while only
  the watermark exists.
  - The whole-column writers (checkpoint, flush, abandon) keep the LIVE row's key in SQL, so a fold that lands
    between a request's read and its write is never reverted.
  - At session open the latest non-null text is read from the worker's sessions. `folded_lines` counts only the
    current session's lines.
- **Event.** `chat.free_chat_summary_updated` v1 (updated / rejected / unavailable, `folded_lines`,
  `summary_chars`); never the text.
- **Kill switch.** It stops folding as well.
- **Erasure.** The summary lives on `chat_sessions`, which account erasure already removes (`ON DELETE cascade`). The
  worker-facing privacy notice should disclose that chat notes are kept (owner action).
- **Arming.** Append `profiling_free_summary` to the box's `AI_REAL_CALL_TASKS`. Until then the mock folds nothing,
  so merging first is safe.
- **Known limit.** Lines still inside the window at session end (up to 6, plus up to 3 pending ones, plus any fold
  skipped while the lock was held) are not folded, so the next session does not see them.

## 9. Regional languages (owner rulings 2026-10-07, #2126)

Release 2 went live on 2026-10-07 (build `19413cd`). This section lets a worker write in five more languages.

| # | Ruling |
|---|---|
| **R25** | **Input.** The worker may write in **Marathi, Gujarati, Kannada, Telugu or Tamil** as well as Hindi, Hinglish and English, in the language's own script or in Latin letters. Every category, mode and guardrail behaves the same whatever the language. |
| **R26** | **Reply language.** A casual or career reply comes back in the worker's language **mixed with English, in Latin letters**: the way Hinglish mixes Hindi and English (Tamil + English, Telugu + English, and so on). Hindi, Hinglish, English and anything unsure keep today's Hinglish. **Superseded for English by R40 (§11): English in, English out.** |
| **R27** | **Everything else is unchanged:** the fixed lines (§5.1, still Hinglish), the résumé lock and interview, the English résumé, the English conversation notes (§8) and every guardrail. |
| **R28** | **Distress list.** §5.2 is widened with phrases in the five languages, in both scripts, reviewed and approved by the owner like the copy. |

**How it works:**
- **Classifier.** The prompt names the five languages and classifies the meaning "whatever the language". The labelled
  set gains 17 regional lines (all five languages, both scripts, both modes) as a baseline, not a gate (R20).
- **Reply prompts.** A shared LANGUAGE block tells both reply prompts to answer in the language of the worker's
  latest message, mixed with English, always in Latin letters. It also gives each language's respectful "you"
  (tumhi; tame/aap; neevu/nimma; meeru/mee; neenga/unga) and its informal "you" to avoid.
- **The reply gate stays Latin-only.** The career gate's `non_latin` wall is unchanged, so a reply in a regional
  script still serves the fallback line. Its word walls are spelled in Hindi and English, so a free-chat-only
  **regional wall** (`free-chat-regional-walls.ts`) holds a regional reply to the same bar in its own words:
  - **persona:** familiar address (anna, thambi, machan, bhau, dada, maga, …) and the informal "you";
  - **promise:** "pakku" alone, or a "surely" word and a "will get" word in one line (the regional
    "zaroor milegi"). A "surely" word alone is advice, just as "zaroor try kijiye" is;
  - **sensitive advice:** each language's words for lawyer, court, medicine, treatment, loan, insurance and
    investment;
  - **rating:** a respectful "you" directly before a judgement word (the regional "aap achhe").

  The walls reuse the career gate's failure reasons and run over every line and chip. They apply to every
  free-chat reply, Hinglish included. **The companion's validator is untouched** (§4). Both reply prompts name every
  word on these lists, and an ai-service test pins the prompt's lists equal to the API's.
- **Distress.** The §5.2 list gains whole phrases in the five languages, in both scripts, plus **word-start stems**
  for the word "suicide" itself (आत्महत्य, ఆత్మహత్య, ಆತ್ಮಹತ್ಯ, આત્મહત્ય, આપઘાત, தற்கொலை and their Latin
  spellings). Tamil, Telugu, Kannada and Gujarati join case endings onto the noun ("தற்கொலைக்கு"), which a
  whole-word match would miss. Distress is still checked before anything else, in both modes.

**Known limits (accepted):**
- The fixed lines (deflect, jobs, distress, cool-down, …) stay Hinglish, so a Tamil worker reads a Hinglish fixed line
  between Tamil + English model replies. Translated fixed lines would need their own copy review.
- The abuse lexicon is Hindi/English. Regional abuse is caught by the classifier: a strike in free mode, and the
  uncounted de-escalation in résumé mode (an AI-only verdict never ends profiling).
- `hasFirstPersonClaim` (the résumé-entry check that turns a self-description into the first answer) reads Hinglish,
  so a regional "I am a welder, make my résumé" enters résumé mode with the opener rather than as the first answer.
- Romanized spellings vary. The lists carry the common ones, and the prompts steer the model away from all of them.
  A miss is no worse than a word the prompt could also miss.
- The Hindi/English walls also apply to a regional reply. For example, the career gate's `pakka` is also Telugu for
  "beside", so a Telugu line using it that way serves the fallback.

## 10. The improvement loop (owner rulings 2026-10-08, #2128)

§7 step 6 promised "event probes → labelled set → prompt revisions". This section says how a round runs.

| # | Ruling |
|---|---|
| **R29** | **Real messages, masked sample.** A round may read up to 50 recent free-chat messages the bot struggled with, read-only, with the owner's approval each time. A message carrying a hard identifier, a name cue, or a name that cannot be looked up is left out whole. The worker's own name is masked. Only fabricated rewrites enter the repo; no real text is stored anywhere new. |
| **R30** | **Cadence.** Round 1 runs now; later rounds run when the owner asks. |
| **R31** | **Ship bar for a prompt revision.** The overall score on the labelled set goes up, **distress, trash and off_limits lose no line**, and every other category drops by at most one line. |
| **R32** | **Eval runs use the live model.** The classifier eval runs on the paid key, with `--expect-model` naming the model that production actually serves. The route's primary is `gemini-2.5-flash-lite`. On 2026-10-08 every box call was served by `claude-haiku-4-5` (#2170), so Haiku is the live model until #2170 is resolved. A Haiku-only run is a re-run owed on flash-lite before the box switches. A run answered by a model other than the one named is not evidence. |
| **R33** | **Own name in another script or as a nickname: accepted limit.** The probe masks the name as stored. "सुरेश" for a stored "Suresh", or "Raju" for "Rajesh", is shown. Only the worker's own first name gets through this way, never an id or a phone, and regional-script lines stay in the sample. |
| **R34** | **The sample runs on the box only.** `--sample` refuses unless `NODE_ENV=production` and the real PII keys are loaded. The production key is never copied to a laptop. The owner runs it in the api container and pastes the masked output. |
| **R35** | **The pasted copy is named and deleted.** The output pasted into the operator's Claude Code session is kept in that session's local transcript, a store outside DPDP erasure (risks register R67). Once the round's labelled lines are written, the session transcript is deleted. |
| **R36** | **Whose lines may be sampled.** Checking the bot's quality is treated as part of running the profiling chat the worker agreed to. A line is eligible only when its worker's latest consent is active and includes `profiling`, and no deletion is scheduled. A withdrawn or erasure-pending worker is never sampled. ADR-0018's `model_training` purpose governs a training corpus and is not required here. No worker has given it, because the app does not ask. |
| **R37** | **Only clear abuse is `trash`.** Gaali, slurs and clear abuse are strikes. A mild insult at the bot ("tu pagal hai kya"), teasing, a complaint about the app, or exasperation at a misread is `casual`: a polite reply, no strike. This matches the abuse word list, which leaves mild words out on purpose. A strike leads to a 30-minute block (R13). |
| **R38** | **A bare acknowledgement after a résumé offer is a yes.** In free mode, "ok", "accha" or "theek hai" right after a line where Bada Bhai offers to make the résumé is `resume`. Those lines are JOBS, CASUAL_NUDGE, NEWS_CAP, and a reply ending with that offer. After any other line, a bare acknowledgement is `unclear`. |

**One round:**
1. **Probe (read-only, owner approval).** `node apps/api/dist/profiling/free-chat/free-chat-probe.cli.js
   --since=<date> [--sample=N]` runs inside one read-only transaction. Without `--sample` it prints counts only,
   and runs anywhere the database is reachable:
   - turns by mode × decided_by × category × outcome, with the classifier's confidence buckets;
   - clarify loops, in greeting and free mode, where every message records an event;
   - sessions with repeated deflections. The order is unknown, because a résumé-mode message that goes to the
     interview records no event;
   - mode changes, summary outcomes and news outcomes;
   - `ai.cost_recorded` for the four free-chat tasks.

   With `--sample`, on the box only (R34), it adds the masked struggled messages (R29): clarify, fallback or
   deflected turns, and classifier verdicts acted on at 0.5–0.7 confidence, from eligible workers only (R36). A turn
   the bot handled as distress is never sampled. A turn whose line cannot be told apart from a neighbour's (overlapping sends) is left out. Each line
   is printed quoted, under an "untrusted worker text" header, with an ordinal and never an id:

   ```bash
   docker exec badabhai-api node apps/api/dist/profiling/free-chat/free-chat-probe.cli.js --since=<date> --sample=50
   ```

   `badabhai-api` is the container name fixed in `docker-compose.yml`. A bare `docker compose … exec` stops on the
   staging file's required `API_IMAGE` / `AI_SERVICE_IMAGE` variables.
2. **Grow the labelled set.** Each weak spot becomes fabricated lines in `eval_free_classify_gold.py`, written fresh
   rather than copied from the sample.
3. **Score the baseline** on the current prompt (R32), on the model production actually serves: read the served
   `model` from `ai.cost_recorded`. On 2026-10-08 that was `claude-haiku-4-5` for every call, because the box's
   Gemini calls all fall back (#2170).
4. **Revise the prompt.** Bump its registry version and score again in the same sitting. Ship only past R31.
5. **Delete the pasted copy** (R35).

**Known limits (accepted):**
- **The sample sees flushed sessions only.** An in-flight conversation lives in the box's Redis. It reaches
  `chat_messages` only at the completion flush, or when the idle sweep closes an abandoned session whose buffer is
  still there. A worker whose buffer expired first is visible in the counts but not in the sample. The probe does
  not read Redis.
- **Masking is fail-closed but not complete.** A line is dropped whole if it has:
  - a hard identifier;
  - 9 or more digits;
  - a name cue (the common Hindi, English and §9-language forms; spoken variants such as Tamil "per" are not all
    covered);
  - an unreadable name;
  - or a stored-name token still in it after masking. A token of 3 or more letters counts anywhere in the
    line, checked as written and again with combining marks (nukta, virama, vowel signs) stripped from both
    the line and the token. A 2-letter token counts only as a whole word. A 1-letter token (an initial)
    never counts.

  R29 covers identifiers, name cues and the worker's own name only. So these still get through:
  - the R33 cases;
  - another person's name with no cue ("mere bhai Ramesh ko…");
  - place and employer names;
  - numbers written in words.
- **No privacy notice yet** tells workers their chats help improve the bot (owner action, alongside the §8 note;
  risks register R67).

## 11. Reply language (owner rulings 2026-10-08, #2181)

§9 asked the reply model to choose its own language, and on the production model it would not. Before this change,
on `claude-haiku-4-5`, which serves every box call (#2170):
- Marathi (Latin and Devanagari), Tamil and Gujarati questions got Hinglish replies in 9 of 10 runs.
- "marathi mai jawab do" got the previous Hinglish answer repeated word for word.
- Replies slipped into "tum" verb forms ("karo", "jaao", "sakte ho") against R17.

Understanding was never the problem: the Marathi question was classified and answered correctly.

| # | Ruling |
|---|---|
| **R39** | **Code detects the language, the model follows.** The API decides each reply's language with word lists, in Latin letters and in each language's script. It passes the result to the reply and news calls as `reply_language`, and the prompt follows it. The model no longer chooses. |
| **R40** | **Every reply mirrors the worker's message.** English in, English out: plain, simple English (this supersedes R26 for English). Hindi or Hinglish, in either script, gets Hinglish. Marathi, Gujarati, Kannada, Telugu or Tamil gets that language mixed with English. Anything unsure gets Hinglish. Always Latin letters (R26). The fixed lines stay Hinglish (R27). The worker should feel they are chatting with someone who speaks every language they do. |
| **R41** | **An explicit language request.** For example "marathi mai jawab do" or "reply in Tamil". That one reply comes in the requested language. Then the fixed ask "Kya aage ki saari baat {Language} mein karein?" follows, with the chips "Haan, {Language} mein" and "Nahi". **Haan:** "Theek hai, ab se {Language} mein baat karenge." Every reply then uses that language for the whole chat, across returns, until another request. **Nahi:** "Theek hai. Aap jis bhasha mein likhenge, usi mein jawab dunga." Each reply follows the message again. Copy approved as drafted. |

**How it works:**
- **Free mode only.** The résumé lock and interview are unchanged (R27). So are the classifier, which still reads the
  meaning in any language, and the conversation notes, which stay in English (§8).
- **Detection (API, pure, literal regexes):**
  - A Gujarati, Tamil, Telugu or Kannada script decides the language.
  - Devanagari is Marathi when Marathi markers outweigh Hindi ones, otherwise Hinglish.
  - Latin text is scored against per-language marker words. Examples: Marathi "aahe", "mala", "kay"; Gujarati "chhe",
    "mare", "kem"; Tamil "enakku", "eppadi"; Telugu "naaku", "ela"; Kannada "nanage", "hege". English is told apart
    from Hinglish by Hindi markers.
  - A tie, or too little evidence, is Hinglish.
- **Precedence for one reply:** an explicit request in the message, then the kept language, then the message's own
  language.
- **The kept language** is stored as a `free_chat_language {v:1, language, set_at, session_id}` sibling key in
  `chat_sessions.conversation_state`. It is written by jsonb merge, with no migration, and read at session open
  (the latest set value), like the §8 summary. Account erasure removes it with the session rows.
- **The ask** is served after the requested-language reply, with its two chips. Only the next message can answer
  it. A tapped chip, or its typed label, is read deterministically. Anything else lets the offer lapse with no
  change.
- **Prompts:**
  - The reply and news prompts carry one hard line, "Reply language: …". English answers are in plain, simple
    English.
  - Every language uses its respectful forms: in Hinglish "kariye / seekhiye / sakte hain", never
    "karo / jaao / sakte ho".
  - An earlier reply is never repeated word for word. A bare language request re-answers the worker's previous
    question in that language.
- **Event:** `chat.free_chat_language_changed` v1 (`from`, `to`, `trigger` accepted | declined; ids and enums
  only). It fires when the kept language changes.
- **No app release.** Chips are drawn by the server.

```
Owner rulings R1–R20 taken 2026-10-06 in the design session; plan and copy approved the same day.
Signed (Divyanshu): Divyanshu          Date: 2026-10-06
Release 2 rulings R21–R24 taken 2026-10-07 (§8).
Regional-language rulings R25–R28 taken 2026-10-07 (§9).
Improvement-loop rulings R29–R38 taken 2026-10-08 (§10).
Reply-language rulings R39–R41 taken 2026-10-08 (§11).
```
