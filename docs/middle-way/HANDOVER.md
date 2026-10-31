# BadaBhai Taxonomy Middle Way — Claude Code handover (P6, 2026-10-31)

v1 (C1–C6 on CNC Turner, VMC, Grinding, CAM) is DONE on `main` and green. This
file is everything needed to continue: expand the remaining trades (EXPAND-12.md)
or operate v1. Read STATE.md + LADDERS.md first; this file is the map, not the
territory.

## 1. Where things stand

| Phase | Branch (merged, squash)                         | What it did                                                                                                                                                                                                      |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | `feat/mw-p0-baseline` (docs) / `mw/p0-baseline` | Inventory lock, Q1–Q4 answers, LADDERS.md                                                                                                                                                                        |
| P1    | `feat/mw-p1-level-field`                        | `trade_level TEXT NULL` + `level_confirmed BOOL` on `worker_profile_skill` (migration 0137, applied by Divyanshu). Old `level` untouched                                                                         |
| P2    | `feat/mw-p2-level-gates`                        | Level Q in all 4 v1 packs + `years OR level` gates; 1 two-line frontend touch (`trade_form_topics.dart`, needs Rishi's review)                                                                                   |
| P3a   | `feat/mw-p3a-required-close`                    | v3 packs: 8 required slots, `required_complete` close + "Bas ho gaya" copy                                                                                                                                       |
| P3b   | `feat/mw-p3b-stop-rule`                         | 14-turn required-focus, one optional offer (accept/decline/unclear), post-accept 20-turn cap, `profile.optional_offered/declined` events. Code-only                                                              |
| P4    | `feat/mw-p4-aliases`                            | §8.1/§8.2 alias starters for Turner+VMC (role terms + `rvm-aliases.jsonl` + Divyanshu seed). Grinding/CAM deferred → EXPAND-12 E4/E5                                                                             |
| P5    | `feat/mw-p5-display`                            | C6 crosswalk (`packages/taxonomy/src/trade-levels.ts`), level-last headline, employer badge wire (`tradeLevels`, Rishi renders), persist to `trade_level`+`level_confirmed`, unlock tier hook (logged, ₹40 live) |
| P6    | `feat/mw-p6-dod-handover` (this)                | DoD gap tests (§7.7/7.8/7.9/7.10), pack-keys snapshot, EXPAND-12, this handover. No product behavior change                                                                                                      |

Commits as Divyanshu Pant, conventional commits, one branch per phase, gates
green before push, PR with checks, squash-merge, verify on `main`.

## 2. DoD §7 — where each test lives (all green on main)

| #   | DoD                                           | Status                     | Pinned by                                                                                                                                                                                                   |
| --- | --------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Setter hoon" → setter section                | ✅                         | `cnc-turning-depth.proof.test.ts:150` (+`turning_level` gate)                                                                                                                                               |
| 2   | 3-yr "Programmer" → programming section       | ✅                         | `cnc-turning-depth.proof.test.ts:156` (+ ask-budget guard)                                                                                                                                                  |
| 3   | 8 slots filled or `nahi pata`                 | ✅                         | `next-question.test.ts:643-713`, `optional-offer-flow.test.ts:99-108,217-230`                                                                                                                               |
| 4   | Ends after 8 + one offer; never loops         | ✅                         | `optional-offer-flow.test.ts:217-344`, `next-question.test.ts:722-819`, sim test (200-turn bound)                                                                                                           |
| 5   | Headline shows level                          | ✅ with approved deviation | `resume-headline.test.ts:49-65`, `trade-resume-map.test.ts:202-219`. Spec example shows `Trade · Level · Years`; P5 owner decision is LEVEL LAST (`Trade · Years · Tools · Level`), pinned in tests + STATE |
| 6   | Employer card shows level badge               | ✅ backend; UI open        | `match-candidates.service.test.ts:122-146`, `match-feed.repository.test.ts:549-724`, wire `tradeLevelBadgeWireSchema`. Rishi renders the badge ([Frontend] issue)                                           |
| 7   | `level = null` visible, ranked same           | ✅ (P6)                    | `match-feed.repository.test.ts` correlated-subquery + COALESCE tests; `match-candidates.service.test.ts` null-vs-stated order test                                                                          |
| 8   | Changing level: zero reach + zero rank change | ✅ (P6)                    | ORDER BY has no `trade_level` (both reads); service-level same-order/dto test; derive never reads the column (`worker-skills.repository.ts` selects `skills`, not `trade_level`)                            |
| 9   | §8 aliases → right trade/level/skill          | ✅ with documented gaps    | `section8-alias-resolution.test.ts` (123 tests: routing + rung capture + option capture, Turner+VMC). Gaps → EXPAND-12 E1/E2/E4/E5                                                                          |
| 10  | Answers untouched; no key renamed             | ✅ (P6)                    | `pack-keys.snapshot.json` + append-only test (mutation-verified: deletion fails the build)                                                                                                                  |

## 3. Key files

- Spec: `C:\Users\divya\Downloads\BadaBhai_Taxonomy_Middle_Way_Spec_v1.md` (CEO-approved 29 Oct 2026)
- State: `docs/middle-way/STATE.md` · ladders: `docs/middle-way/LADDERS.md` · expand: `docs/middle-way/EXPAND-12.md`
- Engine: `apps/api/src/profiling/next-question.ts`, `optional-offer.ts`, `orchestrator.service.ts`, `conversation-state.ts`
- Packs: `packages/db/data/question-packs/packs/qp_{cnc_turning,vmc_milling,cnc_grinding,cam_programming}@{2,3}.json` + `_published-versions.jsonl` ledger
- Routing/roles: `apps/api/src/profiling/roles/*.role.ts`, `trade-form-router.ts`, `role-registry.ts`
- Aliases: `packages/db/data/job-domains/rvm-aliases.jsonl` (seeded to prod by Divyanshu in P4)
- Crosswalk: `packages/taxonomy/src/trade-levels.ts` (+ `.test.ts`)
- Display: `apps/api/src/resume/` (headline/summary/verdict/glance), `match-candidates.service.ts`, `match-feed.repository.ts` (`tradeLevelsColumn`), `apps/payer-web/src/lib/contracts.ts` (`tradeLevelBadgeWire`)
- Persist: `profile-extraction.processor.ts` hook → `ProfileSkillsRepository.upsertTradeLevels` (upsert-only, level columns only; `replaceForProfile` preserves rungs)
- Pricing hook: `unlocks.service.ts` logs `tier=higher|lower`, debits exactly 1 credit
- Key vocabulary lock: `packages/db/src/pack-keys.snapshot.json` (regen: `UPDATE_PACK_KEYS_SNAPSHOT=1 ...`, same commit only)

## 4. Hard locks (spec §3 — break the build before breaking these)

- One ID per trade; level is a field, never an ID. Never rename keys (snapshot test).
- `trade_level` never affects visibility/ranking (ORDER BY + service tests).
- `null` = not stated, never guessed; unclear = decline, never re-ask.
- Free text filling two slots fills both; `nahi pata` closes, never re-asks.
- TURNER `turn-mill` veto, CAM-package non-corroboration, `turning karta hoon`+pin → turner: all pinned with rationale comments. Do not "fix" without re-reading them.
- Pack versions coexist (`@2`/`@3` files + deprecate-in-place); retiring a published version is a separate claim (sessions pin versions; TTS manifest builds from the corpus).
- Controller spellings (`Sinumerik/M70/Mazatrol/TNC`) and slot-2 machine variants are re-ask-with-chips today, NOT capture failures — EXPAND-12 E1/E2 owns them.

## 5. Manual steps (Divyanshu)

- Migrations: direct-SQL apply + drizzle journal row if `db:migrate` is ever re-run (P1 0137 precedent).
- Seeds: `db:seed:packs` (P3a), `db:seed:domains` → normalize → verify (P4). Prod writes need BOTH `--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=<script>`; the guard refuses otherwise (seen live in P4).
- TTS re-render for new clips is a SEPARATE voice-form step (#701) — not part of any trade PR.

## 6. Open items (not P6)

- Rishi: worker-app `trade_form_topics.dart` review (P2 touch) + payer-web level badge render (contract final: optional `tradeLevels`).
- EXPAND-12 E0–E17: Grinding/CAM aliases, CAD Q3 (`mskill_3d_designer` never minted — blocks CAD), 12 trades, E1/E2 pack/copy work.
- Pack option alignment (E1) and controller spellings (E2) for the v1 4 trades.
- No new maths, tiers, multipliers, per-skill months, function/collar columns (parked per spec §9).

## 7. Verify a checkout (what green looks like)

```bash
pnpm turbo run typecheck --filter=@badabhai/api --filter=@badabhai/db --filter=@badabhai/taxonomy
pnpm --filter api exec vitest run src/profiling/section8-alias-resolution.test.ts src/match/match-feed.repository.test.ts src/match/match-candidates.service.test.ts
pnpm --filter @badabhai/db exec vitest run src/question-pack-keys.append-only.test.ts src/question-pack-corpus.test.ts src/question-pack-reachability.test.ts
pnpm --filter @badabhai/event-schema test
```

Full gates run in CI (`ci-required`); P5's PR (#2482) is the reference green run.
