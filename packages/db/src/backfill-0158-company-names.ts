/**
 * #2564 B10 — company search backfill: word hashes + GST hashes.
 *
 * Fills the two keyed-HMAC lookup columns migration 0158 added, from the live
 * ciphertext (the HMAC key lives server-side, so no SQL backfill can compute them):
 *
 *   * `payers.org_name_word_hashes` ← whole-word hashes of the decrypted org name
 *     (`company-search.companyNameWordHashes`), for every row where it is NULL.
 *   * `employer_profiles.gst_number_hash` / `agency_profiles.gst_number_hash` ←
 *     the normalized-GST hash, for every profile row that HAS a GST ciphertext
 *     but no hash.
 *
 * IDEMPOTENT: only NULL hashes are written (re-running reports the same counts
 * with zero writes); rows whose ciphertext will not decrypt are counted as
 * `decrypt_failed` and skipped, never retried blindly. DRY-RUN IS THE DEFAULT;
 * `--apply` writes.
 *
 * PRIVACY: decrypts contact PII in-process (never logged — only ids + counts
 * leave this runner, like every other backfill) and writes digests only.
 *
 *   pnpm db:backfill:company-names            # dry run + counts
 *   pnpm db:backfill:company-names --apply    # write
 */
import { config } from "dotenv";
import { and, eq, isNotNull, isNull, sql as dsql } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import { decryptPii, type PiiKeyring } from "./crypto";
import { companyNameWordHashes, gstinHash, normCompanyName, normGstin } from "./company-search";
import { agencyProfiles, employerProfiles, payers } from "./schema";
import { piiCodec, readOptionalPiiKeyring } from "./pii-keyring-env";
import { parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";

config({ path: "../../.env" });

const NAME = "backfill:company-names";

interface Counts {
  payersScanned: number;
  payersUpdated: number;
  payersDecryptFailed: number;
  gstScanned: number;
  gstUpdated: number;
  gstDecryptFailed: number;
}

/** Decrypt with the keyring when configured, else the legacy single key. */
function makeDecrypt(legacyKey: string, keyring: PiiKeyring | null): (token: string) => string {
  if (keyring) {
    const codec = piiCodec(legacyKey, keyring);
    return (token) => codec.decrypt(token);
  }
  return (token) => decryptPii(token, legacyKey);
}

async function backfillPayerWords(
  db: Database,
  pepper: string,
  decrypt: (token: string) => string,
  batchSize: number,
  apply: boolean,
  counts: Counts,
): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const rows = await db
      .select({ id: payers.id, orgNameEnc: payers.orgNameEnc })
      .from(payers)
      .where(
        afterId === null
          ? isNull(payers.orgNameWordHashes)
          : and(isNull(payers.orgNameWordHashes), dsql`${payers.id} > ${afterId}`),
      )
      .orderBy(payers.id)
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      counts.payersScanned += 1;
      afterId = row.id;
      let name: string;
      try {
        name = decrypt(row.orgNameEnc);
      } catch {
        counts.payersDecryptFailed += 1;
        continue;
      }
      const hashes = companyNameWordHashes(normCompanyName(name), pepper);
      counts.payersUpdated += 1;
      if (!apply) continue;
      await db
        .update(payers)
        .set({ orgNameWordHashes: hashes, updatedAt: dsql`now()` })
        .where(and(eq(payers.id, row.id), isNull(payers.orgNameWordHashes)));
    }
  }
}

async function backfillGstTable(
  db: Database,
  table: typeof employerProfiles | typeof agencyProfiles,
  pepper: string,
  decrypt: (token: string) => string,
  batchSize: number,
  apply: boolean,
  counts: Counts,
): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const rows = await db
      .select({ payerId: table.payerId, gstEnc: table.gstNumberEnc })
      .from(table)
      .where(
        afterId === null
          ? and(isNull(table.gstNumberHash), isNotNull(table.gstNumberEnc))
          : and(
              isNull(table.gstNumberHash),
              isNotNull(table.gstNumberEnc),
              dsql`${table.payerId} > ${afterId}`,
            ),
      )
      .orderBy(table.payerId)
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      counts.gstScanned += 1;
      afterId = row.payerId;
      if (row.gstEnc === null) continue;
      let gst: string;
      try {
        gst = decrypt(row.gstEnc);
      } catch {
        counts.gstDecryptFailed += 1;
        continue;
      }
      const hash = gstinHash(normGstin(gst), pepper);
      counts.gstUpdated += 1;
      if (!apply) continue;
      await db
        .update(table)
        .set({ gstNumberHash: hash, updatedAt: dsql`now()` })
        .where(and(eq(table.payerId, row.payerId), isNull(table.gstNumberHash)));
    }
  }
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  const pepper = process.env.PII_HASH_PEPPER;
  if (!pepper) {
    throw new Error(`[${NAME}] PII_HASH_PEPPER must be set — it keys every digest this script writes.`);
  }
  const legacyKey = process.env.PII_ENCRYPTION_KEY;
  if (!legacyKey) {
    throw new Error(`[${NAME}] PII_ENCRYPTION_KEY must be set — it decrypts the stored ciphertext.`);
  }
  const keyring = readOptionalPiiKeyring(process.env, NAME);
  const decrypt = makeDecrypt(legacyKey, keyring);

  const counts: Counts = {
    payersScanned: 0,
    payersUpdated: 0,
    payersDecryptFailed: 0,
    gstScanned: 0,
    gstUpdated: 0,
    gstDecryptFailed: 0,
  };

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    await backfillPayerWords(db, pepper, decrypt, opts.batchSize, opts.apply, counts);
    await backfillGstTable(db, employerProfiles, pepper, decrypt, opts.batchSize, opts.apply, counts);
    await backfillGstTable(db, agencyProfiles, pepper, decrypt, opts.batchSize, opts.apply, counts);

    printCounts(NAME, {
      "payers scanned": counts.payersScanned,
      "word hashes to write": counts.payersUpdated,
      "payer decrypt failures": counts.payersDecryptFailed,
      "profiles with GST scanned": counts.gstScanned,
      "GST hashes to write": counts.gstUpdated,
      "GST decrypt failures": counts.gstDecryptFailed,
    });
    printFooter(NAME, opts, counts.payersUpdated + counts.gstUpdated);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
