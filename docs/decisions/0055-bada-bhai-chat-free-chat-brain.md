# ADR-0055: The Bada Bhai chat runs the free-chat brain

- **Status:** **Accepted — owner Divyanshu, 2026-10-14.** Rulings 1–4 below were taken on 2026-10-14.
  **Live on merge:** no new flag. The only lever is the existing kill switch `CHAT_FREE_CHAT_DISABLED`.
  ADR-0044 R8 narrowing (own-name read for redaction only) — signed by the owner, Divyanshu, 2026-10-15.
  Brain-first routing (rulings R1–R4, §9) — owner rulings of 2026-10-15.
  **Amended by [ADR-0056](0056-bada-bhai-chat-history.md) (2026-10-15, #2297):** the chat keeps its conversation
  for 7 days; on the brain the recent turns come from it (Redis as the fallback) and the reply reads this chat's own
  rolling summary first, the profiling chat's (R4) only when there is none.
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
5. The v1 deterministic resolver. On the brain, its redo menu also offers the form road, and since 2026-10-15 the
   brain answers first around it: weak aliases, greetings and typed jobs messages (§9).
6. The abuse lexicon sends the message to the existing `FaltuHandler` (unchanged). The gateway and memory are also unchanged.
7. **New: one classifier call.** `FreeChatModelCalls.classifyWithAction` runs in mode `free` with surface
   `companion`. Its context is the companion memory. It returns the category and the résumé action:

   | Verdict | Answer |
   |---|---|
   | distress (any confidence, ADR-0051 R10) | `DISTRESS`, no chips |
   | unavailable, `unclear`, below `FREE_CHAT_MIN_CONFIDENCE` (0.6) | the existing `UnclearHandler` (clarify) |
   | trash | the existing `FaltuHandler`. The message is never model context (since [ADR-0056](0056-bada-bhai-chat-history.md) it is stored only for the worker's own 7-day history). |
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
`sessionId: null`. The reply also reads the profiling chat's rolling summary, read-only (§9 R4).

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
- A message the classifier calls trash (at any confidence) is never model context: it never enters the companion
  memory and is never replayed to a model. Since [ADR-0056](0056-bada-bhai-chat-history.md) it is stored only for
  the worker's own 7-day history (`companion_messages`, `model_context = false`).
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
- Writing or folding the rolling summary from the companion. It only reads it (§9 R4).
- A companion-surface classifier eval set.

## 8. Follow-ups

- **App (Rishi).**
  - Route `companion_resume_download` to the in-chat download tile.
  - Route `resume_form_create` to the trade form.
  - Mirror both keys from `companion-v3-keys.ts` in the parity tests. They are deliberately not in
    `companion-keys.ts` / `resume-menu.ts`, whose key sets those tests pin.
  - Render `news_links` on companion turns.
- **AI service.** The `companion` surface prompts and `resume_action` (PR A of #2275).
- **No box change.** The free-chat tasks are already armed for the profiling chat.
- **Eval (#2285, 2026-10-15).** The companion prompts were measured with fabricated sets: classify 95.4% and reply
  66/80 on Haiku. Greetings misroute; fixes are proposed. See [the evidence](../qa/evidence/free-chat/companion-surface/2026-10-15/README.md).
- **Prompt round 2 (#2287, 2026-10-15).** R31 HELD the full revision (career −16); only the classify fixes shipped
  (68/71 → 71/71). The greeting reply fix is to be re-run alone. See [the evidence](../qa/evidence/free-chat/companion-surface/2026-10-15-round2/README.md).

## 9. Brain-first routing (owner rulings, 2026-10-15)

The first cut left the v1 resolver ahead of the brain. So the brain never heard:
- a résumé word, a menu alias or a section word (the recap or a section menu answered);
- a greeting (the recap answered);
- a typed jobs message ("job nahi mili, marna hai" got job chips, and "marna hai" is not on the distress list).

The owner ruled "brain first" for these. All four rulings apply only while the brain is on. With the kill switch
on, every flow is the pre-2026-10-15 one, byte for byte.

| # | Ruling |
|---|---|
| **R1** | **Résumé words and menu aliases.** WP6's route precedence (TD146) runs whenever the brain is on, as well as under its own flag (`companionRoutePrecedenceOn`). Its order is reused, not forked. A pending task-chip intent routes the next message. An edit phrasing (`looksLikeEditRequest`) goes straight to the edit handler. A weak v1 alias goes to the brain. One deviation: a "Career ki baat" tap leaves no pending intent while the brain is on, because the brain's reply answers career talk on this screen (§4), not the v2 career handler. *2026-10-15 (#2295): on the brain, every résumé-edit ask is answered with the edit section menu; the AI edit card runs only under the kill switch.* Owner ruling of 2026-10-15, after production showed every edit ask spending an edit-parse call on the clarify line. The menu is "Resume ka kaun sa hissa theek karna hai" plus the six section chips, which the app routes into the trade form's walk or Resume Edit. One switch (`editAsksGetSectionMenu`) is read in two places. The handler registry resolves `edit_resume` to the menu, so the brain's `resume` + `edit` verdict makes no edit-parse call; it is recorded on v4 as `edit_resume`, `resume_action` `edit`, outcome `served`. The service answers the deterministic routes before the orchestrator, with no model call and on v1's `resume_menu` event: the edit pattern (`looksLikeEditRequest`, both shapes), a generic ask (`isGenericEditRequest`), a pending `edit_resume` intent and the edit task chip, which leaves no pending intent. `resume_action` `new` and `download` are unchanged, and so are the confirm and cancel routes for a card issued earlier. |
| **R2** | **Typed jobs messages: classify first.** A typed message that v1 would answer with its jobs list (a strong jobs word) is classified once by the brain (`routeJobsWord`). The job-chip and jobs-tab taps stay exact chips and are never classified. These verdicts serve today's v1 jobs answer (job chips + "Sabhi jobs dekhein") and today's v1 event: `jobs`, `unclear`, any verdict below the floor, or an unavailable classifier. So do a refused gateway and a brain that throws. The classify cost is already on the ledger. Distress (any confidence), trash, off_limits, career/casual and résumé get the brain's answer and the v4 event. |
| **R3** | **Greetings** ("hello", "namaste", "status") reach the brain through R1's weak-alias route, normally as a casual reply. The recap on tab open is unchanged. *Amended 2026-10-15 (#2287), after the #2285 eval showed the model failing on greetings ("hello" classified unclear; "namaste" answered with two questions and rejected):* a **bare** greeting gets the fixed line `V3_GREETING` with the clarify line's task chips and no model call. A bare greeting is one where every word is a greeting or a filler: namaste, hello, hi, ram ram, good morning, then bada, bhai, ji, sir, plus punctuation and emoji. It is recorded on v4 as `v1_deterministic` / `casual` / `served`. The turn is deterministic, so a resent one is the same turn on the same event key. A greeting with content ("hello, welder ki salary kitni hai") still reaches the brain. "status" goes back to v1's recap. *Also #2287 (owner ruling 2026-10-15):* the brain drops a model follow-up chip that offers to MAKE a résumé (`isResumeOfferChip`: a résumé word AND a make word). The worker already has one. The lines and the other chips are still served. This applies on the companion surface only; the profiling chat keeps its own "Resume banayein" chip. |
| **R4** | **The rolling summary.** The casual/career reply reads the profiling chat's rolling summary, read-only. The classifier never gets it (ADR-0051 R24), and neither does news. |

R4 implementation:
- `FreeChatSummaryReader` runs one SELECT, the query `ChatRepository.findLatestFreeChatSummary` shares (`selectLatestFreeChatSummary`).
- It uses the @Global database handle, so no `ChatRepository` and no chat-table writer is reachable from the companion.
- It fails soft: any read error is `summary: null` and a warning with the worker id only.
- `FreeChatModelCalls.reply` redacts the worker's own name out of the summary again.
- The companion never writes or folds the summary.

**What this supersedes.** ADR-0044's and ADR-0046's "v1 first, zero model calls" rule no longer holds for three
kinds of message: weak aliases (résumé words, menu aliases, section words, greetings, the bare "kaam") and typed
jobs messages. This applies on this screen and only while the brain is on. These keep their zero-model answers:
- exact chips (the menu's own chip labels, the companion's job and jobs-tab chips, the task chips);
- the named applications, guarantee and status intents.

