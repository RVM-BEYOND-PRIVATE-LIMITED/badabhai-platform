# Lexicon data

The JSON both languages read. `signals.py` loads these; `src/` loads these. One source.

Populated in Phase 3 by extraction from `apps/ai-service/app/profiling/signals.py`:

| File | Holds |
| ---- | ----- |
| `particles.json` | Indian occupational particles the normalizer strips (`wala`, `ka kaam`, …) |
| `cities.json` | `KNOWN_CITIES` + `CITY_ALIASES` (already shared with `pseudonymize.py`) |
| `states.json` | States and regions |
| `trades.json` | Role / machine / controller / skill keyword tables with spelling variants |
| `predicates.json` | Cue lists for don't-know, correction, hardship, abuse, question-back |
| `negation.json` | Negator tokens and the veto window |
| `crosswalk.json` | RFS field id -> `WorkerProfileDraft` path |

**Regex sources in these files must use the JS/Python-common subset — explicit character
classes, never `\d` or `\w`.** JS `\d` is ASCII-only; Python's is Unicode-aware. A `\d` here
means the two readers disagree on Devanagari digits.
