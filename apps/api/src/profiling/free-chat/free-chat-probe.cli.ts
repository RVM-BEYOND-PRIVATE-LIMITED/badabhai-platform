/**
 * The free-chat probe — step 1 of the ADR-0051 §10 improvement loop (#2128), run by hand with the
 * owner's approval each time.
 *
 *   node apps/api/dist/profiling/free-chat/free-chat-probe.cli.js \
 *     --since=2026-10-07 [--until=<date | ISO instant with offset>] [--sample=N]
 *
 * (`pnpm --filter @badabhai/api build` first; on the box the api image already carries `dist/`.)
 *
 * WHAT IT PRINTS. Part A, always: counts over the window's free-chat events — served turns by mode ×
 * decided_by × category × outcome with the classifier's confidence buckets, the struggle rates over
 * worker messages, clarify loops and repeated deflections, mode changes, summary folds, news
 * requests, and the free chat's `ai.cost_recorded` spend and latency. Part B, only with `--sample=N`
 * (1..50, owner ruling R29): up to N of the newest messages the bot STRUGGLED with, each masked
 * before it is printed and dropped whole when it cannot be. stdout only; nothing is stored, no file
 * is written.
 *
 * PART B RUNS ON THE BOX ONLY (owner ruling). `--sample` is refused unless `NODE_ENV=production` and
 * the api's PII keys pass the api's own boot gate (`assertPiiCryptoConfig`): a laptop — dev keys, or
 * any other NODE_ENV — never reads a worker's words, even masked.
 *
 * READ ONLY, ENFORCED THREE WAYS. The shared ops guard is asked as a NON-mutating runner (it refuses
 * an unset DATABASE_URL and announces a production-like target); every read runs inside ONE
 * transaction opened `read only` (repeatable read, so part A and part B see one snapshot), bounded by
 * statement, lock and idle timeouts; and the server's own `transaction_read_only` must read `on`
 * before the first query of a business table, or the probe stops.
 *
 * ELIGIBILITY (owner ruling R36). A worker's lines are sampled only while their latest consent is
 * active for `profiling` and no deletion is scheduled. Eligibility is read first, for every struggled
 * turn (two columns per worker, no text); an ineligible worker's turns are then left out of the link
 * counts and are never linked, read or decrypted, and each is counted `not_eligible` when examined.
 *
 * NAMES. Part B masks the worker's own name (`free-chat-probe.mask.ts`). The name is read with
 * `WorkersRepository.findFullNameToken` — the `full_name` column alone — and decrypted by the shared
 * `decryptWorkerName`, the same decision `ChatService.readWorkerName` makes. A name that is missing,
 * blank or will not decrypt drops the line. The plaintext lives only in this process's memory.
 *
 * NEVER PRINTED: the DATABASE_URL, any key, any id. A failure is printed as the probe's own refusal
 * or through `logSafeReason`, which never echoes a query's bound parameters.
 */
import { assertPiiCryptoConfig, loadServerConfig } from "@badabhai/config";
import { createDbClient, enforceOpsGuard, type Database } from "@badabhai/db";
import { logSafeReason } from "../../common/db-error";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { decryptWorkerName } from "../../common/worker-name-read";
import { hasActiveConsent, type LatestConsentReader } from "../../consent/consent-active";
import { ConsentRepository } from "../../consent/consent.repository";
import { WorkersRepository } from "../../workers/workers.repository";
import {
  FREE_CHAT_AI_TASKS,
  FREE_CHAT_PROBE_SCRIPT,
  ProbeRefusal,
  assertReadOnlyTransaction,
  drawFreeChatSample,
  parseFreeChatProbeArgs,
  readProbeEvents,
  type FreeChatProbeArgs,
  type FreeChatSample,
} from "./free-chat-probe";
import { FreeChatProbeRepository, type TransactionBounds } from "./free-chat-probe.repository";
import { renderFreeChatProbeReport, type FreeChatProbeData } from "./free-chat-probe.report";

/** The run's transaction bounds — a probe must never hold, block or stall production's pooler. */
export const PROBE_TRANSACTION_BOUNDS: TransactionBounds = {
  statementMs: 60_000,
  lockMs: 5_000,
  idleInTransactionMs: 120_000,
};

/**
 * The worker's decrypted `full_name`, or null when none is on file, it is blank, or it will not
 * decrypt — collapsed to the one answer the mask needs (any null drops the line). Reads the
 * `full_name` column alone. Never logs the value or the token.
 */
export async function readKnownName(
  workers: Pick<WorkersRepository, "findFullNameToken">,
  pii: Pick<PiiCryptoService, "decrypt">,
  workerId: string,
): Promise<string | null> {
  const read = decryptWorkerName(await workers.findFullNameToken(workerId), pii);
  return read.ok && read.name !== null && read.name.trim() !== "" ? read.name : null;
}

/**
 * May this worker's lines be sampled at all? Owner ruling R36 (2026-10-08, DPDP): only when the
 * worker's LATEST consent row is not revoked and names `profiling` — `hasActiveConsent`, the rule the
 * consent guard and every off-request AI step already use — and no account deletion is scheduled.
 *
 * Reads two columns of each: `workers.status, deletion_scheduled_at` (`findSelfView`) and the latest
 * consent's `purposes, revoked_at` (`findLatestStateByWorker`). Asked FIRST — before the link counts
 * and any link, text read or decrypt. A worker row that is gone is not eligible; a consent read that
 * throws is "no"
 * (`hasActiveConsent` fails closed).
 */
export async function isSampleEligible(
  workers: Pick<WorkersRepository, "findSelfView">,
  consents: LatestConsentReader,
  workerId: string,
): Promise<boolean> {
  const self = await workers.findSelfView(workerId);
  if (self === undefined || self.deletionScheduledAt !== null) return false;
  return hasActiveConsent(consents, workerId, "profiling");
}

/** The consent rule's reader over the two-column projection — never the row's other columns. */
export function latestConsentState(consents: ConsentRepository): LatestConsentReader {
  return { findLatestByWorker: (workerId) => consents.findLatestStateByWorker(workerId) };
}

/**
 * The api's PII crypto for `--sample`, or a refusal. Part B runs on the box only: `NODE_ENV` must be
 * `production`, and the config must pass the api's own boot gate — which refuses the dev-default
 * pepper and key, an all-zero key and a half-set keyring outside development.
 */
export function samplePiiCrypto(env: NodeJS.ProcessEnv): PiiCryptoService {
  if (env.NODE_ENV !== "production") {
    throw new ProbeRefusal(
      "REFUSING --sample: part B (real worker lines, masked) runs on the box only — NODE_ENV must " +
        "be production. Part A runs anywhere; drop --sample.",
    );
  }
  try {
    const config = loadServerConfig(env);
    assertPiiCryptoConfig(config, env.NODE_ENV);
    return new PiiCryptoService(config);
  } catch (err) {
    throw new ProbeRefusal(
      `REFUSING --sample: the api's PII key configuration is not production-ready, so no name could ` +
        `be read to mask it. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Part A's reads — five event names, each narrowed through the registry. */
async function readAggregates(
  repo: FreeChatProbeRepository,
  args: FreeChatProbeArgs,
): Promise<FreeChatProbeData> {
  return {
    turns: readProbeEvents(
      "chat.free_chat_turn_served",
      await repo.eventsInWindow("chat.free_chat_turn_served", args),
    ),
    modeChanges: readProbeEvents(
      "chat.free_chat_mode_changed",
      await repo.eventsInWindow("chat.free_chat_mode_changed", args),
    ),
    summaries: readProbeEvents(
      "chat.free_chat_summary_updated",
      await repo.eventsInWindow("chat.free_chat_summary_updated", args),
    ),
    news: readProbeEvents(
      "chat.free_chat_news_served",
      await repo.eventsInWindow("chat.free_chat_news_served", args),
    ),
    costs: readProbeEvents(
      "ai.cost_recorded",
      await repo.costEventsInWindow(args, FREE_CHAT_AI_TASKS),
    ),
  };
}

/** The whole probe, inside one read-only transaction. Returns the report; prints nothing. */
async function probe(
  db: Database,
  args: FreeChatProbeArgs,
  pii: PiiCryptoService | null,
): Promise<string[]> {
  const repo = new FreeChatProbeRepository(db);
  assertReadOnlyTransaction(await repo.transactionReadOnly());
  await repo.boundTransaction(PROBE_TRANSACTION_BOUNDS);

  const data = await readAggregates(repo, args);
  let sample: FreeChatSample | null = null;
  if (args.sample !== null && pii !== null) {
    const workers = new WorkersRepository(db);
    const consents = latestConsentState(new ConsentRepository(db));
    sample = await drawFreeChatSample(data.turns.events, args.sample, {
      eligible: (workerId) => isSampleEligible(workers, consents, workerId),
      linkedLines: (refs) => repo.linkedLines(refs),
      linkCounts: (refs) => repo.linkCounts(refs),
      knownName: (workerId) => readKnownName(workers, pii, workerId),
    });
  }
  return renderFreeChatProbeReport(args, data, sample);
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseFreeChatProbeArgs(argv, new Date());
  const log = (line: string) => console.log(line);
  let connectionString: string;
  try {
    // NOT mutating: the guard waves a read through, refuses an unset target, and prints the target's
    // CLASS (never its address) when it is production-like.
    ({ connectionString } = enforceOpsGuard({
      script: FREE_CHAT_PROBE_SCRIPT,
      connectionString: process.env.DATABASE_URL,
      mutating: false,
      log,
    }));
  } catch (err) {
    throw new ProbeRefusal(err instanceof Error ? err.message : String(err));
  }
  // Refused BEFORE any connection is opened.
  const pii = args.sample === null ? null : samplePiiCrypto(process.env);

  const client = createDbClient(connectionString, { max: 1 });
  try {
    // THE ONE TRANSACTION. Drizzle opens it with `begin` and issues `set transaction isolation level
    // repeatable read read only` before the callback runs; the callback then asks the server whether
    // that took. The transaction handle is the `Database` shape every repository takes — the one
    // cast, where the callback meets the client (the `withTransaction` convention).
    const report = await client.db.transaction(
      (tx) => probe(tx as unknown as Database, args, pii),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    // Printed only after the transaction ended cleanly: a failure part-way prints no partial report.
    for (const line of report) log(line);
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
        `[${FREE_CHAT_PROBE_SCRIPT}] failed: ${
          err instanceof ProbeRefusal ? err.message : logSafeReason(err, FREE_CHAT_PROBE_SCRIPT)
        }`,
      );
      process.exitCode = 1;
    });
}
