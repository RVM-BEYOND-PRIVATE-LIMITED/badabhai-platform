# BadaBhai — Team Memory

> Rebuilt 2026-07-14 from git history (all refs), open PRs (gh), `docs/tracker/`, and the
> registers. Single source of truth for ownership + active work. **Update in place — do
> not recreate.** Ownership = declared split in
> [claude-working-guide §4](../docs/claude-working-guide.md) cross-checked against git;
> shared areas are marked.

# Team Overview

- **3 active committers:** Prakash Kantumutchu (**TL / integrator**, ~374 commits), Divyanshu Pant (backend, ~135 — the user), Rishi Ojha (Flutter/mobile, ~16, active since 2026-06-26). Akshit (CEO) signs off ADRs/gates. Utkarsh is the announced Company/Agency web owner (2026-06-19 roster) but has **no repo commits yet** — payer-web is Prakash's in practice.
- Process: automation-first + one human reviewer; specialist agents review, human confirms. Prakash merges most PRs.
- **Status: alpha NO-GO** — sole capstone blocker B1 (real handset vs staging); **P0: staging API deploy overdue since 2026-07-04 (owner Prakash)**. Alpha 2026-08-15.

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
- **packages/db** — 38 migrations (0000–0037); sequential numbering, **check latest before `db:generate`**; renumber-on-merge is a recurring conflict. ONE Supabase DB (the `main`, the only database) — risky migrations need backup + sign-off.
- **Auth stack** — WorkerAuthGuard (OTP+PIN, ADR-0026), ConsentGuard/ConsentNotRevokedGuard, PayerAuthGuard + role/org guards (ADR-0027), AdminAuthGuard/AdminRolesGuard (ADR-0025), InternalServiceGuard (still fronting money routes — LC-1/TD33).
- **Shared libs** — validators, types, config (env gates), taxonomy, ai-contracts (**keep Zod↔Pydantic parity**; last synced #191/#193), pricing, reach-engine, reach-learn.
- `app.module.ts` (32 modules) and `docs/registers/` + `docs/tracker/` — merge hotspots.

# Environment gates

11 boolean env gates, **all default false** (packages/config/src/server.ts): AI_ENABLE_REAL_CALLS, PAYMENTS_ENABLE_REAL, MESSAGING_ENABLE_REAL, MEMBER_INVITES_ENABLE_REAL, RESUME_RENDER_ENABLED, AUTH_ROLLING_TIERS_ENABLED, ADMIN_PII_REVEAL_ENABLED, ZEPTOMAIL_SANDBOX_MODE, CAPACITY_ENFORCEMENT_ENABLED, PACE_ENABLED, PACE_ADJACENCY_ENABLED. Payments/messaging/member-invites **fail closed at boot** if enabled without provider creds. **Any flip = human sign-off + staging first** (CLAUDE.md §7). B1 needs `RESUME_RENDER_ENABLED=true` on staging.

# Active Workstreams

- **B1 alpha capstone** — blocked on P0 staging deploy (runbook exists: `docs/ops/staging-service-deploy-runbook.md`); then real-handset run + 3 evidence artifacts + PDF download. Owner: Prakash (deploy), Rishi/Divyanshu (device run).
- **Worker Alerts/notifications feed** — Divyanshu, **shipped 2026-07-14 (#221)**. (Tracker's "notifications tab mock" blocker row is now resolved — update on next tracker sync.)
- **ADR-0031 deletion grace (7-day)** — Divyanshu drafted 2026-07-14; **PENDING Prakash+Akshit**; reverses ADR-0026 D1/D2/D4; when accepted: migration 0038 (expand-only), events →102, cancel endpoint, BullMQ sweep, worker-app banner; mandatory bb-security-review.
- **Fork-B / TAX (ADR-0030)** — Prakash; FORK-B-1 request-path DB skill store merged 2026-07-14 (#222).
- **Payer-web FE wiring (FE-1..7)** — P1, mock shims → live seams (#194 started).
- **LC-1 money-route auth** — move unlock/reveal + posting-plan off InternalServiceGuard/body payer_id (TD33/TD50). High-value security work, unowned.
- **Parked/waiting:** hospitality vertical (PRD CEO-signed 06-18, content drafted in code, awaiting per-trade RVM ratification), phase-2 seeding/agency-payout stubs, PACE adjacency (Q13, CEO).

# Current PR Status (gh-verified 2026-07-14 afternoon)

- **No open PRs.** Latest merged today: **#221** worker Alerts feed (Divyanshu) and **#222** FORK-B-1 request-path DB skill store (Prakash, ADR-0030).
- Recently merged (#182–#222): tenancy B5.x, TAX-0..4 + fork-B, COST-2/3/4, PERSONA-1/2, worker-app wiring + 3.35.7 (Rishi), TD54 reads, name-edit #204, PDF-409 #209, liberal feed #216, TD25/TD58 #197, mock-STT #198, CI-1 #218, register/tracker sync #220, Alerts #221, FORK-B-1 #222.

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

- ADRs **0001–0031** (`docs/decisions/`) + `docs/registers/team-decisions.md` (note: its top rows end 06-15; the 06-19 CEO locks in memory/master-context supersede where they conflict — e.g. RANK weights).
- 39-table schema map + PII placement → project-memory.md; conventions (Zod pipe, exceptions filter, repo/service split, test stack) → project-memory.md.
- Event naming `domain.action`, registry-driven validation, idempotency keys.
- Windows dev gotchas + single-Supabase-DB connection recipe → project-memory "Developer Notes".
- **Dead decisions** (never rebuild): Employer entity, 100-pt score, RVM-as-ranking, hire/no-show signals, BGE-M3, employer-specific prep, price ranges, mobile-only.
