/**
 * TD22-2 — PII re-encrypt backfill runner.
 *
 * Once an operator opts into the TD22-1 keyring (`PII_ENCRYPTION_KEYS` +
 * `PII_ENCRYPTION_ACTIVE_KID`), new writes mint `v2.<activeKid>...` tokens but
 * every row written BEFORE the opt-in stays on its old token (legacy `v1...` or
 * an earlier `v2.<oldKid>...`) forever — `decryptPiiWithKeyring` keeps reading
 * both, but an old kid can never be safely retired from the keyring while any
 * row still depends on it. This runner re-encrypts those rows onto the CURRENT
 * active kid so old kids eventually become retireable.
 *
 * DRY-RUN IS THE DEFAULT and never touches plaintext: classifying a token as
 * "needs rotation" vs "already current" is a prefix check on the token string,
 * no decrypt call. Only `--apply` decrypts (old key/kid) + re-encrypts (active
 * kid) + writes — one row at a time, immediately dropping the plaintext
 * reference after use.
 *
 * GUARDED, same posture as `retag-skills.ts`: refuses `NODE_ENV=production`
 * outright, and `--apply` additionally requires `PII_REENCRYPT_CONFIRM` to be
 * the exact string below. Neither gate is a substitute for the CLAUDE.md §7
 * human sign-off this is still an ops-run, staging-first, gated procedure. See
 * docs/pii-key-rotation-runbook.md for the full operator procedure.
 *
 * Every column this runner touches is enumerated in TARGETS — one entry per
 * (table, PII column). Optimistic concurrency (`WHERE id = ? AND col = ?`) on
 * the update means a row that changed since it was read is safely skipped
 * (reported, never clobbered) — re-run to pick it up.
 *
 * Resumable: safe to stop and re-run at any time — rows already on the active
 * kid are always skipped, so re-running only ever does the remaining work.
 *
 * PII-FREE LOGGING: every log line carries a table name, column name, row id,
 * and/or counts — NEVER a plaintext value or a ciphertext token (CLAUDE.md §2).
 *
 *   pnpm --filter @badabhai/db db:reencrypt:pii              # dry-run (counts only)
 *   pnpm --filter @badabhai/db db:reencrypt:pii --apply       # rotate (see runbook)
 *   (DATABASE_URL / PII_ENCRYPTION_KEY / PII_ENCRYPTION_KEYS / PII_ENCRYPTION_ACTIVE_KID
 *    from env/.env; --batch-size=<n> overrides the default 500; --table=<name>[,<name>...]
 *    scopes the run to specific tables.)
 */
import { config } from "dotenv";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { createDbClient, type Database } from "./client";
import {
  PII_KID_PATTERN,
  decryptPiiWithKeyring,
  encryptPiiWithKeyring,
  isEncryptedPii,
  type PiiKeyring,
} from "./crypto";
import { adminUsers, agencyKyc, payerMembers, payerOrgs, payers, workers } from "./schema";

config({ path: "../../.env" });

const CONFIRM_TOKEN = "yes-reencrypt-prod-data";
const DEFAULT_BATCH_SIZE = 500;

interface Stats {
  total: number;
  nullValue: number;
  malformed: number;
  alreadyCurrent: number;
  needsRotation: number;
  rotated: number;
  concurrentSkipped: number;
  decryptFailed: number;
}

function emptyStats(): Stats {
  return {
    total: 0,
    nullValue: 0,
    malformed: 0,
    alreadyCurrent: 0,
    needsRotation: 0,
    rotated: 0,
    concurrentSkipped: 0,
    decryptFailed: 0,
  };
}

interface PiiTarget {
  tableName: string;
  columnName: string;
  fetchBatch: (afterId: string | null, limit: number) => Promise<{ id: string; value: string | null }[]>;
  /** Optimistic-concurrency update; returns true iff this call wrote the row. */
  applyOne: (id: string, before: string, after: string) => Promise<boolean>;
}

/** One target per (table, PII column). Keep in sync with schema.ts's *_enc / phone_e164 / full_name columns. */
function buildTargets(db: Database): PiiTarget[] {
  const target = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic over any of the tables below
    table: any,
    idCol: PgColumn,
    dataCol: PgColumn,
    tableName: string,
    columnName: string,
    dataKey: string,
  ): PiiTarget => ({
    tableName,
    columnName,
    fetchBatch: async (afterId, limit) =>
      db
        .select({ id: idCol, value: dataCol })
        .from(table)
        .where(
          afterId ? and(isNotNull(dataCol), gt(idCol, afterId)) : isNotNull(dataCol),
        )
        .orderBy(asc(idCol))
        .limit(limit) as Promise<{ id: string; value: string | null }[]>,
    applyOne: async (id, before, after) => {
      const updated = await db
        .update(table)
        .set({ [dataKey]: after })
        .where(and(eq(idCol, id), eq(dataCol, before)))
        .returning({ id: idCol });
      return updated.length === 1;
    },
  });

  return [
    target(workers, workers.id, workers.phoneE164, "workers", "phone_e164", "phoneE164"),
    target(workers, workers.id, workers.fullName, "workers", "full_name", "fullName"),
    target(payers, payers.id, payers.emailEnc, "payers", "email_enc", "emailEnc"),
    target(payers, payers.id, payers.phoneEnc, "payers", "phone_enc", "phoneEnc"),
    target(payers, payers.id, payers.orgNameEnc, "payers", "org_name_enc", "orgNameEnc"),
    target(payerOrgs, payerOrgs.id, payerOrgs.nameEnc, "payer_orgs", "name_enc", "nameEnc"),
    target(payerMembers, payerMembers.id, payerMembers.emailEnc, "payer_members", "email_enc", "emailEnc"),
    target(agencyKyc, agencyKyc.id, agencyKyc.panEnc, "agency_kyc", "pan_enc", "panEnc"),
    target(agencyKyc, agencyKyc.id, agencyKyc.bankAccountEnc, "agency_kyc", "bank_account_enc", "bankAccountEnc"),
    target(agencyKyc, agencyKyc.id, agencyKyc.ifscEnc, "agency_kyc", "ifsc_enc", "ifscEnc"),
    target(
      agencyKyc,
      agencyKyc.id,
      agencyKyc.accountHolderNameEnc,
      "agency_kyc",
      "account_holder_name_enc",
      "accountHolderNameEnc",
    ),
    target(adminUsers, adminUsers.id, adminUsers.emailEnc, "admin_users", "email_enc", "emailEnc"),
    // `admin_users.name_enc` was missing from this list until the 2026-08-18 identity ruling gave
    // it a READ site. It was always a rotatable `encryptPii` token (`bootstrap-admin.ts` writes
    // one), but nothing ever decrypted it, so a rotation that skipped it was invisible. It is
    // rendered on `/admins` now, and a skipped column surfaces there as every row showing the
    // "No name on record" dash after a key retirement — the failure reported as benign absence.
    target(adminUsers, adminUsers.id, adminUsers.nameEnc, "admin_users", "name_enc", "nameEnc"),
  ];
}

/**
 * Counts top-level `key:` members in a JSON object's raw text (ignores nested
 * braces/brackets and string contents). `JSON.parse` silently keeps the LAST
 * value for a repeated top-level key, so comparing this count to
 * `Object.keys(parsed).length` is how a duplicate kid is caught at all — a
 * straight `JSON.parse` would boot clean and fail only later, at READ time, on
 * rows written under the shadowed key. Byte-for-byte the same algorithm as
 * `packages/config/src/server.ts`'s `countTopLevelJsonMembers` (kept in sync by
 * hand — packages/db cannot depend on packages/config).
 */
function countTopLevelJsonMembers(raw: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let count = 0;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === ":" && depth === 1) count += 1;
  }
  return count;
}

/** Local mirror of @badabhai/config's keyring validation (packages/db cannot depend on config —
 * see crypto.ts's PII_KID_PATTERN doc comment). Fails closed; never echoes key material. */
function parseKeyring(): PiiKeyring {
  const rawKeys = process.env.PII_ENCRYPTION_KEYS;
  const rawKid = process.env.PII_ENCRYPTION_ACTIVE_KID;
  if (!rawKeys || !rawKid) {
    throw new Error(
      "[reencrypt] PII_ENCRYPTION_KEYS + PII_ENCRYPTION_ACTIVE_KID must both be set — " +
        "this backfill only makes sense once the TD22-1 keyring is active.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error("[reencrypt] PII_ENCRYPTION_KEYS is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("[reencrypt] PII_ENCRYPTION_KEYS must be a JSON object");
  }
  const parsedEntries = Object.entries(parsed as Record<string, unknown>);
  if (countTopLevelJsonMembers(rawKeys) !== parsedEntries.length) {
    throw new Error("[reencrypt] PII_ENCRYPTION_KEYS contains a duplicate key id");
  }
  const keys: Record<string, string> = {};
  for (const [kid, key] of parsedEntries) {
    if (!PII_KID_PATTERN.test(kid)) {
      throw new Error("[reencrypt] PII_ENCRYPTION_KEYS contains an invalid key id");
    }
    if (typeof key !== "string" || Buffer.from(key, "base64").length !== 32) {
      throw new Error("[reencrypt] PII_ENCRYPTION_KEYS contains a key that is not base64 of exactly 32 bytes");
    }
    if (Buffer.from(key, "base64").every((b) => b === 0)) {
      throw new Error("[reencrypt] PII_ENCRYPTION_KEYS contains an all-zero key");
    }
    keys[kid] = key;
  }
  if (!PII_KID_PATTERN.test(rawKid) || !Object.prototype.hasOwnProperty.call(keys, rawKid)) {
    throw new Error("[reencrypt] PII_ENCRYPTION_ACTIVE_KID is not a valid key id present in PII_ENCRYPTION_KEYS");
  }
  return { activeKid: rawKid, keys };
}

async function processTarget(
  t: PiiTarget,
  opts: { apply: boolean; batchSize: number; keyring: PiiKeyring; legacyKey: string },
): Promise<Stats> {
  const stats = emptyStats();
  let afterId: string | null = null;
  const activePrefix = `v2.${opts.keyring.activeKid}.`;
  for (;;) {
    const rows = await t.fetchBatch(afterId, opts.batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      stats.total++;
      afterId = row.id;
      const value = row.value;
      if (value === null) {
        stats.nullValue++;
        continue;
      }
      if (!isEncryptedPii(value)) {
        stats.malformed++;
        console.warn(
          `[reencrypt] WARNING malformed value at ${t.tableName}.${t.columnName} id=${row.id} (not a PII token — skipped)`,
        );
        continue;
      }
      if (value.startsWith(activePrefix)) {
        stats.alreadyCurrent++;
        continue;
      }
      stats.needsRotation++;
      if (!opts.apply) continue;

      let plaintext: string;
      try {
        plaintext = decryptPiiWithKeyring(value, opts.keyring, opts.legacyKey);
      } catch {
        stats.decryptFailed++;
        console.error(
          `[reencrypt] ERROR decrypt failed at ${t.tableName}.${t.columnName} id=${row.id} (skipped — investigate manually, do not retry blindly)`,
        );
        continue;
      }
      const newToken = encryptPiiWithKeyring(plaintext, opts.keyring);
      plaintext = ""; // drop the reference as soon as it is no longer needed
      const wrote = await t.applyOne(row.id, value, newToken);
      if (wrote) stats.rotated++;
      else stats.concurrentSkipped++;
    }
    if (rows.length < opts.batchSize) break;
  }
  return stats;
}

function printSummary(rows: { target: PiiTarget; stats: Stats }[], apply: boolean): void {
  console.log("");
  console.log(`[reencrypt] ${apply ? "APPLY" : "DRY-RUN"} summary:`);
  console.log(
    "table.column".padEnd(40) +
      "total".padStart(8) +
      "current".padStart(10) +
      "rotate".padStart(9) +
      (apply ? "rotated".padStart(9) + "skipped".padStart(9) + "failed".padStart(8) : ""),
  );
  let totalNeedsRotation = 0;
  let totalRotated = 0;
  for (const { target: t, stats: s } of rows) {
    totalNeedsRotation += s.needsRotation;
    totalRotated += s.rotated;
    console.log(
      `${t.tableName}.${t.columnName}`.padEnd(40) +
        String(s.total).padStart(8) +
        String(s.alreadyCurrent).padStart(10) +
        String(s.needsRotation).padStart(9) +
        (apply
          ? String(s.rotated).padStart(9) + String(s.concurrentSkipped).padStart(9) + String(s.decryptFailed).padStart(8)
          : ""),
    );
    if (s.malformed > 0) {
      console.log(`  ⚠ ${s.malformed} malformed value(s) in ${t.tableName}.${t.columnName} — see warnings above`);
    }
  }
  console.log("");
  if (!apply) {
    console.log(
      totalNeedsRotation === 0
        ? "[reencrypt] nothing to rotate — every row is already on the active kid."
        : `[reencrypt] DRY RUN — ${totalNeedsRotation} row(s) would be rotated. Re-run with --apply (see docs/pii-key-rotation-runbook.md) to perform them.`,
    );
  } else {
    console.log(`[reencrypt] APPLY complete — ${totalRotated}/${totalNeedsRotation} row(s) rotated.`);
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[reencrypt] refusing to run in production (run is §7-gated ops — see the runbook).");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[reencrypt] DATABASE_URL is not set");
  const legacyKey = process.env.PII_ENCRYPTION_KEY;
  if (!legacyKey) {
    throw new Error(
      "[reencrypt] PII_ENCRYPTION_KEY is not set — required to decrypt any remaining legacy v1 tokens.",
    );
  }
  const keyring = parseKeyring();

  const apply = process.argv.includes("--apply");
  if (apply && process.env.PII_REENCRYPT_CONFIRM !== CONFIRM_TOKEN) {
    throw new Error(
      `[reencrypt] --apply requires PII_REENCRYPT_CONFIRM=${CONFIRM_TOKEN} — this is a deliberate, ` +
        "sign-off-gated step (CLAUDE.md §7). See docs/pii-key-rotation-runbook.md.",
    );
  }
  const batchArg = process.argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchArg ? Number(batchArg.split("=")[1]) : DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("[reencrypt] --batch-size must be a positive integer");
  }
  const tableArg = process.argv.find((a) => a.startsWith("--table="));
  const tableFilter = tableArg ? new Set(tableArg.split("=")[1]!.split(",")) : null;

  console.log(
    `[reencrypt] ${apply ? "APPLY" : "DRY-RUN"} starting — active kid set, keys known: ${Object.keys(keyring.keys).length} (kid values never logged)`,
  );

  const { db, sql: pg } = createDbClient(url, { max: 1 });
  try {
    let targets = buildTargets(db);
    if (tableFilter) {
      targets = targets.filter((t) => tableFilter.has(t.tableName));
      if (targets.length === 0) {
        throw new Error(`[reencrypt] --table filter matched no known target (checked: ${tableFilter.size} name(s))`);
      }
    }
    const results: { target: PiiTarget; stats: Stats }[] = [];
    for (const t of targets) {
      const stats = await processTarget(t, { apply, batchSize, keyring, legacyKey });
      results.push({ target: t, stats });
    }
    printSummary(results, apply);
    const anyFailures = results.some((r) => r.stats.decryptFailed > 0);
    if (anyFailures) {
      console.error("[reencrypt] completed with decrypt failures — see ERROR lines above.");
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
