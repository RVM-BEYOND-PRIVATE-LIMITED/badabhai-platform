# ADR-0038 — The worker interview is deterministic; the LLM parses once, at the end

- **Status:** Accepted
- **Date:** 2026-08-07
- **Supersedes:** the LLM-driven chat interview introduced on `feat/ai-chat-profiling` (`fc95d2f`)
- **Owners:** Backend Platform (Divyanshu, Prakash)
- **Implements:** `docs/sprint-plans/occupation-intelligence-engine.md`, Phase 8

---

## Context

BadaBhai profiles workers who have no resume. The profiling conversation is the only source of
truth for everything downstream — the resume, the match engine, the ranking — so whatever
conducts it decides the quality of the entire product.

Two designs preceded this one, and each fixed the other's defect.

**The first was a 923-line deterministic engine with a 632-line question bank keyed to seven
hardcoded role families.** It was cheap and predictable and it asked a tailor about CNC
machining, because a tailor was not one of the seven. Coverage was the problem, and the problem
was structural: questions were code, so a new trade was a deploy.

**The second replaced it with an LLM that writes its own question every turn.** That solved
coverage completely — a model adapts to any trade — and bought it by handing conversational
control to a model. Three consequences followed:

1. **CLAUDE.md §3 was violated.** "AI never owns business decisions", and which question a
   worker is asked next is a business decision: it decides what ends up on their profile, which
   decides which jobs reach them.
2. **~12 `capable`-tier calls per interview.** One per turn, on the request path, per worker.
3. **Nothing was reproducible.** Two workers who said the same thing got different interviews,
   so a regression in interview quality was invisible and un-bisectable.

There was also a live defect neither design caused and neither fixed: the interview's captured
answers **never reached extraction**. `ProfileExtractionInputSchema` had no field for them, so
extraction re-parsed the transcript under a *different vocabulary* (`trade` → `primary_role`,
`salary_expected` → `expected_salary`). The worker answered; the answer was dropped; a model
guessed it again from prose.

## Decision

**The interview is deterministic. The occupation is identified by retrieval from the worker's
own words. Questions come from versioned, reviewed data. The LLM is called exactly once, at the
end, to parse a transcript into strict JSON — and it cannot override anything the worker said.**

Concretely:

1. **Questions are DATA, not code.** 101 question packs bound to conversational *families*, not
   to occupations. Seeded from JSONL in git through `db:seed:packs`, gated by `db:verify:packs`.
   Adding a trade is a reviewed diff, not a deploy.
2. **The occupation is resolved by a four-rung retrieval ladder** — L0 exact alias, L1 Hinglish
   skeleton, L2 `pg_trgm`, L3 pgvector — with one calibrated confidence and a margin computed at
   **family** level. The ladder short-circuits on `auto`, not on "found something".
3. **The engine picks the next question with a pure function.** `nextQuestion(state, packs)` has
   no DI, no I/O and no clock, so the whole state machine is property-testable and a CAS retry
   can safely re-run it.
4. **The answer map is the RECORD; the transcript is the EVIDENCE STORE.** Every answer is
   normalized at *capture* time, so a complete profile can be projected from the map alone.
5. **The one LLM call is `POST /profile/parse`,** and it is framed so it cannot invent: it is
   never asked "what is this worker's salary", it is asked "the answer for `salary_expected` was
   `pandrah hazaar mahina` — return the typed value and quote the span it came from".
6. **Six mechanical gates run on both sides of that wire.** Provenance (the quote must be a
   literal substring of a `role:"worker"` line), role, type/range/enum, **answer-map agreement**,
   closed vocabulary, and PII re-certification.

**Precedence, written once, in one function:**
`deterministic answer map > LLM parse (post-gates) > heuristic transcript extractor`.

## Consequences

### What this buys

- **~12 `capable` calls per interview → 1.** The economic case for the whole project.
- **The interview is reproducible.** Same answers, same next question, always — so interview
  quality becomes a thing CI can regress on.
- **A visible finish line.** `progress: {answered, total}` is computable for the first time; the
  model never knew how many questions were left because it invented each one as it went.
- **A trust moment.** `occupation_label` echoes the worker's trade back **in their own
  vernacular** the moment retrieval pins it — never `label_en` ("Metal Working Machine Tool
  Setters and Operators" is not a thing anyone calls themselves).
- **The captured answers finally reach extraction**, guarded by an exhaustiveness test over
  `FIELD_CROSSWALK` rather than by a `switch` somebody has to remember to update.
- **An LLM outage no longer breaks profiling.** It degrades to `deterministic_only` and the
  worker still gets a real profile.

### What this costs, stated plainly

- **Coverage now depends on the pack corpus.** 101 families are authored; the universal pack
  catches every trade beyond them, but an unauthored trade gets a less specific interview than
  the LLM would have improvised. This is the plan's Risk #1 and it is a content problem, not an
  engineering one.
- **An ambiguous extraction-time domain match is now honestly UNMATCHED.** The LLM pick in
  `domain_match.py` is deleted; where two near-identical occupations tie, nothing guesses. That
  path only runs for a session with no answer map, and the interview resolves the same ambiguity
  properly — by showing the worker chips and recording which one they tap.
- **No per-trade rollback lever.** The rollback unit is `git revert` of the cutover PR, which is
  exactly why every deletion is *in* that PR rather than spread across earlier ones.

### Rejected alternatives

- **Keep the LLM turn behind a flag, cut over per trade.** Rejected: two live interview engines
  writing into one `captured` map is two sources of truth, and the flag would have outlived the
  migration by years. The plan's author raised the missing rollback lever explicitly and the
  answer is Phase 9's non-optional calibration gates.
- **Bind packs to occupations rather than families.** Rejected on measurement: NCO unit group
  7223 alone holds 44 near-identical machining titles, `"Welder, Gas"` and `"Welder, Electric"`
  differ by ~0.02 at occupation level and by *nothing* in what you would ask someone. Binding to
  occupations means 3,449 near-duplicate packs and a retrieval margin too thin to act on.
- **Let the model rank or choose between retrieved candidates.** Rejected under CLAUDE.md §3 and
  because the better answer is free: ask the worker, and record their tap as
  `matched_worker_confirmed` — not our inference about their words, their own explicit selection
  from a reviewed closed set.

## Compliance

| Principle | How |
|---|---|
| **Event first** | Four new events: `occupation.phrase_unresolved`, `profile.occupation_identified`, `profile.occupation_unresolved`, `profile.parse_disagreement`. Append-only at the end of the registry. |
| **Privacy first** | No worker text in any of the four payloads — ids, codes, scores and counts only, each `.strict()` with a test asserting the tempting field is rejected. The one place a phrase can leave memory (the growth queue) goes through `/pseudonymize` first and is then stored as sha256. |
| **AI never owns business decisions** | The engine selects; retrieval identifies; the model reformats. Gate 4 makes the model *structurally* incapable of overriding a deterministic answer, and `profile.parse_disagreement` makes that gate observable. |
| **Fail closed** | A blocked pseudonymization, an unreachable parse call, or every field failing its gates all produce one outcome: a profile projected from the answer map, `parse_status = "deterministic_only"`. |
| **Backward compatibility** | Migrations 0071/0072 are additive (a new table, a new column, a widened CHECK). No column dropped, no event schema mutated, no client field removed. Every new `chat.dto.ts` field is optional and defaulted, so the Flutter app works unchanged. |

## Migrations

| # | What |
|---|---|
| 0071 | `worker_pack_answer` — the interview's answers as typed rows, unique on `(worker, pack, question_key)` *without* the version, so a re-interview replaces rather than accumulates. RLS-locked. DPDP erasure rides the `ON DELETE CASCADE`. |
| 0072 | `worker_profiles`: two new match statuses in the CHECK, `job_domain_match_layer` for the Phase 9 distribution gate, and `ENABLE`/`FORCE ROW LEVEL SECURITY` — it was one of the last worker tables without it. |

Both are reversible. `worker_pack_answer` is re-derivable from transcripts;
`job_domain_match_layer` is observability and NULL on every pre-cutover row.

## Follow-ups

- **Phase 9 owns the numbers.** Every threshold in `packages/config/src/occupation-tuning.ts` is
  a provisional engineering estimate and says so; the sweep against production utterances
  replaces them.
- **Frontend** — one GitHub Issue covers the progress bar, the occupation confirmation pill, the
  `question_kind == "disambiguate"` single-select list, re-verifying `session_ended →
  clearChatSession`, and the outstanding fact that `flutter analyze` / `flutter test` have never
  been run against this branch.
- **`profiling_persona_guard_enabled` / `profiling_persona_repair_retries`** are now inert config
  keys. Left in place deliberately — removing an env key is a deploy-surface change — and slated
  for the next ai-service config pass.
