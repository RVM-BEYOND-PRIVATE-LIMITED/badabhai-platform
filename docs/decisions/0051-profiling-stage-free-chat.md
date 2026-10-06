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
| **R8** | **Jobs:** a fixed line plus an offer to start the résumé. No job search in chat. |
| **R9** | **Casual:** model-written and checked by code. The résumé chip is always shown, and a nudge is added every 3rd casual turn. |
| **R10** | **Distress:** a fixed line plus a helpline (Tele-MANAS 14416, checked 2026-10-06: toll-free, 24×7, Ministry of Health). The model never writes this reply. |
| **R11** | **Career:** model-written and checked by code. Refuses legal/medical/financial. **Typical ₹ ranges are allowed. Company names are allowed freely.** Encourage the worker but never rank them. Never promise a job; stay hopeful. |
| **R12** | **Live news:** phase 2 (web search, its own ADR). Until then a news request gets a fixed line. |
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
| 1 | cool-down active | the cool-down line + chip, no model call |
| 2 | "Resume banayein" chip, or the greeting's Haan | enter résumé mode and serve the opener |
| 3 | distress word list (§5.2) | the distress line |
| 4 | abuse word list (`isAbusive`) | trash strike |
| 5 | classifier → `resume` | enter résumé mode; a message that already describes the work becomes the first answer |
| 6 | → `career` | model reply (career prompt) → validator → served, or the fallback |
| 7 | → `casual` | model reply (casual prompt) → validator; chip always attached; nudge on every 3rd casual reply |
| 8 | → `jobs` | the jobs line + chip |
| 9 | → `off_limits` | the off-limits line, no strike |
| 10 | → `distress` | the distress line |
| 11 | → `trash` | strike; 3 in a day → 30-minute cool-down |
| 12 | → `unclear`, confidence below 0.6, or classifier **unavailable** | the clarify line + chips |

**Résumé mode, per message.**

These skip the classifier and go to today's interview:
- a tap on an offered option
- a typed answer to a number or yes/no question
- a pending offer (résumé update, identity, batch-confirm, form offer, skills gate)
- an abusive, empty or "pata nahi" message, which goes to today's lexicon handling
- the turn cap

Everything else is classified:

| Verdict | Handling |
|---|---|
| `resume` (an answer) | today's interview |
| `career` / `casual` / `jobs` / `off_limits` (confident) | the deflect line + the pending question again. No turn or ask budget is spent. |
| below 0.6 | the clarify line + the pending question again |
| `trash` | today's de-escalation path and the `MAX_ABUSIVE_TURNS` cap (forced-abusive capture) |
| `distress` | the distress line |
| **unavailable** (mock, timeout, blocked, error) | **today's interview.** An AI outage never degrades the live interview. |

A **real** verdict needs `ai_metadata.real_call === true` and `blocked === false`. Anything else counts as
unavailable.

### 3.3 Model calls

| Task | Route | Model | Temp / tokens | API timeout |
|---|---|---|---|---|
| `profiling_free_classify` | `POST /free-chat/classify` | cheap tier (`gemini-2.5-flash-lite`), fallback Haiku | 0.0 / 48 | ~2.5 s |
| `profiling_free_reply` | `POST /free-chat/reply` | `default_career_model` (Haiku), fallback `gemini-2.5-flash` | 0.5 / 512 | 10 s |

- **The reply has two prompts on one task**, chosen by `category`. Both prompts:
  - write Latin Hinglish
  - use "aap"
  - stay within ≤4 lines of ≤20 words
  - use no "!" or emoji
  - avoid the persona's banned tokens
  - never address the worker by name
- **Casual** refuses `off_limits` and `distress`.
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

- **One additive field:** `read_aloud: false`, only on model-written turns.
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

**Chips and their keys:**
- "Haan, shuru karein" → `free_chat_start`
- "Baad mein" → `free_chat_later`
- "Resume banayein" → `free_chat_resume`

The app posts the label, so readers match the key or the label. Typed variants are also read: haan / ha / yes /
shuru / ok, and baad mein / baad me / later / abhi nahi.

### 5.2 Distress word list (closed; matched as whole phrases, case- and diacritic-insensitive)

- **Latin:** `suicide`, `khudkushi`, `khud khushi`, `aatmahatya`, `atmahatya`, `jeene ka mann nahi`,
  `jine ka man nahi`, `marna chahta`, `marna chahti`, `mar jaana chahta`, `mar jana chahta`,
  `mar jaana chahti`, `mar jana chahti`, `zindagi khatam karna`, `jaan de dunga`, `jaan de dungi`,
  `kill myself`, `end my life`.
- **Devanagari:** `आत्महत्या`, `खुदकुशी`, `ख़ुदकुशी`, `मरना चाहता`, `मरना चाहती`, `जीने का मन नहीं`.

Any widening of this list follows the same review as the copy.

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
  - job search in chat

## 7. Rollout

1. PR 0 (this ADR plus the shared contracts) merges.
2. PR A (ai-service: the two tasks) and PR B (api) are built in parallel.
3. PR A merges.
4. **Owner:** append `profiling_free_classify,profiling_free_reply` to the box's `AI_REAL_CALL_TASKS` and
   redeploy.
5. PR B merges. **The feature is live.**
6. Device test, then the improvement loop: event probes → labelled set → prompt revisions.
7. **Rollback:** set the `production` environment secret `CHAT_FREE_CHAT_DISABLED=true` and redeploy.

```
Owner rulings R1–R20 taken 2026-10-06 in the design session; plan and copy approved the same day.
Signed (Divyanshu): Divyanshu          Date: 2026-10-06
```
