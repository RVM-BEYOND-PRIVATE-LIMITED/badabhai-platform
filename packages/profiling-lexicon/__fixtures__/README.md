# Dual-language parity fixtures

`utterances.jsonl` is the golden corpus: real Hinglish worker utterances with the detector
output both implementations must produce.

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
