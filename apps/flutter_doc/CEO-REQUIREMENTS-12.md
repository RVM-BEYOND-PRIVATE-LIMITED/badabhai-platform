# Requirement sheet for CEO — Middle Way remaining 12 trades + open rulings

Date: 2026-10-31. Status: the 4 approved trades are LIVE on production.
This sheet lists what is live, what the remaining 12 profiles need,
and the decisions only you can make. No work on E6+ starts until Q1–Q7 are answered.

## 1. Live today (4 trades: CNC Turner, VMC, Grinding, CAM)

What a worker and an employer can feel right now:

1. **Level question in the interview.** The second question in each of the 4 forms
   asks the rung ("Machine pe aap kya karte hain?") with trade-correct chips
   (Turner/VMC: Operator→Programmer; Grinding: stops at Setter-cum-Programmer —
   wheels are dressed, not programmed; CAM: Junior→Senior Programmer).
2. **Depth follows the rung.** A low-experience setter/programmer now gets the
   setter depth sections (`years OR level`). Low rung + low years stays shallow.
3. **The interview closes itself.** 8 required answers → "Bas ho gaya" close, at most
   one optional offer, hard 20-turn cap after accepting. No meandering.
4. **Level on the resume.** Headline prints `Trade · Years · Tools · Level` (level LAST).
5. **Level badge for employers.** Shipped in the API, rendered on payer-web candidate
   cards (needs the next app build to be visible).
6. **Recognition.** "kharad wala", "ghisai", "toolpath", "Sinumerik", "turn-mill",
   "live tool", "C-axis" and 20+ similar words now resolve to the right trade,
   level, and machine instead of falling through to generic questions.
7. **What did NOT change (locked).** Level never affects ranking or visibility.
   No key was renamed. Pricing is still flat ₹40 (tier is logged, not charged).

## 2. Remaining 12 profiles (one PR each, in this order)

| # | Trade | Level question today | Ladder (rungs) | Blocker |
|---|---|---|---|---|
| E6 | Conventional Machinist | `machining_level` (helper/operator/skilled), NOT mandatory | helper, operator, **skilled** — new word, needs your call (Q1) | Q1 |
| E7 | Fitter | `fitter_level`, NOT mandatory | helper, **fitter**, **senior_fitter** — new words (Q2) | Q2 |
| E8 | Welder | `welder_level`, NOT mandatory | helper, **welder**, **certified_welder** — new words (Q2) | Q2 |
| E9 | Tool & Die Maker | `toolroom_level`, NOT mandatory | trainee, **tool maker**, **senior** — new words; plus `mould/die ka kaam` routes NOWHERE today (Q3) | Q2, Q3 |
| E10 | Press Operator | `press_level`, NOT mandatory | helper, operator, setter (all known words) | Q4 |
| E11 | Sheet Metal Worker | `sheet_metal_level`, NOT mandatory | helper, operator, **skilled** (Q1 word, shared ruling) | Q1 |
| E12 | Quality Inspector | `inspection_level`, NOT mandatory | **inspector / qc engineer — not a ladder at all** (Q5) | Q5 |
| E13 | Assembly Line Worker | `assembly_level`, NOT mandatory | helper, operator, **skilled** (Q1 word, shared ruling) | Q1 |
| E14 | Painter / Powder Coating | `coating_level`, NOT mandatory | helper, operator, **skilled** (Q1 word, shared ruling) | Q1 |
| E15 | Maintenance Technician | `maintenance_level`, NOT mandatory | helper, **technician**, **senior technician** — new words (Q2) | Q2 |
| E16 | Industrial Electrician | `electrician_level`, NOT mandatory | helper, **electrician**, **senior** — new words (Q2) | Q2 |
| E17 | 2D CAD Draughtsman | NONE — no level question at all | trainee, draughtsman, **senior_draughtsman**, **lead_checker** (Q6) | Q6 |

Each trade gets: level question made mandatory, required-8 close, role words +
retrieval aliases, resume headline + badge wiring, and tests. Cost per trade is
one release + your seed step, same as the 4 live trades.

## 3. Questions for you (nothing in §2 starts without these)

**Q1 — the word "skilled" (E6, E11, E13, E14).** The machinist, sheet-metal,
assembly and paint shops top their ladder with "skilled", a word our system does
not have yet. (a) Is Skilled the top rung in all four trades? (b) Does Skilled
count as confirmed (like Setter-and-above) or not? (c) Does a Skilled worker
price in the Higher or Lower unlock tier?

**Q2 — new rung words (E7, E8, E9, E15, E16).** Fitter, senior fitter, welder,
certified welder, tool maker, senior (tool room), technician, senior technician,
electrician, senior (electrical) — none exist in the system yet. For each trade:
(a) confirm the rungs, (b) name the separating rung (at/above which a level
counts as confirmed), (c) Higher or Lower price tier for the top rungs.

**Q3 — `mould ka kaam` / `die ka kaam` (E9).** Today these route NOWHERE (pinned,
deliberate). Keep them unrouted, or map them to an industry-optional bucket?

**Q4 — supervisor (E10 and anywhere it appears).** Supervisor exists in the system
already. Confirm once for all trades: Supervisor = confirmed + Higher tier?

**Q5 — Quality ladder (E12).** Inspector / QC engineer is not a helper→senior
ladder. What are this trade's rungs, in order, and which rung separates confirmed
from unconfirmed?

**Q6 — CAD level item (E17).** There is no level question in the CAD pack at all.
Confirm the ladder (trainee → draughtsman → senior_draughtsman → lead_checker)
and who authors the reference: do we have a practising draughtsman to ratify
wording, or do we ship the spec sheet's words as-is?

**Q7 — pricing (all trades).** The Higher/Lower tier per rung is computed and
logged today but ₹40 flat is still charged. Do we activate tiered pricing now,
later, or never? (No code changes until you rule.)

## 4. FYI, no decision needed

- **E3 (3D designer trade)** is referenced in our plan but has no role or pack yet.
  We will bring a separate proposal; ignore for this round.
- **Turner vs Machinist boundary** (both say "lathe/kharad") is already ruled and
  pinned in code — E6 will not move it.
- **Voice re-render** for the new chips rides the separate voice-form track (#701);
  it does not block any trade release.
- **Alias embeddings** for the newest rows ride the next embed pass; retrieval
  works without them.
