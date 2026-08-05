# GENERATED — do not edit

Byte-identical mirror of `packages/profiling-lexicon/data/`, which is the source of truth.

It exists because the ai-service image is built from the `apps/ai-service` context only, so
`packages/` does not exist at runtime in the container. See
`packages/profiling-lexicon/scripts/sync-mirror.mjs` for the full reasoning.

## Changing lexicon data

1. Edit the file under `packages/profiling-lexicon/data/`.
2. Run `pnpm lexicon:sync`.
3. Commit **both** directories in the same commit.

`pnpm lexicon:verify` and `apps/ai-service/tests/test_lexicon_parity.py` both fail if these
two directories disagree, so a half-committed change cannot merge.
