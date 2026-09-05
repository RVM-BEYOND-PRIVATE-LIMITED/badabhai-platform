/**
 * Multi-row write chunking for the corpus seeders.
 *
 * EXTRACTED BECAUSE THE THIRD CALLER ARRIVED. `seed-job-domains.ts` and
 * `seed-domain-skills.ts` each carried a private `chunked` with a byte-identical body;
 * `seed-question-packs.ts` was about to be the third copy, which is the point at which
 * duplication starts costing something (CLAUDE.md §17). Nothing about the split is clever
 * — it is the same four lines, in one place.
 *
 * `chunkSizeForColumns` is the half that is NOT a convenience. A chunk size is not a free
 * parameter: the extended query protocol carries a Bind message's parameter count in an
 * INT16, so ONE statement may bind at most 65535 values, and a multi-row INSERT binds
 * (rows × columns) of them. Crossing the line is not graceful degradation — the server
 * rejects the whole statement — and it is invisible until either the corpus or the
 * `--batch-size` flag grows past it. `parseCommonCli` accepts `--batch-size` up to 10000,
 * which is already over the ceiling for anything wider than six columns, so a caller must
 * derive its chunk from its OWN column count instead of trusting the operator's number.
 * The flag stays an upper bound (it is how an operator throttles a slow link); it just
 * stops being the only bound.
 */

/** Split `rows` into consecutive chunks of at most `size`, preserving order. */
export function chunked<T>(rows: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunked: size must be a positive integer, got ${String(size)}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Postgres' hard ceiling on bound parameters in one statement — INT16 in the Bind message. */
export const PG_MAX_BIND_PARAMS = 65535;

/**
 * Parameters a statement spends on things that are NOT per-row values: an
 * `ON CONFLICT ... SET` clause binding a timestamp, a `WHERE` tail, a `RETURNING` filter.
 * Deliberately generous and deliberately not modelled — the goal is that the ceiling is
 * never approached closely enough for the exact figure to matter.
 */
const STATEMENT_PARAM_HEADROOM = 64;

/**
 * The largest chunk a multi-row statement of `columnsPerRow` bound values may use.
 *
 * Returns at least 1 even when a SINGLE row would exceed the ceiling (a >65471-column
 * statement). That case is unreachable for any table in this schema and clamping cannot
 * rescue it anyway — it would need splitting by column, not by row — so it fails at the
 * server with Postgres' own message rather than being disguised here as a chunk size of 0
 * that silently writes nothing.
 */
export function chunkSizeForColumns(requested: number, columnsPerRow: number): number {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`chunkSizeForColumns: requested must be a positive integer, got ${String(requested)}`);
  }
  if (!Number.isInteger(columnsPerRow) || columnsPerRow < 1) {
    throw new Error(
      `chunkSizeForColumns: columnsPerRow must be a positive integer, got ${String(columnsPerRow)}`,
    );
  }
  const ceiling = Math.floor((PG_MAX_BIND_PARAMS - STATEMENT_PARAM_HEADROOM) / columnsPerRow);
  return Math.max(1, Math.min(requested, ceiling));
}
