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
- **Implemented by:** PR #1742 (seams: event, flag, `publishedAfter`, exports) and the companion-module PR on the
  backend; the worker-app data-layer and UI PRs on the app.

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
| `POST /chat/companion/message` | One answer in the same shape, or **409** `{mode:"interview"}` when the worker is not (or no longer) in companion mode, so the app resends down today's path. |

**What the recap says** (reviewed Latin-script Hinglish, one bubble, Devanagari read-aloud twin):
how the current résumé was made (form / chat / upload, from `generated_resumes.generation_source`) and what it
records (its own glance facts — role, tenure, two tools, city); a résumé still being built or updated; how many jobs
the worker applied to; how many jobs matching their skills were posted in the last N days, with up to two as
tappable chips; and at most one nudge line.

**What a message can ask:** anything the existing résumé menu understands (served by that menu, verbatim); new jobs;
applications; "job milegi?" (the persona's guarantee line, verbatim); a greeting or a résumé question (the recap);
anything else (a fallback line with chips).

### 2.1 Who gets the companion (the mode rule)

Server-side, from worker-level facts, on every call; `interview` whenever it is not certain:

1. flag off → interview;
2. the CURRENT profile (`CURRENT_PROFILE_ORDER`) is not `confirmed` → interview (a redo's newer `extracted` row
   outranks an older `confirmed` one, so a worker mid-redo keeps today's path and its confirm button);
3. a live chat session that STARTED AFTER the confirmation → interview (a deliberate "Chat se resume banayein");
4. otherwise → companion. A live session that started BEFORE the confirmation is the early-finish leftover
   ("Phir bhi profile banaiye" never ends the session); it does not block, and the abandonment sweep closes it.

Any read error → interview.

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
  résumé upload/edit/redo: no file edited. Every résumé-menu label, alias and key is resolved by `resolveResumeMenu`
  first and served verbatim (`companion-intents.test.ts`).
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
  The app additionally holds a Remote Config switch so, when off, it does not even make the extra call.
- **Performance.** About seven indexed reads per open. The jobs read is bounded by the window predicate on
  `job_postings_feed_idx (status, published_at DESC)`; the `reach_skill_ids ?|` overlap is a FILTER, not a GIN probe —
  `job_postings_reach_gin` is `jsonb_path_ops`, which cannot serve `?|` (TD141).
- **Residuals, accepted:** the same new jobs can be announced on several visits within the window (TD142); a completed
  worker on a dead network can still get today's fallback path, which may mint an empty interview (pre-existing).

```
Owner rulings R1–R10 taken 2026-09-26 in the planning session; production flag-ON requires this signature.
Signed (CEO / Prakash): ______________________          Date: __________
```
