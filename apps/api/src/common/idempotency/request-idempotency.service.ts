import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PiiCryptoService } from "../pii-crypto.service";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";

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

/** Everything one guarded call needs. Route policy is a parameter; this class owns only the race. */
export interface RunOnceOptions<T> {
  /**
   * The Redis key family, e.g. `otp_idem` / `payer_idem`. SEPARATE PER DOMAIN so a key captured
   * from one surface can never replay into another, and so one domain's retention or key-space
   * decisions cannot silently reach another's.
   */
  readonly namespace: string;
  /** The route within the namespace. Two routes must not share one dedupe bucket. */
  readonly scope: string;
  /**
   * WHOSE request this is, already in a form that is safe to put in a Redis key — a keyed hash
   * for anything PII (a phone, an address), a bare uuid for an internal identifier. This class
   * does NOT hash it, deliberately: only the caller knows which of the two it holds, and hashing
   * here would double-hash the one and mis-classify the other. `SubjectRateLimit` draws the same
   * line for the same reason.
   *
   * SCOPING BY SUBJECT IS A SAFETY PROPERTY, not bookkeeping. Without it, one tenant could
   * present another tenant's key and be served their stored response.
   */
  readonly subject: string;
  /** The client's `Idempotency-Key`. Absent or blank means the work runs unguarded. */
  readonly idempotencyKey?: string;
  /** The side-effecting work. Runs at most once per (namespace, scope, subject, key). */
  readonly work: () => Promise<T>;
  /**
   * What a duplicate gets while the FIRST attempt is still running — the case this seam exists
   * for. It MAY THROW, and on a route with a financial effect it generally should: the OTP path
   * can answer optimistically because the honest answer is "a code is on its way", but a
   * purchase cannot invent a balance it has not computed. Throwing a 409 there is the truthful
   * answer, and the client re-reads state rather than re-submitting.
   *
   * The one thing it must never do is start a second execution.
   */
  readonly inFlight: () => T;
  /**
   * Encrypt the stored outcome at rest. Set it on any route whose response carries a credential.
   * Off by default, so adding a route that DOES carry one is a deliberate decision rather than
   * an omission.
   */
  readonly secret?: boolean;
  /** How long one key's outcome is honoured. Defaults to {@link RequestIdempotency.WINDOW_SECONDS}. */
  readonly windowSeconds?: number;
  /** What to call the subject in logs (`phone_hash`, `payer`). Never the value itself. */
  readonly subjectLabel?: string;
  /** Human name for this seam in logs, e.g. `OTP` / `payer`. */
  readonly logLabel?: string;
}

/**
 * RUN A SIDE-EFFECTING REQUEST AT MOST ONCE per client-supplied `Idempotency-Key`.
 *
 * THE SHAPE OF BUG THIS EXISTS FOR, which is not specific to any one route. A mobile client on a
 * weak link sends a POST, the server commits, the response is lost, and the client — or the
 * person holding it — sends the same request again. Nothing on the wire distinguishes "the
 * network ate my answer" from "I meant to do that twice", so the server does it twice. #1019 was
 * that bug on the OTP send path, where it cost duplicate paid SMS and burned four counters;
 * #1046 is the same bug on `POST /payer/credits`, where it double-grants a credit pack.
 *
 * THE ALGORITHM, and the order is the whole of it:
 *
 *   1. RESERVE with `SET NX` — BEFORE any side effect. This is a mutex, not a cache: two
 *      attempts racing in the same millisecond both reach it, exactly one wins.
 *   2. RUN the work.
 *   3. STORE the outcome, success or failure alike.
 *   4. REPLAY that outcome to every later attempt under the same key.
 *
 * A cache alone would not do. The duplicate this is built for typically lands while the FIRST
 * attempt is still running — that is what a timeout means — so there is no stored result to
 * serve yet, and only a reservation taken before the work can stop the second one starting.
 *
 * ONE KEY IS ONE EXECUTION, INCLUDING WHEN IT FAILED. The seam deliberately does NOT release on
 * failure. A transport retry is not asking to "try again", it is asking for the result of the
 * request it already made, and re-running the work is precisely what repeats the side effect.
 * Recovery from a genuine failure is a NEW user action carrying a FRESH key.
 *
 * EXTRACTED FROM `OtpRequestIdempotency` (#1019) RATHER THAN WRITTEN BESIDE IT. The logic is
 * subtle in ways that do not survive being copied — the NX-before-side-effect ordering, storing
 * failures, treating an unreadable blob as in-flight, failing OPEN here while everything
 * downstream fails closed. Two copies would drift, and the second copy would be the one nobody
 * re-derived the reasoning for. That class is now a thin wrapper over this one, and its tests
 * stand unchanged as the proof this extraction changed no behaviour.
 */
@Injectable()
export class RequestIdempotency {
  private readonly logger = new Logger(RequestIdempotency.name);

  /**
   * How long one key's outcome is honoured, in seconds.
   *
   * 180, THE SAME NUMBER AND THE SAME REASONING AS `SessionService.IDEM_GRACE_SECONDS`, because
   * it is the same client on the same retry ladder: #999 measured the last honest retry landing
   * at t≈30.9s, and 180 is ~6x that, so a device on a slower ladder — or one that suspends
   * mid-retry — still lands inside the window.
   *
   * WIDER THAN A RESEND COOLDOWN ON PURPOSE, and it does not extend anything a user can feel.
   * The key is minted per logical request, so somebody who waits and acts again arrives with a
   * NEW key and is never served from here. Only a retry of one action reuses one.
   */
  static readonly WINDOW_SECONDS = 180;

  constructor(
    private readonly pii: PiiCryptoService,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  async runOnce<T>(opts: RunOnceOptions<T>): Promise<T> {
    const key = opts.idempotencyKey?.trim();
    if (!key) return opts.work();

    const window = opts.windowSeconds ?? RequestIdempotency.WINDOW_SECONDS;
    const label = opts.subjectLabel ?? "subject";
    const name = opts.logLabel ?? opts.namespace;
    // HASHED AND TRUNCATED, NOT INTERPOLATED RAW — the `IpRateLimit` idiom ("truncate to keep
    // the Redis key bounded"), and load-bearing beyond tidiness.
    //
    // The reservation is written BEFORE the work, which on some routes is before that route's
    // only rate limit. So the caller would otherwise be choosing the size of a Redis write that
    // happens ahead of every limiter: Node accepts a ~16KB header block, this Redis runs
    // `--maxmemory-policy noeviction` with no `maxmemory`, and the keys live their full window.
    // That converts caller bandwidth into non-evictable memory on the box that holds the session
    // store — and a full Redis 429s the limiters, 503s the OTP path and 401s every session.
    //
    // Fixed 64 hex chars regardless of what arrives. A collision merges two keys into one dedupe
    // bucket, which can only ever SUPPRESS a duplicate — never cause an extra execution.
    const keyHash = this.pii.hmac(key).slice(0, 64);
    const redisKey = `${opts.namespace}:${opts.scope}:${opts.subject}:${keyHash}`;
    const handle = opts.subject.slice(0, 8);

    let redis: RedisIdemClient;
    let reserved: string | null;
    try {
      redis = (await this.queue.client) as unknown as RedisIdemClient;
      reserved = await redis.set(redisKey, IN_FLIGHT, "EX", window, "NX");
    } catch (err) {
      // FAIL OPEN, AND ONLY HERE. Everything a guarded route does downstream already fails
      // CLOSED on a Redis error — the caps, the cooldowns, the balance reads — so a Redis outage
      // still cannot produce a side effect it otherwise would not. Refusing at THIS line would
      // add a new way to take the platform down during an outage, in exchange for deduplication
      // we cannot perform anyway.
      this.logger.warn(
        `${name} idempotency unavailable scope=${opts.scope} ${label}=${handle}…; ` +
          `proceeding undeduplicated (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      return opts.work();
    }

    if (reserved === null) return this.replay(redis, redisKey, opts, handle, label, name);

    try {
      const value = await opts.work();
      await this.store(redis, redisKey, { ok: true, value }, opts, handle, label, name, window);
      return value;
    } catch (err) {
      // STORED, NOT RELEASED — the property that makes this a mutex rather than a retry helper.
      // By the time most failures throw, the side effect may already have happened (a counter
      // moved, a row written, a provider called), so releasing would let the ladder repeat it.
      // An HttpException replays as itself; anything else is not ours to reinterpret, so it
      // replays as a neutral 503.
      const outcome: StoredOutcome =
        err instanceof HttpException
          ? { ok: false, status: err.getStatus(), message: RequestIdempotency.messageOf(err) }
          : {
              ok: false,
              status: HttpStatus.SERVICE_UNAVAILABLE,
              message: "This is temporarily unavailable; please retry shortly",
            };
      await this.store(redis, redisKey, outcome, opts, handle, label, name, window);
      throw err;
    }
  }

  /**
   * Persist what happened, best effort.
   *
   * A failed write leaves the `in_flight` sentinel, whose TTL is already set — so duplicates get
   * the in-flight answer instead of a second execution. It degrades to the safe side either way,
   * and it must never convert a completed request into a failed one, which is why the throw is
   * swallowed rather than propagated.
   */
  private async store<T>(
    redis: RedisIdemClient,
    redisKey: string,
    outcome: StoredOutcome,
    opts: RunOnceOptions<T>,
    handle: string,
    label: string,
    name: string,
    window: number,
  ): Promise<void> {
    try {
      // The WHOLE outcome, not just the success value. A failure shape carries only a
      // client-visible status and message today, but branching on `ok` here would mean a future
      // field added to the failure side silently lands in plaintext — and the cost of
      // encrypting a small object once per window is nothing.
      const payload = JSON.stringify(outcome);
      await redis.set(redisKey, opts.secret ? this.pii.encrypt(payload) : payload, "EX", window);
    } catch (err) {
      this.logger.warn(
        `${name} idempotency outcome not stored scope=${opts.scope} ${label}=${handle}… ` +
          `(reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** Serve a duplicate: the stored outcome if the first attempt finished, else the in-flight answer. */
  private async replay<T>(
    redis: RedisIdemClient,
    redisKey: string,
    opts: RunOnceOptions<T>,
    handle: string,
    label: string,
    name: string,
  ): Promise<T> {
    let stored: string | null;
    try {
      stored = await redis.get(redisKey);
    } catch (err) {
      // We KNOW a reservation exists — the NX above lost to it — so the one thing we must not do
      // is run the work. The in-flight answer is the safe read of "somebody else has this".
      this.logger.warn(
        `${name} idempotency replay read failed scope=${opts.scope} ${label}=${handle}… ` +
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
      // Symmetric with `store()`: the flag comes from the CALL SITE, so a scope always reads back
      // the way it wrote. A blob written before a route was marked `secret` (or under a retired
      // key) fails to decrypt and lands in the catch below — which is the safe side.
      outcome = JSON.parse(opts.secret ? this.pii.decrypt(stored) : stored) as StoredOutcome;
    } catch {
      // Unreadable is not a licence to run the work again — the reservation still means an
      // attempt owns this key. Treat it as in flight.
      return opts.inFlight();
    }

    if (outcome.ok) return outcome.value as T;
    // The SAME status and the SAME wording the first attempt produced. Replaying the RESPONSE
    // rather than the exception CLASS is deliberate: tagged exceptions exist so a service emits
    // ONE monitoring event per real occurrence, and a retry of a request that already happened
    // is not a second occurrence.
    throw new HttpException(outcome.message, outcome.status);
  }

  /**
   * The client-visible message of an HttpException, whether it was built from a string or from
   * Nest's `{ message }` object form. Falls back to generic wording rather than risking an
   * internal detail reaching a caller.
   */
  private static messageOf(err: HttpException): string {
    const res = err.getResponse();
    if (typeof res === "string") return res;
    if (res && typeof res === "object" && "message" in res) {
      const m = (res as { message: unknown }).message;
      if (typeof m === "string") return m;
      if (Array.isArray(m) && typeof m[0] === "string") return m[0];
    }
    return "Please retry shortly";
  }
}
