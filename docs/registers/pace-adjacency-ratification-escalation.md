# ESCALATION — Ratify an industrial `ADJACENT_ROLES` map (PACE adjacent-trade leg)

- **Raised:** 2026-06-19 · **To:** Product + CEO (Akshit) / TL (Prakash) · **From:** Engineering (PACE build, ADR-0021)
- **Decision needed:** a **ratified** related-trade adjacency map for the launch (CNC/VMC) trades, or an explicit "not now".
- **Blocks:** the PACE **adjacent-trade widen leg** only. The AREA-widen + OPS-ALERT legs shipped without it.
- **Status:** OPEN — gated. `PACE_ADJACENCY_ENABLED=false` and is a **no-op until a ratified map is wired**.

## Why this is an escalation, not an engineering task

The PACE supply-widening engine (ADR-0021) escalates a thin-supply job: widen AREA → **widen ADJACENT
trade** → ops alert. The reach engine is **already adjacency-ready** — it scores `secondaryRoleIds` at
the lower secondary weight (0.6, below on-trade). The **only** missing piece is the **data**: which
trades are "adjacent" to which. That is a **product/business judgement** (who can credibly do a
related job), not an engineering call — and wiring a wrong/guessed map silently mis-targets supply.

Per the build's non-negotiable: **do not wire a draft or invent a map.** So the leg is built and
gated, awaiting ratification.

## What we verified (ground truth)

- `packages/taxonomy` has **no** `ADJACENT_ROLES` map (only roles/domains/skills/machines).
- Hospitality **explicitly declined** an adjacency map — product call 2026-06-17
  ([hospitality-vertical-prd.md](../sprint-plans/hospitality-vertical-prd.md) §"No adjacency map").
- Industrial adjacency exists at best as a **draft** (the reach-engine-config doc is a draft, not
  source of truth) — not ratified, not safe to wire.
- `reach.mappers.workerProfileRowToSignals` returns `secondaryRoleIds: []` (no lookup wired).

## The ask (one of)

1. **Ratify a map** — for the 7 launch CNC/VMC roles, sign off which roles are mutually adjacent
   (e.g. is a "CNC Turner/Operator" adjacent to a "VMC Operator"? to a "CNC Setter-Operator"?). A
   small reviewed table is enough; engineering wires it into `@badabhai/taxonomy` as `ADJACENT_ROLES`
   and flips `PACE_ADJACENCY_ENABLED`. A horizontal-correctness test will assert adjacent matches
   enter **below** on-trade (never out-ranking a true on-trade worker).
2. **Defer explicitly** — "no adjacency for the launch trades yet" (mirroring hospitality). PACE then
   widens by AREA only and escalates to the ops alert; the adjacent leg stays inert. No code change.

## If ratified — what engineering does (small, bounded)

- Add `ADJACENT_ROLES: Record<RoleId, RoleId[]>` to `@badabhai/taxonomy` from the **ratified** table.
- Wire it into `reach.mappers` so `secondaryRoleIds` is populated (the only mapper change).
- Flip `PACE_ADJACENCY_ENABLED=true` (staging-first). The PACE escalation order already accounts for it.
- Add the adjacency-correctness + still-PII-free tests.

## Cross-links

- [ADR-0021](../decisions/0021-pace-supply-widening-and-ops-alert.md) §Escalations
- Open question **Q-PACE-ADJ** ([open-questions.md](./open-questions.md))
- Tech-debt: the gated adjacent-trade leg ([tech-debt-register.md](./tech-debt-register.md))
