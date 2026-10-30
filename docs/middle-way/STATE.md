# BadaBhai Taxonomy Middle Way — STATE

Spec: `BadaBhai_Taxonomy_Middle_Way_Spec_v1.md` (CEO approved 29 Oct 2026)
Base: `origin/main 03a90966` | Scope v1: 4 trades (Turner, VMC, Grinding, CAM) | Owner: Divya (feature dev)

## Split (per task rules)

- **Mine (backend/AI/DB):** P0 inventory + STATE/LADDERS docs, P1-P6 pack + lexicon + headline/badge backend, tests.
- **Rishi:** none for P0. P5 will raise `[Frontend] level badge/headline` issue once API contract final.
- **Prakash:** none for P0 (no box change).
- **Me (manual):** none for P0. P1 needs Divyanshu manual migration apply before merge.

## §9 Answers (approved by Divya)

1. **Q1 level storage:** Add `trade_level TEXT NULL` + `level_confirmed BOOL DEFAULT FALSE` to `worker_profile_skill` (`packages/db/src/schema/taxonomy.ts:286`). Keep old `level` untouched. Needs Divyanshu manual additive migration. Date: 1 day after Akshit/Prakash sign-off.
2. **Q2 old IDs:** Keep `mskill_cnc_setter_operator` + `mskill_cnc_programmer` permanent (never rename/reuse). Stop deriving new workers to them; new claims → `mskill_cnc_turner` / `mskill_vmc_operator` + `trade_level`. Old rows keep matching via existing relations.
3. **Q3 CAD:** `mskill_designer` today = generic Designer (2D+3D conflated). Keep ID = 2D CAD Draughtsman (relabel only), mint `mskill_3d_designer`, relate both ways. Split `ATTRIBUTE_TO_MATCH_SKILLS` 2D→designer, 3D→new.
4. **Q4 estimate:** 10 working days for C1–C6 on 4 trades (Turner, VMC, Grinding, CAM): P1 2d, P2 2d, P3 1d, P4 2d, P5 2d, P6 1d + verification. Date: 2 weeks from P1 start (buffer for review). Docs-only P0 ships first.

## Phases

| Phase | Spec | Status | Commit | Test |
|---|---|---|---|---|
| P0 Baseline lock | inventory 4 packs/forms, snapshot tests | done | 9b5b7906 | taxonomy corpus load OK, 4 packs parse OK |
| P1 C1 level field | nullable, display-only, zero reach/rank change | done | - | schema 27 pass, taxonomy 136 pass, match-engine 223 pass, no match reader |
| P2 C3+C4 gates | level to all, `years OR level` | done | - | corpus 169 packs valid; db pack 180+72 pass; api proof/parity/budget/registry 900+ pass; goldens regen; ai parity 17 pass |
| P3a C2 required + close | v3 mandatory flags, required_complete + Bas-ho-gaya copy | done | - | corpus 173 packs valid; db 180+72 pass; api engine/proof/parity/budget/TTS/registry 1000+ pass; goldens regen; ai parity 17 pass |
| P3b stop rule | 14-turn focus, 20-turn cap, one optional offer + end | done | - | engine 48 pass; offer module+flow 12 pass; envelope round-trip 50 pass; orchestrator 133 pass; TTS/golden/ai parity green; budget unchanged (39/9) |
| P4 C5 aliases | §8 Hinglish Turner+VMC (Grinding/CAM→P6) | done | - | router 82 pass; role registry/scope/invariants/parity/handover/identify 414 pass; db corpus+reachability 233 pass; typecheck+eslint clean |
| P5 C6+display | crosswalk, headline `Trade · Years · Tools · Level`, badge, unlock hook ₹40 live | done | - | taxonomy crosswalk 9 pass; headline/verdict/glance 151+637 pass; persist hook 212 pass; badge DTO+wire 245+38 pass; unlock hook tier logged, debit still 1cr; typecheck+eslint clean |
| P6 DoD+handover | 10 tests, expand plan 12, Claude Code pack | todo | - | §7 tests 1-10 |

Rules: additive-only, no key rename, level never affects visibility/ranking, one branch per phase `mw/pN-*`.

## P0 Inventory (origin/main)

Packs (all v1):
- `qp_cnc_turning` (18 items): mand only `turning_experience` (easy). Gates: setting/tolerance/sector at `turning_experience>=2`, programming/advanced/quality/troubleshoot at `>=5`, fresher 3 at `<=0`. No level Q, no machine/controller mandatory.
- `qp_vmc_milling` (18 items): mand only `milling_experience` (easy). Same gate shape on `milling_experience` (2/5/0).
- `qp_cnc_grinding` (18 items): mand only `grinding_experience` (easy). Gates on `grinding_experience` (2/5/0). Ladder stops at Setter-cum-Programmer (no Programmer rung).
- `qp_cam_programming` (14 items): mand `programming_mode` + `programming_experience` (easy). Gates on `programming_experience` (2/5/0).

Forms (role descriptors): `cnc_turner`, `vmc_milling`, `cnc_grinding`, `cam_programmer` — all `formEnabled:true`. Tenure keys match pack experience fields. Ladders in LADDERS.md.

Gap to spec: today 1 mandatory per pack (experience only). Spec needs 8 required (Trade/Machine/Level/Years/Controller-or-Workarea/Location/Salary/Availability). Location/Salary/Availability are universal (central gate, agreed). Machine/Controller/Level need `is_mandatory + min_tier=easy` + `ask_if years OR level` in P2/P3.
