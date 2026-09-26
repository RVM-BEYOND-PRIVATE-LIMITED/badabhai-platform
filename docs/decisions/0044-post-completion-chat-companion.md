# ADR-0044: The post-completion Bada Bhai companion

- **Status:** **Accepted for build (ships OFF).** R2–R4 were chosen by the owner on 2026-09-26; R1 is the owner's own
  request ("let the worker know what has happened till now"); R5–R10 are the defaults the owner approved with the
  plan. **Production flag-ON is gated on the owner's signature** at the foot.
- **Date:** 2026-09-26
- **Owner:** CEO / Prakash
- **Relates:** [ADR-0043](0043-resume-history-and-chat-update.md) (R3 required its own ADR for post-interview Bada
  Bhai behaviour — this is it) · [ADR-0042](0042-profile-road-separation.md) (the roads) ·
  [ADR-0024](0024-worker-visible-job-fields-pii.md) (worker-visible job fields) ·
  [ADR-0036](0036-matching-algorithm-v1.md) (untouched: no rank key) ·
  [ADR-0034](0034-worker-push-notifications.md) / [ADR-0020](0020-whatsapp-invite-funnel-and-reengagement.md)
  (untouched: no push, no WhatsApp) · persona v3.2 (`docs/specs/persona-system-v3.2.md`)
- **Implemented by:** PR #1742 (seams: event, flag, `publishedAfter`, exports) and PR #1743 (the companion module) on
  the backend; the worker-app client PR on the app.

---

## 1. Context

Once a worker's profile was done, the Bada Bhai tab went silent:

- **Chat-road worker:** the tab re-attached to the ENDED interview, redrew its transcript under the canned opener,
  and showed a composer. The server said nothing until the worker typed, and then every message got the stateless
  résumé menu (`resolveResumeMenu`).
- **Form-road / upload worker:** there was no chat session, so the tab minted a brand-new interview.

Nothing told the worker what had happened (how their résumé was made, what it says), how many jobs they had applied
to, or that new jobs matching their skills had been posted — and nothing nudged them to apply.

## 2. Decision

A **companion** answers on the Bada Bhai tab once the worker's profile is confirmed. It is a separate, additive
layer: a leaf Nest module (`apps/api/src/chat-companion/`) with two worker routes, and a tab-only client mode.

| Route | Answer |
|---|---|
| `GET /chat/companion` | `{mode:"interview"}` → the app runs the chat tab exactly as before; or `{mode:"companion", …}` — the recap, in the chat reply's own shape (`PostMessageResponse` minus `session_id`, plus `mode` and `digest_key`). |
| `POST /chat/companion/message` | One answer in the same shape, or **HTTP 409** when the worker is not (or no longer) in companion mode, so the app resends down today's path. The status code is the signal: the body is the global error envelope, `{statusCode: 409, error: {mode: "interview"}, …}`, and this is the route's only 409. |

**What the recap says** (reviewed Latin-script Hinglish, one bubble, Devanagari read-aloud twin):
how the current résumé was made (form / chat / upload, from `generated_resumes.generation_source`) and what it
records (its own glance facts — role, tenure, two tools, city); a résumé still being built or updated; how many jobs
the worker applied to; how many jobs matching their skills were posted in the last N days, with up to two as
tappable chips; and at most one nudge line. §2.2 lists what it must never claim.

**What a message can ask:** the existing résumé menu's chips (served by that menu, verbatim); new jobs; applications;
"job milegi?" (the persona's guarantee line, verbatim); a status question, a greeting or a résumé question (the
recap); anything else the menu's aliases understand (served verbatim); anything else (a fallback line with chips).
The menu's substring aliases ("update", "phir se", "dobara", a section name) run AFTER the companion's own jobs,
applications, guarantee and status signals, because on a status surface "koi update hai?" and "phir se jobs dikhao"
are questions about status and jobs, not requests to edit or rebuild the résumé.

### 2.1 Who gets the companion (the mode rule)

Server-side, from worker-level facts, on every call; `interview` whenever it is not certain:

1. flag off → interview;
2. the CURRENT profile (`CURRENT_PROFILE_ORDER`) is not `confirmed` → interview (a redo's newer `extracted` row
   outranks an older `confirmed` one, so a worker mid-redo keeps today's path and its confirm button);
3. the live chat session that `POST /chat/session` would reattach to shows ACTIVITY after the confirmation →
   interview. Activity is the later of its `started_at` and its `last_message_at`. A session minted after the
   confirmation is a deliberate "Chat se resume banayein". A pre-confirmation session that moved after it is that
   same redo REATTACHED to the early-finish leftover: the server reattaches before it mints (#1197);
4. otherwise → companion. A live session whose every clock predates the confirmation is the early-finish leftover
   ("Phir bhi profile banaiye" never ends the session); it does not block, and the abandonment sweep closes it.

Any read error → interview.

**Known gap (TD143).** `last_message_at` moves only at the interview's checkpoints (every 5 asks) and at its end;
the per-turn clock is the chat module's Redis transcript buffer, which this module must not read. So for the first
four answers of a redo reattached to a leftover, a COLD app start shows the recap. The live app is unaffected (the
bloc left companion mode when the worker chose the redo), and one more tap on the redo reattaches the same session
with nothing lost. Whether a reattached redo can produce a new profile at all is a pre-existing chat question, filed
as #1744.

### 2.2 What the recap must never claim

- **A failed render is not "made".** When the current row's render ended at `failed` there is no PDF and the Resume
  tab says NAHI BANI, so the recap says the résumé cannot be downloaded yet and points at the Resume tab. It states
  no road and no glance.
- **"Being made" is time-bounded.** A `pending` row, or no row just after confirming, is "being made" only within
  `RESUME_UPDATE_PENDING_TIMEOUT_SECONDS` (the ADR-0043 bound). Past it, a parked `pending` row is described as made
  (its text exists), and a missing row is not mentioned.
- **"Abhi sab theek hai" is a conclusion.** It is served only when every section was read and reported nothing to
  act on: a finished résumé, no update failing, a known applied count, and a jobs read that matched on skills.
- **"Neeche diye jobs" needs jobs below.** The first-application nudge is served only on a turn that carries job
  chips; otherwise the reply points at the new-jobs chip.
- **No irrelevant gap.** `machines` is never nudged: the profile summary reports it for every empty list whatever
  the trade, so a cook or a mason would be told to add machines their work never involves.
- **Payer text as shown.** A job chip's title is screened after whitespace is collapsed, and its city is screened
  too; a blank title or one that looks like a phone number or an email never becomes a chip.

## 3. Owner rulings (2026-09-26)

| # | Ruling |
|---|---|
| **R1** | **Persona scope.** Persona v3.2 Law 2 ("never summarise") and the §7 *Purpose* row govern INTERVIEW turns. A companion turn may STATE facts the platform recorded — the road, that résumé's glance, counts — in the same voice. It never restates the worker's own words. Laws 1, 3, 5–10 and the §3 vocabulary still bind (aap register, no vocative, no "!", no emoji, ≤1 "?", ≤20 words a line, no promise, no score or rank). |
| **R2** | **"New jobs" = the last N days** (`CHAT_COMPANION_NEW_JOBS_WINDOW_DAYS`, 7): open postings published inside the window whose `reach_skill_ids` overlap the worker's wanted skills and that the worker has not applied to or skipped — the #1240 search rule, in the search's own order (`published_at DESC, id`). A per-worker "since your last visit" watermark is deferred (TD142). |
| **R3** | **Chips, not cards.** Jobs ride as option chips (`companion_job:<id>`, "title — city") that open the existing job-detail screen. Rich cards are a later, additive change. |
| **R4** | **Companion only on the tab.** The old interview transcript is not redrawn for a companion worker; the recap is the opening. |
| **R5** | **No skills, no claim.** A worker with no wanted skills gets no "aapke kaam ke" line and no job chips — #1240's "every open posting" fallback is a search-box ruling, not licence to call unmatched postings theirs. |
| **R6** | **Apply attribution unchanged.** Applies still happen on the job-detail screen with `source_surface: feed`; a `chat` surface would need `application.submitted` v2 and is deferred. |
| **R7** | **No LLM in V1.** Copy is reviewed constants; intents are a closed deterministic set after the résumé menu. A later model step may only CLASSIFY into the same closed set, behind its own flag and its own task; a model-phrased answer needs its own ADR. |
| **R8** | **No vocative in V1.** The companion never reads the `workers` row, so it never decrypts a name. |
| **R9** | **In-chat only.** No push (ADR-0034 stays security-only), no WhatsApp (ADR-0020 stays mock/consent-gated). |
| **R10** | **Production ON only after this ADR is signed.** Staging first. |

## 4. Invariants the implementation holds (and the tests that pin them)

- **Never writes `chat_sessions` or `chat_messages`.** Those rows are the extraction transcript and the résumé's
  verbatim-quote source. The module does not import the chat module; its repository has no insert/update/delete
  (`chat-companion.repository.test.ts`); an egress guard bans the chat writers (`chat-companion.module.boot.test.ts`).
- **The existing flows are untouched.** `ChatService`, `resume-menu.ts`, the interview engine, the ADR-0043 offer,
  résumé upload/edit/redo: no file edited. Every résumé-menu chip is resolved by `resolveResumeMenu` first, and every
  alias it understands is served by it verbatim unless the text carries a companion jobs, applications, guarantee
  or status signal (`companion-intents.test.ts`).
- **No impression pollution, no ranking.** Reads go through repositories (`JobsRepository.searchOpenPostings` with
  `publishedAfter`, `ResumeService.history`, `WorkerSkillsRepository`, a two-SELECT companion repository) — never
  `MatchFeedService.getFeed`, `ApplicationsService.getFeed` or `JobsService.searchJobs`, which record `feed.shown(_v2)`
  / `job.search_performed`.
- **Privacy.** No worker name, phone or ciphertext; job chips carry the ADR-0024 SHOW-set title and city only, and a
  title that `looksLikePii` is never put on a chip; the worker's text is classified and dropped, never logged.
- **Event-first.** `chat.companion_turn_served` v1: counts and closed sets only, `.strict()`, with `new_jobs_count`
  tied to `jobs_scope` by a refine. The tab open is deduped per worker per UTC day; a message by its `submission_id`.
- **Persona.** Every line and chip is scanned by `companion-replies.test.ts` (`checkPersonaTokens`, no "!", no emoji,
  ≤1 "?", ≤20 words, Latin display, a Devanagari twin with the same slots). Chip rows never exceed `maxChips` (4).
- **Fail soft.** Each fact is read on its own; a failed read drops its section (a failed résumé read says nothing
  rather than "being built"); a failed event write never costs the worker the answer; a turn that fails the strict
  outbound schema is replaced by the fallback line.

## 5. Consequences

- **Flag OFF is today's behaviour.** `CHAT_COMPANION_ENABLED` defaults off; off answers every open with
  `{mode:"interview"}`. Old app builds never call the routes. New builds on an old server get a 404 and fall back.
  The app additionally holds a Remote Config switch, `worker_chat_companion_enabled` (default `false`), so when it
  is off the app does not even make the extra call. Only the `/bada-bhai` tab asks; the `/chat` route never does.
- **Turning it on.** Staging first: `CHAT_COMPANION_ENABLED=true` on the server, then the Remote Config switch. Either one
  off means today's tab, so the order is not a safety question. Production needs the signature below.
- **Performance.** About seven indexed reads per open. The jobs read is bounded by the window predicate on
  `job_postings_feed_idx (status, published_at DESC)`; the `reach_skill_ids ?|` overlap is a FILTER, not a GIN probe —
  `job_postings_reach_gin` is `jsonb_path_ops`, which cannot serve `?|` (TD141; migration 0127 adds
  the `jsonb_ops` GIN `job_postings_reach_ops_gin` that can).
- **Residuals, accepted:** the same new jobs can be announced on several visits within the window (TD142); a completed
  worker on a dead network can still get today's fallback path, which may mint an empty interview (pre-existing); a
  cold start in the first four answers of a reattached redo shows the recap (TD143, §2.1).

```
Owner rulings R1–R10 taken 2026-09-26 in the planning session; production flag-ON requires this signature.
Signed (CEO / Prakash): ______________________          Date: __________
```
