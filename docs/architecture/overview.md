# Architecture — the worker profiling path

> Scope: how a worker with no resume becomes a structured, matchable profile.
> Written for an engineer touching this path for the first time.
> Companion decision record: [ADR-0038](../adr/ADR-0038-deterministic-occupation-interview.md).
> Plan of record: [occupation-intelligence-engine.md](../sprint-plans/occupation-intelligence-engine.md).

This document covers the profiling path only. It is deliberately not a whole-platform overview:
payments, matching, the payer portal and the resume renderer each have their own owners, and a
document that claims to describe everything goes stale faster than anyone repairs it.

---

## 1. The problem this shape exists for

Most BadaBhai workers have no resume and no structured professional history. The profiling
conversation is therefore the **only** source of truth for everything downstream — the resume, the
match engine, and the ranking. If it records the wrong trade, every later question is the wrong
question and every later match is wrong too.

That asymmetry drives the entire design: **precision over coverage, determinism over fluency.**

---

## 2. The path, end to end

```
worker message
  → [api] ChatService.postMessage
  → [api] ProfilingOrchestrator.takeTurn        ← load envelope (Redis), CAS on `rev`
      ├─ answer capture      (pure)             ← deterministic detectors → AnswerRecord
      ├─ identify            (IdentifyService)  ← only while the occupation is unpinned
      └─ next question       (pure)             ← (envelope, pack) → ask | disambiguate | clarify | close
  → [api] CAS save, reply + chips to the client
  ... repeat, ZERO LLM CALLS ...
  → completion → ONE Postgres transaction (transcript + answers + events)
  → BullMQ → [ai-service] POST /profile/parse   ← THE ONE LLM CALL
  → six "never invent" gates, run on BOTH sides
  → AnswerMapProjector → worker_profiles
```

**The economics:** ~12 `capable`-tier calls per interview became **1**.

### Where each part lives

| Concern | Home | Why there |
|---|---|---|
| Turn loop, question selection, answer capture | `apps/api/src/profiling/` | Question selection is a business decision (CLAUDE.md §3/§4) |
| Occupation retrieval, packs | `apps/api/src/occupation/` | Needs the database on every turn |
| The single parse call, pseudonymization, embeddings | `apps/ai-service/` | The service is deliberately DB-free |
| Taxonomy, packs, aliases as data | `packages/db/data/` | Question text is data, never TypeScript constants |
| Hinglish detectors and normalizers | `packages/profiling-lexicon/` | One corpus, asserted by both Vitest *and* pytest |

The ai-service holds exactly three jobs after the cutover: **pseudonymize, embed, parse.**

---

## 3. The five invariants

Everything below is a consequence of one of these.

### 3.1 The AI never owns a business decision

The LLM is called once, at the end, and is asked to *reformat* a record it cannot contradict. It
never chooses a question, never ranks, never decides. See §5.

### 3.2 The answer map is the RECORD; the transcript is the EVIDENCE STORE

Normalization happens at **capture** time, not at parse time. `answer-capture.ts` writes
`valueNormalized` every turn using the shared lexicon. The consequence is the one that matters:
**a complete, usable profile can be projected from the answer map alone**, so an LLM outage
degrades coverage rather than breaking profiling.

### 3.3 Fail closed, and make the closed path the same code path

A null parse, a blocked parse, and a parse where every field was rejected all produce the *same*
thing: a real profile projected from the answer map, `parse_status = "deterministic_only"`.
One branch, not three.

### 3.4 A declination is a complete answer

*"Nahi pata"* is an answer. It is recorded as `status: "declined"`, never re-asked, and never
blocks completion. This is why `wpa_answer_shape_chk` is a **biconditional** — `answered` iff
exactly one value column is non-null — so a declined row persists carrying no value. Storing only
valued answers would make "the worker told us they do not know" indistinguishable from "we never
asked".

### 3.5 Raw PII never crosses an AI boundary

Every string leaving for the model is pseudonymized first, per message (≤4,000 chars each), and a
blocked line is dropped and counted rather than being fatal. Events carry ids, enums and counts —
never utterances. Where an utterance genuinely must be recorded (the growth queue), it is stored
pseudonymized and emitted only as a `sha256`.

---

## 4. Resolving the occupation

### Family first, occupation second

NCO-2015 is over-granular for conversation: *"Welder, Gas"* vs *"Welder, Electric"* is a coin flip
at occupation level and **identical at family level** — they share a question pack. Confidence and
margin are therefore computed at **family** level, which is what makes ~3,400 near-duplicate
occupations survivable. The exact code is settled later by the pack's own first question, which is
deterministic, free, and better UX than a prompt listing 44 titles.

### The retrieval ladder — lexical first, vectors as an upgrade

| Layer | Method | Cost |
|---|---|---|
| **L0** exact | normalized alias hash | free |
| **L1** skeleton | Hinglish confusion folding (`kh↔k`, `aa↔a`, `w↔v`, `z↔j`, `sh↔s`) | free |
| **L2** trigram | `pg_trgm` over `text_norm` | free |
| **L3** vector | pgvector ANN | 1 embed call |

The product must work with vector retrieval **off** — that is a hard constraint, not a preference.
Every layer's raw score is mapped onto one shared `confidence ∈ [0,1]` through a piecewise-linear
table in `packages/config/src/occupation-tuning.ts`, because a trigram 0.7 and a cosine 0.7 are not
the same number.

### Disambiguation chips

Never `label_en` — *"Metal Working Machine Tool Setters and Operators"* is not a thing a worker
says. Chips use `label_hi` or the shortest alias, because **aliases are the worker's own vocabulary
by design**. Max 4 plus an escape. The chip→id map is held **server-side** in the envelope and a
tap resolves through that map, never by re-matching the label text — which would re-enter the very
ambiguity the chips exist to settle.

A chip tap is `matched_worker_confirmed`: the highest-quality signal the platform collects, because
it is the worker's explicit selection from a reviewed closed set rather than our inference about
their words.

### Re-pinning

One re-pin per interview (`MAX_OCCUPATION_REPINS = 1`), and only on an `auto` match against a
**different family**. Those two conditions are what distinguish *"ab tempo chalata hun"* from
*"I also run a second machine"*. A re-pin **never discards an answer** — only the unanswered
questions of the old pack — and never refunds the global ask budget.

---

## 5. The six "never invent" gates

Run in the ai-service before the response leaves, then **again** in Nest before anything is
persisted. Not paranoia about our own code: the two walls fail independently — a version-skewed
service, a proxy that rewrote a body, a mock left enabled somewhere.

| # | Gate | What it catches |
|---|---|---|
| 1 | **Provenance** | `evidence.quote` must be a literal substring of the cited transcript line. *A hallucinated value has no span to point at.* |
| 2 | **Role** | The span must come from a `worker` line — not from our own question text |
| 3 | **Type / range** | `experience_years ∈ [0,60]`, salary bounds, closed enums, known cities |
| 4 | **Answer-map agreement** | On disagreement the deterministic value wins and the model's is discarded |
| 5 | **Closed vocabulary** | Any `field_id` outside `target_fields` is dropped and counted |
| 6 | **PII re-certification** | Every parsed string goes back through the pseudonymizer |

**Gate 4 is the mechanism that makes the LLM structurally incapable of overriding the worker.** It
can only reformat. Because a gate that silently discards is a gate nobody can watch degrade,
disagreements emit `profile.parse_disagreement` (field ids and counts, never values) and total
rejections emit `profile.parse_gates_rejected` (per-gate counts, no field ids at all — a value that
failed `provenance` is unverified model output, and so is the field id attached to it).

**Precedence, written once, in one function:**
`deterministic answer map > LLM parse (post-gates) > heuristic transcript extractor`.

---

## 6. State, durability and concurrency

**In flight, an interview lives in Redis**, as a transcript buffer plus a `ProfilingEnvelope`. This
is deliberate: the per-turn design it replaced cost ~4 Postgres writes per turn, roughly 150 rows
per interview.

Three properties keep that safe:

- **Lua CAS on a monotonic `rev`.** A writer that read `rev` may only write at `rev`. The loser
  reloads and re-runs the *pure* decision function against the winner's state — safe precisely
  because the function is pure. Bounded at 2 attempts; on exhaustion nothing is written.
- **A reply cache** (`sha256(sessionId + rev + text)`, 10 s). A mobile client on a flaky 2G
  connection retrying gets the byte-identical previous reply, not a 409 telling it something went
  wrong when nothing did.
- **A Postgres checkpoint every 5 asks.** Redis has a 24 h TTL, and a lapse used to cost the entire
  interview. State only, never message text: ~2 small UPDATEs per interview, and worst-case loss
  drops to 4 answers.

At completion, **one transaction** writes the transcript, the answers as a single multi-row INSERT,
and every event. `turn.complete` says the engine closed the interview; `flushed` says it landed —
conflating them loses the interview, so they are separate.

⚠ **`ChatTranscriptBuffer.narrow()` rebuilds the envelope field by field and drops unknown keys.**
Every new envelope field must be added there or it is silently destroyed on the next load. This is
enforced by the compiler (`PROFILING_ENVELOPE_KEYS` has a `satisfies` clause) and by a round-trip
fixture with every field set to a non-default value.

---

## 7. What the platform can observe

All PII-free. These are the only sources for the engine's health metrics — `worker_profiles`
records where a worker *ended up* and overwrites the evidence of how they got there.

| Event | Answers |
|---|---|
| `profile.occupation_identified` | The layer distribution (L0/L1/L2/L3), confidence, candidate count |
| `profile.occupation_unresolved` | How often the catalogue fails to cover a growing trade |
| `profile.interview_completed` | p95 turn latency (histogram), ask count, completion rate |
| `profile.parse_disagreement` | Whether gate 4 is firing more than it used to |
| `profile.parse_gates_rejected` | Which of the six gates is degrading |
| `occupation.phrase_unresolved` | The growth queue, as a `sha256` |

Latency is a **histogram carried in the envelope and emitted once per interview**, not an event per
turn: ~12 turns × 1M conversations would be 12M rows whose only reader is a dashboard.

---

## 8. The growth loop

An unmatched utterance is not a dead end — it is the highest-value input the catalogue receives.

```
worker says a word nothing matches
  → unresolved_phrase (scope='occupation', pseudonymized, atomic count upsert)
  → pnpm db:growth:occupation        ← ranked by DISTINCT WORKERS, floor of 3
  → a human maps each to a job_domain_id and pastes into rvm-aliases.jsonl
  → db:seed:domains --apply && db:normalize:aliases
  → the next worker who says that word hits L0, free
```

`unresolved_phrase` is **one table with a `scope` column**, not two tables — it already owned the
atomic count upsert, the pseudonymized-only contract and the `open|clustered|resolved` lifecycle.
But the two scopes never share rows: *"fitter"* is an unresolved skill **and** an unresolved
occupation at once, with different follow-up work.

The occupation runner does **no embedding and no clustering**, unlike its skill sibling. An
unresolved skill is usually a near-miss on one we have, so a vector finds the neighbour. An
unresolved occupation has already failed L0, L1, L2 *and* L3 across the whole catalogue —
embedding it again to hunt a neighbour repeats, at cost, the search that just failed.

**The proposed target always renders blank.** Guessing it would be the exact failure this engine
exists to prevent.

---

## 9. Where the gates live

| Gate | Command | Blocks on |
|---|---|---|
| Retrieval accuracy | `pnpm db:eval:occupation` | L0+L1 hit rate, family precision ≥ 0.97 |
| Pack corpus | `pnpm db:verify:packs --corpus` | Structure, vocabulary, persona, cycles |
| Pack deployment | `pnpm db:verify:packs` | The live database, incl. "exactly one active pack" |
| Taxonomy | `pnpm db:verify:domains` | Catalogue integrity |
| Lexicon parity | `pnpm lexicon:verify` | The JS/Python mirror being byte-identical |

A gate that runs in no workflow is documentation, not a gate — every one of these is wired into
`.github/workflows/ci.yml`.

---

## 10. Reading order for a new engineer

1. `docs/adr/ADR-0038` — why the interview is deterministic.
2. `apps/api/src/profiling/next-question.ts` — the state machine. Pure, no DI, no I/O.
3. `apps/api/src/profiling/answer-capture.ts` — how a sentence becomes an `AnswerRecord`.
4. `apps/api/src/occupation/occupation-calibration.ts` — how four layers become one number.
5. `apps/api/src/profiling/parse-gates.ts` — the six gates.
6. `packages/db/data/question-packs/` — the questions, as data.
