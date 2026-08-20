import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/**
 * Minimal typed view of the Redis commands this seam needs. BullMQ's `IRedisClient` declares
 * only the subset BullMQ itself uses; the runtime client is ioredis, which has these. Narrowed
 * to an interface rather than `any` so the call sites below stay type-checked — the same idiom
 * `OtpService` and `IpRateLimit` already use.
 */
interface RedisIdemClient {
  set(key: string, value: string, mode: "EX", seconds: number, nx: "NX"): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** What a completed attempt left behind, as stored. */
type StoredOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** The sentinel written by the winning reservation, before the work has finished. */
const IN_FLIGHT = "in_flight";

/**
 * Makes an OTP-send route idempotent under a client-supplied `Idempotency-Key` (#1019).
 *
 * THE BUG THIS EXISTS FOR. The worker app retries an idempotent write up to three times on a
 * TRANSPORT failure, reusing ONE key across all attempts (`AuthedClient`, ladder measured in
 * #999: t=0, t≈15.3s, t≈30.9s). `/auth/token/refresh` honoured that header; `/auth/otp/request`
 * did not. Our audience is on flaky links and a real Fast2SMS send can outlive the client's 15s
 * timeout, so the ordinary case was: server sends, response is lost, client retries with the
 * same key, server treats it as a brand-new request. One tap fanned out to as many as three
 * counted sends and three paid SMS, against FOUR separate counters — per-phone hourly (5),
 * per-phone daily (10), per-IP hourly, and the platform-wide daily breaker (2000).
 *
 * That is why the report was "429 after about two uses, on every number and every device": two
 * taps could exhaust a per-phone hourly cap of five, and the same amplification burned the
 * global breaker — which, once tripped, 429s EVERY worker on EVERY device until UTC midnight.
 *
 * ONE KEY IS ONE SEND, INCLUDING WHEN IT FAILED. A reservation is taken with `SET NX` BEFORE
 * any counter moves, and the outcome — success or failure — is then stored under that same key
 * and replayed to every later attempt. The seam deliberately does NOT release on failure:
 * "retry the send" is not what a transport retry is asking for, it is asking for the result of
 * the request it already made, and re-running the work is precisely what re-increments the
 * counters. A worker whose send genuinely failed recovers through the resend cooldown with a
 * FRESH key (the client mints a new UUID per user-initiated call), which is the shorter window
 * of the two and therefore the one that governs.
 *
 * PRIVACY (§2). The key namespace carries `hashPhone(phone)`, never the number itself — the
 * same rule `OtpService` follows for every one of its keys. The stored value is a route response
 * that already went over the wire to this caller (`{ success, channel, resend_in_seconds }`), so
 * unlike the refresh grace there is no credential at rest here and nothing to encrypt.
 *
 * SCOPED PER ROUTE AND PER PHONE. `otp_idem:<scope>:<phoneHash>:<keyHash>` — so a key captured from
 * one flow cannot replay into another, and login and PIN-reset never collide on a client that
 * happens to reuse a UUID across them.
 */
@Injectable()
export class OtpRequestIdempotency {
  private readonly logger = new Logger(OtpRequestIdempotency.name);

  /**
   * How long one key's outcome is honoured, in seconds.
   *
   * 180, THE SAME NUMBER AND THE SAME REASONING AS `SessionService.IDEM_GRACE_SECONDS`, because
   * it is the same client on the same retry ladder: #999 measured the last honest retry landing
   * at t≈30.9s, and 180 is ~6× that, so a device on a slower ladder — or one that suspends
   * mid-retry — still lands inside the window.
   *
   * WIDER THAN THE 30s RESEND COOLDOWN ON PURPOSE, and it does not extend anything a worker can
   * feel. The key is minted per `AuthedClient.send()` call, so a worker who waits out the
   * cooldown and taps "resend" arrives with a NEW key and is never served from here. Only a
   * transport retry — which is not a second request — reuses one.
   */
  static readonly WINDOW_SECONDS = 180;

  constructor(
    private readonly pii: PiiCryptoService,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Run `work` at most once per `(scope, phone, idempotencyKey)`.
   *
   * With NO key the work runs unguarded, which is deliberate: the header is OPTIONAL on these
   * routes. `/auth/token/refresh` can demand it because the credential is in the body and every
   * caller is our own client; `/auth/otp/request` is the front door, and 400-ing a caller that
   * omits a header it was never asked for would be a breaking API change (§3) to fix a bug that
   * only affects callers who DO send one.
   *
   * `inFlight` supplies what a duplicate gets while the first attempt is still running — the
   * case the whole bug is made of, since the client's 15s timeout is shorter than a slow
   * Fast2SMS send. Answering it optimistically is correct: either the in-flight attempt lands
   * and the worker has their code, or it does not and the cooldown lets them ask again. What it
   * must never do is start a second send.
   */
  async runOnce<T>(opts: {
    readonly scope: string;
    readonly phoneE164: string;
    readonly idempotencyKey?: string;
    readonly work: () => Promise<T>;
    readonly inFlight: () => T;
  }): Promise<T> {
    const key = opts.idempotencyKey?.trim();
    if (!key) return opts.work();

    const phoneHash = this.pii.hashPhone(opts.phoneE164);
    // HASHED AND TRUNCATED, NOT INTERPOLATED RAW — the `IpRateLimit.assertWithinHourlyIpCap`
    // idiom ("Truncate to keep the Redis key bounded"), and load-bearing for a different reason
    // here than there.
    //
    // The reservation below is written BEFORE `work()`, and `work()` is now where this route's
    // only rate limit lives. So on an UNAUTHENTICATED front-door route, the client would
    // otherwise be choosing the size of a Redis write that happens ahead of every limiter:
    // Node accepts a ~16KB header block, this Redis runs `--maxmemory-policy noeviction` with
    // no `maxmemory`, and the keys live their full 180s. That converts attacker bandwidth into
    // non-evictable memory on the box that holds the session store — and when that Redis fills,
    // `IpRateLimit` 429s, `OtpService` 503s and `SessionService` 401s, which is the
    // platform-wide lockout this change exists to END, handed to anyone with a socket.
    //
    // Fixed 64 hex chars regardless of what arrives. A collision merges two keys into one
    // dedupe bucket, which can only ever suppress a duplicate — never send an extra SMS.
    const keyHash = this.pii.hmac(key).slice(0, 64);
    const redisKey = OtpRequestIdempotency.key(opts.scope, phoneHash, keyHash);
    const hashPrefix = phoneHash.slice(0, 8);

    let redis: RedisIdemClient;
    let reserved: string | null;
    try {
      redis = (await this.queue.client) as unknown as RedisIdemClient;
      // RESERVE BEFORE ANY COUNTER MOVES. `NX` is what makes this a mutex and not merely a
      // cache: two attempts racing in the same millisecond both reach here, exactly one wins,
      // and the loser cannot start a second send.
      reserved = await redis.set(
        redisKey,
        IN_FLIGHT,
        "EX",
        OtpRequestIdempotency.WINDOW_SECONDS,
        "NX",
      );
    } catch (err) {
      // FAIL OPEN, and only here. Everything downstream of this line already fails CLOSED on a
      // Redis error — the caps, the cooldown, the code store — so a Redis outage still cannot
      // send an SMS or move a counter. Refusing the request at THIS line would add a new way to
      // lock every worker out during an outage in exchange for deduplication we cannot perform
      // anyway. Never logs the phone; the hash prefix is the same handle used elsewhere.
      this.logger.warn(
        `OTP idempotency unavailable scope=${opts.scope} phone_hash=${hashPrefix}; ` +
          `proceeding undeduplicated (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      return opts.work();
    }

    if (reserved === null) return this.replay(redis, redisKey, opts, hashPrefix);

    try {
      const value = await opts.work();
      await this.store(redis, redisKey, { ok: true, value }, opts.scope, hashPrefix);
      return value;
    } catch (err) {
      // STORED, NOT RELEASED. By the time most failures are thrown the counters have already
      // moved (the hourly cap increments before it checks, and a provider 502 is thrown after
      // all three counters and the global breaker), so releasing would let the retry ladder
      // spend the budget a second and third time — the exact amplification this class exists to
      // stop. An HttpException replays as itself; anything else is not ours to reinterpret, so
      // it replays as the 503 the OTP path already returns for an unexpected fault.
      const outcome: StoredOutcome =
        err instanceof HttpException
          ? { ok: false, status: err.getStatus(), message: OtpRequestIdempotency.messageOf(err) }
          : {
              ok: false,
              status: HttpStatus.SERVICE_UNAVAILABLE,
              message: "This is temporarily unavailable; please retry shortly",
            };
      await this.store(redis, redisKey, outcome, opts.scope, hashPrefix);
      throw err;
    }
  }

  /**
   * Persist what happened, best effort.
   *
   * A failed write leaves the `in_flight` sentinel, whose TTL is already set — so duplicates get
   * the optimistic answer instead of a second send. It degrades to the safe side either way, and
   * it must never convert a completed request into a failed one, which is why the throw is
   * swallowed rather than propagated.
   */
  private async store(
    redis: RedisIdemClient,
    redisKey: string,
    outcome: StoredOutcome,
    scope: string,
    hashPrefix: string,
  ): Promise<void> {
    try {
      await redis.set(
        redisKey,
        JSON.stringify(outcome),
        "EX",
        OtpRequestIdempotency.WINDOW_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `OTP idempotency outcome not stored scope=${scope} phone_hash=${hashPrefix} ` +
          `(reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** Serve a duplicate: the stored outcome if the first attempt finished, else the optimist. */
  private async replay<T>(
    redis: RedisIdemClient,
    redisKey: string,
    opts: { readonly scope: string; readonly inFlight: () => T; readonly work: () => Promise<T> },
    hashPrefix: string,
  ): Promise<T> {
    let stored: string | null;
    try {
      stored = await redis.get(redisKey);
    } catch (err) {
      // We KNOW a reservation exists — the NX above lost to it — so the one thing we must not
      // do is run the work. The optimistic answer is the safe read of "somebody else has this".
      this.logger.warn(
        `OTP idempotency replay read failed scope=${opts.scope} phone_hash=${hashPrefix} ` +
          `(reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      return opts.inFlight();
    }

    // Expired between the NX and the GET, which is a genuine race rather than a duplicate: the
    // window has closed, so this attempt is entitled to be a request of its own.
    if (stored === null) return opts.work();
    if (stored === IN_FLIGHT) return opts.inFlight();

    let outcome: StoredOutcome;
    try {
      outcome = JSON.parse(stored) as StoredOutcome;
    } catch {
      // Unreadable is not a licence to send again — the reservation still means an attempt owns
      // this key. Treat it as in flight.
      return opts.inFlight();
    }

    if (outcome.ok) return outcome.value as T;
    // The SAME status and the SAME wording the first attempt produced. Replaying the response
    // rather than the exception CLASS is deliberate: the tagged send-failure and cap-breach
    // exceptions exist so `AuthService` emits ONE monitoring event per real occurrence, and a
    // retry of a request that already happened is not a second occurrence.
    throw new HttpException(outcome.message, outcome.status);
  }

  /**
   * `otp_idem:<scope>:<phoneHash>:<keyHash>` — fixed width, and neither the raw phone (§2)
   * nor the raw client header (see the bound at the call site).
   */
  private static key(scope: string, phoneHash: string, idempotencyKeyHash: string): string {
    return `otp_idem:${scope}:${phoneHash}:${idempotencyKeyHash}`;
  }

  /**
   * The client-visible message of an HttpException, whether it was built from a string or from
   * Nest's `{ message }` object form. Falls back to the generic throttle wording rather than
   * risking an internal detail reaching a worker.
   */
  private static messageOf(err: HttpException): string {
    const res = err.getResponse();
    if (typeof res === "string") return res;
    if (res && typeof res === "object" && "message" in res) {
      const m = (res as { message: unknown }).message;
      if (typeof m === "string") return m;
      if (Array.isArray(m) && typeof m[0] === "string") return m[0];
    }
    return "Please wait before requesting another code";
  }
}
