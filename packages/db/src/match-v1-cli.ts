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
 *  2. PRODUCTION IS EXPLICIT. `NODE_ENV=production` refuses unless
 *     `MATCH_V1_PROD_CONFIRM=apply-matching-v1` is also set. Matching V1 migrations and
 *     backfills ARE applied to production by hand (see
 *     docs/ops/matching-v1-migration-runbook.md) — so, unlike a fixture seed, an outright
 *     refusal would make the runbook impossible. The confirm token makes the production
 *     run a deliberate two-key action instead of a one-character mistake.
 *  3. DATABASE_URL must be set. No localhost fallback — a backfill that silently targets
 *     the wrong database is the failure mode this whole file exists to prevent.
 *
 * PRIVACY: these runners read `worker_profiles` signal columns, `jobs`, `job_postings`
 * and the skill vocabulary. They MUST NOT read or print phone, name, or any other PII —
 * every log line here is ids + counts. `printCounts` is the only logging helper for a
 * reason: keep it that way.
 */
import { config } from "dotenv";

// Load the repo-root .env (CWD is packages/db when run via a package script).
config({ path: "../../.env" });

export const PROD_CONFIRM_ENV = "MATCH_V1_PROD_CONFIRM";
export const PROD_CONFIRM_TOKEN = "apply-matching-v1";

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

  if (
    process.env.NODE_ENV === "production" &&
    process.env[PROD_CONFIRM_ENV] !== PROD_CONFIRM_TOKEN
  ) {
    throw new Error(
      `[${scriptName}] refusing to run with NODE_ENV=production without ` +
        `${PROD_CONFIRM_ENV}=${PROD_CONFIRM_TOKEN}.\n` +
        `  Matching V1 backfills ARE run against production by hand — see\n` +
        `  docs/ops/matching-v1-migration-runbook.md. Setting the token is the deliberate\n` +
        `  second key. Do not set it in a deployed service's environment.`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      `[${scriptName}] DATABASE_URL is not set. There is no localhost fallback here on ` +
        `purpose — a backfill pointed at the wrong database is unrecoverable.`,
    );
  }

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

/** Round DOWN to a bucket boundary (the V1 `month_bucket` rule). Never negative. */
export function bucketMonths(months: number, bucket: number): number {
  if (!Number.isFinite(months) || months <= 0) return 0;
  if (!Number.isInteger(bucket) || bucket < 1) {
    throw new Error(`bucketMonths: bucket must be a positive integer (got ${bucket})`);
  }
  return Math.floor(months / bucket) * bucket;
}

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
