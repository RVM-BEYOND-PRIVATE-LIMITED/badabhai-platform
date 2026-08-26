# §5a — fresh vernacular collision re-sweep

**Prepared against main `4798aba6` · measured 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · nothing re-domained, nulled, moved or enabled**

Reproduce: `pnpm db:audit:vernacular-resweep --json=<out>`
Artifact: [`5a-vernacular-resweep.json`](./5a-vernacular-resweep.json)

> **STATUS: PASS — measured at ₹0. One new owner decision required (§5a-2).**

---

## A. What was measured

**106 probes** — every embedded `skill_alias` row on an active skill — scored against the same
population in **three scopes**, reproducing all three ceilings `config.py` uses to justify the
0.75 floor. Not just the 22 wedge aliases the previous instrument covered, and not just the two
known collisions.

**Zero spend, and why it was possible:** every probe *and* every candidate already has a stored
vector, all from a single model (`gemini-embedding-001` — asserted, because cosine across two
models would be meaningless). No text needed embedding, so there was nothing to pay for.

**The honest limit.** An alias's own vector is the most favourable possible query for its own
skill, so a **miss is definitive**. But the negative ceilings are therefore ceilings *over the
phrases the corpus contains* — a real worker's paraphrase could score higher against a wrong
skill. **Each figure below is a lower bound on the true ceiling.** The risk is at least this
large, never smaller.

---

## B. What changed against the recorded calibration

`config.py` says the floor is safe because *"0.75 clears all three"*. All three were measured
**2026-07-14**; the 22 aliases shipped **2026-07-16**. Re-measured:

| ceiling | 2026-07-14 | now | Δ | |
|---|---:|---:|---:|---|
| labeled-domain negative | 0.5980 | **0.0000** | −0.5980 | *vacuous — see below* |
| sibling-confusion | 0.7220 | **0.8405** | **+0.1185** | **breaches 0.75** |
| ANCHOR-path negative | 0.7263 | **0.7760** | **+0.0497** | **breaches 0.75** |

**The claim is falsified: 0.75 clears one of the three, not all three.**

> **The 0.0000 is vacuous, not an improvement.** A probe scoped to its own domain always matches
> its own alias at 1.0, so there is never a wrong top-1 to measure. Reporting it as a −0.598
> improvement would be a lie by omission. The meaningful figure for the correctly-scoped case is
> the **sibling** ceiling.

---

## C. Do the two known false assignments still exist?

**Yes — both, unchanged.**

| phrase | home slug | resolves to | score |
|---|---|---|---:|
| `welding ka kaam` | `welding` | **`skill_drilling`** via *"drilling ka kaam"* | **0.7760** |
| `fitting ka kaam` | `fitting-assembly` | **`skill_drilling`** via *"drilling ka kaam"* | **0.7621** |

Both above the floor, so both would be **assigned**, not left unresolved.

---

## D. Additional collisions

**Yes — three separate findings the previous sweep did not cover.**

### 1. A third above-floor anchor-path collision

`dimensional inspection` → **`skill_drawing_reading` @ 0.7570**. The same defect D-7C-1 found on
the canonical path, now confirmed on the anchor path too. Already an open owner decision.

### 2. Sixteen above-floor sibling collisions, ceiling 0.8405 — inside the *correct* domain

**These are not live misassignments.** Each probe's own alias still wins at 1.0000; the sibling
is the runner-up. What the number measures is **margin**, and what has been lost is the floor's
ability to *reject* a sibling if a real paraphrase ever reorders the two. The 2026-07-14
calibration deliberately placed 0.75 above the worst sibling (0.722) precisely so that could
never happen.

The worst are genuinely distinct trades:

| phrase | own skill | runner-up | score |
|---|---|---|---:|
| `GMAW` / `SMAW` | MIG / arc welding | each other | **0.8405** |
| `GTAW` | TIG welding | MIG welding | 0.8355 |
| `quality check` | dimensional inspection | quality control | 0.8219 |
| `TIG welding` / `MIG welding` | — | each other | 0.8002 |
| `Fanuc controller` / `Mitsubishi controller` | — | each other | 0.7650 |
| `boring` / `drilling` | — | each other | 0.7556 |

GMAW *is* MIG and SMAW *is* stick/arc — different machines, different tickets. 0.8405 is an
artifact of acronym shape, not of the trades resembling one another. (`boring`/`drilling` at
0.7556 reproduces the D-7A figure exactly — the two instruments agree.)

**This is the finding that changes the remediation plan.** These collisions are *already inside
the correct domain*, so **per-label domain resolution cannot reach them.** Re-domaining is
necessary but **not sufficient**.

### 3. Eight phrases exist on two skills at 1.0000 — merge residue, reported separately

`CAD`, `GD&T`, `blueprint reading`, `drawing padhna`, `drawing reading`, `geometric dimensioning
and tolerancing`, `read engineering drawings`, `technical drawing`. TD-01 copied these onto
`skill_drawing_reading` without removing the originals, so the winner is decided by index order
— a **nondeterministic** assignment between a live skill and a corpus-deprecated one.

Folding these into the ceilings would report **1.0000** and drown the actual finding, so they
are counted separately. They need the **D-7C alias cleanup**, not a scoping fix.

---

## E. Is the existing floor still safe?

**No — the argument for it is falsified.** Two of three ceilings now sit above 0.75, and three
phrases would be actively misassigned today.

**This is not a recommendation to move the floor.** The owner ruled 0.75 stays, and nothing here
argues otherwise: a lower floor makes this strictly worse, and a higher one would have to clear
0.8405, which would reject most legitimate resolutions. **The defect is in the corpus and the
scoping, not in the threshold.**

---

## F. Is remediation required before canonicalization?

**Yes, unambiguously.** With `SKILL_CANONICALIZE_ENABLED=false` none of this fires. Turning it on
without remediation would begin writing:

- `welding ka kaam` → drilling · `fitting ka kaam` → drilling · `dimensional inspection` →
  drawing reading — all above the floor, so all **assigned**;
- nondeterministic GD&T/CAD assignments between a live and a corpus-deprecated skill.

The remediation order follows from the evidence rather than from preference:

1. **D-7C alias cleanup** — removes the 8 duplicate-text pairs *and* the
   `dimensional inspection` collision, which shares a cause.
2. **Per-label domain resolution (TAX-6)** — clears all 3 anchor-path collisions; the
   labeled-domain above-floor count is **0**.
3. **Sibling margin** — 16 cases survive both of the above. **Unowned**, and the subject of the
   new decision below.

---

## G. AI spend

**₹0.** No embedding call was made. Recorded in the artifact as `ai_spend_inr: 0` and asserted by
test.

---

## New owner decision

### §5a-2 — the sibling margin

**FACTS.** 16 within-domain sibling pairs score above the floor, ceiling 0.8405. The correct
skill currently wins every one of them, so nothing is misassigned today.

**MEASURED EVIDENCE.** The worst pairs are welding-process acronyms (GMAW/SMAW 0.8405, GTAW
0.8355) and controller brands (Fanuc/Mitsubishi 0.7650) — genuinely distinct concepts whose
*phrases* are lexically close.

**RISK.** The floor no longer separates a correct answer from its nearest wrong sibling. A
paraphrase that reorders the top two would be assigned rather than rejected. This is invisible to
the anchor-path and labeled-domain measures, and it survives every remediation currently planned.

**OPTIONS.**
**A** — accept the margin and rely on the correct alias winning.
**B** — require a minimum *separation* between the top two, not only an absolute floor.
**C** — treat lexically-close siblings (process acronyms, controller brands) as a disambiguation
group needing an explicit tie-break.

**RECOMMENDATION.** None on the product question. On evidence only: **this is the one class the
current plan does not address**, and it should not be rediscovered after canonicalization is
enabled.

**OWNER DECISION: PENDING.**

---

## The defect behind the defect

The collisions are not the most durable finding. **A stale safety argument sat in a config
comment for six weeks and read as current**, because nothing connected the calibration to the
corpus it was measured on. `config.py` even instructs a re-sweep "on any corpus/model change";
the corpus changed two days after the measurement and nothing noticed.

`vernacular-resweep.test.ts` now pins the three recorded numbers, the floor, and the measured
result together, so the two cannot drift apart silently again. The artifact carries `measured_at`
— the property the config comment never had.

---

## What did NOT change

`SKILL_CANONICALIZE_ENABLED` (false) · the 0.75 floor · every alias row, slug and domain · bridge
mappings · `MATCH_SKILLS` · promotion status · every promotion gate · the crosswalk · D-7A, D-7B,
D-7C.

## Gates

```
MATCH_VOCABULARY          PASS — 0/96       unchanged (Q1, ratified 2026-08-26)
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL — 96/96      unchanged
EVAL_COVERED              FAIL — 41/96      unchanged
PROMOTION CANDIDATES      96, eligible 0    unchanged
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**
