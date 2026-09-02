PHASE PX — alias ingestion and review tooling. Runs in parallel with everything.

Build ingestion and review tooling for the alias corpus.
You are NOT writing aliases yourself.

1. Ingest the RVM WhatsApp screenshot corpus and existing profiling transcripts
   into candidate aliases, each with a source label and a raw occurrence count.
2. Deduplicate and cluster near-duplicates across candidates.
3. Generate Hinglish variants with an LLM. Every one is marked
   source = llm_proposed and status = provisional.
   Provisional is never active. That is a locked rule.
4. Route everything into the EXISTING admin skill-discovery review queue.
   /admin/skill-discovery already exists. Do not build a second review screen.
5. Search inside the domain first, then fall back to global. This is required by
   section 24 — "cutting" means different things in metal, tailoring and a salon.
6. Confidence floor 0.80 to 0.85. Below the floor, the phrase goes to
   unresolved_phrase. Never force a match. A wrong skill_id silently corrupts
   matching and nobody ever finds it.

skill_id is permanent. Never reused, never renumbered, never deleted. Only deprecated.

INVARIANT: no alias ever becomes active without a human approving it.
