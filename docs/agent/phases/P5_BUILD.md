STATUS: BLOCKED ON RULING R7 (unsigned, docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:774).
The hot-tag half of this phase is deleted outright; what remains IS R7 option (a) verbatim, and
building it settles an open ruling. BUILD_RULES.md:31 makes that a full stop. HALT and ask.

PHASE P5 — an employer facet over the applicants list.

DO THIS, AND ONLY THIS.
Write docs/qa/evidence/P5/HALT.md. Name R7 and worksheet:774, or name the P0 FAIL
(docs/qa/evidence/P0/VERDICT.md line 1 is "FAIL", and README.md:47 forbids starting downstream
of that). Either ground is sufficient. Change no code. No route, no query parameter, no
constant, no test.

DELETED BY RULING. Do not build these, and do not reintroduce them as a fallback or an option:
  - The hot tag, the ~12 percent ratio, the 70-candidate floor, small_pool.
    ADR-0036:97 — "`hot` does not exist in V1" — and the 2026-07-31 owner ruling at
    docs/registers/team-decisions.md:250, which retires "the 35/20/15/15/10/5 ledger, `hot`,
    and `pushFloor`". No small-pool deliverable survives.
  - HOT_TOP_RATIO. That identifier appears in no source file, in any casing. Do not create it.
  - The 70-candidate floor. It exists nowhere. packages/reach-engine/src/ranking.ts has no
    pool-size cutoff of any kind; the only gate on the flag is trade relevance at :77.

THE P5/P7 COLLISION IS DISSOLVED, NOT REORDERED.
ADR-0036:97 retires PACE and `hot` on one line, so both sides of it are gone. No phase moves.
P7 is CLOSED for the same reason and says so at P7_BUILD.md:1.

RECORD FOR WHEN R7 IS SIGNED. Do not build on any of it now.
  - The route ships and takes no query parameter today:
    apps/api/src/payer-portal/payer-reach.controller.ts:63-68 carries only @Param,
    @CurrentPayer and @Ctx. It is an extension point, not a duplicate-handler hazard.
  - DESIGN CONSTRAINT, and the only thing that could make a facet legal. ADR-0036:61 —
    "Nothing else may enter the rank — not education, age, gender, caste, religion, RVM
    affiliation, attributes, or money" — and :65, attributes are "shown on the card, never
    matched, never ranked". A facet may exist ONLY as a post-rank permutation of an unchanged
    set, the shape ADR-0036:85 grants boost. R7 option (c), the hard filter, is already dead by
    :65 — that is ADR-0036 speaking, not this brief narrowing a live ruling.
  - When R7 is signed, an unknown facet key must return 400, never be silently ignored.
  - FACET KEY SOURCE, until matching_catalog carries real values: the question-pack JSON,
    packages/db/data/question-packs/packs/*.json, keyed "target_kind": "attribute" plus
    "target_field" — qp_cnc_turning.json:94-95 gives controller_brand, six option_keys at
    :101-129. matching_catalog is not on main (open PR #1387, DO NOT MERGE) and P1_BUILD.md:45-46
    seeds only an is_active=false fixture with no real values. Do NOT source it from
    apps/api/src/match/pack-attribute-skills.ts:78, which carries three of the six on purpose.
  - OPEN, NOT YOURS TO SETTLE: (i) does ADR-0036:86, "Boost never touches the company's
    candidate list", extend to non-money permutation? (ii) once #1387 merges and R1-R4 are
    signed, does the whitelist move to matching_catalog's per-role attribute whitelists
    (P1_BUILD.md:25) or stay on the pack JSON? Two sources for one closed set is what P1 exists
    to prevent.

INVARIANT: no attribute enters the rank key, and no query parameter on
GET /payer/reach/jobs/:jobId/applicants changes WHICH workers the response contains.
