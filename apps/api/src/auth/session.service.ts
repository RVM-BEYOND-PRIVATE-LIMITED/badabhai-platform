import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { JwtService } from "@nestjs/jwt";
import { Queue } from "bullmq";
import { randomBytes, randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { sha256Hex } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { computeRollingSession, istDateString } from "./session-tiers";

/**
 * Minimal typed view of the raw Redis commands the session store needs. The runtime
 * client is ioredis (obtained from the BullMQ queue), which supports the optional
 * `NX`/`EX` variadic `set` form + the set commands used for the worker-session lineage.
 */
interface RedisSessionClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  /** `SET key val NX EX sec` — atomic create-if-absent (rotation lock). */
  set(key: string, value: string, nx: "NX", ex: "EX", seconds: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

/** JWT claims we sign. `sub` = worker id, `sid` = server-side session id. */
interface WorkerJwtClaims {
  sub: string;
  sid: string;
  exp?: number;
}

/** The Redis `session:<sid>` record (ADR-0026 — extended, old records default safely). */
interface SessionRecord {
  worker_id: string;
  /** The refresh FAMILY this session belongs to (so a deliberate logout kills it). */
  family_id?: string;
  created_via_otp_at_ms?: number;
  absolute_expiry_ms?: number;
  active_days?: string[];
  tier?: number;
}

/** The Redis `refresh:<sha256(token)>` record. The token VALUE is never stored. */
interface RefreshRecord {
  sid: string;
  family_id: string;
  worker_id: string;
  used: boolean;
  superseded_by: string | null;
  created_at_ms: number;
  /**
   * The epoch-ms of the OTP that minted this session's family — the IMMUTABLE absolute-cap
   * anchor. Copied UNCHANGED onto every rotated refresh record in the family; ONLY a fresh
   * OTP (a new `create()`) starts a new clock. (ADR-0026: "only an OTP resets that clock".)
   */
  created_via_otp_at_ms: number;
}

export interface SessionToken {
  token: string;
  expiresInSeconds: number;
}

/** An opaque rotating refresh token handed to the client (the value, never persisted). */
export interface RefreshToken {
  token: string;
  expiresInSeconds: number;
}

/** Session introspection surfaced by GET /auth/session (tier/expiry — no secrets). */
export interface SessionView {
  tier: number;
  /** Epoch-ms the current session record's idle TTL expires at. */
  expiresAtMs: number;
  /** Epoch-ms the absolute cap fires (gate ON), else null (gate OFF → no cap). */
  requiresOtpAfterMs: number | null;
}

/** The result of a successful mint (create or rotate): access + refresh + view. */
export interface MintedSession {
  access: SessionToken;
  refresh: RefreshToken;
  session: SessionView;
}

export interface ValidatedSession {
  workerId: string;
  sid: string;
  /** Seconds until the CURRENT token expires (per its JWT `exp`). */
  remainingSeconds: number;
}

/** A typed reason a refresh failed (mapped to 401 by the controller). */
export type RefreshFailure = "invalid" | "reuse_detected" | "requires_otp";

export type RefreshOutcome = { ok: true; minted: MintedSession } | { ok: false; reason: RefreshFailure };

/**
 * Rolling worker sessions backed by a signed JWT + a Redis session record, PLUS
 * (ADR-0026 Phase 1) an opaque ROTATING refresh token with reuse detection + token
 * families + an idempotency grace window, and an engagement-tiered rolling idle TTL
 * with a hard 90d absolute cap.
 *
 * BACK-COMPAT: the original short-access-JWT + `session:<sid>` rolling behavior is
 * UNCHANGED when AUTH_ROLLING_TIERS_ENABLED is false (the default). The refresh-token
 * endpoints are always live (additive); only the tiered idle-TTL / absolute-cap
 * BEHAVIOR is gated. Existing HS256 JWTs and `validateAndTouch`/`refresh`/`revoke`/
 * `mint` keep working exactly as before.
 *
 * PRIVACY (CLAUDE.md §2): the refresh TOKEN VALUE is NEVER persisted or logged — only
 * `sha256(token)` is a Redis key (mirrors how OtpService stores only the OTP HMAC).
 * Event payloads carry opaque ids/counts only.
 *
 * FAIL CLOSED: any verify/Redis error returns null/`invalid` → the caller responds 401
 * (matches OtpService/the existing session behavior).
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  /**
   * Idempotency-grace TTL (seconds) — an honest double-refresh returns the cached mint.
   * Kept short (ample for a flaky-network retry) to narrow the by-design single-in-grace
   * replay window (ADR-0026 residual risk).
   */
  private static readonly IDEM_GRACE_SECONDS = 30;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly jwt: JwtService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private ttlSeconds(): number {
    return this.config.SESSION_TTL_DAYS * 86400;
  }

  private absoluteMaxSeconds(): number {
    return this.config.AUTH_SESSION_ABSOLUTE_MAX_DAYS * 86400;
  }

  private refreshTtlSeconds(): number {
    return this.config.AUTH_REFRESH_TTL_DAYS * 86400;
  }

  private async client(): Promise<RedisSessionClient> {
    return (await this.queue.client) as unknown as RedisSessionClient;
  }

  private static sessionKey(sid: string): string {
    return `session:${sid}`;
  }
  private static workerSessionsKey(workerId: string): string {
    return `worker_sessions:${workerId}`;
  }
  private static workerFamiliesKey(workerId: string): string {
    return `worker_families:${workerId}`;
  }
  private static refreshKey(tokenHash: string): string {
    return `refresh:${tokenHash}`;
  }
  private static refreshFamilyKey(familyId: string): string {
    return `refresh_family:${familyId}`;
  }
  private static idemKey(sid: string, idempotencyKey: string): string {
    return `refresh_idem:${sid}:${idempotencyKey}`;
  }

  /**
   * Create a new session for `workerId` after OTP: store the (extended) record, mint a
   * JWT, mint a fresh refresh token + family, and register the sid under the worker's
   * session set. Returns the access token + the opaque refresh token + the session view.
   */
  async create(workerId: string): Promise<MintedSession> {
    const sid = randomUUID();
    const familyId = randomUUID();
    const nowMs = Date.now();
    const istToday = istDateString(nowMs);
    const redis = await this.client();

    const record: SessionRecord = {
      worker_id: workerId,
      family_id: familyId,
      created_via_otp_at_ms: nowMs,
      absolute_expiry_ms: nowMs + this.absoluteMaxSeconds() * 1000,
      active_days: [istToday],
      tier: 0,
    };
    // Idle TTL on create: flat SESSION_TTL_DAYS unless the tier behavior is enabled.
    const ttlSec = this.config.AUTH_ROLLING_TIERS_ENABLED
      ? this.computeTtlOnCreate(record, nowMs)
      : this.ttlSeconds();

    await redis.set(SessionService.sessionKey(sid), JSON.stringify(record), "EX", ttlSec);
    await this.trackWorkerSession(redis, workerId, sid, familyId);

    const access = await this.mintAccess(workerId, sid);
    // The OTP that mints this session is the IMMUTABLE absolute-cap anchor — only a new
    // create() (= a fresh OTP) starts a new clock; rotation copies it forward unchanged.
    const refresh = await this.mintRefresh(redis, {
      sid,
      familyId,
      workerId,
      createdViaOtpAtMs: nowMs,
    });

    return { access, refresh, session: this.viewOf(record, ttlSec, nowMs) };
  }

  /** Idle TTL for a freshly created record when tiers are ON (tier 0 → its idle days). */
  private computeTtlOnCreate(record: SessionRecord, nowMs: number): number {
    const rolled = computeRollingSession({
      createdViaOtpAtMs: record.created_via_otp_at_ms ?? nowMs,
      activeDays: record.active_days ?? [],
      nowMs,
      absoluteMaxDays: this.config.AUTH_SESSION_ABSOLUTE_MAX_DAYS,
      tierWindowDays: this.config.AUTH_TIER_WINDOW_DAYS,
    });
    // A just-created session can never be expired, but be defensive.
    return rolled.expired ? this.ttlSeconds() : rolled.ttlSec;
  }

  private viewOf(record: SessionRecord, ttlSec: number, nowMs: number): SessionView {
    return {
      tier: record.tier ?? 0,
      expiresAtMs: nowMs + ttlSec * 1000,
      // requires_otp_after is the absolute cap ONLY when the gate is on; null otherwise.
      requiresOtpAfterMs: this.config.AUTH_ROLLING_TIERS_ENABLED
        ? (record.absolute_expiry_ms ?? null)
        : null,
    };
  }

  /**
   * Verify the token + load its Redis session, RESET the session TTL (sliding —
   * this is the rolling behavior), and return the claims. Returns null on any
   * failure (bad signature, expired JWT, missing/revoked session, Redis error).
   *
   * When AUTH_ROLLING_TIERS_ENABLED is false this slides the flat SESSION_TTL_DAYS
   * exactly as before. When true, the slide uses the tier-based idle TTL and the
   * absolute cap is enforced (a past-cap session is treated as invalid → 401).
   */
  async validateAndTouch(token: string): Promise<ValidatedSession | null> {
    let claims: WorkerJwtClaims;
    try {
      // Pin the accepted algorithm (defense-in-depth — reject anything but HS256,
      // including `alg:none`), matching the HS256 sign option in AuthModule.
      claims = await this.jwt.verifyAsync<WorkerJwtClaims>(token, { algorithms: ["HS256"] });
    } catch {
      return null; // bad signature / expired / malformed / wrong alg
    }
    if (!claims.sub || !claims.sid) return null;

    try {
      const redis = await this.client();
      const key = SessionService.sessionKey(claims.sid);
      const raw = await redis.get(key);
      if (!raw) return null; // revoked or expired server-side

      if (this.config.AUTH_ROLLING_TIERS_ENABLED) {
        const slid = await this.slideTiered(redis, key, raw, claims.sub);
        if (!slid) return null; // past absolute cap → force OTP
      } else {
        // Original behavior: slide the flat SESSION_TTL_DAYS forward.
        await redis.expire(key, this.ttlSeconds());
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const remainingSeconds = claims.exp ? Math.max(0, claims.exp - nowSeconds) : 0;
      return { workerId: claims.sub, sid: claims.sid, remainingSeconds };
    } catch (err) {
      this.logger.error(
        `Session Redis error; treating as unauthenticated (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /**
   * Roll the session record forward one tier-step and reset its idle TTL. Returns the
   * updated record + ttl, or null when past the absolute cap (caller forces OTP). Old
   * records lacking the new fields default safely (created_via_otp_at_ms ⇒ now,
   * active_days ⇒ []).
   */
  private async slideTiered(
    redis: RedisSessionClient,
    key: string,
    raw: string,
    workerId: string,
  ): Promise<{ record: SessionRecord; ttlSec: number } | null> {
    const nowMs = Date.now();
    const record = this.parseRecord(raw, workerId, nowMs);

    const rolled = computeRollingSession({
      createdViaOtpAtMs: record.created_via_otp_at_ms ?? nowMs,
      activeDays: record.active_days ?? [],
      nowMs,
      absoluteMaxDays: this.config.AUTH_SESSION_ABSOLUTE_MAX_DAYS,
      tierWindowDays: this.config.AUTH_TIER_WINDOW_DAYS,
    });
    if (rolled.expired) return null;

    const updated: SessionRecord = {
      worker_id: record.worker_id,
      family_id: record.family_id, // preserve the family so logout can kill the lineage
      created_via_otp_at_ms: record.created_via_otp_at_ms ?? nowMs,
      absolute_expiry_ms: rolled.absoluteExpiryMs,
      active_days: rolled.activeDays,
      tier: rolled.tier,
    };
    await redis.set(key, JSON.stringify(updated), "EX", rolled.ttlSec);
    return { record: updated, ttlSec: rolled.ttlSec };
  }

  /** Parse a session record, defaulting missing ADR-0026 fields safely (old records). */
  private parseRecord(raw: string, fallbackWorkerId: string, nowMs: number): SessionRecord {
    let parsed: SessionRecord;
    try {
      parsed = JSON.parse(raw) as SessionRecord;
    } catch {
      parsed = { worker_id: fallbackWorkerId };
    }
    return {
      worker_id: parsed.worker_id ?? fallbackWorkerId,
      family_id: parsed.family_id,
      created_via_otp_at_ms: parsed.created_via_otp_at_ms ?? nowMs,
      absolute_expiry_ms:
        parsed.absolute_expiry_ms ?? nowMs + this.absoluteMaxSeconds() * 1000,
      active_days: Array.isArray(parsed.active_days) ? parsed.active_days : [],
      tier: typeof parsed.tier === "number" ? parsed.tier : 0,
    };
  }

  /**
   * Validate the current token and, if valid, mint a FRESH JWT (new full-length exp)
   * for the same session. Returns null when the session is invalid. UNCHANGED legacy
   * path used by `POST /auth/refresh` (kept working during cutover).
   */
  async refresh(token: string): Promise<SessionToken | null> {
    const session = await this.validateAndTouch(token);
    if (!session) return null;
    return this.mintAccess(session.workerId, session.sid);
  }

  /** Mint a fresh JWT for an already-validated worker+session (rolling refresh). */
  async mint(workerId: string, sid: string): Promise<SessionToken> {
    return this.mintAccess(workerId, sid);
  }

  private async mintAccess(workerId: string, sid: string): Promise<SessionToken> {
    const token = await this.jwt.signAsync(
      { sub: workerId, sid },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: this.ttlSeconds() };
  }

  /**
   * Mint + persist a new opaque refresh token in `family`. Stores ONLY sha256(token)
   * (the value is returned to the caller and never logged/persisted), and SADDs the
   * hash to the family lineage. TTL = AUTH_REFRESH_TTL_DAYS.
   */
  private async mintRefresh(
    redis: RedisSessionClient,
    args: { sid: string; familyId: string; workerId: string; createdViaOtpAtMs: number },
  ): Promise<RefreshToken> {
    const rawToken = randomBytes(32).toString("hex"); // 256-bit opaque secret
    const tokenHash = sha256Hex(rawToken);
    const ttl = this.refreshTtlSeconds();
    const record: RefreshRecord = {
      sid: args.sid,
      family_id: args.familyId,
      worker_id: args.workerId,
      used: false,
      superseded_by: null,
      created_at_ms: Date.now(),
      created_via_otp_at_ms: args.createdViaOtpAtMs,
    };
    await redis.set(SessionService.refreshKey(tokenHash), JSON.stringify(record), "EX", ttl);
    await redis.sadd(SessionService.refreshFamilyKey(args.familyId), tokenHash);
    await redis.expire(SessionService.refreshFamilyKey(args.familyId), ttl);
    return { token: rawToken, expiresInSeconds: ttl };
  }

  /**
   * Register a sid (and its refresh family) under the worker's lineage sets so a
   * deliberate logout/logout-all can find and kill the refresh tokens (not just the
   * session record). Idempotent (SADD), and called on BOTH create() and every rotation.
   *
   * The set TTLs are armed to `refreshTtlSeconds()` — NOT `absoluteMaxSeconds()` — so the
   * lineage sets always OUTLIVE the `refresh:<hash>` records they index (which themselves
   * re-arm to refreshTtl on every rotation). Otherwise, in the gate-OFF (no absolute-cap)
   * corner, a worker who keeps rotating past the lineage-set TTL would leave logout-all
   * iterating an EMPTY worker_families set, so an outstanding (possibly stolen) refresh
   * token would survive logout-all and resurrect the session. The boot guard ensures
   * refreshTtl >= absoluteMax, so this never shortens the absolute-cap horizon.
   */
  private async trackWorkerSession(
    redis: RedisSessionClient,
    workerId: string,
    sid: string,
    familyId: string,
  ): Promise<void> {
    const sessionsKey = SessionService.workerSessionsKey(workerId);
    await redis.sadd(sessionsKey, sid);
    await redis.expire(sessionsKey, this.refreshTtlSeconds());

    const familiesKey = SessionService.workerFamiliesKey(workerId);
    await redis.sadd(familiesKey, familyId);
    await redis.expire(familiesKey, this.refreshTtlSeconds());
  }

  /**
   * Rotate an opaque refresh token (ADR-0026 §Refresh rotation + reuse detection).
   *
   *  1. Load `refresh:<sha256(token)>`. Missing ⇒ invalid (401).
   *  2. Idempotency grace: if `idempotencyKey` and the cached mint exists, return it
   *     (an honest double-refresh / flaky-network retry — do NOT rotate again, do NOT
   *     flag reuse).
   *  3. Reuse detection: a record already `used` (and no idem hit) ⇒ revoke the WHOLE
   *     family + the session, emit `worker.refresh_reuse_detected`, return reuse (401).
   *  4. Otherwise rotate atomically (a SET NX lock prevents two concurrent rotations of
   *     the same token both succeeding): mark used, mint a new token in the same family,
   *     mint a fresh access JWT for the same sid, run the (gated) rolling-session update,
   *     cache the mint under the idem key, and return the new pair. A past-absolute-cap
   *     update ⇒ revoke + requires_otp (401).
   *
   * Routine rotation deliberately emits NO event (it is not a material state change and
   * would flood the events spine — only the security-material reuse fact is recorded).
   */
  async refreshByToken(rawToken: string, idempotencyKey: string): Promise<RefreshOutcome> {
    let redis: RedisSessionClient;
    try {
      redis = await this.client();
    } catch {
      return { ok: false, reason: "invalid" }; // fail closed
    }

    const tokenHash = sha256Hex(rawToken);

    try {
      const raw = await redis.get(SessionService.refreshKey(tokenHash));
      if (!raw) return { ok: false, reason: "invalid" };
      const rec = JSON.parse(raw) as RefreshRecord;

      // 2. Idempotency grace — return the cached mint for an honest retry. The cache is
      // ENCRYPTED at rest (it holds live bearer secrets — the rotated refresh token + the
      // access JWT), so no plaintext credential ever sits in Redis (mirrors the refresh-key
      // hash + the OTP-HMAC rule).
      if (idempotencyKey) {
        const cachedMint = await this.readIdem(redis, rec.sid, idempotencyKey);
        if (cachedMint) return { ok: true, minted: cachedMint };
      }

      // 3. Reuse detection — a replayed already-used token nukes the family.
      if (rec.used) {
        await this.revokeFamily(redis, rec.family_id, rec.sid, rec.worker_id);
        await this.events.emit({
          event_name: "worker.refresh_reuse_detected",
          actor: { actor_type: "worker", actor_id: rec.worker_id },
          subject: { subject_type: "worker", subject_id: rec.worker_id },
          payload: { worker_id: rec.worker_id, family_id: rec.family_id },
        });
        return { ok: false, reason: "reuse_detected" };
      }

      // 4a. Rotation lock: SET NX so two concurrent rotations of the SAME token cannot
      // both proceed (the loser sees the lock and is treated as an honest retry that
      // missed the idem cache → invalid, never a false reuse-flag of the just-minted new
      // token). The lock auto-expires with the grace window.
      const lockKey = `refresh_lock:${tokenHash}`;
      const locked = await redis.set(lockKey, "1", "NX", "EX", SessionService.IDEM_GRACE_SECONDS);
      if (locked !== "OK") {
        // Another rotation of this exact token is in flight. If it cached an idem result
        // under this key, return that; otherwise fail closed (invalid) — never rotate
        // twice and never flag reuse on a race.
        if (idempotencyKey) {
          const cachedMint = await this.readIdem(redis, rec.sid, idempotencyKey);
          if (cachedMint) return { ok: true, minted: cachedMint };
        }
        return { ok: false, reason: "invalid" };
      }

      // 4b. Run the gated rolling-session update on the session record. The OTP anchor is
      // the IMMUTABLE absolute-cap clock carried on the refresh lineage — pass it through so
      // a lapse-then-refresh re-anchors from the ORIGINAL OTP, not now (only an OTP resets).
      const sessionView = await this.rotateSession(
        redis,
        rec.sid,
        rec.worker_id,
        rec.created_via_otp_at_ms,
      );
      if (!sessionView) {
        // Past the absolute cap (only possible when the gate is on) — revoke + force OTP.
        await this.revokeFamily(redis, rec.family_id, rec.sid, rec.worker_id);
        return { ok: false, reason: "requires_otp" };
      }

      // 4c. Mark the presented token used, mint a fresh access JWT + a new refresh token in
      // the same family. The OTP anchor (created_via_otp_at_ms) is copied UNCHANGED — only a
      // fresh OTP (a new create()) starts a new absolute clock.
      const newRawToken = randomBytes(32).toString("hex");
      const newHash = sha256Hex(newRawToken);
      const usedRec: RefreshRecord = { ...rec, used: true, superseded_by: newHash };
      await redis.set(
        SessionService.refreshKey(tokenHash),
        JSON.stringify(usedRec),
        "EX",
        this.refreshTtlSeconds(),
      );

      const newRefreshRecord: RefreshRecord = {
        sid: rec.sid,
        family_id: rec.family_id,
        worker_id: rec.worker_id,
        used: false,
        superseded_by: null,
        created_at_ms: Date.now(),
        created_via_otp_at_ms: rec.created_via_otp_at_ms, // immutable OTP anchor — never reset
      };
      await redis.set(
        SessionService.refreshKey(newHash),
        JSON.stringify(newRefreshRecord),
        "EX",
        this.refreshTtlSeconds(),
      );
      await redis.sadd(SessionService.refreshFamilyKey(rec.family_id), newHash);
      await redis.expire(SessionService.refreshFamilyKey(rec.family_id), this.refreshTtlSeconds());

      // Re-arm the worker LINEAGE sets (worker_sessions + worker_families) on every
      // rotation, mirroring how the refresh records themselves re-arm. Without this the
      // sets are armed only at create() and a long-rotating family would let them expire
      // out from under the still-alive refresh tokens — leaving logout-all iterating an
      // empty set and an outstanding (stolen) token surviving (resurrection). SADD is
      // idempotent; this only refreshes both set TTLs to refreshTtlSeconds().
      await this.trackWorkerSession(redis, rec.worker_id, rec.sid, rec.family_id);

      const access = await this.mintAccess(rec.worker_id, rec.sid);
      const minted: MintedSession = {
        access,
        refresh: { token: newRawToken, expiresInSeconds: this.refreshTtlSeconds() },
        session: sessionView,
      };

      // 4d. Cache the mint (ENCRYPTED) for the idempotency grace window (honest double-
      // refresh) — never plaintext bearer secrets at rest.
      if (idempotencyKey) {
        await redis.set(
          SessionService.idemKey(rec.sid, idempotencyKey),
          this.pii.encrypt(JSON.stringify(minted)),
          "EX",
          SessionService.IDEM_GRACE_SECONDS,
        );
      }

      // 4e. Release the rotation lock on success so an honest sequential retry within the
      // window hits the idem cache instead of being needlessly fail-closed (UX, no security
      // impact — the presented token is already marked used, so it cannot re-rotate).
      await redis.del(lockKey);

      return { ok: true, minted };
    } catch (err) {
      this.logger.error(
        `Refresh rotation Redis error; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return { ok: false, reason: "invalid" };
    }
  }

  /** Read + decrypt the encrypted idem cache; null when absent (or undecryptable). */
  private async readIdem(
    redis: RedisSessionClient,
    sid: string,
    idempotencyKey: string,
  ): Promise<MintedSession | null> {
    const cached = await redis.get(SessionService.idemKey(sid, idempotencyKey));
    if (!cached) return null;
    try {
      return JSON.parse(this.pii.decrypt(cached)) as MintedSession;
    } catch {
      // A corrupt/old plaintext blob → treat as a miss (fail safe; the lock prevents a
      // double rotation). Never throw out of a refresh.
      return null;
    }
  }

  /**
   * Update the `session:<sid>` record on a refresh. Returns the session view, or null
   * when past the absolute cap (gate on). When the gate is OFF this slides the flat
   * SESSION_TTL_DAYS (no behavior change) and never expires here.
   *
   * `createdViaOtpAtMs` is the IMMUTABLE OTP anchor carried on the refresh lineage — used
   * to re-anchor a LAPSED (record-absent) tiered session from the ORIGINAL OTP, so the 90d
   * absolute cap cannot be reset by a lapse-then-refresh (only a fresh OTP resets it).
   */
  private async rotateSession(
    redis: RedisSessionClient,
    sid: string,
    workerId: string,
    createdViaOtpAtMs: number,
  ): Promise<SessionView | null> {
    const key = SessionService.sessionKey(sid);
    const raw = await redis.get(key);
    const nowMs = Date.now();

    if (!this.config.AUTH_ROLLING_TIERS_ENABLED) {
      // Flat slide — recreate the record if missing (refresh keeps a session alive),
      // preserving the worker id + family. No absolute cap (gate OFF — byte-identical
      // to the pre-ADR-0026 behavior).
      const record = raw
        ? this.parseRecord(raw, workerId, nowMs)
        : {
            worker_id: workerId,
            tier: 0,
            active_days: [],
            created_via_otp_at_ms: createdViaOtpAtMs,
          };
      await redis.set(key, JSON.stringify(record), "EX", this.ttlSeconds());
      return this.viewOf(record, this.ttlSeconds(), nowMs);
    }

    // Tiered behavior.
    if (!raw) {
      // The session record lapsed (idle TTL hit) while a refresh token was still valid.
      // Re-anchor from the ORIGINAL OTP — NOT now — so the absolute cap holds. If the
      // original OTP is already past the absolute cap, force OTP (return null).
      const absoluteExpiryMs = createdViaOtpAtMs + this.absoluteMaxSeconds() * 1000;
      if (nowMs >= absoluteExpiryMs) return null;

      const rolled = computeRollingSession({
        createdViaOtpAtMs,
        activeDays: [],
        nowMs,
        absoluteMaxDays: this.config.AUTH_SESSION_ABSOLUTE_MAX_DAYS,
        tierWindowDays: this.config.AUTH_TIER_WINDOW_DAYS,
      });
      if (rolled.expired) return null;
      const record: SessionRecord = {
        worker_id: workerId,
        created_via_otp_at_ms: createdViaOtpAtMs,
        absolute_expiry_ms: rolled.absoluteExpiryMs,
        active_days: rolled.activeDays,
        tier: rolled.tier,
      };
      await redis.set(key, JSON.stringify(record), "EX", rolled.ttlSec);
      return this.viewOf(record, rolled.ttlSec, nowMs);
    }

    // The present record already preserves its own OTP anchor; slideTiered keeps it.
    const slid = await this.slideTiered(redis, key, raw, workerId);
    if (!slid) return null;
    return this.viewOf(slid.record, slid.ttlSec, nowMs);
  }

  /** A read-only session view for GET /auth/session (no slide, no secrets). */
  async describe(workerId: string, sid: string): Promise<SessionView | null> {
    try {
      const redis = await this.client();
      const raw = await redis.get(SessionService.sessionKey(sid));
      if (!raw) return null;
      const nowMs = Date.now();
      const record = this.parseRecord(raw, workerId, nowMs);
      // Report the remaining idle TTL as best-effort from the absolute window; the exact
      // Redis TTL isn't read here (introspection only). expires_at is the idle horizon.
      const idleMs = Math.max(0, (record.absolute_expiry_ms ?? nowMs) - nowMs);
      return {
        tier: record.tier ?? 0,
        expiresAtMs: nowMs + idleMs,
        requiresOtpAfterMs: this.config.AUTH_ROLLING_TIERS_ENABLED
          ? (record.absolute_expiry_ms ?? null)
          : null,
      };
    } catch (err) {
      this.logger.error(
        `Session describe Redis error (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    }
  }

  /**
   * Revoke a single session (logout). Deletes the session record AND its whole refresh
   * FAMILY (every `refresh:<hash>` + the family set), so a deliberate logout cannot be
   * undone by replaying an outstanding (un-rotated) refresh token — that token's record
   * is gone, so `refreshByToken` hits its `!raw` guard → 401 (no resurrection). Reads the
   * session record to find its family; if the record already lapsed, the family lapses at
   * its own TTL (still un-resurrectable once the session record is gone). Best-effort/
   * fail-safe: never throws out of logout.
   */
  async revoke(sid: string, workerId?: string): Promise<void> {
    try {
      const redis = await this.client();
      const raw = await redis.get(SessionService.sessionKey(sid));
      const familyId = raw ? this.parseRecord(raw, workerId ?? "", Date.now()).family_id : undefined;
      const wid = workerId ?? (raw ? this.parseRecord(raw, "", Date.now()).worker_id : "");

      if (familyId) {
        // Kills every refresh:<hash> in the lineage + the family set + the session + both
        // set memberships (worker_sessions + worker_families) in one place.
        await this.revokeFamily(redis, familyId, sid, wid);
      } else {
        // No family on the record (lapsed/legacy) — at least delete the session + memberships.
        await redis.del(SessionService.sessionKey(sid));
        if (wid) await redis.srem(SessionService.workerSessionsKey(wid), sid);
      }
    } catch (err) {
      // Best-effort: a revoke that can't reach Redis still returns; the session
      // will lapse at its TTL. Never throw out of logout.
      this.logger.error(
        `Session revoke Redis error (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /**
   * Revoke EVERY active session for a worker (logout-all). Reads the worker's FAMILY set
   * and kills each family (deleting every outstanding `refresh:<hash>` + family set +
   * session + membership), then cleans up any remaining `session:<sid>` in the session set
   * and deletes both lineage sets. Emits `worker.logged_out_all` with the count of session
   * records actually deleted. Best-effort on Redis errors (count 0).
   *
   * SECURITY: because the refresh records are deleted, a replayed (un-rotated) refresh
   * token after logout-all hits the `!raw` guard in `refreshByToken` → `invalid` (401):
   * no refresh-token session resurrection.
   */
  async revokeAll(workerId: string): Promise<number> {
    let count = 0;
    try {
      const redis = await this.client();
      const sessionsKey = SessionService.workerSessionsKey(workerId);
      const familiesKey = SessionService.workerFamiliesKey(workerId);

      // Kill every refresh FAMILY the worker holds: delete every outstanding
      // refresh:<hash> + the family set. (Driven off worker_families so we catch families
      // whose session record already lapsed.)
      const familyIds = await redis.smembers(familiesKey);
      for (const familyId of familyIds) {
        const hashes = await redis.smembers(SessionService.refreshFamilyKey(familyId));
        if (hashes.length > 0) {
          await redis.del(...hashes.map((h) => SessionService.refreshKey(h)));
        }
        await redis.del(SessionService.refreshFamilyKey(familyId));
      }

      // Delete every session record the worker holds, counting the ones that existed.
      const sids = await redis.smembers(sessionsKey);
      if (sids.length > 0) {
        count = await redis.del(...sids.map((s) => SessionService.sessionKey(s)));
      }

      // Delete both lineage sets.
      await redis.del(sessionsKey, familiesKey);
    } catch (err) {
      this.logger.error(
        `logout-all Redis error (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      count = 0;
    }

    await this.events.emit({
      event_name: "worker.logged_out_all",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId, sessions_revoked: count },
    });
    return count;
  }

  /**
   * Revoke an entire refresh-token FAMILY (reuse detection): delete every refresh hash
   * in the lineage, the family set, the session record, and drop the sid from the worker
   * set. Best-effort/idempotent (del of a missing key is a no-op).
   */
  private async revokeFamily(
    redis: RedisSessionClient,
    familyId: string,
    sid: string,
    workerId: string,
  ): Promise<void> {
    const familyKey = SessionService.refreshFamilyKey(familyId);
    const hashes = await redis.smembers(familyKey);
    if (hashes.length > 0) {
      await redis.del(...hashes.map((h) => SessionService.refreshKey(h)));
    }
    await redis.del(familyKey);
    await redis.del(SessionService.sessionKey(sid));
    await redis.srem(SessionService.workerSessionsKey(workerId), sid);
    if (workerId) await redis.srem(SessionService.workerFamiliesKey(workerId), familyId);
  }
}
