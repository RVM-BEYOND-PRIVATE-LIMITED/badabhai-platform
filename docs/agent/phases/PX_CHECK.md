PHASE-ID: PX
INVARIANT: no alias ever becomes active without a human approving it.

EXPECTED ARTIFACTS: an ingestion pipeline producing provisional candidate aliases with
source labels, routed into the existing /admin/skill-discovery queue.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Run the full pipeline on a sample. Every output row must be status = provisional.
   Any active alias is a FAIL.
2. Confirm every LLM-generated variant carries source = llm_proposed.
   Any untagged one is a FAIL.
3. Feed in a phrase that scores below the confidence floor. It must land in
   unresolved_phrase and NOT become an alias. A forced match is a FAIL.
4. Confirm the review path is the existing /admin/skill-discovery queue.
   A second review screen is a FAIL.
5. Try to renumber or delete a skill_id through the tooling. It must be impossible.
6. Confirm domain-scoped search runs before the global fallback. Cite file and line.
