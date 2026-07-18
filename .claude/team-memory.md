# BadaBhai — Team Memory

> Rebuilt 2026-07-14; updated 2026-07-18 (PRs #232–#408, ADRs 0031–0033, migrations 0039–0044).
> Single source of truth for ownership + active work. **Update in place — do
> not recreate.** Ownership = declared split in
> [claude-working-guide §4](../docs/claude-working-guide.md) cross-checked against git;
> shared areas are marked.

# Team Overview

- **3 active committers:** Prakash Kantumutchu (**TL / integrator**, ~374 commits), Divyanshu Pant (backend, ~135 — the user), Rishi Ojha (Flutter/mobile, ~16, active since 2026-06-26). Akshit (CEO) signs off ADRs/gates. Utkarsh is the announced Company/Agency web owner (2026-06-19 roster) but has **no repo commits yet** — payer-web is Prakash's in practice.
- Process: automation-first + one human reviewer; specialist agents review, human confirms. Prakash merges most PRs.
- **Status: alpha IN PROGRESS** — **B1 CLOSED 2026-07-18** (owner-attested; staging live, real OTP, resume download). Remaining to full GO: TD81 (ai-service not in compose), gates 1/2/5/4-half. Phase 2 UNBLOCKED. Alpha 2026-08-15. Utkarsh: no repo commits — removed 2026-06-29.

# Developer Ownership

> Declared split (working-guide §4) + git evidence. Effectively co-owned: `auth` (50/50), `job-postings` (50/50), `packages/db` (55/45 P/D), `apps/worker-app` (P11/D9/R7).

## Prakash (TL)

- **Declared:** auth, workers, events, chat, consent, profiles, voice, resume-download authz, interview-kit, E2E, CI, Drizzle migrations, ops console, Flutter oversight.
- **Git adds:** unlocks (~80%), **payer-web (~94%)**, ai-service overall (~76%), pricing package (~80%), payer org tenancy (B5.x #182–#186), skills taxonomy TAX-0..4 + fork-B, COST/PERSONA AI work, voice unblock (#198), CI-1 (#218).
- **Current:** fork-B (#222 merged 2026-07-14), **staging deploy P0**, integration/merges.
- **Avoid without coordination:** reach feed/serving, reach-engine, worker-app feature slices Divyanshu is driving, job-postings halves.

## Divyanshu (the user)

- **Declared:** `apps/ai-service/app/ai/*` (router/model-config/cost), reach + feed, job-postings, reach-engine, resume PDF render, OTP/STT real integration, pricing engine design.
- **Git adds:** reach (~71%), reach-engine (~75%), TD54 self-serve reads (#195/#196), resume name-edit + §2 own-session read-back (#204), PDF-409 UX (#209), liberal feed (#216), TD25 trust-proxy + OTP caps + devices PIN (#197).
- **Current:** Alerts/notifications feed **merged 2026-07-14 (#221)**; **ADR-0031 deletion-grace draft (uncommitted, pending Prakash/Akshit)**; interview-kit test edits (uncommitted, on `feat/worker-feed-liberal-no-location`).
- **Avoid without coordination:** unlocks, payer-web, payer tenancy, admin portal, TAX/fork-B stream, CI workflows.

## Rishi (Flutter)

- Worker-app + payer-app Flutter builds, backend wiring, Flutter 3.35.7 bump (#189/#190/#201); B1 evidence capture (emulator-only so far — doesn't satisfy B1).

# Shared Infrastructure (coordinate before touching)

- **event-schema registry** — 100 events / 28 domains, all v1; every new domain edits it.
- **packages/db** — **45 migrations** (0000–0044; **0042+0043 apply-before-deploy**); sequential numbering, **check latest (0044) before `db:generate`**; renumber-on-merge is a recurring conflict. ONE Supabase DB (the `main`, the only database) — risky migrations need backup + sign-off.
- **Auth stack** — WorkerAuthGuard (OTP+PIN, ADR-0026; `kPersistentAuth` ON since #201; **TD62 RESOLVED #240**), ConsentGuard/ConsentNotRevokedGuard, PayerAuthGuard + role/org guards (ADR-0027), AdminAuthGuard/AdminRolesGuard (ADR-0025), InternalServiceGuard (ops `/unlocks*` only — NOT payer-facing; LC-1 residual, TD33, retire blocked on ADMIN-4..8). **POST /resume/generate** now WorkerAuthGuard (B-3, #385, R26 CLOSED).
- **Shared libs** — validators, types, config (env gates), taxonomy, ai-contracts (**keep Zod↔Pydantic parity**; last synced #191/#193), pricing, reach-engine, reach-learn.
- `app.module.ts` (32 modules) and `docs/registers/` + `docs/tracker/` — merge hotspots.

# Environment gates

11 boolean env gates, **all default false** (packages/config/src/server.ts): AI_ENABLE_REAL_CALLS, PAYMENTS_ENABLE_REAL, MESSAGING_ENABLE_REAL, MEMBER_INVITES_ENABLE_REAL, RESUME_RENDER_ENABLED, AUTH_ROLLING_TIERS_ENABLED, ADMIN_PII_REVEAL_ENABLED, ZEPTOMAIL_SANDBOX_MODE, CAPACITY_ENFORCEMENT_ENABLED, PACE_ENABLED, PACE_ADJACENCY_ENABLED. Payments/messaging/member-invites **fail closed at boot** if enabled without provider creds. **Any flip = human sign-off + staging first** (CLAUDE.md §7). B1 needs `RESUME_RENDER_ENABLED=true` on staging.

# Active Workstreams (2026-07-18)

- **B1 alpha capstone — CLOSED 2026-07-18** (owner-attested: staging live, 0042+0043 applied, R27 triaged, real OTP, resume download). `docs/qa/evidence/staging/` not captured — close on next run. Phase 2 UNBLOCKED.
- **TAX-9 COMPLETE** (#232, migration 0039 applied 2026-07-15). RATIFY-1 DONE (22/22 aliases 2026-07-16). `SKILL_CANONICALIZE_ENABLED` flip awaits post-B1 staging verify.
- **ADR-0031 deletion grace MERGED** (#400, 2026-07-16). Migration 0040 applied. Prod endpoint §7-gated.
- **ADR-0032 profile photo MERGED** (#340 + #402 photo→PDF re-render, 2026-07-16).
- **ADR-0033 skills-overlap factor .15 MERGED** (#394, 2026-07-17). CEO 06-19 weight ledger now operative.
- **TD62 RESOLVED** (#240, 2026-07-15). kPersistentAuth ON + consent-routing tri-state gate live.
- **R28 OPEN** — GET /workers/:id/profile returns decrypted name unauthenticated (bounded; Divyanshu fix before external traffic).
- **R31 OPEN** — PUT/GET /pricing/catalog unauthenticated (bounded by PAYMENTS_ENABLE_REAL=false; Divyanshu fix before real payments).
- **TD81 OPEN** — ai-service not in staging compose file (staging mocks AI while reporting healthy; Divyanshu/DevOps).
- **LC-1 payer-facing CLOSED.** Ops surface retire blocked on ADMIN-4..8 (TD33/TD50).
- **Parked/waiting:** hospitality vertical (per-trade RVM ratification pending), PACE adjacency (Q13, CEO), TD61 Flutter CI pin bump (3.27.4→3.35.7, Rishi+DevOps), TD55 Argon2id, voice-audio DSAR erase (before real voice ships), PAYER-PIN-1.

# Current PR Status (gh-verified 2026-07-18)

- **No open PRs.** HEAD: `085e2f6` (#408 guard template suffix fix). Latest merged: #407/#408 guard fixes, #405 storage/interview-kit fix, #404 TD83(a) alerts, #403 worker-own-apply in alerts, #402 photo→PDF re-render, #401 AI-ENV-1, #400 ADR-0031 deletion grace.
- Recently merged since 07-15 (#232–#408, 66+ PRs): TAX-9 (#232), TD67 (#235), TD68+COST-4 (#238), TD62 (#240), RATIFY-1 (#244), Q14 (#245), TD22-1 (#247/#250), TD25a (#248), TD70 (#252), CD-0..5 (#253+#383/#384/#386), in-app PDF (#256), WA-1..4 (#326), ADR-0032 (#340), ten rulings (#387), B-6 (#388), TD53 (#389), D-3 (#391), B-4/B-5/D-1 (#392), ADR-0033 (#394), D-2 (#395), R31-partial (#396), danda (#397), ADR-0031 (#400), AI-ENV-1 (#401), photo→PDF (#402), alerts (#403/#404), storage fix (#405), guard fixes (#407/#408).

# Important Domain Knowledge

- **`job_posting.*` (ops/payer vacancy register, banded) ≠ `job.*` (faceless feed jobs)** — two entities by design (TD37); never conflate.
- **RANK weights CEO-locked 2026-06-19: 35/20/15/15/10/5 (Trade/Loc/Skills/Exp/Salary/Avail)** — code reconciliation pending (add Skills, drop Activity); supersedes the 06-12 "implemented weights authoritative" register row. Money never ranks; no demographics.
- Unlock ₹40 flat; workers free; masking payer-only; **§2 own-session name ruling (2026-07-14): worker may read back their OWN decrypted full_name — settled, don't re-escalate.**
- Consent: profiling and disclosure are separate purposes; both needed for unlock.
- Backward compat: version events/columns, never mutate; expand→migrate→contract.

# Coordination Notes

- **Merge-conflict hotspots:** `app.module.ts`, migration numbers, event registry + enums, `docs/registers/*` IDs, `docs/tracker/*` (synced by dedicated PRs — last #220).
- **Talk first:** event-schema, ai-contracts parity, RLS/migrations, pseudonymization path, auth guards, anything §7 (real keys, gate flips, destructive migrations, production data).
- **Before any PR:** rebase onto origin/main (fast-merging repo), resolve event-count/migration collisions, re-run gates, `--force-with-lease` push. Include QA evidence (`docs/qa/evidence/`) where relevant.

# Do Not Rediscover

- ADRs **0001–0033** (`docs/decisions/`) + `docs/registers/team-decisions.md` (note: its top rows end 06-15; the 06-19 CEO locks in memory/master-context supersede where they conflict — e.g. RANK weights; ADR-0033 makes CEO 06-19 ledger operative with Skills weight .15).
- 39-table schema map + PII placement → project-memory.md; conventions (Zod pipe, exceptions filter, repo/service split, test stack) → project-memory.md.
- Event naming `domain.action`, registry-driven validation, idempotency keys.
- Windows dev gotchas + single-Supabase-DB connection recipe → project-memory "Developer Notes".
- **Dead decisions** (never rebuild): Employer entity, 100-pt score, RVM-as-ranking, hire/no-show signals, BGE-M3, employer-specific prep, price ranges, mobile-only.
