import { Logger } from "@nestjs/common";

/** Postgres `undefined_table`: `worker_search_exits` does not exist (migration 0168 not applied). */
export const PG_UNDEFINED_TABLE = "42P01";

const logger = new Logger("SearchExit");
let warned = false;

/**
 * #2753 item 6 — SEARCH_EXIT_ENABLED is on and `worker_search_exits` is missing: the reader FAILS
 * OPEN (nobody can have left search without the table, since the write needs it). Logged ONCE per
 * process, whichever reader meets it first, so a deploy-order slip is visible without a line per
 * search or per unlock. Names the table and the code only.
 */
export function warnSearchExitsTableMissingOnce(surface: "search" | "unlock"): void {
  if (warned) return;
  warned = true;
  logger.warn(
    `worker_search_exits is missing (sqlstate=${PG_UNDEFINED_TABLE}, first seen by ${surface}) ` +
      `with SEARCH_EXIT_ENABLED on: failing open (everyone visible) until migration 0168 is applied`,
  );
}
