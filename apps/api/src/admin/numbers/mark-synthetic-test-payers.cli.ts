/**
 * #2755 item 2 — mark the TEST SIGN-INS as test companies (`payers.is_test_account`).
 *
 *   pnpm --filter @badabhai/api build
 *   node apps/api/dist/admin/numbers/mark-synthetic-test-payers.cli.js [--apply] [--batch-size=<n>]
 *
 * WHY. A company created through the test-login seam signs in with an email in the reserved
 * `@e2e.badabhai.invalid` domain (`isSyntheticPayerEmail`). It is not a customer, but nothing on the
 * row said so, and the email is encrypted, so no query can find it. This runner decrypts each
 * unmarked company's sign-in email IN PROCESS, and marks the synthetic ones with reason
 * `synthetic_sign_in` — the same write the admin route makes (`AdminNumbersService.mark`): the
 * column and `admin.payer_test_account_marked` (admin_id null) in one transaction.
 *
 * DRY RUN BY DEFAULT (ids and counts only), like every runner in this family. `--apply` writes.
 * Already-marked companies are not read, so re-running is cheap and idempotent. It never prints,
 * logs or stores an email — only payer ids and counts.
 *
 * TARGET SAFETY: the shared ops guard — a write to a production-like database needs
 * `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=mark-synthetic-test-payers`.
 * Decryption reads `PII_ENCRYPTION_KEY` (legacy v1 tokens) and, when set, the
 * `PII_ENCRYPTION_KEYS` + `PII_ENCRYPTION_ACTIVE_KID` keyring (v2 tokens), as the API does.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  PRODUCTION_WRITE_FLAG,
  createDbClient,
  decryptPii,
  decryptPiiWithKeyring,
  enforceOpsGuard,
  type PiiKeyring,
} from "@badabhai/db";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { AdminNumbersRepository } from "./admin-numbers.repository";
import { AdminNumbersService } from "./admin-numbers.service";
import { markSyntheticTestPayers } from "./mark-synthetic-test-payers";

export const MARK_SYNTHETIC_TEST_PAYERS_SCRIPT = "mark-synthetic-test-payers";

export interface MarkSyntheticTestPayersArgs {
  apply: boolean;
  batchSize: number;
}

/** Strict argv parsing: an unknown or malformed flag is an error, never a guess. */
export function parseMarkSyntheticTestPayersArgs(
  argv: readonly string[],
): MarkSyntheticTestPayersArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: "boolean", default: false },
      "batch-size": { type: "string" },
      [PRODUCTION_WRITE_FLAG.replace(/^--/, "")]: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const batchSize = values["batch-size"] === undefined ? 500 : Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error("--batch-size must be an integer in 1..5000");
  }
  return { apply: values.apply === true, batchSize };
}

/**
 * The decrypter the API uses: `v2` tokens under the TD22-1 keyring when one is configured, `v1`
 * under `PII_ENCRYPTION_KEY`. This runner only DECRYPTS, so it needs no active key of its own.
 */
export function buildPiiDecrypter(
  env: Readonly<Record<string, string | undefined>>,
): (token: string) => string {
  const legacyKey = env.PII_ENCRYPTION_KEY ?? "";
  const rawKeys = env.PII_ENCRYPTION_KEYS;
  const rawKid = env.PII_ENCRYPTION_ACTIVE_KID;
  let keyring: PiiKeyring | null = null;
  if (rawKeys !== undefined || rawKid !== undefined) {
    if (!rawKeys || !rawKid) {
      throw new Error("PII_ENCRYPTION_KEYS and PII_ENCRYPTION_ACTIVE_KID must be set together");
    }
    keyring = { activeKid: rawKid, keys: JSON.parse(rawKeys) as Record<string, string> };
  }
  if (keyring === null && legacyKey === "") {
    throw new Error(
      "PII_ENCRYPTION_KEY (or the keyring) must be set: there is nothing to decrypt with",
    );
  }
  return (token: string) =>
    keyring ? decryptPiiWithKeyring(token, keyring, legacyKey) : decryptPii(token, legacyKey);
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseMarkSyntheticTestPayersArgs(argv);
  const { connectionString } = enforceOpsGuard({
    script: MARK_SYNTHETIC_TEST_PAYERS_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: args.apply,
  });
  const decrypt = buildPiiDecrypter(process.env);
  console.log(`[${MARK_SYNTHETIC_TEST_PAYERS_SCRIPT}] ${args.apply ? "APPLY" : "DRY-RUN"}`);

  const client = createDbClient(connectionString, { max: 2 });
  const repo = new AdminNumbersRepository(client.db);
  // The real, registry-validating emitter. NODE_ENV labels the event's metadata only; the blast
  // radius was decided above by the guard, from the connection string.
  const events = new EventsService(new EventsRepository(client.db), {
    NODE_ENV: process.env.NODE_ENV ?? "development",
  } as ServerConfig);
  const service = new AdminNumbersService(repo, events, {} as ServerConfig);
  // One run, one key: a company unmarked by an admin and found again by a later run is a NEW mark.
  const runKey = `${MARK_SYNTHETIC_TEST_PAYERS_SCRIPT}:${randomUUID()}`;
  const ctx = { correlationId: randomUUID(), requestId: MARK_SYNTHETIC_TEST_PAYERS_SCRIPT };

  try {
    const summary = await markSyntheticTestPayers(
      {
        listUnmarked: (afterId, limit) => repo.listUnmarkedPayersWithEmail(afterId, limit),
        decrypt,
        mark: async (payerId) => {
          try {
            const out = await service.mark(
              payerId,
              "synthetic_sign_in",
              { kind: "backfill" },
              runKey,
              ctx,
            );
            return out.changed ? "changed" : "unchanged";
          } catch (err) {
            if (err instanceof NotFoundException) return "not_found";
            throw err;
          }
        },
        log: (line) => console.log(line),
      },
      { apply: args.apply, batchSize: args.batchSize },
    );
    return summary.failed > 0 ? 1 : 0;
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
        `[${MARK_SYNTHETIC_TEST_PAYERS_SCRIPT}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
