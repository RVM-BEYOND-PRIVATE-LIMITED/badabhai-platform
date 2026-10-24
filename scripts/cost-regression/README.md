# Cost regression — nine profiling runs

Recorded baseline for the profiling cost work. No live model calls, no spend:
everything here is measured data from the October token audit (111 provider
calls across 9 scripted runs, one fictional persona throughout).

## Files

- `token_audit_calls.csv` — one row per provider call, exact audit header.
- `token_audit_calls_extended.csv` — same rows plus pricing, ledger and
  reply-visibility columns. This is what the checker reads.
- `check_cost_regression.py` — validates the data and prints the per-flow
  cost table plus the Done-means checklist.

## Run it

```bash
python scripts/cost-regression/check_cost_regression.py
python scripts/cost-regression/check_cost_regression.py --strict
```

Default mode gates only on data integrity (shape, no blanks, pricing maths),
so it stays green while fixes land. It prints the checklist as information.
`--strict` also gates on the checklist rows — use it once the fixes it
measures are armed.
