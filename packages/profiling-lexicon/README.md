# @badabhai/profiling-lexicon

The Hinglish occupational lexicon, shared by the **TypeScript** conversation orchestrator
(`apps/api/src/profiling/`) and the **Python** ai-service (`apps/ai-service/app/profiling/signals.py`).

## Why this package exists

`signals.py` is ~3,200 lines and is the single most valuable asset on the profiling path: Indian city
and state gazetteers, machine/controller/trade keyword tables with spelling variants, the
conversational predicates (`is_dont_know`, `is_correction`, `is_hardship`, `is_abusive`), the value
normalizers (experience, salary + period disambiguation, notice period, relocation), and the negation
engine that stops *"abhi kaam nahi mil raha"* becoming `availability: immediate`.

The deterministic orchestrator needs all of it **in TypeScript**, on every turn. Porting it by hand
would create two copies that drift — and drift here is silent: a detector that stops firing produces a
slightly worse profile, not an error.

**So the data moves, not the logic.** The gazetteers, keyword tables, regex sources and the field
crosswalk live here as JSON. `signals.py` reads them; `src/` reads them. One source, two readers.

## Ownership

| Path | Owner | Contents |
| ---- | ----- | -------- |
| `src/normalize/` | Divyanshu | Occupation-text normalization — the function shared by the alias seeder and the retrieval query path |
| `src/predicates/` | Prakash | Conversational detectors the orchestrator calls every turn |
| `src/values/` | Prakash | Value normalizers + the negation engine |
| `data/` | shared | The JSON the two languages both read. Changes reviewed by both. |
| `__fixtures__/` | shared | The dual-language parity corpus |

## The two guards that keep the languages honest

**1. Regexes must be written in a JS/Python-common subset.** Explicit character classes only —
**never `\d` or `\w`**. This repo has already been bitten by exactly this: `apps/api/src/skills/skills.dto.ts`
documents that JS `\d` is ASCII-only while the Python pseudonymizer's `\d` is Unicode-aware, and that
"this boundary must not be looser than the upstream gate". A `\d` here would mean the TS detector and
the Python detector disagree on Devanagari digits.

**2. One golden corpus, asserted by both suites.** `__fixtures__/utterances.jsonl` holds real Hinglish
worker utterances with their expected detector output. The Vitest suite in this package and the pytest
suite in `apps/ai-service/tests/` both assert against **the same file**. Adding, renaming or changing a
case turns the other side red.

This is the same mechanism, and the same reasoning, as
`packages/ai-contracts/src/__fixtures__/profiling.keys.json` + `apps/ai-service/tests/test_contract_parity.py`.

## Status

Phase 0 froze the **contracts** in `src/`.

**`src/normalize/` is IMPLEMENTED** (Phase 1, Divyanshu). `normalizeOccupationText`,
`normalizeOccupationTextTraced` and `skeletonKey` are real, `data/particles.json` is populated, and
`@badabhai/db` consumes them from `db:normalize:aliases` to build `job_domain_alias.text_norm`. This
is the occupation-text half of the lexicon only — the particle list wraps a TRADE NAME and is
deliberately scoped to that; conversational cues (don't-know, correction, negation) are not here.

`src/predicates/` and `src/values/` are still `export declare` stubs. Phase 3 (Prakash) performs that
extraction: moving the conversational data out of `signals.py` into `data/`, implementing the readers,
and populating the ≥300-case parity corpus. Until then `signals.py` remains the sole implementation of
those, and `__fixtures__/utterances.jsonl` does not exist yet.

### A note on `skeletonKey`, for whoever reads it next

The Phase 0 contract described the fold as vowel substitution (`aa→a`, `ee→i`, `oo→u`, drop trailing
`-a`). Measured against all 8,695 seeded aliases, those rules scored **2/5 on their own stated
examples** — they miss the headline case `welder/waelder/velder`, and also `mistri/mistry` and
`driver/draiver`. The shipped implementation is a **consonant skeleton**, which scores 5/5 for a
measured collision cost of 0.9% (37 keys shared by 75 of 8,695 texts, most of them foldings we want:
`glazier|glazer`, `waitress|waiters`, `brakes man|breaks man`). The signature is unchanged; the doc
comment on the function carries the full reasoning.
