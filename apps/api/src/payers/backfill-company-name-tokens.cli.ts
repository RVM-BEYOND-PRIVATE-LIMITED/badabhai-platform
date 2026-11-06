/**
 * #2564 â€” backfill the company-name search tokens on `payers`.
 *
 *   pnpm --filter @badabhai/api build
 *   node apps/api/dist/payers/backfill-company-name-tokens.cli.js [--apply] [--batch-size=<n>]
 *
 * WHY. The tokens are written by the same `PayersRepository` statement that writes
 * `org_name_enc`, so every company created or renamed AFTER this deploy is searchable at once.
 * Companies that already exist keep `org_name_token_hashes = '{}'` (the column default) and are
 * invisible to the admin Companies name filter until this runs. It decrypts each stored name IN
 * PROCESS and writes only keyed HMAC tokens â€” no plaintext is printed, logged or stored.
 *
 * DRY RUN BY DEFAULT (counts only), like every runner in this family. `--apply` writes. A row
 * whose tokens are already current (same key id, non-empty) is skipped, so re-running is cheap
 * and idempotent; after a KEY ROTATION the whole set is re-tokenised under the new active kid.
 *
 * Fail-closed: with `ADMIN_NAME_TOKEN_KEYS` unset the runner refuses (nothing to tokenise with),
 * and the admin name filter stays OFF until the keys are configured and this has run.
 *
 * TARGET SAFETY: the shared ops guard â€” a write to a production-like database needs
 * `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=backfill-company-name-tokens`.
 */
import { parseArgs } from "node:util";
import type { ServerConfig } from "@badabhai/config";
import {
  PRODUCTION_WRITE_FLAG,
  createDbClient,
  decryptPii,
  decryptPiiWithKeyring,
  enforceOpsGuard,
  type PiiKeyring,
} from "@badabhai/db";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { payers } from "@badabhai/db";
import { NameTokenService } from "../admin/candidate-index/name-token.service";

export const BACKFILL_COMPANY_NAME_TOKENS_SCRIPT = "backfill-company-name-tokens";
const BATCH = 500;

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "batch-size": { type: "string" },
    [PRODUCTION_WRITE_FLAG]: { type: "boolean", default: false },
  },
});

const apply = values.apply === true;
const batchSize = values["batch-size"] ? Number.parseInt(values["batch-size"], 10) : BATCH;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
  throw new Error("--batch-size must be an integer between 1 and 5000");
}

const DATABASE_URL = process.env.DATABASE_URL;
enforceOpsGuard({
  script: BACKFILL_COMPANY_NAME_TOKENS_SCRIPT,
  env: process.env,
  connectionString: DATABASE_URL,
  argv: process.argv.slice(2),
  mutating: apply,
});

const config = {
  ADMIN_NAME_TOKEN_KEYS: process.env.ADMIN_NAME_TOKEN_KEYS ?? "",
  ADMIN_NAME_TOKEN_ACTIVE_KID: process.env.ADMIN_NAME_TOKEN_ACTIVE_KID ?? "",
} as ServerConfig;
const tokens = new NameTokenService(config);
const ring = tokens.keyring();
if (ring === null) {
  throw new Error(
    "ADMIN_NAME_TOKEN_KEYS + ADMIN_NAME_TOKEN_ACTIVE_KID must be set: with no keyring there is " +
      "nothing to tokenise with, and admin company-name search stays unavailable.",
  );
}
/**
 * Read back both token formats the API writes: legacy `v1` under `PII_ENCRYPTION_KEY`, and `v2`
 * under the TD22-1 keyring when one is configured. This runner only DECRYPTS — it writes tokens,
 * never ciphertext — so it needs no `activeKid`.
 */
const legacyKey = process.env.PII_ENCRYPTION_KEY ?? "";
const rawKeys = process.env.PII_ENCRYPTION_KEYS;
const rawKid = process.env.PII_ENCRYPTION_ACTIVE_KID;
let keyring: PiiKeyring | null = null;
if (rawKeys !== undefined || rawKid !== undefined) {
  if (!rawKeys || !rawKid) {
    throw new Error(
      "[company-tokens] PII_ENCRYPTION_KEYS and PII_ENCRYPTION_ACTIVE_KID must be set together",
    );
  }
  keyring = { activeKid: rawKid, keys: JSON.parse(rawKeys) as Record<string, string> };
}
const decrypt = (token: string): string =>
  keyring ? decryptPiiWithKeyring(token, keyring, legacyKey) : decryptPii(token, legacyKey);

if (DATABASE_URL === undefined || DATABASE_URL === "") {
  throw new Error("DATABASE_URL is not set");
}
const client = createDbClient(DATABASE_URL, { max: 4 });

async function main(): Promise<void> {
  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let afterId: string | null = null;

  for (;;) {
    const rows = await client.db
      .select({ id: payers.id, nameCipher: payers.orgNameEnc })
      .from(payers)
      .where(
        and(
          isNotNull(payers.orgNameEnc),
          // Never tokenised (NULL / older kid) â€” `IS DISTINCT FROM` covers NULL.
          sql`${payers.orgNameTokenKeyId} IS DISTINCT FROM ${ring!.activeKid}`,
          afterId === null ? undefined : gt(payers.id, afterId),
        ),
      )
      .orderBy(payers.id)
      .limit(batchSize);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      scanned += 1;
      let name: string;
      try {
        name = decrypt(row.nameCipher);
      } catch {
        failed += 1;
        console.warn(`[company-tokens] could not decrypt payer=${row.id.slice(0, 8)}â€¦; skipped`);
        continue;
      }
      const { hashes, kid } = tokens.tokenise(name, "company");
      if (hashes.length === 0) continue;
      if (!apply) {
        updated += 1;
        continue;
      }
      await client.db
        .update(payers)
        .set({ orgNameTokenHashes: hashes, orgNameTokenKeyId: kid, updatedAt: new Date() })
        .where(eq(payers.id, row.id));
      updated += 1;
    }
    if (rows.length < batchSize) break;
  }

  console.log(
    `[company-tokens] ${apply ? "APPLIED" : "DRY RUN"} â€” scanned=${scanned} ` +
      `${apply ? "updated" : "would_update"}=${updated} failed=${failed} ` +
      `key_id=${ring!.activeKid}`,
  );
}

main()
  .then(() => client.sql.end({ timeout: 5 }))
  .catch(async (err: unknown) => {
    console.error(`[company-tokens] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await client.sql.end({ timeout: 5 }).catch(() => undefined);
    process.exitCode = 1;
  });
