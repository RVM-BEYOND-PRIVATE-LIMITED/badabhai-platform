# Lexicon data — the canonical source

The JSON both languages read. **This directory is the source of truth.**

`apps/ai-service/app/profiling/lexicon_data/` holds a byte-identical **committed mirror**, because
the ai-service image cannot see this directory (see [Why a mirror](#why-a-mirror) below).
Never hand-edit the mirror: run `pnpm lexicon:sync` and commit what it writes.

| File | Holds | Extracted in |
| ---- | ----- | ------------ |
| `negation.json` | Negator tokens, tag-negator rules, clause splitting, the veto window, negatable topic cues | Phase 3 |
| `predicates.json` | Cue patterns for don't-know, hardship, question-back, abuse, correction | Phase 3 |
| `skills.json` | The `_SKILLS` keyword → label → taxonomy-id table | Phase 3 |
| `particles.json` | Indian occupational particles the normalizer strips (`wala`, `ka kaam`, …) | Phase 1 (Divyanshu) |
| `cities.json` | `KNOWN_CITIES` + `CITY_ALIASES` | Phase 3 (values slice) |
| `states.json` | States, abbreviations and multi-state regions | Phase 3 (values slice) |
| `trades.json` | Role / machine / controller keyword tables with spelling variants | Phase 3 (values slice) |
| `crosswalk.json` | RFS field id → `WorkerProfileDraft` path | Phase 7 |

## Why a mirror

`apps/ai-service/Dockerfile` builds from the `apps/ai-service` **context only** — `packages/` is not
in the build context at all, and the Dockerfile header states the package "reads nothing outside
itself". A runtime `Path(__file__).parents[3] / "packages" / …` read works on a developer laptop and
in CI, then `ImportError`s on boot in staging and production.

`apps/ai-service/tests/test_contract_parity.py` gets away with exactly that path only because tests
are never copied into the image. `signals.py` is runtime code, so it cannot.

Two gates make the duplication safe, and they run in **different CI jobs on purpose** — the node job
sees `packages/**`, the ai-service job sees `apps/ai-service/**`, so whichever side a change touches,
at least one gate fires:

| Gate | Runs in | Fails when |
| ---- | ------- | ---------- |
| `pnpm lexicon:verify` | node job | the mirror differs from this directory |
| `tests/test_lexicon_parity.py` | ai-service job | same check, from the Python side |

`.github/workflows/ci.yml` also lists `packages/profiling-lexicon/**` in the **ai-service** path
filter, so editing canonical data runs pytest too. Without that line a lexicon-only change would
skip the entire Python suite and report green — the failure mode this repo has already shipped once.

## The common-regex-subset rule

Patterns in these files are compiled by **both** Python `re` and JavaScript `RegExp`. A pattern that
means different things in the two engines is the whole failure mode this package exists to prevent,
and it is silent: a detector that stops firing produces a slightly worse profile, not an error.

**Banned outright: `\d` and `\w`.** JS `\d` is ASCII-only; Python's is Unicode-aware and matches
Devanagari digits. `apps/api/src/skills/skills.dto.ts` documents this repo being bitten by exactly
that, and that "this boundary must not be looser than the upstream gate".

**Banned: `\b`.** It is *defined* in terms of `\w`, so it inherits the same divergence — Python sees
`है` as a word character and JavaScript does not. Use the `{WB}` / `{WE}` macros instead.

**Permitted: `\s`, `\S`.** Both engines agree on these for every character that occurs in worker
text. Called out explicitly so the rule reads as a decision rather than an oversight.

`tools/check-regex-subset` is not a separate script — the rule is asserted by
`src/internal/regex.test.ts` and `tests/test_lexicon_parity.py`, which walk every pattern in every
file and fail on a banned escape. A new file is covered automatically.

### Macros

Both loaders expand these to the identical source string before compiling. They exist so the JSON
stays readable *and* provably identical across the two engines.

| Macro | Expands to | Purpose |
| ----- | ---------- | ------- |
| `{WB}` | `(?<![`*word class*`])` | Leading word boundary |
| `{WE}` | `(?![`*word class*`])` | Trailing word boundary |
| `{SKILL_KEYWORDS}` | the `skills.json` keywords, regex-escaped, `\|`-joined, in file order | Keeps the negatable-skills cue from drifting out of the skills table |

The *word class* is ASCII alphanumerics + `_`, plus the Devanagari **letters and digits** —
**enumerated, not the whole U+0900–U+097F block**:

```
U+0904-U+0939  letters          WORD      U+0964-U+0965  DANDA + double danda   not word
U+093D         avagraha         WORD      U+0966-U+096F  digits                 WORD
U+0950         om               WORD      U+0970         abbreviation sign      not word
U+0958-U+0961  letters          WORD      U+0971         high spacing dot       WORD
U+0972-U+097F  letters          WORD      everything else in the block (marks)  not word
```

**The danda is why.** `।` ends a Hindi sentence the way `.` ends an English one, so it sits directly
after the tokens these detectors match. Python's `\w` is `str.isalnum()`-backed and excludes it, so
`\b` fires there. Taking the block wholesale makes it a *word* character, which kills the trailing
boundary — `idk।` and `kaam nahi mil raha।` both stop matching. Measured against the pre-extraction
patterns: 15 regressions, every one a danda.

Note this is a **different question** from `signals.py`'s `_dev()` helper, which brackets a
Devanagari token to stop it matching inside a longer one. That helper wants the whole block; a
boundary macro standing in for `\b` wants only the alphanumerics.

For scripts this corpus does not contain, the class is a deliberate narrowing of Python's
full-Unicode `\b`: a Tamil or Bengali character now counts as a boundary in *both* engines rather
than only in JavaScript. Narrowing toward agreement is the safe direction.

`{SKILL_KEYWORDS}` escapes only `. * + ? ^ $ ( ) { } [ ] | \` — every one a JS `SyntaxCharacter` and
a Python metacharacter. Space, `-` and `&` are deliberately **not** escaped: they are literal outside
a character class in both engines, and `\-` is a *SyntaxError* in a JavaScript `u`-mode pattern.
Python's `re.escape` does escape them, which is why the composed source is not byte-identical to the
string `signals.py` used to build inline — only semantically identical, which is what the parity
corpus asserts.

## Flags

Each pattern object carries `{ "source": ..., "flags": ... }`. Only `i` is used. The loaders map it
to `re.IGNORECASE` and the JS `i` flag. A pattern with `"flags": ""` is case-sensitive **on purpose**
— `states.json`'s two-letter abbreviations will rely on it, because a case-insensitive `up` would
swallow "set up".
