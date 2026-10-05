/**
 * #1432 — ONE-TIME title-case backfill for three worker-typed labels.
 *
 * Since worker-app f55a020f (first shipped as the `worker-app-sha-f55a020` APK release) the app runs
 * `titleCaseName` (`apps/worker-app/lib/core/util/title_case.dart`) over `employer_name`,
 * `role_label` and the education `field` before the trade form's PUT, so rows saved there arrive
 * cased. Rows stored before that fix are stuck as typed — "recursive global infotech pvt ltd" — and
 * the worker has no screen that can re-save them: the trade form is reached once, mid-onboarding,
 * and does not hydrate stored rows. Since #1940 the API cases `employer_name` and the education
 * `field` on every write with this same `titleCaseWords` (`apps/api/src/profiles/
 * title-case-on-write.ts`), so for those two columns one run after that deploy is the last. The API
 * still stores `role_label` as received (an open owner decision), so other writers — the companion
 * v2 edit card among them — still add uncased role labels (the runbook's residuals list them). This
 * brings every stored value to the value the app would have sent, server-side:
 *
 *   worker_employment.employer_name_enc   AES-256-GCM token — decrypted, cased, RE-ENCRYPTED
 *   worker_employment_role.role_label     plain text
 *   worker_education.field                plain text (nullable — null rows are not scanned)
 *
 * THE RULE IS THE APP'S, PORTED EXACTLY — `titleCaseWords` in `@badabhai/validators`, with a parity
 * suite against the Dart tests. It only ever RAISES the first letter of a whitespace-separated word,
 * so "RVM CAD" and "CNC Operator" are left byte-identical. NEVER Postgres `INITCAP()`, which
 * lowercases first and would turn both into "Rvm Cad" / "Cnc Operator".
 *
 * DRY-RUN IS THE DEFAULT and writes nothing. It DOES decrypt — whether an employer name would change
 * is a fact about its plaintext — but the plaintext lives only in this process, one row at a time.
 * `--apply` writes in batches of `--batch-size` (default 500), ONE TRANSACTION PER BATCH, each row
 * `UPDATE … WHERE id = ? AND <column> = <the value read>`: a row the worker re-saved since the read
 * is skipped and counted, never clobbered. Re-running is a no-op (the rule is idempotent) and
 * resumes an interrupted run. An unchanged row is never written, so its `updated_at` does not move.
 *
 * A TOKEN THAT WILL NOT DECRYPT IS SKIPPED AND COUNTED, never fatal — the API's readers already
 * treat such a row as unreadable and carry it across untouched (`readEmployerName`, #1504); this
 * leaves it exactly as found. The run exits 1 so the count is not missed.
 *
 * THE TOKEN WRITTEN IS THE ONE THE API WOULD WRITE: v2 under the active kid when the keyring is
 * configured, else legacy v1 — `piiCodec` is `PiiCryptoService` minus Nest. So a re-cased v1 row
 * moves onto the active kid, exactly as a worker re-saving it would. Which of the two is printed in
 * the header and the summary ("writes v2 (keyring armed …)" / "writes v1 (legacy key …)"), and
 * before an `--apply` writes v2 the run checks the API has written under that exact key — see
 * `WriteKeyCheck`.
 *
 * GUARDED, DATABASE-AWARE (`ops-guard.ts`): a dry run against any identified target is allowed and
 * announced; `--apply` against a production-like DATABASE_URL — or with NODE_ENV=production — also
 * needs `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=backfill:title-case`.
 * Neither signal is the owner's go-ahead; the runbook is.
 *
 * NO SPINE EVENT, NO AUDIT ROW — the convention every `packages/db` runner follows
 * (`reencrypt-pii-backfill.ts`, `retag-skills.ts`): this process has no event pipeline and no actor
 * it could truthfully attribute a write to. The counts-only summary IS the record; the runbook says
 * where to file it.
 *
 * PII-FREE OUTPUT: counts, column names, and the row id of an undecryptable row — NEVER a value,
 * plaintext or ciphertext. A failed write prints its SQLSTATE and never the driver message, because
 * drizzle's query error embeds the bound parameters, which here are the values.
 *
 *   pnpm --filter @badabhai/db db:backfill:title-case             # dry-run (counts only)
 *   pnpm --filter @badabhai/db db:backfill:title-case --apply     # write — see the runbook first
 *   (DATABASE_URL, PII_ENCRYPTION_KEY and — when the API runs with one — PII_ENCRYPTION_KEYS +
 *    PII_ENCRYPTION_ACTIVE_KID, from env/.env; --batch-size=<n> in 1..10000;
 *    --column=<table.column>[,<table.column>…] scopes the run; --keyring-is-newly-armed, see
 *    `checkWriteKey`.)
 *   Runbook: docs/ops/title-case-backfill-runbook.md
 */
import { config } from "dotenv";
import { and, asc, eq, getTableName, gt, isNotNull, sql } from "drizzle-orm";

import { titleCaseWords } from "@badabhai/validators";

import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { createDbClient, type Database } from "./client";
import { enforceOpsGuard, PRODUCTION_WRITE_FLAG } from "./ops-guard";
import { piiCodec, readOptionalPiiKeyring, type PiiCodec } from "./pii-keyring-env";
import { workerEducations, workerEmployment, workerEmploymentRole, workers } from "./schema";

const SCRIPT = "backfill:title-case";
const TAG = "[title-case]";
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10_000;
/** Undecryptable row ids printed per column before the rest are only counted. */
const MAX_IDS_PRINTED = 10;
/** Stored tokens under the active kid read per column by `checkWriteKey`. */
const WRITE_KEY_SAMPLE = 3;
/** The operator's word that the API runs this exact keyring and has not written under it yet. */
export const NEWLY_ARMED_FLAG = "--keyring-is-newly-armed";

/** Every column this backfill cases, by the name `--column=` takes and the summary prints. */
export const TITLE_CASE_COLUMNS = [
  "worker_employment.employer_name_enc",
  "worker_employment_role.role_label",
  "worker_education.field",
] as const;
export type TitleCaseColumn = (typeof TITLE_CASE_COLUMNS)[number];

/** One stored value, with the worker it belongs to (for the "workers affected" count). */
export interface StoredRow {
  readonly id: string;
  readonly workerId: string;
  readonly value: string;
}

/** One column the backfill cases. */
export interface TitleCaseTarget {
  readonly name: TitleCaseColumn;
  /** True for the AES-256-GCM column: decrypted to case, re-encrypted to store. */
  readonly encrypted: boolean;
  /** The next page of non-null values after `afterId`, in id order. */
  fetchBatch(afterId: string | null, limit: number): Promise<StoredRow[]>;
  /** Optimistic write — true iff the row still held `before` and now holds `after`. */
  applyOne(tx: Database, id: string, before: string, after: string): Promise<boolean>;
}

/** The three targets. Keyset-paged by primary key, so a page is an index range scan. */
export function buildTargets(db: Database): TitleCaseTarget[] {
  return [
    {
      name: "worker_employment.employer_name_enc",
      encrypted: true,
      fetchBatch: (afterId, limit) =>
        db
          .select({
            id: workerEmployment.id,
            workerId: workerEmployment.workerId,
            value: workerEmployment.employerNameEnc,
          })
          .from(workerEmployment)
          .where(afterId === null ? undefined : gt(workerEmployment.id, afterId))
          .orderBy(asc(workerEmployment.id))
          .limit(limit),
      applyOne: async (tx, id, before, after) => {
        const updated = await tx
          .update(workerEmployment)
          .set({ employerNameEnc: after })
          .where(and(eq(workerEmployment.id, id), eq(workerEmployment.employerNameEnc, before)))
          .returning({ id: workerEmployment.id });
        return updated.length === 1;
      },
    },
    {
      name: "worker_employment_role.role_label",
      encrypted: false,
      // Joined to its employment only for the worker id; the join is on the employment's PK.
      fetchBatch: (afterId, limit) =>
        db
          .select({
            id: workerEmploymentRole.id,
            workerId: workerEmployment.workerId,
            value: workerEmploymentRole.roleLabel,
          })
          .from(workerEmploymentRole)
          .innerJoin(workerEmployment, eq(workerEmploymentRole.employmentId, workerEmployment.id))
          .where(afterId === null ? undefined : gt(workerEmploymentRole.id, afterId))
          .orderBy(asc(workerEmploymentRole.id))
          .limit(limit),
      applyOne: async (tx, id, before, after) => {
        const updated = await tx
          .update(workerEmploymentRole)
          .set({ roleLabel: after })
          .where(and(eq(workerEmploymentRole.id, id), eq(workerEmploymentRole.roleLabel, before)))
          .returning({ id: workerEmploymentRole.id });
        return updated.length === 1;
      },
    },
    {
      name: "worker_education.field",
      encrypted: false,
      fetchBatch: async (afterId, limit) => {
        const rows = await db
          .select({
            id: workerEducations.id,
            workerId: workerEducations.workerId,
            value: workerEducations.field,
          })
          .from(workerEducations)
          .where(
            afterId === null
              ? isNotNull(workerEducations.field)
              : and(isNotNull(workerEducations.field), gt(workerEducations.id, afterId)),
          )
          .orderBy(asc(workerEducations.id))
          .limit(limit);
        return rows.flatMap((r) => (r.value === null ? [] : [{ ...r, value: r.value }]));
      },
      applyOne: async (tx, id, before, after) => {
        const updated = await tx
          .update(workerEducations)
          .set({ field: after })
          .where(and(eq(workerEducations.id, id), eq(workerEducations.field, before)))
          .returning({ id: workerEducations.id });
        return updated.length === 1;
      },
    },
  ];
}

/** What the backfill would do with one stored value. */
export type ValuePlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "undecryptable" }
  /** `cased` is PLAINTEXT — encode it for storage and drop it. */
  | { readonly kind: "change"; readonly cased: string };

/**
 * The whole decision for one value. `decode` is identity for a plain column and the PII decrypt for
 * the encrypted one; a decode that throws — wrong key, unknown kid, a malformed or tampered token —
 * is "undecryptable", never an abort.
 */
export function planValue(stored: string, decode: (stored: string) => string): ValuePlan {
  let plain: string;
  try {
    plain = decode(stored);
  } catch {
    return { kind: "undecryptable" };
  }
  const cased = titleCaseWords(plain);
  return cased === plain ? { kind: "unchanged" } : { kind: "change", cased };
}

export interface ColumnStats {
  /** Non-null values read. */
  scanned: number;
  unchanged: number;
  /** Would change (dry run) / planned to change (apply). */
  change: number;
  undecryptable: number;
  /** Apply only: rows this run wrote. */
  written: number;
  /** Apply only: rows that changed since they were read, left for a re-run. */
  concurrentSkipped: number;
}

function emptyStats(): ColumnStats {
  return {
    scanned: 0,
    unchanged: 0,
    change: 0,
    undecryptable: 0,
    written: 0,
    concurrentSkipped: 0,
  };
}

export interface TitleCaseRunOptions {
  readonly apply: boolean;
  readonly batchSize: number;
  /** Required whenever the encrypted column is in scope; may be null otherwise. */
  readonly codec: PiiCodec | null;
  /** Scope to these columns; all three when null. */
  readonly columns: readonly TitleCaseColumn[] | null;
  /** `--keyring-is-newly-armed` — lets an `--apply` write under a kid no stored token proves. */
  readonly keyringNewlyArmed?: boolean;
  /** Injected for tests. Defaults to `console.log`. Receives no value, ever. */
  readonly log?: (line: string) => void;
}

export interface TitleCaseRunResult {
  readonly columns: readonly { readonly name: TitleCaseColumn; readonly stats: ColumnStats }[];
  /** Distinct workers with at least one value changed (dry run: that would change). */
  readonly workersAffected: number;
  /** The token format employer names are written in; null when that column is out of scope. */
  readonly employerNameWrites: "v1" | "v2" | null;
  /** Whether the API can read what an `--apply` writes (see `WriteKeyCheck`). */
  readonly writeKey: WriteKeyCheck;
}

/**
 * Can the connected role see rows in a FORCE ROW LEVEL SECURITY table with no policies?
 *
 * All three tables are FORCE-RLS with no policy (0094, 0098), so a role that is neither superuser
 * nor BYPASSRLS reads ZERO rows from them — and this runner would report "nothing to change" over a
 * table full of lowercase values. That false all-clear is refused before the first read.
 */
export function canSeeForcedRlsRows(role: { rolsuper: boolean; rolbypassrls: boolean }): boolean {
  return role.rolsuper || role.rolbypassrls;
}

async function assertRoleSeesRows(db: Database): Promise<void> {
  const rows = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
    sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  );
  const role = rows[0];
  if (role === undefined || !canSeeForcedRlsRows(role)) {
    throw new Error(
      `${TAG} REFUSING: the connected role is neither superuser nor BYPASSRLS, so the three ` +
        "FORCE-RLS tables read as empty and this run would report nothing to change. Connect " +
        "with the role the API uses.",
    );
  }
}

/**
 * Is the key `--apply` would ENCRYPT with one the deployed API holds?
 *
 * THE ONE KEY THE SCAN NEVER PROVES. Every key this run decrypts with is proven by the decrypt: a
 * wrong legacy key or a missing old kid makes rows undecryptable, and the dry run counts them. The
 * key it encrypts with is not. With a keyring set, a re-cased employer name is written as v2 under
 * the ACTIVE kid; if the API does not hold that exact key, `readEmployerName` returns null for the
 * row and the employer drops off the résumé and the #1504 edit page, recoverable only by deploying
 * that key or restoring the backup. A dry run looks clean all the while, because v1 rows decrypt
 * under the legacy key. The likely way in: dotenv fills a dev keyring from the root `.env` into a
 * shell that exported only production's DATABASE_URL and PII_ENCRYPTION_KEY.
 *
 * So the run reads a few stored tokens already written under the active kid and DECRYPTS them. A
 * token that opens shows the kid AND the key bytes match the writer's (GCM authenticates; a wrong
 * key never opens a token). The plaintext is discarded unread.
 *
 * THE PROOF COMES ONLY FROM COLUMNS THIS RUNNER NEVER WRITES — `WRITE_KEY_PROOF_COLUMNS`, which
 * the API writes (the phone at sign-up, the name on every save). Never `employer_name_enc`: a run
 * with the wrong key under `--keyring-is-newly-armed` writes v2 employer names the API cannot read,
 * and if those counted, every later run would open them with that same wrong key, call it proven,
 * and keep writing unreadable rows with no flag at all. A token another ops runner wrote under the
 * same wrong keyring (`db:reencrypt:pii` rotates both columns) still proves it; no rerun of a runner
 * can see that, which is why the runbook's verify step reads back through the API.
 *
 * EVERY SAMPLED TOKEN MUST OPEN. One under the active kid that does not is far likelier a second
 * key behind the kid name than tampering, and the rows written with the other key are rows the API
 * cannot read — so it is refused whatever the flags say. A kid with no stored token proves nothing,
 * and an `--apply` refuses unless the operator passes `--keyring-is-newly-armed`.
 */
export type WriteKeyCheck =
  /** Employer names are out of scope, or written as legacy v1 — there is no new key to prove. */
  | "not-applicable"
  /** Every sampled token under the active kid opens with this run's key. */
  | "proven"
  /** No stored token under the active kid; the operator passed `--keyring-is-newly-armed`. */
  | "acknowledged"
  /** No stored token under the active kid. `--apply` refuses. */
  | "no-token"
  /** A sampled token under the active kid does not open. `--apply` refuses, always. */
  | "key-mismatch";

/**
 * Where the proof is read from: columns the API writes and this runner never does (see
 * `WriteKeyCheck`). Both live on `workers`; a null name is not sampled.
 */
const WRITE_KEY_PROOF_SOURCES = [workers.phoneE164, workers.fullName] as const;

/** `WRITE_KEY_PROOF_SOURCES` by `<table>.<column>`, the form `TITLE_CASE_COLUMNS` takes. */
export const WRITE_KEY_PROOF_COLUMNS: readonly string[] = WRITE_KEY_PROOF_SOURCES.map(
  (c) => `${getTableName(c.table)}.${c.name}`,
);

/** The verdict on a sample of stored tokens under the active kid. Pure. Fails closed. */
export function judgeWriteKey(
  sample: readonly string[],
  decrypt: (token: string) => string,
  acknowledged: boolean,
): WriteKeyCheck {
  if (sample.length === 0) return acknowledged ? "acknowledged" : "no-token";
  for (const token of sample) {
    try {
      decrypt(token);
    } catch {
      // Not outvoted by a token that opens: the rows behind this one are unreadable to someone.
      return "key-mismatch";
    }
  }
  return "proven";
}

/**
 * Why an `--apply` must not write, or null when it may. Constant strings: no kid, no key, no token.
 */
export function writeKeyProblem(check: WriteKeyCheck): string | null {
  switch (check) {
    case "not-applicable":
    case "proven":
    case "acknowledged":
      return null;
    case "no-token":
      return (
        "a keyring is configured, so employer names would be written as v2 under its active kid, " +
        `and no stored token the API writes (${WRITE_KEY_PROOF_COLUMNS.join(", ")}) is under ` +
        "that kid. Employer names this runner wrote earlier do not count. Nothing shows the " +
        "deployed API holds that key; if it does not, every re-cased employer becomes unreadable " +
        "to it. Compare PII_ENCRYPTION_KEYS and PII_ENCRYPTION_ACTIVE_KID with the API's " +
        "environment (dotenv fills them from the root .env when the shell does not set them). If " +
        "the API runs exactly this keyring and has not written under it yet, re-run with " +
        `${NEWLY_ARMED_FLAG}.`
      );
    case "key-mismatch":
      return (
        "a stored token under the keyring's active kid does not decrypt with this run's key for " +
        "that kid: it was written with a different key under the same kid name, and whoever holds " +
        "that key could not read an employer name this run wrote. Use the API's exact " +
        `PII_ENCRYPTION_KEYS (${NEWLY_ARMED_FLAG} does not override this).`
      );
  }
}

/** `column` holds a v2 token under `kid`. The kid is a bound parameter, never interpolated. */
function writtenUnderKid(column: AnyPgColumn, kid: string) {
  return and(
    sql`split_part(${column}, '.', 1) = 'v2'`,
    sql`split_part(${column}, '.', 2) = ${kid}`,
  );
}

/**
 * Up to `WRITE_KEY_SAMPLE` tokens per proof column under `kid`. Exact match on `split_part`, not
 * LIKE: a kid may contain `_`, which LIKE reads as a wildcard. Unindexed, but it stops at the first
 * rows it needs and runs once, before the first write.
 */
async function sampleTokensUnderKid(db: Database, kid: string): Promise<string[]> {
  const sample: string[] = [];
  for (const column of WRITE_KEY_PROOF_SOURCES) {
    const rows = await db
      .select({ token: column })
      .from(column.table)
      .where(writtenUnderKid(column, kid))
      .limit(WRITE_KEY_SAMPLE);
    for (const { token } of rows) if (token !== null) sample.push(token);
  }
  return sample;
}

async function checkWriteKey(
  db: Database,
  selected: readonly TitleCaseTarget[],
  opts: TitleCaseRunOptions,
): Promise<WriteKeyCheck> {
  const codec = opts.codec;
  if (!selected.some((t) => t.encrypted) || codec === null || codec.activeKid === null) {
    return "not-applicable";
  }
  const sample = await sampleTokensUnderKid(db, codec.activeKid);
  return judgeWriteKey(sample, (t) => codec.decrypt(t), opts.keyringNewlyArmed === true);
}

/** Run the backfill over the selected columns. Exported for the DB-backed test; `main` is the CLI. */
export async function runTitleCaseBackfill(
  db: Database,
  opts: TitleCaseRunOptions,
): Promise<TitleCaseRunResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const selected = buildTargets(db).filter(
    (t) => opts.columns === null || opts.columns.includes(t.name),
  );
  if (selected.some((t) => t.encrypted) && opts.codec === null) {
    throw new Error(
      `${TAG} worker_employment.employer_name_enc is in scope but no PII key is configured.`,
    );
  }
  await assertRoleSeesRows(db);

  // Before the first read of a target, so a refused --apply has written nothing at all.
  const writeKey = await checkWriteKey(db, selected, opts);
  const problem = writeKeyProblem(writeKey);
  if (problem !== null) {
    if (opts.apply) throw new Error(`${TAG} REFUSING TO WRITE: ${problem}`);
    log(`${TAG} WARN — an --apply would refuse: ${problem}`);
  }

  const affected = new Set<string>();
  const columns: { name: TitleCaseColumn; stats: ColumnStats }[] = [];
  for (const target of selected) {
    columns.push({
      name: target.name,
      stats: await processTarget(db, target, opts, affected, log),
    });
  }
  const employerNameWrites = !selected.some((t) => t.encrypted)
    ? null
    : (opts.codec?.activeKid ?? null) === null
      ? "v1"
      : "v2";
  return { columns, workersAffected: affected.size, employerNameWrites, writeKey };
}

async function processTarget(
  db: Database,
  target: TitleCaseTarget,
  opts: TitleCaseRunOptions,
  affected: Set<string>,
  log: (line: string) => void,
): Promise<ColumnStats> {
  const stats = emptyStats();
  const codec = opts.codec;
  const decode = target.encrypted && codec ? (s: string) => codec.decrypt(s) : (s: string) => s;
  const encode = target.encrypted && codec ? (s: string) => codec.encrypt(s) : (s: string) => s;

  let afterId: string | null = null;
  for (;;) {
    const rows = await target.fetchBatch(afterId, opts.batchSize);
    if (rows.length === 0) break;

    const writes: { id: string; workerId: string; before: string; after: string }[] = [];
    for (const row of rows) {
      stats.scanned++;
      afterId = row.id;
      const plan = planValue(row.value, decode);
      if (plan.kind === "undecryptable") {
        stats.undecryptable++;
        if (stats.undecryptable <= MAX_IDS_PRINTED) {
          log(`${TAG} WARN ${target.name} id=${row.id} will not decrypt — skipped, left as found`);
        }
        continue;
      }
      if (plan.kind === "unchanged") {
        stats.unchanged++;
        continue;
      }
      stats.change++;
      if (!opts.apply) {
        affected.add(row.workerId);
        continue;
      }
      // Encoded here so the plaintext is dropped with this iteration, not held for the batch.
      writes.push({
        id: row.id,
        workerId: row.workerId,
        before: row.value,
        after: encode(plan.cased),
      });
    }

    if (writes.length > 0) {
      const outcome = await writeBatch(db, target, writes);
      stats.written += outcome.writtenWorkerIds.length;
      stats.concurrentSkipped += outcome.skipped;
      for (const id of outcome.writtenWorkerIds) affected.add(id);
    }
    if (rows.length < opts.batchSize) break;
  }
  if (stats.undecryptable > MAX_IDS_PRINTED) {
    log(
      `${TAG} WARN ${target.name}: ${stats.undecryptable - MAX_IDS_PRINTED} more undecryptable ` +
        "row(s) not listed",
    );
  }
  return stats;
}

/**
 * One batch, one transaction. Counts are returned only once it COMMITS, so a batch that rolls back
 * cannot leave the summary claiming writes that never happened.
 */
async function writeBatch(
  db: Database,
  target: TitleCaseTarget,
  writes: readonly { id: string; workerId: string; before: string; after: string }[],
): Promise<{ writtenWorkerIds: string[]; skipped: number }> {
  try {
    return await db.transaction(async (tx) => {
      // A drizzle transaction exposes the client's query API; typed as `Database`, the codebase's
      // convention for a writer's `tx` (see `client.ts`), with the one cast contained here.
      const handle = tx as unknown as Database;
      const writtenWorkerIds: string[] = [];
      let skipped = 0;
      for (const w of writes) {
        if (await target.applyOne(handle, w.id, w.before, w.after))
          writtenWorkerIds.push(w.workerId);
        else skipped++;
      }
      return { writtenWorkerIds, skipped };
    });
  } catch (err) {
    throw new Error(
      `${TAG} write failed on ${target.name} (${describeDbFailure(err)}) — this batch of ` +
        `${writes.length} rolled back and none of it was written. Earlier batches stand; a ` +
        "re-run is safe.",
    );
  }
}

/** The SQLSTATE anywhere on the cause chain (drizzle 0.45 wraps the driver error). */
function sqlStateOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A database failure, described WITHOUT its message. Drizzle builds a query error's message from
 * the SQL and its bound parameters, and here the parameters are the values being cased — an
 * employer name's ciphertext, a role label. The SQLSTATE is what an operator debugs with.
 */
export function describeDbFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = sqlStateOf(err);
  return `${name}${code ? `, SQLSTATE ${code}` : ""}; driver message withheld — it can carry row values`;
}

/** Is this a drizzle query error, whose message embeds bound parameters? Matched by shape. */
function isQueryError(err: unknown): boolean {
  return (
    err instanceof Error &&
    typeof (err as { query?: unknown }).query === "string" &&
    Array.isArray((err as { params?: unknown }).params)
  );
}

/** The one line the CLI prints for a fatal error — a value never reaches it. */
export function safeErrorLine(err: unknown): string {
  if (isQueryError(err)) return `${TAG} query failed (${describeDbFailure(err)})`;
  return err instanceof Error ? err.message : `${TAG} failed (${typeof err})`;
}

export interface TitleCaseCli {
  readonly apply: boolean;
  readonly batchSize: number;
  readonly columns: readonly TitleCaseColumn[] | null;
  readonly keyringNewlyArmed: boolean;
}

/**
 * Parse argv (without the node + script entries). Fails closed on an unknown flag: a typo such as
 * `--colum=…` must not silently widen an `--apply` to every column.
 */
export function parseTitleCaseCli(argv: readonly string[]): TitleCaseCli {
  let apply = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let columns: TitleCaseColumn[] | null = null;
  let keyringNewlyArmed = false;
  for (const arg of argv) {
    if (arg === "--") continue; // pnpm may forward the separator verbatim
    if (arg === "--apply") {
      apply = true;
    } else if (arg === NEWLY_ARMED_FLAG) {
      keyringNewlyArmed = true;
    } else if (arg === PRODUCTION_WRITE_FLAG) {
      // Read by `enforceOpsGuard`, not here.
    } else if (arg.startsWith("--batch-size=")) {
      const raw = arg.slice("--batch-size=".length);
      batchSize = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
        throw new Error(`${TAG} --batch-size must be an integer in 1..${MAX_BATCH_SIZE}`);
      }
    } else if (arg.startsWith("--column=")) {
      const names = arg.slice("--column=".length).split(",");
      const unknown = names.filter((n) => !(TITLE_CASE_COLUMNS as readonly string[]).includes(n));
      if (unknown.length > 0) {
        throw new Error(
          `${TAG} --column takes one or more of: ${TITLE_CASE_COLUMNS.join(", ")} ` +
            `(unknown: ${unknown.join(", ")})`,
        );
      }
      columns = [...new Set(names as TitleCaseColumn[])];
    } else {
      throw new Error(`${TAG} unknown argument "${arg}"`);
    }
  }
  return { apply, batchSize, columns, keyringNewlyArmed };
}

/** Where the two keyring variables came from. dotenv never overrides, so "before it ran" = shell. */
export type KeyringSource = "shell" | "env-file" | "mixed";

export function keyringSourceOf(inShell: { keys: boolean; kid: boolean }): KeyringSource {
  if (inShell.keys && inShell.kid) return "shell";
  if (!inShell.keys && !inShell.kid) return "env-file";
  return "mixed";
}

/**
 * The write format for the header line — "v2" or "v1" and where the keyring came from, never the
 * kid. Runbook step 1 compares it with the API's environment.
 */
export function writeFormatLabel(source: KeyringSource | null): string {
  if (source === null) return "writes v1 (legacy key, no keyring)";
  const from = {
    shell: "from the shell",
    "env-file": "from the root .env, not the shell",
    mixed: "partly from the root .env",
  }[source];
  return `writes v2 (keyring armed, ${from})`;
}

/** The summary's write-format line: the format, and what proves the API can read it. */
function writeKeyLine(result: TitleCaseRunResult): string | null {
  if (result.employerNameWrites === null) return null;
  if (result.employerNameWrites === "v1") {
    return `${TAG} employer names: writes v1 (legacy key, no keyring).`;
  }
  const proof: Record<WriteKeyCheck, string> = {
    proven: "every sampled token the API wrote under that kid decrypts with this run's key",
    acknowledged: `NO token the API wrote under that kid; allowed by ${NEWLY_ARMED_FLAG}`,
    "no-token": "NO token the API wrote under that kid, so an --apply refuses",
    "key-mismatch": "a token under that kid does NOT decrypt, so an --apply refuses",
    "not-applicable": "nothing to prove",
  };
  return `${TAG} employer names: writes v2 under the keyring's active kid — ${proof[result.writeKey]}.`;
}

/** The summary — counts only. Pure, so a test can hold it to "no value, ever". */
export function formatSummary(result: TitleCaseRunResult, apply: boolean): string[] {
  const lines: string[] = [
    "",
    `${TAG} ${apply ? "APPLY" : "DRY-RUN"} summary (counts only — no value is ever printed):`,
    "column".padEnd(38) +
      "scanned".padStart(9) +
      "unchanged".padStart(11) +
      (apply ? "planned" : "change").padStart(9) +
      "undecryptable".padStart(15) +
      (apply ? "written".padStart(9) + "skipped".padStart(9) : ""),
  ];
  let change = 0;
  let written = 0;
  let skipped = 0;
  for (const { name, stats: s } of result.columns) {
    change += s.change;
    written += s.written;
    skipped += s.concurrentSkipped;
    lines.push(
      name.padEnd(38) +
        String(s.scanned).padStart(9) +
        String(s.unchanged).padStart(11) +
        String(s.change).padStart(9) +
        String(s.undecryptable).padStart(15) +
        (apply ? String(s.written).padStart(9) + String(s.concurrentSkipped).padStart(9) : ""),
    );
  }
  lines.push(
    `workers with at least one ${apply ? "changed" : "changing"} value: ${result.workersAffected}`,
    "",
  );
  const keyLine = writeKeyLine(result);
  if (keyLine !== null) lines.push(keyLine);
  if (!apply) {
    lines.push(
      change === 0
        ? `${TAG} nothing to change — every stored value is already what the app would send.`
        : `${TAG} DRY RUN — ${change} value(s) would change. Re-run with --apply ` +
            "(see docs/ops/title-case-backfill-runbook.md).",
    );
  } else {
    lines.push(
      `${TAG} APPLY complete — ${written}/${change} value(s) written` +
        (skipped > 0
          ? `; ${skipped} changed since read and were left — re-run to pick them up.`
          : "."),
      `${TAG} Rendered résumés are NOT re-rendered by this run — see the runbook's residuals.`,
    );
  }
  return lines;
}

/** `PII_ENCRYPTION_KEY`, validated the way `decodeKey` will need it — before the first row. */
function requireLegacyKey(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new Error(
      `${TAG} PII_ENCRYPTION_KEY is not set — required to read and write ` +
        "worker_employment.employer_name_enc (scope it out with --column= to run without it).",
    );
  }
  if (Buffer.from(raw, "base64").length !== 32) {
    throw new Error(`${TAG} PII_ENCRYPTION_KEY is not base64 of exactly 32 bytes`);
  }
  return raw;
}

async function main(): Promise<void> {
  // Read BEFORE dotenv, which fills in only what the shell left unset — so this says which
  // keyring variables the operator exported and which the root .env supplied.
  const inShell = {
    keys: process.env.PII_ENCRYPTION_KEYS !== undefined,
    kid: process.env.PII_ENCRYPTION_ACTIVE_KID !== undefined,
  };
  // Loaded HERE, not at module scope, so importing this file (the tests do) reads no env file.
  config({ path: "../../.env" });
  const cli = parseTitleCaseCli(process.argv.slice(2));
  const { connectionString } = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: cli.apply,
  });
  const needsKey =
    cli.columns === null || cli.columns.includes("worker_employment.employer_name_enc");
  const keyring = needsKey ? readOptionalPiiKeyring(process.env, "title-case") : null;
  const codec = needsKey
    ? piiCodec(requireLegacyKey(process.env.PII_ENCRYPTION_KEY), keyring)
    : null;

  console.log(
    `${TAG} ${cli.apply ? "APPLY" : "DRY-RUN"} — batch=${cli.batchSize}, columns=` +
      `${(cli.columns ?? TITLE_CASE_COLUMNS).join(",")}` +
      (needsKey
        ? `, employer names: ${writeFormatLabel(keyring === null ? null : keyringSourceOf(inShell))}`
        : "") +
      (cli.apply ? "" : " (nothing will be written)"),
  );

  const { db, sql: pg } = createDbClient(connectionString, { max: 1 });
  try {
    const result = await runTitleCaseBackfill(db, {
      apply: cli.apply,
      batchSize: cli.batchSize,
      codec,
      columns: cli.columns,
      keyringNewlyArmed: cli.keyringNewlyArmed,
    });
    for (const line of formatSummary(result, cli.apply)) console.log(line);
    const undecryptable = result.columns.reduce((n, c) => n + c.stats.undecryptable, 0);
    if (undecryptable > 0) {
      console.error(
        `${TAG} ${undecryptable} value(s) would not decrypt and were left exactly as found — ` +
          "see the WARN lines. Check the key configuration before anything else.",
      );
      process.exitCode = 1;
    }
    // Only a dry run gets here with a problem — an --apply refused before its first read.
    if (writeKeyProblem(result.writeKey) !== null) {
      console.error(
        `${TAG} an --apply with this key configuration would refuse — see the WARN line.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(safeErrorLine(err));
    process.exit(1);
  });
}
