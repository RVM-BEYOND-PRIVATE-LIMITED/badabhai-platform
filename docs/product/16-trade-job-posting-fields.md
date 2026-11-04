# 16-trade job posting fields — implementation plan and status

Source of truth: `16-trades-ladders-skills.pdf` (build reference generated 2026-11-03) and the
checked-in question packs under `packages/db/data/question-packs/packs`.

Owner ruling: only the 16 non-polymer trades are postable today. The five polymer roles stay
declared on the worker side, but they are absent from every posting picker.

## The rule the document states

A posting form asks, in order:

1. **Role** — mandatory, one of the 16.
2. **Function / collar (rung)** — the trade's ladder, stored as `trade_level`. It never enters
   `match_skill_ids` or `job_reach`. Since engine v1.1 ([ADR-0061](../decisions/0061-level-needed-applicant-sort.md),
   CEO ruling 30 Oct 2026) it is the posting's **"Level needed"**: on the 4 CNC trades, with
   `LEVEL_NEEDED_SORT_ENABLED` on, it sorts the applicant list (meets → not confirmed → below,
   inside each trade group). Sort only, never hide; no rung = "Any level" = today's list.
3. **Match-affecting chips** — the pack chips whose `PACK_ANSWER_SKILLS` entry resolves to an
   `mskill_*` the poster does not already get from the role's base skill. They drive reach
   through `match_skill_ids`.
4. **Facet chips** — every other chip (controllers, machines, materials, tolerances, sectors,
   CMM work, inspection documents …), including a chip that only repeats the role's own base
   skill. Same candidate set; the employer list can lead with candidates who match them and
   badge the count.
5. **City / shift / pay / vacancy** — the existing card and commercial fields.

The trade's own `mskill_*` is always part of the match set. A role posting with no chips still
reaches that trade.

## Matching scope: the 16 trades only (#2635, owner ruling 2026-11-04)

The app profiles workers in more trades than the 16. Their profiles and `worker_skill` rows are
kept, but matching runs only for the 16:

- **A company can publish only a 16-trade posting**, and cannot move a live one off the 16
  (`400 reason: posting_trade_required`).
- **A 16-trade posting's match set comes from its trade, whatever the client sends.** The trade's
  own skill, plus every requested id the trade owns (its pack's chip skills,
  `postingTradeSkillIds`). Anything else is dropped and recorded on
  `job_posting.match_skills_scoped`. This stops the 2026-11-03 production defect — a Welder job
  matching on CNC grinding, and a Grinding job matching on delivery riders, both sent by a client
  that skipped the trade fields — for every write from now on.
- **Postings already live keep their stored set** until an edit that changes their skills or
  trade, an unpause, or a re-post rebuilds them. The nightly `db:materialize:reach` and the
  per-worker reconcile only re-read the stored `reach_skill_ids`; neither re-scopes. The two
  2026-11-03 jobs (`8b3e6fc0…`, `04bfde7d…`) and the June seed job (`5eeded00…`, no trade) are an
  owner close / re-post step.
- **Related reach stays inside the 16** (`POSTING_SCOPE_SKILL_IDS`, 22 skills: the 16 base skills
  plus CNC programmer, HMC operator, 3D designer and Arc/MIG/TIG welder). Related matches between
  the 16 stay (Turner → VMC/Grinding, Fitter → Maintenance/QC). The ones that leave the 16 are
  trimmed: General CNC operator, CNC setter-operator, 3D CAD designer, Interior designer, Plumber.
- **One place:** `scopePostingSkills` / `POSTING_SCOPE_SKILL_IDS` (`packages/taxonomy/src/posting-scope.ts`),
  applied by `MatchSkillsService.resolveForPublish` (create, publish, edit, unpause) and the
  company reach preview. The stored `reach_skill_ids` then drives the nightly
  `db:materialize:reach` and the per-worker reconcile unchanged.
- **Not covered:** ops postings without a 16-trade role (unchanged); the audited ops reach widen
  (an explicit ops act); and **agency twins** — `packages/db/src/agency-twin.ts` resolves a
  twin's reach on its own, unscoped, even for a 16-trade agency job. Twins are off in
  production (`AGENCY_TWIN_SYNC_ENABLED` unset); scope them before that flag is armed.

## What is implemented

### Canonical catalogue (`packages/taxonomy/src/posting-trades.ts`)

- `POSTING_TRADE_KINDS` — the 16 role kinds.
- `POSTING_TRADES` — role → pack id / family id / base `mskill_*` / CEO ladder.
- Tests pin the 16, the ladder keys, and the match-skill ids.

### API

- `PostingTradesModule` / `PostingTradesService` build the form from the **active pack** through
  `PackRegistryService`, so question text and chips cannot drift from the worker interview.
- `GET /payer/posting-trades` (PayerAuthGuard) returns the 16 trades, ladders and questions;
  each chip carries `match` and its `match_skill_ids`.
- `PostingTradesService.normalizeSelection` validates the role, rung, question keys and option
  keys, and derives the match set server-side (base + selected match chips). A client cannot
  widen the set through the trade form.
- Company postings (`job_postings.trade_level`, `trade_answers`) and agency jobs
  (`jobs.trade_level`, `trade_answers`) persist the rung and answers. Both are nullable, so
  "not stated" stays distinguishable from an empty answer map.
- Migration `0141_trade_posting_fields.sql`; the agency twin copies both columns.
- `job_posting.updated` / `job.updated` gained the additive `trade_fields` changed key.
- Worker job detail resolves the stored answers to labels (`trade_level_label`,
  `trade_facets`) on `GET /jobs/:jobId`.

### Payer web

- New/edit company posting forms render the 16-trade `TradePostingFields` panel. Since #2645 they
  have no generic match-picker fallback (see below); the agency forms keep theirs.
- On an edit, the panel appears for drafts and for postings that already use the trade form
  (or after a role change). An older open posting with a hand-picked match set keeps its panel
  hidden, so a display-only rung edit cannot silently shrink its reach.
- Agency new/edit forms render the same panel, with the same edit gate.
- The edit forms send the trade fields only when edited or already stored, so an unrelated save
  cannot trip the clear diff. Since #2645 a company draft's Publish always sends them (below).
- Match chips respect the live `match_config.max_skills_per_posting` cap, learned from the
  reach preview (fallback 3 / 5 in the app); an over-cap tap is refused with the reason before
  publish.
- The preview rail lists the rung and selected answers under “Also in your posting”.
- **#2645 (web half of #2635) — a company job is always one of the 16 trades.** New posting, Edit
  posting and the AI chat's publish step share one picker (`postings/trade-picker.tsx`) that lists
  only the trades `GET /payer/posting-trades` served: no free role list, flat match picker or
  "could not load the skill list" fallback for company forms. A failed or empty catalogue names
  the real cause at the picker with a Retry (a server re-read that keeps the form), and posting is
  refused there with "Pick one of the 16 trades". The create always sends `role_kind` plus the
  trade form (`trade_answers` `{}` when untouched), so the server derives the match set. Edit sends
  the role only when the payer moved it to another trade and never clears it (`role_kind` is out
  of the client's `clear` diff). Edit's Publish always carries the trade form too (`{}` when
  untouched), so a draft an older client saved with free skills publishes its trade's set, the one
  the panel previews, never those skills. A `400 reason: posting_trade_required` on
  `PATCH /payer/job-postings/:id` is read by its `reason` (never the message) and shown AT the
  picker; a create whose publish is refused that way opens the draft's edit page there
  (`?trade=required`), with focus on the picker even when the 16 did not load. If a Retry then
  brings the 16 back, focus moves to the select only when it was lost with the Retry button,
  never off a control the payer moved on to. The panel's "Matched as:" line names skills from
  the catalogue when the match vocabulary did not load, never by raw id. The postings list has
  no Publish of its own (a draft publishes from Edit), so no list path can meet the refusal. The
  company reach preview (live and post-publish) sends `role_kind`; the agency one sends none. The
  AI chat refuses a publish without one of the 16 before anything is sent. Agency jobs are
  unchanged.
- **On the current API the `posting_trade_required` handling is defensive.** The API checks the
  trade form before its 16-trade gate: `PostingTradesService.normalizeSelection` runs on the
  create and in `updateForPayer` ahead of the gate. A request carrying trade fields
  (`trade_level` / `trade_answers`) for a role outside the 16 therefore gets a 400 with no
  `reason` and no field `issues` ("trade fields are only available for a postable role"), never
  `posting_trade_required`. Every web path to the gate sends those fields first: the create's
  POST (its publish follows only a create the API accepted), Edit's Publish, and an Edit that
  moves the role. So the web's `posting_trade_required` handling and the `?trade=required`
  landing cannot run until Backend moves the 16-trade check ahead of the trade-form check. The
  web also refuses, before sending, any role outside the 16 it was served, so that 400 needs the
  served catalogue and the API to disagree. When it does come, Edit's Publish says "The server
  refused to publish this posting. Nothing was changed: it is still a draft." A plain Save keeps
  "No changes to save.".

### Payer app (Flutter)

- `PayerApiClient.fetchPostingTrades()` (HTTP + mock).
- `PostingTradeForm` / question / option / rung models, plus `matchSkillIdsFor`.
- `TradePostingFields` widget; the company and agency post screens load the catalogue, require
  a role, render the pack chips and derive the match set.
- The company and agency **edit** screens load the same catalogue, prefill the stored role/rung/
  answers, send only a changed form, and keep the panel hidden on a pre-0141 open job until the
  role is explicitly changed (same reach-safety gate as web).
- The API client accepts `role_kind`, `trade_level` and `trade_answers` on company and agency
  create/update.
- **#2645 (client half of #2635) — a company job is always one of the 16 trades.** The company
  post and edit screens pick the role only from the catalogue: no free role list, flat match
  picker or free-text skills fallback; a failed or empty catalogue says why with a Retry and the
  post is refused at the picker. The create always sends the trade form (`{}` when untouched),
  so the server derives the match set from the trade. A `400 reason: posting_trade_required` on
  `PATCH /payer/job-postings/:id` is read by its `reason` (never the message) and shown as "Pick
  one of the 16 trades" AT the trade picker; a Publish refused this way in My jobs opens the
  job's edit screen there. The company reach preview sends `role_kind`. The AI chat's publish
  step offers only the catalogue's trades and refuses a publish without one before anything is
  sent (it still asks no pack questions). Agency jobs are unchanged.
- Candidates are visible to BOTH session kinds in the Find tab: a company session reads
  `job_postings`, an agency session reads its `jobs` rows, and both use the one
  `/payer/reach/jobs/:id/applicants` feed. The “Applicants” button on a company or agency job
  card opens that feed.

### Worker app

- `JobDetail` parses `trade_level_label` and `trade_facets`; the detail screen renders a
  “KAAM KI SHARTEIN” card when the posting stated any.

## Deliberate limits / next phase

- **A8 facet reordering on the employer candidate list is not yet wired.** The answers are
  stored and returned, but the applicant feed does not yet filter by a facet or show
  “N of M match <chip>”. That is the next backend slice: join `worker_attributes` on the
  applicant's worker/pack, then reorder without changing the candidate set or count.
- **AI chat publishing** still writes the legacy draft fields. Since #2645 it must carry
  `role_kind` (one of the 16; refused before publish otherwise, in both apps), but it does not ask
  the pack questions yet: `PublishJobPostingChatSchema` takes only `role_kind` and `area`, so the
  trade level and chips need a backend contract change first. On web the chat lands on the
  posting's edit page, where the trade fields are.
- **Polymer roles** are intentionally not postable. If they return, add five rows to
  `POSTING_TRADES` and a posting pack per role; no migration is needed.
- Flutter changes were compiled and the payer-app suite passes (`flutter analyze` clean); the
  worker app is clean for these files, with only its 16 pre-existing `AppLocalizations`
  biometric-getter errors outstanding.
