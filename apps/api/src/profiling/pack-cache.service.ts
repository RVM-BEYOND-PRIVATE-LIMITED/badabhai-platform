/**
 * The L2 (Redis) tier behind {@link PackRegistryService} — shared by every API instance.
 *
 * WHAT IT ACTUALLY BUYS, because it is not what the name suggests. Pack CONTENT was already
 * cached in-process, keyed `packId:version`. What was never cached is the RESOLUTION in front of
 * it: `resolveForOccupation` runs `findBindings` + `findActivePacks` on the way to that cache, and
 * `resolvePacks` calls `loadUniversal` — which is `resolveForOccupation(null, …)` — on EVERY turn
 * of EVERY interview. `findBindings` is a `SELECT` over `profiling_family_binding` with NO `WHERE`
 * clause, filtered in JS. So the hot path paid two uncached round trips per turn, one of them a
 * full table read, to re-derive an answer that changes when a reviewer publishes a pack.
 *
 * TWO KEY SPACES, BECAUSE THEY GO STALE FOR DIFFERENT REASONS AND AT DIFFERENT SPEEDS:
 *
 *   `packcontent:v1:<packId>:<version>` — the pack itself, at `PACK_CACHE_TTL_SECONDS`.
 *
 *     THE TTL IS NOT REDUNDANT, however immutable this key looks. `PackRegistryService`'s header
 *     says a pack version never changes ("a new version is a new key"), and that is the authoring
 *     DISCIPLINE rather than an enforced invariant: `seed-question-packs.ts` upserts
 *     `question_pack` on `(pack_id, version)` and then deletes and re-inserts that version's items
 *     and options, so `db:seed:packs --apply` after editing a JSON file rewrites content under the
 *     same key. Caching it forever — the obvious optimisation — would turn a routine re-seed into
 *     permanent, cross-instance poisoning that only a manual Redis flush could clear. The expiry
 *     is what bounds that to one TTL, and it must survive until the seeder refuses to touch a
 *     published version.
 *
 *   `packresolve:v1:<locale>:<jobDomainId>:<iscoUnitCode>` — which pack a trade resolves TO, at
 *     the much shorter `PACK_RESOLUTION_TTL_SECONDS`. This moves faster: a reviewer flips a
 *     version to `active`, or authors the first pack for a family that was falling through, and
 *     that should reach an instance in a minute rather than a quarter of an hour.
 *
 * A MISS AND A CACHED "NOTHING" ARE DIFFERENT ANSWERS, hence {@link CacheLookup}. Half the
 * corpus's families are unauthored at any time (Phase 6 lands ~200 incrementally), and their
 * trades resolve to the universal pack through a chain that ends in nothing. Collapsing "not
 * cached" into "no pack" with a bare `null` would make every one of those workers re-run the full
 * table read on every turn — the exact case the cache exists for.
 *
 * FAILS OPEN, ALWAYS, and this is the deliberate opposite of the rate limiters and the spend
 * ledger, which fail closed. Being wrong there permits an unaccounted spend; being wrong here
 * costs a Postgres query that was happening anyway. A cache that can refuse to serve an interview
 * is worse than no cache — so every method here swallows its own errors and reports a miss.
 *
 * A TRY/CATCH IS NOT ENOUGH TO ACHIEVE THAT, which is the single least obvious thing in this file.
 * `queue.module.ts` builds the shared connection with `maxRetriesPerRequest: null`, and nothing in
 * this repo sets `enableOfflineQueue` — so ioredis defaults it to `true`. Under that pair a
 * command issued while the connection is down is BUFFERED IN MEMORY AND NEVER REJECTS: it waits
 * for a reconnect that may never come. The `catch` is unreachable, the `await` never returns, and
 * a Redis outage stops being a slow interview and becomes a HUNG one — on the chat hot path, for
 * every worker at once.
 *
 * {@link REDIS_TIMEOUT_MS} is what actually delivers the fail-open promise: every command races a
 * timer and loses to it by default. That bound is the contract; the try/catch is only there for
 * the errors that DO surface (a malformed reply, a serialization failure).
 *
 * NO PII, BY CONSTRUCTION. Keys are a locale, a catalogue id and an ISCO code; values are reviewed
 * pack copy identical for every worker. Nothing worker-derived reaches this class, which is what
 * makes a SHARED cache safe here and nowhere else in the chat path.
 */

import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { QuestionPackSchema, type QuestionPack } from "@badabhai/ai-contracts";

import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import {
  hashSerialized,
  resolutionKey,
  PACK_CACHE_TTL_SECONDS,
  PACK_RESOLUTION_TTL_SECONDS,
} from "./pack-cache.constants";

const CONTENT_PREFIX = "packcontent:v1";
const RESOLUTION_PREFIX = "packresolve:v1";

/**
 * How long any single Redis command may take before it is abandoned as a miss.
 *
 * THIS IS THE FAIL-OPEN MECHANISM, not the try/catch — see the class doc for why a command against
 * a downed connection never rejects at all. Without this bound a Redis outage hangs every
 * profiling turn in the process.
 *
 * 150 ms is ~two orders of magnitude above a healthy same-network round trip (low single-digit ms
 * on the compose network / VPC) and still far below anything a worker would notice, so it cannot
 * trip on a merely loaded box while still bounding a dead one. The comparable timeout on the
 * ai-service spend ledger is 2 s, but that one guards a fail-CLOSED check where a false timeout
 * blocks a real spend; here a false timeout costs one Postgres query, so it can be aggressive.
 */
export const REDIS_TIMEOUT_MS = 150;

/** Which pack a resolution landed on. `null` = the chain ran and produced nothing. */
export interface PackRef {
  readonly packId: string;
  readonly version: number;
}

/**
 * A cache read. `hit: false` means "we do not know"; `hit: true` with `value: null` means "we
 * know, and the answer is nothing". See the class doc — the distinction is load-bearing.
 */
export type CacheLookup<T> = { readonly hit: false } | { readonly hit: true; readonly value: T };

const MISS = { hit: false } as const;

/**
 * Minimal typed view of the Redis commands this needs. BullMQ's `IRedisClient` declares only the
 * subset BullMQ itself uses; the runtime client is ioredis, which has the variadic `EX` form.
 * Narrowed to an interface rather than `any` so the call sites stay type-checked — the same
 * pattern as `ChatTranscriptBuffer`, `SubjectRateLimit` and `SessionService`.
 */
interface RedisPackCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/**
 * The stored shape of a cached pack.
 *
 * `pack` IS A STRING, not a nested object, and the double encoding is the point: the hash covers
 * the exact bytes that were stored, so verifying it needs no assumption about key ordering
 * surviving a `JSON.parse` → Zod → `JSON.stringify` round trip. It does not — see
 * {@link hashSerialized}.
 */
interface CachedPack {
  readonly content_hash: string;
  readonly pack: string;
}

/** Sentinel for "the race was won by the timer". A unique object, so no real value can equal it. */
const TIMED_OUT = Symbol("pack-cache-timeout");

@Injectable()
export class PackCacheService {
  private readonly logger = new Logger(PackCacheService.name);

  constructor(
    // REUSES BULLMQ'S CONNECTION — the house rule, stated in comments in at least four files:
    // do NOT open a second Redis client. `RESUME_RENDER_QUEUE` is injected only to obtain that
    // client, exactly as `RateLimitModule` does ("registers RESUME_RENDER_QUEUE only to obtain
    // that client — no second connection"). This class never enqueues anything.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private async client(): Promise<RedisPackCacheClient> {
    return (await this.queue.client) as unknown as RedisPackCacheClient;
  }

  /**
   * Run a Redis interaction under {@link REDIS_TIMEOUT_MS}, yielding `fallback` if it does not
   * settle in time. The one place the fail-open promise is actually kept.
   *
   * `await this.client()` IS INSIDE THE RACE, deliberately. BullMQ's `client` is itself a promise
   * that resolves on connection; during an outage it can be pending, so a timeout that only
   * covered the command would still be preceded by an unbounded await.
   *
   * THE LOSING PROMISE IS EXPLICITLY DEFUSED. `Promise.race` does not cancel the loser — it keeps
   * running, and if it later rejects (the reconnect finally fails) that rejection has no handler
   * and takes the process down under Node's default `unhandledRejection` behaviour. Attaching a
   * no-op catch is what makes abandoning it safe.
   */
  private async guard<T>(operation: string, work: (client: RedisPackCacheClient) => Promise<T>, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const attempt = (async () => work(await this.client()))();
      attempt.catch(() => undefined);
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), REDIS_TIMEOUT_MS);
      });
      const outcome = await Promise.race([attempt, timeout]);
      if (outcome === TIMED_OUT) {
        this.logger.warn(
          `pack cache timed out after ${REDIS_TIMEOUT_MS}ms on ${operation}; ` +
            `falling through to the database`,
        );
        return fallback;
      }
      return outcome;
    } catch (error) {
      this.logger.warn(
        `pack cache could not ${operation}; falling through to the database ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private redisResolutionKey(
    locale: string,
    jobDomainId: string | null,
    iscoUnitCode: string | null,
  ) {
    return `${RESOLUTION_PREFIX}:${resolutionKey(locale, jobDomainId, iscoUnitCode)}`;
  }

  private contentKey(packId: string, version: number) {
    return `${CONTENT_PREFIX}:${packId}:${version}`;
  }

  /** Which pack this occupation resolves to, if we have already worked it out. */
  async readResolution(
    locale: string,
    jobDomainId: string | null,
    iscoUnitCode: string | null,
  ): Promise<CacheLookup<PackRef | null>> {
    const key = this.redisResolutionKey(locale, jobDomainId, iscoUnitCode);
    return this.guard<CacheLookup<PackRef | null>>(
      "read resolution",
      async (client) => {
        const raw = await client.get(key);
        if (raw === null) return MISS;
        const parsed: unknown = JSON.parse(raw);
        // The cached "nothing" sentinel. Written as JSON `null`, read back as the definite answer
        // that the chain produced no pack.
        if (parsed === null) return { hit: true, value: null };
        if (
          typeof parsed === "object" &&
          typeof (parsed as PackRef).packId === "string" &&
          Number.isInteger((parsed as PackRef).version)
        ) {
          const { packId, version } = parsed as PackRef;
          return { hit: true, value: { packId, version } };
        }
        // Anything else is a value we did not write. Treated as a miss rather than trusted or
        // repaired — the database is one query away and is never wrong.
        this.logger.warn(`pack resolution cache held an off-contract value; ignoring it`);
        return MISS;
      },
      MISS,
    );
  }

  /** Record which pack an occupation resolves to — including that it resolves to nothing. */
  async writeResolution(
    locale: string,
    jobDomainId: string | null,
    iscoUnitCode: string | null,
    value: PackRef | null,
  ): Promise<void> {
    const key = this.redisResolutionKey(locale, jobDomainId, iscoUnitCode);
    await this.guard(
      "write resolution",
      (client) => client.set(key, JSON.stringify(value), "EX", PACK_RESOLUTION_TTL_SECONDS),
      undefined,
    );
  }

  /**
   * A validated pack, or null on any miss / any doubt.
   *
   * VALIDATED ON THE WAY OUT OF REDIS, not merely on the way in, and for the same reason
   * `PackRegistryService` re-validates on the way out of Postgres: this is the object a live
   * interview reads, and the store is shared, evictable and writable by any instance — including
   * one running a different build. A pack that fails here is dropped and the caller falls through
   * to the database.
   *
   * THE HASH IS CHECKED TOO, because `safeParse` alone is not enough. `QuestionPackSchema` accepts
   * a pack with FEWER items perfectly happily — a truncated or partially-written value can be
   * structurally valid and semantically wrong, which is the failure mode that would serve a worker
   * half an interview with no error anywhere.
   *
   * CHECKED BEFORE PARSING, over the raw stored string. Hashing the PARSED object instead would
   * compare a digest of schema-ordered keys against one of literal-ordered keys and never match —
   * the integrity check would reject every entry and the shared tier would silently do nothing.
   * See {@link hashSerialized}.
   */
  async readPack(packId: string, version: number): Promise<QuestionPack | null> {
    const key = this.contentKey(packId, version);
    return this.guard<QuestionPack | null>(
      "read pack",
      async (client) => {
        const raw = await client.get(key);
        if (raw === null) return null;
        const envelope = JSON.parse(raw) as CachedPack;
        if (typeof envelope?.pack !== "string") {
          this.logger.warn(`cached pack ${packId}:${version} is off-envelope; dropping the entry`);
          return null;
        }
        const actual = hashSerialized(envelope.pack);
        if (actual !== envelope.content_hash) {
          this.logger.warn(
            `cached pack ${packId}:${version} failed its integrity check ` +
              `(stored ${envelope.content_hash}, computed ${actual}); dropping the entry`,
          );
          return null;
        }
        const parsed = QuestionPackSchema.safeParse(JSON.parse(envelope.pack));
        if (!parsed.success) {
          this.logger.warn(
            `cached pack ${packId}:${version} failed contract validation; dropping the entry`,
          );
          return null;
        }
        return parsed.data;
      },
      null,
    );
  }

  /**
   * Store a pack, with the expiry the class doc explains is load-bearing.
   *
   * The hash is computed here over the SERIALIZED pack rather than taken from `pack.content_hash`,
   * so that it describes exactly the bytes being written — which is what makes the read-side check
   * meaningful and, crucially, satisfiable at all.
   *
   * AN EMPTY PACK IS NEVER PUBLISHED, and that guard is not paranoia. `seed-question-packs.ts`
   * runs OUTSIDE a transaction: it DELETEs a version's items and then re-INSERTs them, so a
   * `load()` landing inside that window reads zero rows, builds a pack that
   * `QuestionPackSchema` accepts (it does not require a minimum item count), and hashes it
   * SELF-CONSISTENTLY — the integrity check above cannot catch it, because the emptiness is
   * faithfully recorded. Refusing to share a pack with no items is the one cheap check that
   * stops a re-seed from broadcasting an empty interview to every instance for a full TTL.
   * A partial (not empty) read remains a residual risk; only a transactional seeder closes it.
   */
  async writePack(pack: QuestionPack): Promise<void> {
    if (pack.items.length === 0) {
      this.logger.warn(
        `refusing to share pack ${pack.pack_id}:${pack.version} — it has no items, which most ` +
          `likely means it was read mid-reseed; leaving the shared tier untouched`,
      );
      return;
    }
    const key = this.contentKey(pack.pack_id, pack.version);
    const serialized = JSON.stringify(pack);
    const envelope: CachedPack = {
      content_hash: hashSerialized(serialized),
      pack: serialized,
    };
    const body = JSON.stringify(envelope);
    await this.guard(
      "write pack",
      (client) => client.set(key, body, "EX", PACK_CACHE_TTL_SECONDS),
      undefined,
    );
  }

}
