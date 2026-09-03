PHASE PX — alias ingestion and review tooling. Runs in parallel with everything.

STATUS: CLOSED 2026-09-03 — NOT BUILT (already implemented).
See docs/qa/evidence/PX/VERDICT.md. Do not build from this file without reopening
the phase; most of it already ships and predates the brief.

This brief was corrected on 2026-09-03 to match owner rulings ① to ④ and ⑥. Three
statements below were wrong when issued and have been removed, not annotated.

Build ingestion and review tooling for the SKILL alias corpus.
You are NOT writing aliases yourself.

CORPUS SCOPE (ruling ①). PX concerns `skill_alias` only. It never writes
`job_domain_alias`, and occupation vernacular is never a source for `skill_alias` —
the directional rule. These are two separate corpora and the earlier draft of this
brief conflated them.

1. Ingest into candidate aliases, each with a source label and a raw occurrence
   count. Sources are the catalogue source types the pipeline already emits.
   Occupation vernacular is out of scope by ruling ①.
2. Deduplicate and cluster near-duplicates across candidates. Any clusterer must be
   non-transitive: token-subset and consonant-skeleton merging were both removed
   after measurement.
3. DELETED BY RULING ② — a model may not author alias text that a reviewer approves
   in bulk. `source_type` names a place a phrase was SEEN; "a model made this up" is
   not a place, and the minted alias set is built from source rows, so a model
   variant filed as one becomes a real alias on a single human click. LLM Hinglish
   variant generation already exists for the OCCUPATION corpus in
   packages/db/src/generate-domain-aliases.ts and must not be replicated here.
4. Route everything into the EXISTING admin skill-discovery review queue.
   /admin/skill-discovery already exists, and so does its admin-web console.
   Do not build a second review screen.
5. Search inside the domain. Domain-scoped ONLY (ruling ④) — there is no global
   tier and none is to be built. Section 24 mandates isolation: "cutting" means
   different things in metal, tailoring and a salon, which is the argument FOR
   scoping, not for a fallback. Absence of a global tier is defended at four layers
   and by ten cross_domain_isolation gold negatives.
6. The confidence floor is 0.75 and it is a signed owner ruling with an explicit
   prohibition on lowering it (ruling ③). Do not change it and do not desynchronise
   its call sites. Below the floor a phrase goes to unresolved_phrase — this ships
   in the runtime canonicalizer. Never force a match: a wrong skill_id silently
   corrupts matching and nobody ever finds it.
   The discovery review surface carries NO floor, on purpose. A threshold that
   selects a review queue is one product decision away from a threshold that
   approves it. Do not add one.

STATUS VOCABULARY (ruling ⑥). The candidate layer's machine-written status is
`pending`, documented as the only status a pipeline may write. An earlier draft of
this brief said `provisional`; the concepts are identical and `pending` is the house
spelling. Provisional is never active — that is a locked rule, and it is enforced by
database CHECK, not by convention.

skill_id is permanent. Never reused, never renumbered, never deleted. Only deprecated.

INVARIANT: no alias ever becomes active without a human approving it.
