# ADR-0061: "Level needed" — the applicant list sorts by the employer's minimum rung (engine v1.1)

- **Status:** Accepted. CEO ruling (Akshit), 30 Oct 2026 — `BadaBhai_Level_Decisions_30Oct_FINAL.md`, Q3 = A ("sort only, never hide"). Implementation rulings by Divyanshu, 2026-11-04.
- **Date:** 2026-11-04
- **Owner:** Divyanshu (Backend Platform, match module) · **Issue:** #2548 · **Frontend:** #2549
- **Needs:** migration `0153` applied to production BEFORE the build that writes it deploys. (Applied by the owner 2026-11-04 under its earlier number, `0149`, and verified read-only; renumbered to `0153` after main gained its own `0147`–`0152`. The DDL is unchanged.) Then the deploy bridge for the flag (#2613), and on the CEO's go-ahead the `production` environment secret `LEVEL_NEEDED_SORT_ENABLED=true` and a redeploy.
- **Amends:**
  - [ADR-0036](0036-matching-algorithm-v1.md) §2, the rank tuple. One key is added inside the tier group. Spec Policy 23/25 (a rank-key change needs a new `engine_version`, CEO sign-off and an ADR) is met: v1.1, the 30 Oct ruling, this file.
  - The Middle-Way hard lock "`trade_level` never affects visibility/ranking" (`docs/middle-way/HANDOVER.md` §4, spec §3). The CEO superseded it: the rung moves rank **only** when the employer picked a level. Visibility is unchanged.

## 1. Context

Workers in the four CNC trades now answer their rung (Helper → Operator → Setter → Setter-cum-Programmer → Programmer → Supervisor). Since migration 0141 a company posting can also name one rung (`job_postings.trade_level`), but it was display-only. A "Setter wanted" job and an "Operator wanted" job showed the same list, so the employer spent an unlock credit before finding the mismatch.

## 2. Decision

### 2.1 The order (CEO ruling Q3, verbatim intent)

When the posting names a rung, applicants are grouped **inside each trade group**:

1. **Trade first, as today.** Exact trade above related trade. The 36-month tier floor stays exactly as it is.
2. **Inside each trade group, by level:** meets (that rung or above) → **level not confirmed** → below.
3. **Then as today:** skill months → industry months → recency → arrival → id.

No scores, weights or points: one more lexicographic key. Nobody is added or removed.

### 2.2 Implementation rulings (owner, 2026-11-04)

| #      | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **The floor stays as it is.** The ruling's worked example prints related worker C at 72 months, but the floor promotes a related worker with 36+ months into tier-1 ordering, so at 72 months C (a Setter) comes **first**, not 4th. The floor wins. The example is pinned at a sub-floor month count (24), where it gives exactly A → D → B → C. Reported to the CEO with the rollout.                                             |
| **R2** | **A "koi aur" answer is not a confirmed level.** An upper rung (one that carries a separating question: Setter and above on the CNC ladders, Programmer and above on CAM) with `level_confirmed = false` sorts in the middle group with the "Level not confirmed" tag. A rung that has no separating question (Operator) meets an Operator post on its own. Anything under the needed rung is below, whatever the confirm bit says. |
| **R3** | **The rung is frozen at apply.** The worker's rung and confirm bit are snapshotted onto `applications` (migration 0153) with the rest of the rank inputs and frozen the same way (E16: only a skip→apply flip rewrites them). A worker who edits his level later never moves on a list the employer already saw. Applications from before 0153 have no frozen rung and sit in the middle group. Nothing is backfilled.              |
| **R4** | **Rollout: a flag plus the 4 CNC trades, company postings only.** `LEVEL_NEEDED_SORT_ENABLED` (default off) gates the sort; the capture (R3) runs regardless, because history not captured is gone. Agency `jobs` lists use the legacy weighted ranker and follow in a later slice.                                                                                                                                                 |

### 2.3 Which rung counts, and in what order

- The frozen rung is the one on the skill the worker was **reached through**: the posted trade for an exact match, the related trade for a related one (the example's "VMC Operator · Setter").
- The rung order per trade is `LEVEL_SORT_LADDERS` in `packages/taxonomy/src/level-needed.ts`, copied from the CEO Launch Plan Pack v1 sheets. Legacy keys that a CEO ruling equates with a rung sort there: `helper` → `trainee` (§2 shared words); on CAM `junior_programmer` → `trainee` and `senior_programmer` → `senior` (2 Nov reconciliation; sheet 3 labels `senior` "Senior Programmer").
- A rung the posting trade's ladder does not know (a turner's `setter` on a CAM post, a CAM `lead` on a turner post) is never guessed into a position: it sorts as not confirmed.
- An exhaustiveness test fails the build if any rung the posting form offers, or any level answer any version of the four packs can store, has no position.

### 2.4 "Any level" is today's list

No rung on the posting, a trade outside the four, an unknown posting rung, or the flag off: the service hands the repository an empty level map, the SQL keeps the v1.0 ORDER BY (text and binds), no extra query runs, and `levelFit` is `null`.

## 3. Where it lives

| Concern                                                               | File                                                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Trades, ladders, the three-way fit (`levelNeededSpec`, `levelFitFor`) | `packages/taxonomy/src/level-needed.ts`                                                                                                   |
| Comparator key (`levelOrder`)                                         | `packages/match-engine/src/rank.ts`, `types.ts`                                                                                           |
| SQL key (`levelSortKey`), frozen-rung columns, `listPostingLevels`    | `apps/api/src/match/match-feed.repository.ts`                                                                                             |
| Gate + `levelFit` label                                               | `apps/api/src/match/match-candidates.service.ts`, `level-needed-sort.flag.ts`                                                             |
| Capture at apply                                                      | `match-apply.service.ts` (V1 + union), `applications.repository.ts` (agency twin), `worker-skills.repository.ts` (`findStatedTradeLevel`) |
| Parity (SQL ⇔ comparator, incl. the §3 example)                       | `apps/api/src/match/rank-parity.test.ts` (DB gate in CI)                                                                                  |

The SQL and the comparator are the two spellings of the rule, pinned to each other by `rank-parity.test.ts` exactly as the rest of the tuple is.

## 4. Consequences

- `engine_version` becomes `v1.1` (code default and seed). The active `match_config` row stores snake_case keys that `MatchConfigSchema` does not read (TD128), so the engine serves the code defaults. Every application captured from this deploy on is therefore stamped `v1.1`, with no ops edit. Whoever fixes TD128 must carry `engineVersion: "v1.1"` in the corrected row.
- The level key is computed, not indexed: `applications_rank_idx` still serves the posting filter, and the per-posting list is capped at 500 rows, so the extra sort is bounded.
- `levelFit` is an additive field on the company-posting applicant row and the inbox row. payer-web renders the "Level not confirmed" tag from it (frontend issue).
- The CEO's 2-week metrics (ruling §7) need `trade_level` on postings and the frozen rung on applications; both are now stored.

## 5. Not decided here

- Level-based unlock pricing (ruling Q5): the hook stays as built; no change.
- The posting form's CAM rung chips still offer the pre-sheet-3 keys (`junior_programmer`, `senior_programmer`); they sort correctly through the aliases above, but the chip list should match sheet 3 (#2550).
- The agency `jobs` applicant list (legacy weighted ranker).
