STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

NOTHING SURVIVES THIS CLOSURE. Every deliverable is either shipped, deleted by a signed
ruling, or carried by an E-phase. Checked adversarially, not assumed.

------------------------------------------------------------------------------
PHASE-ID: PX
INVARIANT: no alias ever becomes active without a human approving it.

STATUS: CLOSED 2026-09-03 — NOT BUILT (already implemented).
The verdict is written: docs/qa/evidence/PX/VERDICT.md. There was no check session
because nothing was built to check.

This sheet was corrected on 2026-09-03 to match owner rulings ② to ④ and ⑥. Items
that were unsatisfiable as written are fixed or deleted, not annotated — a check
item that asks for the wrong thing fails a correct build.

EXPECTED ARTIFACTS: an ingestion pipeline producing candidate aliases at status
`pending` with source labels, routed into the existing /admin/skill-discovery queue.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:

1. Run the full pipeline on a sample. Every output row must be status = `pending`
   (ruling ⑥ — the earlier `provisional` is the same concept under a different
   spelling, and `provisional` is REFUSED by skill_candidate_status_chk, so a
   correct build cannot produce it). Any active alias is a FAIL.
   Note the pipeline reads four tables created by migration 0093; if that migration
   is not applied to the database you are checking, this item is not executable and
   saying so is the honest result.

2. DELETED BY RULING ② — PX generates no LLM variants, so there is nothing to tag.
   Do not record a PASS here over an empty set: "no untagged variant was found" is
   trivially true when zero variants exist, and an empty result is not evidence.

3. Confirm a phrase scoring below the confidence floor lands in unresolved_phrase
   and does NOT become an alias. The floor is 0.75 (ruling ③) and it lives in the
   RUNTIME canonicalizer, not in the discovery pipeline — check it there. A forced
   match is a FAIL. The discovery review surface is expected to carry no floor at
   all; finding one is a FAIL, not a PASS.

4. Confirm the review path is the existing /admin/skill-discovery queue.
   A second review screen is a FAIL. Note the console already shipped, so the
   correct finding here is that it exists, not that it is missing.

5. Try to renumber or delete a skill_id through the tooling. It must be impossible.
   State WHICH it is: "the system refuses it" and "I could not find a way to do it"
   are different claims, and only the first answers this item.

6. Confirm search is domain-scoped and that NO global tier exists (ruling ④ — the
   earlier "global fallback" is retracted; section 24 mandates isolation). A global
   fallback is a FAIL. Cite file and line for the scoping.
   Two traps on this item: a path named "LEGACY / FALLBACK PATH" in the skills
   repository is legacy-slug scope falling back to canonical scope — BOTH domain
   scoped — so citing it does not answer this question; and the discovery batch
   matcher is global-only by design today, which is parked as P-012 and is not a
   PX defect.
