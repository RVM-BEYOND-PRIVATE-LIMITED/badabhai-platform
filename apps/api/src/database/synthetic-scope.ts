import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";

/**
 * #2967 — THE SYNTHETIC RUN'S SCOPE: one database transaction that every query of the run joins,
 * and that is ALWAYS rolled back.
 *
 * The daily synthetic run walks the real posting → reach → application → contact flow through the
 * real services, in-process, on accounts it creates itself. To leave nothing behind — no posting a
 * real worker could see, no job Campus could list, no credit, no event — the whole walk runs inside
 * ONE transaction that is rolled back at the end. Every other session sees none of it, ever.
 *
 * HOW THE SERVICES JOIN IT. The `DATABASE` provider is {@link scopedDatabase}: a proxy over the
 * pool that, ONLY inside {@link runRolledBack}, forwards every property to the run's transaction
 * (a service's own `db.transaction(...)` becomes a savepoint inside it). Outside a run the proxy is
 * the pool, exactly as before: no request, job or processor is ever in a scope, because only
 * `runRolledBack` enters one (pinned by `synthetic-scope.static.test.ts`).
 *
 * AFTER THE RUN, THE SCOPE IS CLOSED, NOT DROPPED. Work the run started that outlives it (a
 * fire-and-forget write) still carries the scope; any query from it then throws
 * {@link SyntheticScopeClosedError} instead of falling back to the pool, so a synthetic id can never
 * be written for real.
 *
 * RVM. The run's Campus student is answered from the scope ({@link syntheticStudentFor}), so the
 * walk never calls RVM's Student API; any other student ref is read from RVM as always.
 */

/** What RVM's Student API would answer for the run's own student (`RvmStudentRead`'s shape). */
export interface SyntheticStudent {
  readonly name: string;
  readonly phone: string;
  readonly course: string;
  readonly branch: string;
  readonly status: "current_student" | "alumnus";
  readonly test_score: number | null;
}

interface Scope {
  readonly tx: Database;
  open: boolean;
  readonly students: ReadonlyMap<string, SyntheticStudent>;
}

const storage = new AsyncLocalStorage<Scope>();

export class SyntheticScopeClosedError extends Error {
  constructor() {
    super("synthetic run scope closed: work started by a synthetic run outlived it");
    this.name = "SyntheticScopeClosedError";
  }
}

/** Thrown inside the transaction to roll it back while carrying the run's result out. */
class RollBack<T> extends Error {
  constructor(readonly value: T) {
    super("synthetic run: rolled back by design");
  }
}

/**
 * The `DATABASE` provider's value: the pool, or the run's transaction while inside a run. Methods
 * are invoked with the proxy as `this`, so drizzle's own `this.session` reads route the same way.
 */
export function scopedDatabase(db: Database): Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const scope = storage.getStore();
      if (scope === undefined) return Reflect.get(target, prop, receiver);
      if (!scope.open) throw new SyntheticScopeClosedError();
      return Reflect.get(scope.tx, prop, scope.tx);
    },
  });
}

/** Is the current async context inside an open synthetic run? */
export function inSyntheticRun(): boolean {
  return storage.getStore()?.open === true;
}

/** The run's own Campus student for this ref, or undefined (outside a run, or another ref). */
export function syntheticStudentFor(studentRef: string): SyntheticStudent | undefined {
  const scope = storage.getStore();
  if (scope === undefined || !scope.open) return undefined;
  return scope.students.get(studentRef.toLowerCase());
}

/** Bounds on the one transaction, so a stuck step can never hold a lock for long. */
export const SYNTHETIC_STATEMENT_TIMEOUT_MS = 20_000;
export const SYNTHETIC_LOCK_TIMEOUT_MS = 3_000;

/**
 * Run `fn` inside one transaction that is ALWAYS rolled back, with every query through the
 * `DATABASE` proxy joining it. Returns what `fn` returned; rethrows what it threw (also rolled back).
 * `pool` must be the raw pool (`DB_CLIENT.db`), never the proxy. A run inside a run is refused.
 */
export async function runRolledBack<T>(
  pool: Database,
  students: ReadonlyMap<string, SyntheticStudent>,
  fn: () => Promise<T>,
): Promise<T> {
  if (storage.getStore() !== undefined) throw new Error("synthetic run: already inside a run");
  try {
    await pool.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${SYNTHETIC_STATEMENT_TIMEOUT_MS}`));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${SYNTHETIC_LOCK_TIMEOUT_MS}`));
      const scope: Scope = { tx: tx as unknown as Database, open: true, students };
      let value: T;
      try {
        value = await storage.run(scope, fn);
      } finally {
        scope.open = false;
      }
      throw new RollBack(value);
    });
  } catch (err) {
    if (err instanceof RollBack) return err.value as T;
    throw err;
  }
  throw new Error("synthetic run: the transaction committed"); // unreachable
}
