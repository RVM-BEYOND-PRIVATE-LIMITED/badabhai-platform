# 16-trade job posting fields — implementation plan and status

Source of truth: `16-trades-ladders-skills.pdf` (build reference generated 2026-11-03) and the
checked-in question packs under `packages/db/data/question-packs/packs`.

Owner ruling: only the 16 non-polymer trades are postable today. The five polymer roles stay
declared on the worker side, but they are absent from every posting picker.

## The rule the document states

A posting form asks, in order:

1. **Role** — mandatory, one of the 16.
2. **Function / collar (rung)** — the trade's ladder, stored as `trade_level`. **Display-only**:
   it never enters `match_skill_ids` or `job_reach`.
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

- New/edit company posting forms render the 16-trade `TradePostingFields` panel. The generic
  match picker remains the fallback when the catalogue cannot be loaded.
- On an edit, the panel appears for drafts and for postings that already use the trade form
  (or after a role change). An older open posting with a hand-picked match set keeps its panel
  hidden, so a display-only rung edit cannot silently shrink its reach.
- Agency new/edit forms render the same panel, with the same edit gate.
- The edit forms send the trade fields only when edited or already stored, so an unrelated save
  cannot trip the clear diff.
- Match chips respect the live `match_config.max_skills_per_posting` cap, learned from the
  reach preview (fallback 3 / 5 in the app); an over-cap tap is refused with the reason before
  publish.
- The preview rail lists the rung and selected answers under “Also in your posting”.

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
- **AI chat publishing** still writes the legacy draft fields. It can carry `role_kind`, but it
  does not ask the pack questions yet; a chat-created posting should either route the payer to
  the trade fields before publish or the chat must gain the same pack flow.
- **Polymer roles** are intentionally not postable. If they return, add five rows to
  `POSTING_TRADES` and a posting pack per role; no migration is needed.
- Flutter changes were compiled and the payer-app suite passes (`flutter analyze` clean); the
  worker app is clean for these files, with only its 16 pre-existing `AppLocalizations`
  biometric-getter errors outstanding.
