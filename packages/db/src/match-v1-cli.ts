/**
 * Matching V1 — shared CLI harness for the D1..D6 data scripts + the verifier.
 *
 * One place for the guards every one of them must honour, so a new script cannot
 * accidentally ship without them. Modelled on `retag-skills.ts` /
 * `reencrypt-pii-backfill.ts` (the repo's two existing BACKFILL runners), not on the
 * synthetic-fixture seeds.
 *
 * THE GUARDS
 *  1. DRY-RUN IS THE DEFAULT. Every mutating script plans and PRINTS, and writes nothing
 *     until `--apply`. There is no "it seemed fine so it wrote" path.
 *  2. PRODUCTION IS DECIDED BY THE TARGET, NOT BY A LABEL ON THE PROCESS. This used to read
 *     `NODE_ENV === "production"` plus a `MATCH_V1_PROD_CONFIRM` token, and neither half asked
 *     about the DATABASE. Two consequences, and the second is the one that cost something:
 *
 *       • a read-only DRY RUN was refused whenever the process was labelled production — and on
 *         this repository it always is, because `.env` sets it and dotenv loads it right above;
 *       • once the token was exported, `--apply` proceeded AGAINST ANY DATABASE. The token was
 *         the production key and it said nothing about the target, so it authorised a write to
 *         production and a write to a colleague's laptop with the same three words. And with
 *         NODE_ENV merely unset — a fresh clone, or CI — the whole check was skipped.
 *
 *     `opsGuard` classifies the CONNECTION STRING and requires two independent signals before a
 *     production write; NODE_ENV is kept as a second tripwire rather than as the authority.
 *     Matching V1 backfills ARE applied to production by hand
 *     (docs/ops/matching-v1-migration-runbook.md), so the point was never to refuse outright —
 *     it was to make it deliberate, and to make it about the right thing.
 *  3. DATABASE_URL must be set. No localhost fallback — a backfill that silently targets
 *     the wrong database is the failure mode this whole file exists to prevent.
 *     `enforceOpsGuard` owns that refusal now, and it refuses a DRY RUN too: "read-only" is a
 *     claim about a database nobody has identified.
 *
 * PRIVACY: these runners read `worker_profiles` signal columns, `jobs`, `job_postings`
 * and the skill vocabulary. They MUST NOT read or print phone, name, or any other PII —
 * every log line here is ids + counts. `printCounts` is the only logging helper for a
 * reason: keep it that way.
 */
import { config } from "dotenv";

import {
  enforceOpsGuard,
  PRODUCTION_WRITE_ENV,
  PRODUCTION_WRITE_FLAG,
} from "./ops-guard";

// Load the repo-root .env (CWD is packages/db when run via a package script).
config({ path: "../../.env" });

/**
 * RETIRED 2026-08-20. `MATCH_V1_PROD_CONFIRM=apply-matching-v1` was this harness's production
 * key; `opsGuard`'s two signals replace it.
 *
 * The name is kept, and {@link retiredConfirmTokenProblem} still looks for it, for one reason:
 * an operator following an older copy of the runbook would otherwise export it, see no
 * complaint, and then be refused for what reads like an unrelated reason. Silently ignoring a
 * retired security control is how somebody concludes the guard is broken and goes looking for a
 * way around it.
 */
export const RETIRED_PROD_CONFIRM_ENV = "MATCH_V1_PROD_CONFIRM";

/**
 * `null`, or the refusal for an operator still carrying the retired production key.
 *
 * Pure and exported so a test can drive it: the interesting property is not that the old
 * variable stops working, it is that it stops working LOUDLY, and only when it would have
 * mattered. Setting it during a dry run is harmless and says nothing. Setting it for an
 * `--apply` that is otherwise authorised is stale environment, and also says nothing — the run
 * is already legitimate. Setting it for an `--apply` that is NOT otherwise authorised is
 * somebody trying to unlock production with a key that no longer opens anything, and they need
 * to be told which key does.
 */
export function retiredConfirmTokenProblem(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  scriptName: string,
): string | null {
  if (env[RETIRED_PROD_CONFIRM_ENV] === undefined) return null;
  if (!argv.includes("--apply")) return null;
  if (argv.includes(PRODUCTION_WRITE_FLAG) && env[PRODUCTION_WRITE_ENV] === scriptName) return null;
  return (
    `[${scriptName}] ${RETIRED_PROD_CONFIRM_ENV} is set, and it no longer authorises anything. ` +
    `It was retired on 2026-08-20 because it keyed on NODE_ENV, which labels the PROCESS, while ` +
    `the blast radius is decided by DATABASE_URL. A production write now needs BOTH ` +
    `${PRODUCTION_WRITE_FLAG} on the command line and ${PRODUCTION_WRITE_ENV}=${scriptName} in ` +
    `the environment. Unset ${RETIRED_PROD_CONFIRM_ENV} and see ` +
    `docs/ops/matching-v1-migration-runbook.md.`
  );
}

export interface CommonCliOptions {
  /** True when `--apply` was passed. Everything else is a dry run. */
  apply: boolean;
  /** Rows per batch for the resumable backfills. */
  batchSize: number;
  /** `--start-after=<uuid>` — resume a batched backfill after this id. */
  startAfter: string | undefined;
  /** The validated DATABASE_URL. */
  databaseUrl: string;
}

/** Read a `--flag=value` argument. */
export function argValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/** Read a `--flag` boolean argument. */
export function argFlag(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

/**
 * Parse + validate the common options and enforce the guards. Throws (never exits
 * silently) so `main().catch` prints one clear failure.
 */
export function parseCommonCli(scriptName: string): CommonCliOptions {
  const apply = argFlag("apply");

  const retired = retiredConfirmTokenProblem(process.env, process.argv.slice(2), scriptName);
  if (retired !== null) throw new Error(retired);

  // THE TARGET DECIDES, NOT `NODE_ENV`. See the header. `enforceOpsGuard` also owns the
  // missing-DATABASE_URL refusal, so there is ONE place that answers "may this run touch the
  // database in front of it" rather than two that can drift apart.
  const { connectionString: databaseUrl } = enforceOpsGuard({
    script: scriptName,
    connectionString: process.env.DATABASE_URL,
    mutating: apply,
  });

  const rawBatch = argValue("batch-size");
  const batchSize = rawBatch === undefined ? 500 : Number.parseInt(rawBatch, 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error(`[${scriptName}] --batch-size must be an integer in 1..10000`);
  }

  const startAfter = argValue("start-after");
  if (startAfter !== undefined && !/^[0-9a-f-]{36}$/i.test(startAfter)) {
    throw new Error(`[${scriptName}] --start-after must be a uuid`);
  }

  return { apply, batchSize, startAfter, databaseUrl };
}

/** The banner every runner prints first, so a log always says which mode it ran in. */
export function printHeader(scriptName: string, opts: CommonCliOptions): void {
  console.log(
    `[${scriptName}] ${opts.apply ? "APPLY" : "DRY-RUN"} — batch=${opts.batchSize}` +
      (opts.startAfter ? ` start-after=${opts.startAfter}` : "") +
      (opts.apply ? "" : " (nothing will be written; re-run with --apply)"),
  );
}

/** Counts-only summary. Never log a row's contents — ids + integers only. */
export function printCounts(scriptName: string, counts: Record<string, number | string>): void {
  console.log(`[${scriptName}] summary:`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(34)} = ${v}`);
}

/** The dry-run/apply footer. */
export function printFooter(scriptName: string, opts: CommonCliOptions, planned: number): void {
  console.log(
    opts.apply
      ? `[${scriptName}] APPLY complete — ${planned} row change(s) written.`
      : `[${scriptName}] DRY RUN — ${planned} row change(s) planned. Re-run with --apply to perform them.`,
  );
}

/*
 * `bucketMonthValue` USED TO LIVE HERE and was deleted with TD120 (2026-08-01).
 *
 * It was a second implementation of `@badabhai/match-engine`'s function of the same name,
 * kept because `packages/db` did not depend on the engine. It does now, so the copy had no
 * remaining caller and no reason to exist: import `bucketMonths` (takes YEARS) or
 * `bucketMonthValue` (takes MONTHS) from `@badabhai/match-engine` instead.
 *
 * The unit-collision hazard its old docstring warned about is now structurally gone rather
 * than managed by naming discipline: there is exactly one `bucketMonths` and one
 * `bucketMonthValue` reachable from this package, and they are the engine's. A careless
 * auto-import can no longer pick a same-named function with different units and silently
 * multiply the D2 backfill's months by 12.
 */

/** A finite number, or null. */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A plain JSON object, or null (arrays are not objects here). */
export function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A `string[]` from an untyped jsonb column; non-strings and blanks are dropped. */
export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}
