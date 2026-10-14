# ADR-0055: The Bada Bhai chat runs the free-chat brain

- **Status:** **Accepted — owner Divyanshu, 2026-10-14.** Rulings 1–4 below were taken on 2026-10-14.
  **Live on merge:** no new flag. The only lever is the existing kill switch `CHAT_FREE_CHAT_DISABLED`.
- **Date:** 2026-10-14
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2275
- **Relates:**
  - [ADR-0044](0044-post-completion-chat-companion.md) and [ADR-0046](0046-chat-companion-v2-llm-task-router.md):
    the Bada Bhai chat (the companion) this changes.
  - [ADR-0051](0051-profiling-stage-free-chat.md): the free chat whose brain it now runs.
  - [ADR-0054](0054-free-chat-live-news.md): live news, now on this screen too.
  - [ADR-0047](0047-lift-pii-restriction.md): the masking policy. G1 stays enforced.
  - [ADR-0044](0044-post-completion-chat-companion.md) R8 is narrowed: see §4.

---

## 1. Context

After profiling, the worker talks to Bada Bhai on the companion (`POST /chat/companion/message`). A message the
deterministic resolver misses goes to the v2 router: the companion classifier picks an intent, and a handler
answers. The router knows only résumé edits, a new résumé, career talk and trash. Everything else is "Samajh nahi
aaya", and its career answers may not name a figure or a company (ADR-0046 O10).

The profiling chat already has a better brain (ADR-0051): one classifier with eight categories, casual and career
replies with typical ₹ ranges and company names, live news, the worker's language and a distress helpline. The
owner wants the same brain on the Bada Bhai chat, with every companion feature kept (the recap, the job chips, the
edit card and the redo menu).

## 2. Rulings (owner, 2026-10-14)

| # | Ruling |
|---|---|
| **1** | **Jobs.** A typed jobs question gets a fixed line and the existing `companion_jobs_tab` chip "Sabhi jobs dekhein", which the app already routes to the Jobs screen. |
| **2** | **Free-chat rules on this screen.** Career and casual replies may give typical ₹ ranges and name companies (`FREE_CHAT_WALLS`). Live news (ADR-0054), the reply in the worker's language, the distress helpline and the off-limits deflect all apply. |
| **3** | **No new flag; live on merge.** The only lever is `CHAT_FREE_CHAT_DISABLED`. When it is true, the companion runs today's v2 path byte for byte. |
| **4** | **Extras.** "Form se resume banayein" is added to the redo menu. A download request the classifier finds gets the `companion_resume_download` chip. |

## 3. The pipeline

`ChatCompanionService.message`, then `CompanionV2Orchestrator.handleMessage`. Steps marked **new** run only while
the brain is on (`CHAT_COMPANION_V2_ENABLED` on and the kill switch off):

1. Policy (unchanged).
2. Exact chips (unchanged), plus **new**: the form road's label ("Form se resume banayein") is answered by its ack.
3. **New: the distress word list** (`matchesDistress`, the free chat's own list) runs before the cool-down and
   before v1. A hit serves `DISTRESS` (the Tele-MANAS line) with no chips. No gateway call, no model, no memory.
4. The faltu cool-down (unchanged).
5. The v1 deterministic resolver (unchanged). On the brain, its redo menu also offers the form road.
6. The abuse lexicon sends the message to the existing `FaltuHandler` (unchanged). The gateway and memory are also unchanged.
7. **New: one classifier call.** `FreeChatModelCalls.classifyWithAction` runs in mode `free` with surface
   `companion`. Its context is the companion memory. It returns the category and the résumé action:

   | Verdict | Answer |
   |---|---|
   | distress (any confidence, ADR-0051 R10) | `DISTRESS`, no chips |
   | unavailable, `unclear`, below `FREE_CHAT_MIN_CONFIDENCE` (0.6) | the existing `UnclearHandler` (clarify) |
   | trash | the existing `FaltuHandler`. The message is never stored. |
   | off_limits | `OFF_LIMITS` + the task chips |
   | career / casual | the free chat's reply through `screenFreeChatAnswer` (no employer-name backstop), `read_aloud: false`, the model's follow-up chips. A refusal serves its reviewed line. A `news` refusal sends the question to the live-news request, which serves `news_links` tiles. Its cap line is `V3_NEWS_CAP`. A failure serves `REPLY_FALLBACK`. |
   | jobs | `V3_JOBS` + "Sabhi jobs dekhein" |
   | resume + edit / new | the existing edit / new-résumé handlers (and their phase flags) |
   | resume + download | `V3_DOWNLOAD_READY` + the download chip if the current résumé's PDF is rendered. `V3_DOWNLOAD_PENDING` while the first build is in flight. Otherwise the recap's `RESUME_RENDER_FAILED` line. |
   | resume + no action | the résumé root menu, + the download chip when a PDF is ready |

   The reply language is an explicit request in this message ("marathi mein jawab do"), for this reply only.
   Otherwise it is the message's own language (`messageLanguage`, the classifier's label where code is unsure).
8. The pair is appended to memory, the event is emitted, and the turn gets the strict DTO check (existing).
   Every model failure serves a fixed line. A brain that throws serves the clarify line.

**Wiring.** The companion module may not reach `ChatRepository` (ADR-0044's egress guard). So the free chat's model
calls were split into `FreeChatModelCalls`, which `FreeChatService` now extends unchanged. The companion module
provides its own instance of `FreeChatModelCalls` and of `FreeChatNewsCap`. The news cap's Redis key is the
worker's, so both chats share one daily allowance of 5. The companion has no chat session, so the calls carry
`sessionId: null`. The profiling chat's rolling summary is not read here: it lives on a chat session row.

**Own-name redaction (security gate, 2026-10-14).** The brain removes the worker's own name from every classify,
reply and news input, with the profiling chat's exact semantics (the ADR-0051 privacy invariant; ADR-0054 §4 and
§8 M1).
- **Why it is needed.** With `AI_RAW_PII_ENABLED=true` in production, the gateway hop is skipped and the message
  reaches the model raw. So the gateway cannot be relied on here: own-name redaction is what keeps the name out.
- **How the name is read.** `WorkerNameReader` reads `workers.full_name`, and that column alone
  (`findFullNameToken`). It decrypts the name once per turn and offers two views of that one read. The definition
  (`workerNameSources`) is shared with `ChatService`.
- **The two views.**
  - `knownName` feeds classify and reply. A name that will not decrypt reads as none, so they still run.
  - `ownName` feeds news. A name that will not decrypt rejects, so news makes no search and serves its
    unavailable line (fail closed).
- **What the plaintext is used for.** Only to be removed from text (`redactKnownName` → `[NAME]`). It is never
  shown, logged, evented, stored or sent anywhere.
- **Output side.** The G1 output wall still runs on every model line.

Two other rules hold on this path:
- A message the classifier calls trash (at any confidence) is never stored in the companion memory.
- Neither is a message answered with the distress line.

## 4. What it supersedes

- **ADR-0046 O2** (jobs deferred), **O9** (Hinglish-only career answers) and **O10** (career refusals of figures
  and companies) — on this screen, while the brain is on.
- **ADR-0051 R1** ("the companion is untouched").
- **ADR-0044 R8 is NARROWED** ("the companion never reads the `workers` row, so it never decrypts a name"). It
  still holds for the recap, the menus and every reply. The one exception is the free-chat brain: it reads
  `workers.full_name` solely to redact the worker's own name from model egress (ADR-0051 privacy invariant,
  ADR-0054 §4 / §8 M1). It never uses the name to show, log or store it. There is still no vocative on this screen.

## 5. Kill switch

`CHAT_FREE_CHAT_DISABLED=true` (the GitHub `production` environment secret, then a redeploy) turns off both chats'
free-chat behaviour:
- the profiling chat goes back to its pre-ADR-0051 interview;
- the Bada Bhai chat goes back to today's v2 path (the companion classifier, the career handler and the shipped
  résumé menu), byte for byte.

The existing companion suites now pin that path with the switch on.

## 6. Events

- **`chat.companion_turn_served_v4`** is a new name; v3 is kept as shipped. It has the v3 fields, with `v2_intent`
  drawn from `COMPANION_V3_INTENTS` and `outcome` drawn from `COMPANION_V3_OUTCOMES`:
  - `COMPANION_V3_INTENTS` adds `download_resume`, `resume_menu`, `casual`, `off_limits` and `distress`;
  - `COMPANION_V3_OUTCOMES` adds `answered`.

  It also adds `free_category`, `resume_action`, `refusal_topic`, `reply_language`, `news_outcome` and
  `news_source_count` (0–3). The event is strict and carries ids and closed enums only. Every v2 turn emits it, on
  both paths. On a kill-switch turn the brain's fields are null. v3 stays registered and stops being emitted.
- `chat.free_chat_news_served` is not emitted here, because its session id is required. The news facts ride v4.
- Spend is recorded as `profiling_free_classify` / `_reply` / `_news` (the same AI tasks) with a null session.

## 7. Out of scope

- The sticky language ask (LANG_ASK / kept language).
- Folding companion turns into the rolling summary.
- `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED`, which stays off.
- A companion-surface classifier eval set.
- The distress word list is unchanged. "job nahi mili marna hai" is not on it, so it is answered by v1 (a strong
  jobs word) before any classifier sees it. Widening the list is a copy review for the owner.

## 8. Follow-ups

- **App (Rishi).**
  - Route `companion_resume_download` to the in-chat download tile.
  - Route `resume_form_create` to the trade form.
  - Mirror both keys from `companion-v3-keys.ts` in the parity tests. They are deliberately not in
    `companion-keys.ts` / `resume-menu.ts`, whose key sets those tests pin.
  - Render `news_links` on companion turns.
- **AI service.** The `companion` surface prompts and `resume_action` (PR A of #2275).
- **No box change.** The free-chat tasks are already armed for the profiling chat.
