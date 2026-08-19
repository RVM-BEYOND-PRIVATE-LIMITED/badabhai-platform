/**
 * Prove the `unresolved_phrase` write path works against the LIVE schema — without leaving a row.
 *
 * ===========================================================================
 * WHY THIS IS A COMMITTED TOOL AND NOT AN AD-HOC QUERY
 * ===========================================================================
 * Migration 0078 was reported applied twice before it was. `db:audit:schema-contract` closed
 * half of that gap by asking whether the OBJECTS exist. This closes the other half: whether the
 * objects, together, still admit the writes the deployed code performs and still refuse the ones
 * it must never perform. Those are different questions, and the second one has a failure mode
 * the first cannot see — an index of the right name and the wrong SHAPE silently MERGES two
 * canonical misses that belong in separate rows, which is exactly what widening the key in 0078
 * existed to prevent. Presence checks report that state as healthy.
 *
 * ===========================================================================
 * WHY IT IS SAFE TO POINT AT PRODUCTION
 * ===========================================================================
 * Every statement runs inside ONE transaction that CANNOT commit. The callback throws
 * {@link RollbackSignal} as its last act, unconditionally, and the driver turns that into a
 * ROLLBACK; the signal is caught outside and discarded. There is no `--apply`, no branch that
 * skips the throw, and no code path that reaches COMMIT — the rollback is structural rather than
 * a flag someone can forget. The probe then RE-COUNTS on a fresh statement after the transaction
 * has ended and fails loudly if the count moved, so "nothing was written" is verified rather
 * than asserted.
 *
 * The probe phrases carry a random suffix, so they cannot collide with a real queued phrase and
 * cannot inflate a real row's `count` even inside the doomed transaction.
 *
 * It still takes ordinary row locks for the life of the transaction (milliseconds, on rows it
 * created itself) and consumes a few UUIDs. That is the entire footprint.
 *
 *   pnpm db:verify:unresolved-write            # report
 *   pnpm db:verify:unresolved-write --json=<p> # + an evidence record
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import { opsGuard } from "./ops-guard";

config({ path: join("..", "..", ".env") });

const SCRIPT = "verify:unresolved-write";

/** Thrown to force the ROLLBACK. Never escapes {@link main}. */
export class RollbackSignal extends Error {
  constructor() {
    super("verify:unresolved-write — deliberate rollback");
    this.name = "RollbackSignal";
  }
}

export interface ProbeResult {
  /** Stable id, used in the report and in tests. */
  readonly id: string;
  /** What the write path must do, in one line. */
  readonly expectation: string;
  readonly passed: boolean;
  /** Only on failure — what actually happened. */
  readonly detail?: string;
}

/**
 * The five properties, and why each one is here rather than covered by a presence check.
 *
 * Ordered so a reader meets the load-bearing one (`distinct-job-domains`) having already seen
 * the two inserts it depends on.
 */
export const PROBE_EXPECTATIONS: Readonly<Record<string, string>> = {
  "legacy-insert": "a legacy-scoped miss (domain_id set) inserts — the only path live today",
  "canonical-insert": "a canonical-scoped miss (job_domain_id set) inserts — what 0078 is for",
  "occupation-insert": "an occupation-scoped miss (both NULL) inserts — legal since 0070",
  "both-scopes-refused": "a row carrying BOTH ids is refused by unresolved_phrase_one_domain_chk",
  "repeat-increments": "the same canonical miss again increments count rather than inserting",
  "distinct-job-domains":
    "the SAME phrase in two DIFFERENT job domains stays two rows — the reason the unique key was widened",
  "nothing-committed": "the row count is identical after the transaction ends",
};

/**
 * The message that actually says what went wrong.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose `message` is the SQL TEXT, so
 * reporting `e.message` prints the statement back at the reader and hides the reason — a CHECK
 * violation, a full pooler and an aborted transaction all render identically. The cause carries
 * the Postgres message and its SQLSTATE.
 */
export function causeOf(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string; code?: string } };
  const cause = err?.cause?.message;
  if (cause) return err.cause?.code ? `${cause} [${err.cause.code}]` : cause;
  return (err?.message ?? String(e)).split("\n")[0] ?? String(e);
}

/**
 * The single number a `SELECT count(*)` returned.
 *
 * `noUncheckedIndexedAccess` is on, and rightly so here: an empty result would otherwise
 * destructure to `undefined` and compare unequal to itself, turning a query that returned
 * nothing into a silent "the count changed". Throwing is the correct answer — a counting query
 * that yields no row means the probe cannot make its claim.
 */
export function scalar<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`[${SCRIPT}] ${what} returned no row`);
  return row;
}

/** True when every probe passed. Pure, so the exit-code decision is testable. */
export function allPassed(results: readonly ProbeResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}

/** One line per probe, aligned. Pure. */
export function formatResults(results: readonly ProbeResult[]): string[] {
  const width = Math.max(0, ...results.map((r) => r.id.length));
  return results.flatMap((r) => {
    const head = `  ${r.passed ? "PASS" : "FAIL"}  ${r.id.padEnd(width)}  ${r.expectation}`;
    return r.detail === undefined ? [head] : [head, `        ${" ".repeat(width)}  -> ${r.detail}`];
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArg = argv.find((a) => a.startsWith("--json="));
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  // `mutating: false` is the honest declaration: the transaction cannot commit, so this run
  // has no net effect on any row. The banner below says what it does anyway, because "writes
  // inside a doomed transaction" is not what a reader assumes from "read-only".
  const verdict = opsGuard({
    script: SCRIPT,
    connectionString: url,
    nodeEnv: process.env["NODE_ENV"],
    allowEnv: process.env["OPS_ALLOW_PRODUCTION"],
    argv,
    mutating: false,
  });
  if (verdict.warning) console.log(verdict.warning);
  console.log(`[${SCRIPT}] WRITE-SHAPED PROBE inside a transaction that CANNOT commit.`);
  console.log(`  target = ${hostClass(url)}`);

  const { db, sql } = createDbClient(url, { max: 1 });
  const results: ProbeResult[] = [];
  const add = (id: string, passed: boolean, detail?: string): void => {
    results.push({ id, expectation: PROBE_EXPECTATIONS[id] ?? id, passed, ...(detail ? { detail } : {}) });
  };

  try {
    const { n: before } = scalar(
      (await db.execute(dsql`SELECT count(*)::int AS n FROM unresolved_phrase`)) as unknown as {
        n: number;
      }[],
      "the pre-probe row count",
    );

    // Two REAL job domains — the column has an FK, so a fabricated id would fail for the wrong
    // reason and read as "0078 is broken".
    const domains = (await db.execute(
      dsql`SELECT job_domain_id FROM job_domain ORDER BY job_domain_id LIMIT 2`,
    )) as unknown as { job_domain_id: string }[];
    if (domains.length < 2) {
      throw new Error(`[${SCRIPT}] need 2 job_domain rows to test the widened key; found ${domains.length}`);
    }
    const [jdA, jdB] = [domains[0]!.job_domain_id, domains[1]!.job_domain_id];
    const probe = `zz-probe-${randomUUID()}`;

    try {
      await db.transaction(async (tx) => {
        const ins = async (
          scope: string,
          domainId: string | null,
          jobDomainId: string | null,
          phrase = probe,
        ): Promise<void> => {
          await tx.execute(
            dsql`INSERT INTO unresolved_phrase (phrase, lang, domain_id, job_domain_id, scope)
                 VALUES (${phrase}, 'en', ${domainId}, ${jobDomainId}, ${scope})
                 ON CONFLICT (scope, phrase, domain_id, job_domain_id, lang)
                 DO UPDATE SET count = unresolved_phrase.count + 1, last_seen = now()`,
          );
        };

        const attempt = async (id: string, fn: () => Promise<void>): Promise<void> => {
          try {
            await fn();
            add(id, true);
          } catch (e) {
            add(id, false, causeOf(e));
          }
        };

        await attempt("legacy-insert", () => ins("skill", "cnc-machining", null, `${probe}-legacy`));
        await attempt("canonical-insert", () => ins("skill", null, jdA));
        await attempt("occupation-insert", () => ins("occupation", null, null, `${probe}-occ`));

        // The CHECK must REFUSE this one, so the pass condition is inverted: an error is the
        // correct outcome and silence is the failure.
        //
        // INSIDE A SAVEPOINT, and that is not tidiness. A failed statement puts a Postgres
        // transaction into the aborted state, where EVERY later statement errors with 25P02 —
        // so without this nesting the two probes after it would fail for a reason that has
        // nothing to do with what they test, and the report would blame the schema for the
        // probe's own bug. `tx.transaction` issues a SAVEPOINT / ROLLBACK TO, which confines
        // the abort to this one statement.
        try {
          await tx.transaction(async (sp) => {
            await sp.execute(
              dsql`INSERT INTO unresolved_phrase (phrase, lang, domain_id, job_domain_id, scope)
                   VALUES (${`${probe}-both`}, 'en', 'cnc-machining', ${jdA}, 'skill')`,
            );
          });
          add("both-scopes-refused", false, "the INSERT was ACCEPTED — the CHECK is missing or wrong");
        } catch (e) {
          const msg = causeOf(e);
          const byTheRightCheck = /one_domain_chk/i.test(msg);
          add(
            "both-scopes-refused",
            byTheRightCheck,
            byTheRightCheck ? undefined : `refused, but not by the expected CHECK: ${msg}`,
          );
        }

        // Repeat the canonical row: the upsert must find it and increment.
        await attempt("repeat-increments", async () => {
          await ins("skill", null, jdA);
          const { c } = scalar(
            (await tx.execute(
              dsql`SELECT count::int AS c FROM unresolved_phrase
                   WHERE phrase = ${probe} AND job_domain_id = ${jdA}`,
            )) as unknown as { c: number }[],
            "the repeated canonical row",
          );
          if (c !== 2) throw new Error(`count is ${c}, expected 2 — the upsert did not match its own row`);
        });

        // THE ONE THAT PRESENCE CHECKS CANNOT SEE. Under the pre-0078 four-column key these two
        // collide (both have domain_id NULL) and merge into a single row with count 2.
        await attempt("distinct-job-domains", async () => {
          await ins("skill", null, jdB);
          const { n } = scalar(
            (await tx.execute(
              dsql`SELECT count(*)::int AS n FROM unresolved_phrase WHERE phrase = ${probe}`,
            )) as unknown as { n: number }[],
            "the two-job-domain row count",
          );
          if (n !== 2) {
            throw new Error(
              `${n} row(s) for one phrase across two job domains, expected 2 — the unique key is NOT widened`,
            );
          }
        });

        throw new RollbackSignal();
      });
    } catch (e) {
      if (!(e instanceof RollbackSignal)) throw e;
    }

    // On a statement AFTER the transaction ended. This is the assertion that makes the safety
    // claim verified rather than asserted.
    const { n: after } = scalar(
      (await db.execute(dsql`SELECT count(*)::int AS n FROM unresolved_phrase`)) as unknown as {
        n: number;
      }[],
      "the post-probe row count",
    );
    add(
      "nothing-committed",
      before === after,
      before === after ? undefined : `row count moved ${before} -> ${after}; THE ROLLBACK DID NOT HOLD`,
    );

    console.log("");
    for (const line of formatResults(results)) console.log(line);
    const ok = allPassed(results);
    console.log(`\n  unresolved_phrase write path = ${ok ? "HEALTHY" : "BROKEN"}  (rows before/after ${before}/${after})`);
    if (!ok) process.exitCode = 1;

    if (jsonArg !== undefined) {
      const path = jsonArg.slice("--json=".length);
      if (existsSync(path)) {
        console.error(`  refusing to overwrite ${path} — evidence is never replaced.`);
        process.exitCode = 1;
        return;
      }
      writeFileSync(
        path,
        `${JSON.stringify(
          { kind: "unresolved-write-probe", target: hostClass(url), rowsBefore: before, rowsAfter: after, healthy: ok, results },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`  evidence written to ${path}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    // The CAUSE, not just the wrapper. Drizzle's `DrizzleQueryError` message is the SQL text,
    // so printing `e.message` alone turns "the pooler is full" into a mute failed query and
    // sends the reader looking at their statement instead of at the connection.
    const err = e as { message?: string; cause?: { message?: string } };
    console.error(err?.message ?? String(e));
    if (err?.cause?.message) console.error(`  cause: ${err.cause.message}`);
    process.exit(1);
  });
}
