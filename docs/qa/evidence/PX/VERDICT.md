CLOSED — NOT BUILT (already implemented)

# PX — Alias ingestion and review tooling · VERDICT

## Why there is no check session

**Nothing was built, so there is nothing to check.** This document is written by the build agent,
not by an independent checker, and that is a departure from the two-session rule in
`docs/agent/README.md` — recorded here rather than left as an unexplained absence.

The two-session rule exists so that an adversarial reader, blind to the builder's reasoning, can
attack the artifact. PX produced no artifact to attack: no schema, no runner, no route, no test.
The working branch `px-alias-tooling` carried exactly two files, both documentation, and zero
files of any code extension. An independent checker opening `PX_CHECK.md` item 1 — _"run the full
pipeline on a sample"_ — would find the pipeline, discover it predates this phase, and be unable
to attribute a single line of it to PX.

What CAN still be checked is this document's claims about what already exists. Every one is cited
by file and line and was read at HEAD `6d1d979e`. A checker who wants to attack something should
attack those citations.

| | |
|---|---|
| **PHASE-ID** | PX |
| **INVARIANT** | *no alias ever becomes active without a human approving it* |
| **SHA** | `6d1d979e` (`origin/main` and `HEAD` agreed, delta 0/0) |
| **Branch** | `px-alias-tooling`, cut from `origin/main` |
| **Files of code written** | none |
| **Migration written** | none — 0093 already provides the candidate layer |
| **Guarded routes added** | none, so no `OPS_ROUTES` row was required |

**The invariant holds, and it held before PX started.** It is not enforced by a status flag —
`skill_alias` has no status column at all. Liveness is derived: a row, a non-null embedding, and
a parent skill at `status='active'` (`apps/api/src/skills/skills.repository.ts` lines 113-124 and
214-227). The human gate is a database CHECK: `skill_candidate_reviewed_chk` demands a reviewer,
a moment and a reason on every human status, and `skill_candidate_machine_status_chk` forbids a
reviewer on the two a pipeline may write
(`packages/db/migrations/0093_skill_discovery_candidate_layer.sql` lines 198-201).

---

## The six deliverables

| # | Deliverable | Outcome |
|---|---|---|
| 1 | Ingest corpus into candidates with source label + raw occurrence count | **DONE** (labels) · **MOVED TO PARK P-009** (count) |
| 2 | Deduplicate and cluster near-duplicates | **DONE** |
| 3 | Generate Hinglish variants with an LLM | **DELETED BY RULING ②** |
| 4 | Route into the existing `/admin/skill-discovery` queue | **DONE** |
| 5 | Domain-scoped search, then global fallback | **DELETED BY RULING ④** (the global half) · **MOVED TO PARK P-012** (the rest) |
| 6 | Confidence floor, below it to `unresolved_phrase` | **DONE** (runtime) · **DELETED BY RULING ③** (discovery) |

**1 — DONE, except the count.** Source labelling ships:
`packages/db/src/discover-skills.ts` emits every row with a `source_type` from the closed union at
`0093` line 157 and a `source_id` naming the row it came from, guarded by a tripwire test in
`packages/db/src/skill-discovery-guardrails.test.ts` that fails if a fourth source type appears.
The raw occurrence count is dropped — `unresolved_phrase.count` is authoritative
(`packages/db/src/schema/skill.ts` line 271) and is not selected by the reader
(`discover-skills.ts` lines 384-387) — and travels with **P-009**, because the same three lines
also carry a missing `scope` predicate and touching that reader twice would change a run's
`input_fingerprint` twice.

**2 — DONE.** `discoveryKey` (`packages/db/src/skill-discovery-plan.ts` line 396) plus union-find
over identity relations only, and reviewer batching by `groupCandidates`
(`packages/db/src/skill-discovery-groups.ts` line 246), non-transitive by construction.

**3 — DELETED BY RULING ②.** Already built for the occupation corpus by
`packages/db/src/generate-domain-aliases.ts`, and ruling ① places that corpus outside PX.

**4 — DONE.** Seven routes on `apps/api/src/admin/admin-skill-discovery.controller.ts`, class-guarded
by `AdminAuthGuard` + `AdminRolesGuard`, with the console shipped at
`apps/admin-web/src/app/(portal)/skills/discovery/`. See **P-008**: the controller's own docblock
still says this console cannot ship, which would have led a builder to construct the second review
screen `PX_BUILD.md` line 12 forbids.

**5 — DELETED, then PARKED.** The global fallback is retracted by ruling ④. What remains is that
the discovery batch matcher is global-only while runtime is scope-refusing —
`matchExistingSkills` takes no domain parameter (`packages/db/src/skill-discovery-match.ts` line
214). That is **P-012**, and it needs a measurement before it needs a decision.

**6 — DONE at runtime, DELETED at discovery.** The floor behaviour ships in
`apps/ai-service/app/ai/canonicalize.py` at 0.75 (`apps/ai-service/app/config.py` line 431).
Ruling ③ upholds the discovery surface's refusal to carry any floor. One residue is recorded as
**P-010**: a path where a phrase is discarded with no reviewer and no unresolved row, invisible to
any floor because the drop happens on the relation before a number is consulted.

---

## The four rulings that reduced this phase

Issued by the owner on 2026-09-03 after PX halted on four blockers.

| # | Ruling |
|---|---|
| ① | **Corpus separation.** PX writes `skill_alias` only. Occupation vernacular is never a source for `skill_alias`, and PX never writes `job_domain_alias`. |
| ② | **No model-authored alias text.** A model may not author alias text that a reviewer approves in bulk; `source_type` names a place a phrase was seen, and "a model made this up" is not a place. |
| ③ | **The floor stays 0.75.** It is a signed ruling with an explicit prohibition on lowering it and 32 call sites; the brief's 0.80-0.85 was written without knowing that. |
| ④ | **Domain-scoped only.** §24 mandates isolation; "fall back to global" is retracted and no global tier is to be built. |

Ruling ② is the one that matters most for the invariant. `candidateAliasTexts` builds the minted
alias set from `source.original_text` (`packages/db/src/skill-discovery-candidate.ts` lines
596-635), so a model-generated variant filed as a source row would become a real corpus alias on
one human "create" click — shown to that reviewer as evidence that somebody said it, because the
detail screen has no field that could distinguish a guess from an observation. The phase invariant
would have broken through the mechanism the phase was built to provide.

A fifth ruling, ⑥, resolved a naming conflict rather than a design one: the brief's `provisional`
maps to `skill_candidate.status = 'pending'`, documented as *the only status a pipeline may write*.
It is recorded so a future checker does not fail a correct build on vocabulary.

---

## What I could not verify

**Whether migration 0093 is applied to any database.** The owner states it is applied. I did not
verify it and could not: I ran no `psql`, no `drizzle-kit`, and no database command of any kind in
this phase. The in-repo evidence points the other way and is stale —
`packages/db/src/export-approved-skills.ts` lines 36-46 read *"Migration 0093 is authored and NOT
applied"*, but that comment dates from when 0092 was the applied head, and 0094 through 0098 have
landed since. This matters because `PX_CHECK.md` item 1 is not executable against a database
missing those four tables. The read-only query that settles it is given to the owner separately;
it was not run here.

**That the WhatsApp screenshot corpus does not exist in this repository.** Measured, and this is a
negative result stated with its scope: `find` over the whole worktree excluding `node_modules`
matched **zero** files against `*screenshot*`; a case-insensitive grep for a word-bounded `ocr`
returned five files, all ISCO-scrape residue comments and corpus data, with no OCR code path.
`packages/db/data/job-domains/` holds exactly four entries — `__gold__`, `isco08.jsonl`,
`nco2015.jsonl`, `rvm-aliases.jsonl` — and the last is 770 lines of human-authored occupation
vernacular that is already ingested, not a screenshot corpus. Positive control on the same command
shape: a grep for `whatsapp` returned 20+ files, so the search works. **What I cannot verify is
where that corpus is, what format it is in, or whether it exists at all outside this repository.**

**The ~28-of-3,885 coverage figure.** It is a **documentation claim, not a measurement I made**.
It appears at `docs/architecture/project-control.md` line 191 and
`docs/architecture/project-status.md` lines 41 and 527, marked VERIFIED and attributed to a probe,
in a table whose surrounding rows are stamped with a catalog version dated 2026-08-07. I did not
re-run the probe. **It must be measured before anyone acts on it** — see **P-012**, which carries
the query.

### And the thing this phase actually found

PX existed because roughly 2,100 Hinglish aliases were believed to be the longest-lead item on the
programme.

**The pipeline to process them ships. The corpus does not exist.**

Ingestion, normalization, clustering, classification, competing-match scoring, reviewer batching,
a seven-route review API, a shipped admin console, an export path and a promotion gate are all
built and were built before this phase opened. What is absent is the input: no screenshot corpus,
no OCR path, nothing ingested. The `job_domain_skill` coverage figure points the same way — a
taxonomy with edges into a few dozen of nearly four thousand domains is not short of machinery, it
is short of content.

**Read this as a supply gap, not an engineering gap.** The next person to pick this up should be
sourcing and ingesting a corpus, not building a pipeline — and should re-measure the coverage
figure first, because it is the number that says how much of the taxonomy the corpus would even
have somewhere to land.

---

## Parks raised by this phase

| Park | Subject |
|---|---|
| **P-008** | A shipped console is documented as unshippable, and the docblock invites rebuilding it |
| **P-009** | The discovery reader ignores `unresolved_phrase.scope`; carries the dropped occurrence count |
| **P-010** | The consonant-skeleton fold is banned from merging and trusted to silently drop |
| **P-011** | Two consumers share one `unresolved_phrase` queue and starve each other with no watermark |
| **P-012** | Should the discovery batch matcher be domain-scoped? Owner ruling, needs a measurement first |

## Nothing was fixed

No defect found during this phase was repaired. All five are recorded in `PARKED.md` with a file
and a line. The scope proposal that preceded this closure is at
`docs/decisions/PX_SCOPE_PROPOSAL_2026-09.md`.
