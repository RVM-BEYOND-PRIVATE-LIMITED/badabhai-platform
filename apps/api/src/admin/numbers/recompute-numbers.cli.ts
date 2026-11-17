/**
 * #2755 item 4 — the LOGGED RECOMPUTE of the numbers screen's weekly snapshot.
 *
 *   pnpm --filter @badabhai/api build
 *   node apps/api/dist/admin/numbers/recompute-numbers.cli.js \
 *     --from <week> --to <week> --reason "<why, in your own words>" [--apply]
 *
 * WHY. A frozen week of `numbers_weekly` never changes under the nightly sweep. When a definition
 * changes (a bumped `NUMBERS_DEFINITION_VERSION`, a new city in a group) or a source is repaired,
 * this recomputes the span from the source tables, frozen weeks included, and records the run.
 *
 * DRY RUN BY DEFAULT: it prints, per metric, how many stored cells the recompute would add, remove
 * or change, and writes nothing. `--apply` rewrites the weeks, re-freezes the ones past their
 * freeze time, and writes ONE `numbers_recompute_log` row, all in one transaction. Weeks are
 * Mondays (`yyyy-mm-dd`), from the baseline to the current week, at most 104 per run.
 *
 * THE REASON is stored in the log row only: never printed, never logged, never put on an event.
 * The run prints metric ids, counts and the log row's id, nothing else.
 *
 * TARGET SAFETY: the shared ops guard — a write to a production-like database needs
 * `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=recompute-numbers`.
 * `NUMBERS_FREEZE_AFTER_DAYS` is read as the API reads it (default 3), so a re-freeze lands where
 * the sweep's would.
 */
import type { ServerConfig } from "@badabhai/config";
import { createDbClient, enforceOpsGuard } from "@badabhai/db";
import { AdminEventsRepository } from "../admin-events.repository";
import { NumbersSnapshotService } from "./numbers-snapshot.service";
import { NumbersWeeklyRepository } from "./numbers-weekly.repository";
import {
  RECOMPUTE_NUMBERS_SCRIPT,
  parseRecomputeNumbersArgs,
  recomputeNumbers,
} from "./recompute-numbers";

/** `NUMBERS_FREEZE_AFTER_DAYS` from the environment, as the config parses it (else the default). */
export function freezeDaysFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("NUMBERS_FREEZE_AFTER_DAYS must be a whole number of at least 1, or empty");
  }
  return n;
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseRecomputeNumbersArgs(argv);
  const { connectionString } = enforceOpsGuard({
    script: RECOMPUTE_NUMBERS_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: args.apply,
  });
  const client = createDbClient(connectionString, { max: 3 });
  try {
    const repo = new NumbersWeeklyRepository(client.db, new AdminEventsRepository(client.db));
    const snapshot = new NumbersSnapshotService(repo, {
      NUMBERS_FREEZE_AFTER_DAYS: freezeDaysFromEnv(process.env.NUMBERS_FREEZE_AFTER_DAYS),
    } as unknown as ServerConfig);
    await recomputeNumbers({ repo, snapshot, log: (line) => console.log(line) }, args);
    return 0;
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // The error's own text only: argv (and so the reason) is never echoed.
      console.error(
        `[${RECOMPUTE_NUMBERS_SCRIPT}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
