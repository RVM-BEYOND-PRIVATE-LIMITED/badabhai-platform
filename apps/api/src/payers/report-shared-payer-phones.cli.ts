/**
 * #2754 item 3 — REPORT every phone that two or more company accounts share, for the hand
 * resolution that comes before a unique index on `payers.phone_hash`.
 *
 *   pnpm --filter @badabhai/api build
 *   pnpm --filter @badabhai/api report:shared-payer-phones
 *   (= node apps/api/dist/payers/report-shared-payer-phones.cli.js)
 *
 * WHY. `payers.phone_hash` is indexed but not unique, so production may hold two accounts on one
 * phone. Since #2754 item 3 that can no longer send an SMS sign-in to the wrong account (a phone
 * signs in only the ONE account that proved it, `payer_phone_proofs`), but each shared phone still
 * needs a person to decide which account keeps it before the payers-level unique index can apply
 * (issue question 4: the placement team resolves each by hand). This lists them.
 *
 * READ-ONLY, ALWAYS. There is no `--apply` and no write path at all: the query runs inside a
 * `READ ONLY` transaction, so even a future edit that slipped a write in would be refused by
 * Postgres. Any flag is refused. The shared ops guard still names the target and refuses an unset
 * DATABASE_URL.
 *
 * WHAT IT PRINTS: the number of phone hashes shared by two or more accounts, how many accounts that
 * is, and, per group (numbered 1..n, oldest account first), each account's id, role, status and
 * created_at. NEVER a phone, a phone hash, a name or an email — the group number is the only link
 * between the rows of one group, and it means nothing outside this one printout.
 */
import { parseArgs } from "node:util";
import { createDbClient, enforceOpsGuard, type Database } from "@badabhai/db";
import { sql } from "drizzle-orm";

export const REPORT_SHARED_PAYER_PHONES_SCRIPT = "report-shared-payer-phones";

/** The arguments: none. A flag (an `--apply` above all) is refused, never ignored. */
export function parseReportSharedPayerPhonesArgs(argv: readonly string[]): void {
  parseArgs({ args: [...argv], options: {}, strict: true, allowPositionals: false });
}

/** One account on a shared phone, as read. `phone_hash` groups the rows and is never printed. */
export interface SharedPhoneRow {
  phone_hash: string;
  payer_id: string;
  role: string;
  status: string;
  created_at: Date | string;
}

/** One account in the printed report. */
export interface SharedPhoneAccount {
  payerId: string;
  role: string;
  status: string;
  createdAt: string;
}

export interface SharedPhonesReport {
  /** Phone hashes held by two or more accounts. */
  sharedPhones: number;
  /** Accounts across those groups. */
  accounts: number;
  /** One entry per shared phone, oldest account first. No hash. */
  groups: SharedPhoneAccount[][];
}

/**
 * Every account whose phone hash at least one other account also holds, ordered by group then age,
 * inside a READ ONLY transaction. Archived and suspended accounts are listed too: a restore would
 * bring the duplicate back, so the person resolving it needs to see them.
 */
export async function readSharedPayerPhones(db: Database): Promise<SharedPhoneRow[]> {
  return db.transaction(
    async (tx) => {
      const rows = await tx.execute(sql`
        SELECT p.phone_hash, p.id AS payer_id, p.role, p.status, p.created_at
          FROM payers p
         WHERE p.phone_hash IN (
                 SELECT phone_hash FROM payers
                  WHERE phone_hash IS NOT NULL
                  GROUP BY phone_hash
                 HAVING count(*) > 1)
         ORDER BY p.phone_hash, p.created_at, p.id`);
      return rows as unknown as SharedPhoneRow[];
    },
    { accessMode: "read only" },
  );
}

/** Group the rows by phone (dropping the hash) into the printable report. */
export function groupSharedPhones(rows: readonly SharedPhoneRow[]): SharedPhonesReport {
  const byHash = new Map<string, SharedPhoneAccount[]>();
  for (const row of rows) {
    const group = byHash.get(row.phone_hash) ?? [];
    group.push({
      payerId: row.payer_id,
      role: row.role,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    });
    byHash.set(row.phone_hash, group);
  }
  // A group of one cannot come from the query; dropped anyway, so the count is always "shared".
  const groups = [...byHash.values()].filter((g) => g.length > 1);
  return {
    sharedPhones: groups.length,
    accounts: groups.reduce((n, g) => n + g.length, 0),
    groups,
  };
}

/** The printed lines: ids, roles, statuses and dates only. */
export function formatSharedPhonesReport(report: SharedPhonesReport): string[] {
  const lines = [
    `[${REPORT_SHARED_PAYER_PHONES_SCRIPT}] READ-ONLY — shared_phones=${report.sharedPhones} ` +
      `accounts=${report.accounts}`,
  ];
  report.groups.forEach((group, i) => {
    lines.push(`  group ${i + 1} (${group.length} accounts):`);
    for (const a of group) {
      lines.push(
        `    payer=${a.payerId} role=${a.role} status=${a.status} created_at=${a.createdAt}`,
      );
    }
  });
  if (report.sharedPhones === 0) {
    lines.push("  no phone is shared by two accounts: the payers-level unique index can be added.");
  }
  return lines;
}

async function run(argv: readonly string[]): Promise<number> {
  parseReportSharedPayerPhonesArgs(argv);
  const { connectionString } = enforceOpsGuard({
    script: REPORT_SHARED_PAYER_PHONES_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: false,
  });
  const client = createDbClient(connectionString, { max: 1 });
  try {
    const report = groupSharedPhones(await readSharedPayerPhones(client.db));
    for (const line of formatSharedPhonesReport(report)) console.log(line);
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
      console.error(
        `[${REPORT_SHARED_PAYER_PHONES_SCRIPT}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
