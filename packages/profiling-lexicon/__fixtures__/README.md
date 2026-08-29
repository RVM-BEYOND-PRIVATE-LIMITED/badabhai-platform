# Dual-language parity fixtures

`utterances.jsonl` is the golden corpus: real Hinglish worker utterances with the detector
output both implementations must produce.

> ## ⚠ DO NOT EDIT `utterances.jsonl`. It is GENERATED.
>
> Add your case to the `FAMILIES` list in
> **`apps/ai-service/scripts/build_lexicon_corpus.py`**, then run it:
>
> ```
> apps/ai-service/.venv/Scripts/python.exe scripts/build_lexicon_corpus.py
> ```
>
> **This warning is the fix for a real incident (R14).** The section below documents the record
> shape and says "adding, renaming or changing a case turns the other side red" — and for two
> packets it named no generator at all, so it read as an instruction to edit the file. Six rows
> were appended straight to the JSONL: the only six that could tell a guarded salary build from
> an unguarded one. Running the documented regeneration command deleted all six plus two pinned
> gaps, and every suite stayed green afterwards, because the rows that could have gone red no
> longer existed.
>
> The generator now refuses to write when a committed case exists in no family, so the delete
> cannot happen silently any more. This paragraph exists because a guard that fires is still a
> worse outcome than not being pointed at the wrong file.
>
> `occupation-normalization.jsonl`, in this same directory, is hand-maintained and has no
> generator — which is exactly why the distinction has to be written down rather than inferred
> from where a file lives.

**Both suites assert against this one file.** The Vitest suite in this package and the pytest
suite in `apps/ai-service/tests/` read it. Adding, renaming or changing a case turns the other
side red — which is the point. Same mechanism as
`packages/ai-contracts/src/__fixtures__/profiling.keys.json` + `test_contract_parity.py`.

## Record shape

One JSON object per line, so a corpus update is a line-diffable review:

```json
{"id": "exp_001", "text": "7 saal se silai kar raha hoon", "cls": "answer", "values": {"experience_years": 7}}
{"id": "neg_004", "text": "abhi kaam nahi mil raha", "cls": "answer", "values": {}, "note": "must NOT yield availability=immediate"}
{"id": "dk_002", "text": "pata nahi bhai", "cls": "dont_know", "values": {}}
```

- `id` — stable, referenced by failure output.
- `text` — the worker's line, verbatim. **Pseudonymized before it lands here.**
- `cls` — expected `UtteranceClass`.
- `values` — expected normalizer output. Absent key = the normalizer must return null.
- `note` — why this case exists. Required for regression cases.

## Coverage requirement

Phase 3 lands ≥300 cases. The negation cases are the ones that matter most: every value
normalizer needs at least one case proving a negated cue does **not** fire.

Populated in Phase 3. Empty until then.
