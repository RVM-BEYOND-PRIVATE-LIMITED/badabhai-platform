# PX — Revised scope proposal

**For:** Prakash (owner)
**From:** BadaBhai engineering
**Date:** 2026-09-03
**Code state:** HEAD `6d1d979e`, branch `px-alias-tooling` cut from `origin/main` (delta 0/0)

---

## What this document is

A **proposal, not a plan of record.** It states, for each of the six deliverables in
`docs/agent/phases/PX_BUILD.md`, whether the thing is already built, deleted by an owner ruling,
or genuinely remaining — and for anything remaining, what it is, why it is needed, and what it
touches. Nothing here is decided. No code was written for it.

Every claim about the code was read at HEAD `6d1d979e` and is cited by file and line.

### The rulings this implements

Issued by the owner on 2026-09-03, in response to the four blockers raised at the end of PX
scoping. They are recorded here because most of PX's scope disappears into them.

| # | Ruling |
| --- | --- |
| ① | **Corpus: `skill_alias` only.** PX never writes `job_domain_alias` and never reads occupation vernacular into `skill_candidate`. The directional rule holds. |
| ② | **A model may not author alias text that a reviewer approves in bulk.** Deliverable 3 is DELETED, not deferred. |
| ③ | **The floor stays 0.75.** It is a signed ruling with 32 call sites. The discovery surface's refusal to carry any floor is upheld. |
| ④ | **Section 24 means domain-scoped only.** "Fall back to global" is retracted. Do not build a global tier. |
| ⑤ | **The WhatsApp screenshot corpus is out of scope.** It is an RVM asset that was never ingested and has no OCR path in this repository. |
| ⑥ | **`provisional` maps to `pending`.** A naming resolution, not a design change — recorded so a checker cannot fail a correct build on vocabulary. |

---

## The six deliverables

| # | Deliverable | Status |
| --- | ------------------------------------------- | ------------------------------ |
| 1 | Ingest corpus into candidates with source label + raw occurrence count | **PARTLY DONE** — one item remains |
| 2 | Deduplicate and cluster near-duplicates | **DONE** |
| 3 | LLM Hinglish variants, `llm_proposed` / `provisional` | **DELETED BY RULING ②** |
| 4 | Route into the existing `/admin/skill-discovery` queue | **DONE** — before PX writes a line |
| 5 | Domain-scoped search, then global fallback | **HALF DELETED BY RULING ④**, half is an open question |
| 6 | Confidence floor, below it to `unresolved_phrase` | **DONE at runtime · DELETED at discovery by ruling ③** |

---

### 1 · Ingestion — PARTLY DONE

**Done.** A three-source ingester exists in
[packages/db/src/discover-skills.ts](../../packages/db/src/discover-skills.ts), and every row it
emits carries a `source_type` from the closed union in
[0093](../../packages/db/migrations/0093_skill_discovery_candidate_layer.sql) line 157 plus a
`source_id` naming the row it came from. Source labelling — the first half of the deliverable —
is shipped and is guarded by a tripwire test that fails if a fourth source type ever appears
(`skill-discovery-guardrails.test.ts`).

**Deleted.** The WhatsApp screenshot corpus, by ruling ⑤. Also out: a transcript-to-candidate
path. `mine-chat-aliases.ts` exists but targets `job_domain_alias`, which ruling ① excludes; and
the source type that would carry transcripts, `worker_phrase`, is pinned **absent** on purpose —
it would make `source_id` a join key back to a person on a response whose privacy argument is
that no such key exists.

**Remaining — the raw occurrence count.** `PX_BUILD.md` line 7 asks for it and the pipeline drops
it. `unresolved_phrase.count` is authoritative and atomically incremented
(`packages/db/src/schema/skill.ts` line 271), and the reader selects only `id`, `phrase` and
`job_domain_id` ([discover-skills.ts](../../packages/db/src/discover-skills.ts) lines 384-387).
Occurrences are then recomputed as source-row multiplicity, so **a phrase forty workers said is
indistinguishable from one said once** — in a queue whose whole job is ranking what deserves a
human's attention.

_What it touches._ Not a one-line change, and it should not be attempted as one. It needs a NEW
field: `source_alias_count` already exists, is indexed into the queue sort, and sits inside
`PROVENANCE_FIELDS`, so redefining it invalidates every stored `provenance_digest` and makes old
and new runs non-comparable. It is also entangled with **P-009**, since the same three lines carry
the missing `scope` predicate, and fixing one without the other changes a run's
`input_fingerprint` twice.

---

### 2 · Deduplicate and cluster — DONE

`discoveryKey` ([skill-discovery-plan.ts](../../packages/db/src/skill-discovery-plan.ts) line 396)
plus union-find over **identity relations only**, and reviewer batching by `groupCandidates`
([skill-discovery-groups.ts](../../packages/db/src/skill-discovery-groups.ts) line 246), which is
non-transitive by construction — its docblock states there is _"no union, no find, no threshold,
and no way for a chain"_ to form.

**This is the deliverable most likely to be rebuilt wastefully, and rebuilding it reproduces a
measured disaster.** The two obvious implementations — token subset, and the consonant skeleton —
are exactly the two rungs that were REMOVED after measurement (`skill-discovery-match.ts` lines
322-356): subset chaining under union-find produced a single `wood` cluster holding 8,478 source
rows across 2,814 domains. Any clusterer added here must be non-transitive or it regresses that.

---

### 3 · LLM Hinglish variants — DELETED BY RULING ②

Already built for the occupation corpus by
[packages/db/src/generate-domain-aliases.ts](../../packages/db/src/generate-domain-aliases.ts) — a
two-phase, human-gated, provider-key-free generator — and ruling ① puts that corpus outside PX
anyway. It must not be replicated on the skill side.

The reasoning is worth keeping where the next reader will find it:
`candidateAliasTexts` builds the minted alias set from `source.original_text`
(`skill-discovery-candidate.ts` lines 596-635), so a model-generated variant filed as a source row
becomes a real corpus alias on **one** human "create" click — shown to that reviewer as evidence
that somebody said it, because the detail screen has no field that could tell a guess from an
observation. That is the phase invariant breaking through the mechanism PX would have built.

---

### 4 · Route into the existing review queue — DONE

Seven routes on one controller, class-guarded by `AdminAuthGuard` + `AdminRolesGuard`
([admin-skill-discovery.controller.ts](../../apps/api/src/admin/admin-skill-discovery.controller.ts)),
and the admin console shipped in full at `apps/admin-web/src/app/(portal)/skills/discovery/`.

**Two inverse risks, both recorded as parks.** The controller docblock still claims the review UI
cannot ship (**P-008**) — a builder who trusts it constructs the second review screen that
`PX_BUILD.md` line 12 forbids and `PX_CHECK.md` line 15 fails on. And the route inventory is
pinned by equality in `admin-skill-discovery.authz.test.ts` line 174 — _"declares EXACTLY six
reads and ONE write — no export, no batch, no re-open"_ — which is a design refusal, not a fixture
to update.

---

### 5 · Domain-scoped search — HALF DELETED, HALF AN OPEN QUESTION

**Deleted by ruling ④:** the global fallback. Its absence is defended at four layers, and ten
`cross_domain_isolation` gold negatives pass because a cross-domain return is impossible.

**The open question is the inverse of how the brief framed it.** At runtime, search is
scope-refusing — the repository signature makes "neither scope" unrepresentable. In **discovery**,
matching is global-only: `matchExistingSkills(normalized, index, limit)`
([skill-discovery-match.ts](../../packages/db/src/skill-discovery-match.ts) line 214) takes no
domain parameter, and `EXISTING_SKILL_SQL` ([discover-skills.ts](../../packages/db/src/discover-skills.ts)
lines 135-141) joins no domain — it selects every non-deprecated skill.

So under ruling ④ the batch matcher is the one place inconsistent with the ruling. Whether to
close that gap is **a question for the owner, not a PX build**, for two reasons:

- It is not a post-filter. The match result feeds `disposition`, `proposeAction`,
  `confidenceBand` and `confidenceValue`, so scoping it changes which phrases become candidates
  at all.
- Canonical scope resolves through `job_domain_skill`, which repository documentation puts at
  roughly 28 of 3,885 selectable domains. If that figure is near right, naive domain-first over
  the discovery corpus returns near-zero for the overwhelming majority of trades. **That figure is
  a documentation claim, not a measurement — it must be measured before anyone acts on it.**

---

### 6 · Confidence floor to `unresolved_phrase` — DONE at runtime, DELETED at discovery

**Done, at runtime, at 0.75.** The canonicalizer performs exactly the behaviour the deliverable
describes — one scoped search, take the best, compare to the floor, otherwise record the
pseudonymized miss and return unresolved (`apps/ai-service/app/ai/canonicalize.py`), with
`skill_canonicalize_floor = 0.75` at `apps/ai-service/app/config.py` line 431.

**Deleted at discovery, by ruling ③.** The discovery surface refuses thresholds by design, and
says so: _"There is no threshold, no score gate, no confidence floor and no auto-approve anywhere
on this surface, and there is no field through which one could be introduced"_
(`admin-skill-discovery.dto.ts` lines 65-69), because _"a threshold that selects a review queue is
one product decision away from a threshold that approves it"_ (lines 244-251).

**One residue, recorded as P-010 rather than proposed as work.** There is a path where a phrase is
dropped with no reviewer and no unresolved row — a consonant-skeleton collision scored at a pinned
0.95 — and it is invisible to any floor because the drop happens on the relation, before a number
is consulted. It is the failure mode deliverable 6 exists to prevent, arriving by a route
deliverable 6 cannot see.

---

## Proposal

**PX is substantially already built. Engineering's recommendation is to close the phase**, on the
grounds that four of six deliverables are done or deleted outright, and neither of the two
residues is PX-shaped:

- The occurrence count (deliverable 1) is real and small, but it is entangled with **P-009** and
  should travel with it as one measured change to the discovery reader, with a before-and-after
  dry run — not as a phase.
- Domain-scoping the batch matcher (deliverable 5) needs a measurement and an owner ruling before
  it needs an implementation.

**This is a recommendation, not a ruling.** The alternative — keep PX open and scope it to exactly
those two items — is equally defensible and costs a phase gate rather than a park.

```
Signed (owner): .......................  Date: .................
```

---

## Open questions

1. **Close PX, or keep it open for the two residues?**
2. **Is 0093 applied to any database?** `export-approved-skills.ts` lines 36-46 say _"Migration
   0093 is authored and NOT applied"_, but that comment dates from when 0092 was head and
   0094-0098 have landed since. `PX_CHECK.md` item 1 asks to run the pipeline on a sample, which
   is not executable against a database missing these four tables.
3. **Should the four parks P-008 to P-011 land on `main`,** or stay on `px-alias-tooling` with
   this proposal?
