import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";

/**
 * A capturing Drizzle stub that records the SQL and bound parameters a repository actually
 * produces — used by the admin read tests to assert on the QUERY rather than on fixture rows.
 *
 * ── WHY THIS EXISTS AS A SHARED HELPER, AND WHY IT LOOKS LIKE THIS ──────────────────────
 * Three admin test files grew their own copy, and two of them were subtly WRONG in the same
 * way: they passed each projected value straight to `dialect.sqlToQuery(...)`. A bare Drizzle
 * COLUMN is not an `SQL` object — rendering one throws `sql2.toQuery is not a function` — and
 * the copies swallowed that in a `try/catch`. The projections were therefore never captured
 * at all, which made every "this column must not be selected" assertion **vacuously true**.
 *
 * Measured, not suspected: adding `fullName: workers.fullName` to the faceless worker
 * projection SURVIVED `admin-entities.repository.test.ts` completely. (It was still caught,
 * by the source-scanning build-blocker — but one of the two layers was doing nothing.)
 *
 * The fix is one line: wrap every captured value in `sql\`${value}\`` first, which renders a
 * column, a fragment or a literal alike. This helper is the single correct copy.
 */

const dialect = new PgDialect();

export interface CapturedQuery {
  /** The stubbed Drizzle database to hand a repository. */
  db: Database;
  /** Every rendered SQL string: projections, WHERE clauses, ORDER BY. */
  statements: string[];
  /** Every bound parameter, in capture order. */
  params: unknown[];
  /** All statements joined — convenient for `toContain` assertions. */
  sql: () => string;
  /** The rows the stub resolves with. Default empty; set to exercise a mapper. */
  rows: unknown[];
}

export function captureQueries(rows: unknown[] = []): CapturedQuery {
  const statements: string[] = [];
  const params: unknown[] = [];

  const capture = (value: unknown) => {
    if (value === undefined) return;
    // The load-bearing line: wrap FIRST. A bare column throws when rendered directly, and
    // swallowing that throw is what made the original copies vacuous.
    const rendered = dialect.sqlToQuery(sql`${value as SQL}`);
    statements.push(rendered.sql);
    params.push(...rendered.params);
  };

  const chain: Record<string, unknown> = {
    /**
     * CAPTURED, not ignored (BP-5). A repository's SOURCE is as much a property of the read as
     * its projection: "this aggregate reads `platform_ai_cost_totals`, never
     * `worker_ai_cost_totals`" is a correctness claim (the worker table cannot see payer-side
     * spend), and it is unassertable if the FROM clause is thrown away. Drizzle's `sql`
     * template renders a `Table` as its quoted name and a `Subquery` as its whole body, so this
     * also brings a `DISTINCT ON` subquery's ORDER BY into the captured text.
     */
    from: (src: unknown) => {
      capture(src);
      return chain;
    },
    innerJoin: () => chain,
    leftJoin: () => chain,
    groupBy: (...args: unknown[]) => {
      args.forEach(capture);
      return chain;
    },
    where: (w: unknown) => {
      capture(w);
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      args.forEach(capture);
      return chain;
    },
    limit: async () => rows,
    /**
     * Name this select as a SUBQUERY, so the caller can `from(sub)` and project `sub.column`.
     *
     * The real drizzle `.as()` returns a subquery whose column properties are aliased columns.
     * Here they are rendered fragments — a Proxy is used because the stub does not know the
     * projection's key set at this point, and a fixed object would silently yield `undefined`
     * (which `capture` skips) for any column the test did not anticipate: a vacuous pass.
     */
    as: (alias: string) =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== "string") return undefined;
            const column = prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
            return sql.raw(`"${alias}"."${column}"`);
          },
        },
      ),
    then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
  };

  const db = {
    select: (projection?: Record<string, unknown>) => {
      if (projection) Object.values(projection).forEach(capture);
      return chain;
    },
    /**
     * `DISTINCT ON (...)` — the form `CURRENT_PROFILE_ORDER` is designed to be the tail of.
     * Both the DISTINCT-ON expressions and the projection are captured, so a read that silently
     * lost its per-worker dedup shows up as a missing fragment rather than as a passing test.
     */
    selectDistinctOn: (on: unknown[], projection?: Record<string, unknown>) => {
      on.forEach(capture);
      if (projection) Object.values(projection).forEach(capture);
      return chain;
    },
  } as unknown as Database;

  return { db, statements, params, sql: () => statements.join(" | "), rows };
}

/**
 * Assert that none of `columns` appears in the captured SQL.
 *
 * Only meaningful because `captureQueries` records projections — with the old helper this
 * assertion could not fail. Takes SNAKE_CASE database column names, which is what the
 * rendered SQL contains.
 */
export function expectColumnsAbsent(captured: CapturedQuery, columns: string[]): void {
  const found = columns.filter((c) => captured.sql().includes(c));
  if (found.length > 0) {
    throw new Error(
      `these columns reached the query but must never be selected: ${found.join(", ")}\n` +
        `SQL: ${captured.sql()}`,
    );
  }
}
