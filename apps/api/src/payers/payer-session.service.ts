import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { JwtService } from "@nestjs/jwt";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { PayerRole } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/**
 * Payer sessions — a PROVIDER-AGNOSTIC session mechanism mirroring the worker
 * {@link import("../auth/session.service").SessionService} (signed JWT + a revocable
 * Redis record). ADR-0019 Decision B leaves the payer login IdP open (B-R1, Supabase
 * Auth vs bespoke); this is only the **session** layer that whichever login mints —
 * it does not decide the IdP. The JWT `sub` is the `payer_id`; the Redis key
 * `payer_session:<sid>` makes a session revocable + sliding.
 *
 * FAIL SAFE: any verify/Redis error → null → the guard responds 401. The namespace
 * is distinct from worker sessions (`payer_session:` prefix) so a worker token can
 * never satisfy the payer guard and vice-versa, even though both are HS256 JWTs.
 */
/**
 * The Redis surface this service uses. A hand-written NARROWING of the live ioredis
 * connection, not a capability limit — the object returned by `client()` is the BullMQ
 * connection and supports the full command set. Widened for ADR-0037's `revokeAllForPayer`
 * with the set commands that maintain the payer→sid index.
 */
interface RedisSessionClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

/**
 * JWT claims. `sub` = payer id, `sid` = server-side session id, `typ` pins audience.
 *
 * `role` (ADR-0022) carries the payer's vertical-authz role so `PayerRoleGuard` can gate
 * agent-only routes without a DB hit. It is OPTIONAL on the wire: sessions minted before
 * ADR-0022 carry no `role`, so it MUST be treated as possibly-absent and resolved by the
 * guard's fallback (load from the `payers` row) — never assumed. This keeps the change
 * additive + backward-compatible (no token migration; old tokens keep validating).
 */
interface PayerJwtClaims {
  sub: string;
  sid: string;
  typ: "payer";
  role?: PayerRole;
  exp?: number;
}

export interface PayerSessionToken {
  token: string;
  expiresInSeconds: number;
}

export interface ValidatedPayerSession {
  payerId: string;
  sid: string;
  remainingSeconds: number;
  /**
   * The session's vertical-authz role (ADR-0022), or `null` when this is a pre-ADR-0022
   * session that carried no role claim. `null` is NOT "no role" — it signals the guard to
   * resolve the role from the `payers` row. Callers must never treat `null` as privileged.
   */
  role: PayerRole | null;
}

@Injectable()
export class PayerSessionService {
  private readonly logger = new Logger(PayerSessionService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly jwt: JwtService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private ttlSeconds(): number {
    return this.config.SESSION_TTL_DAYS * 86400;
  }

  private async client(): Promise<RedisSessionClient> {
    return (await this.queue.client) as unknown as RedisSessionClient;
  }

  private static sessionKey(sid: string): string {
    return `payer_session:${sid}`;
  }

  /**
   * ADR-0037 — the payer→sids index backing {@link revokeAllForPayer}.
   *
   * Sessions are keyed by `sid` alone, so without this there is NO way to enumerate a
   * payer's live sessions and "suspension revokes every active session immediately" is
   * unimplementable. The set is best-effort and self-healing: entries are removed on
   * revoke, and `revokeAllForPayer` prunes any sid whose session key has already expired,
   * so a crash between the two writes leaves a stale member that costs one wasted DEL and
   * is then cleaned up. The index is given the SAME TTL as a session on every add, so an
   * abandoned payer's index expires rather than growing forever.
   */
  private static payerIndexKey(payerId: string): string {
    return `payer_sessions:${payerId}`;
  }

  /**
   * Create a new payer session: store the record and mint a JWT.
   *
   * `role` (ADR-0022) is OPTIONAL so existing callers keep compiling; when supplied it is
   * persisted in BOTH the JWT claim and the Redis blob so the vertical-authz role travels
   * with the session and the guard needs no DB hit on the hot path. Login mints WITH the
   * role (it has just loaded the `payers` row); a caller that omits it produces a
   * pre-ADR-0022-shaped session that the guard resolves via its fallback — backward-compat.
   */
  async create(payerId: string, role?: PayerRole): Promise<PayerSessionToken> {
    const sid = randomUUID();
    const ttl = this.ttlSeconds();
    const redis = await this.client();
    await redis.set(
      PayerSessionService.sessionKey(sid),
      JSON.stringify({ payer_id: payerId, ...(role ? { role } : {}) }),
      "EX",
      ttl,
    );
    // Index this sid under the payer so a suspension can revoke every live session
    // (ADR-0037). Best-effort: an index failure must never block a legitimate login —
    // the lifecycle gate in PayerAuthGuard re-reads status per request, so a session that
    // escaped the index is still stopped on its very next request.
    try {
      const indexKey = PayerSessionService.payerIndexKey(payerId);
      await redis.sadd(indexKey, sid);
      await redis.expire(indexKey, ttl);
    } catch (err) {
      this.logger.error(
        `Payer session index add failed (session still created; reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    const token = await this.jwt.signAsync(
      { sub: payerId, sid, typ: "payer", ...(role ? { role } : {}) },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: ttl };
  }

  /** Verify the token + load its Redis session, slide the TTL, return claims (or null). */
  async validateAndTouch(token: string): Promise<ValidatedPayerSession | null> {
    let claims: PayerJwtClaims;
    try {
      claims = await this.jwt.verifyAsync<PayerJwtClaims>(token, { algorithms: ["HS256"] });
    } catch {
      return null;
    }
    // Audience pin: a worker JWT (no `typ:"payer"`) can never satisfy this guard.
    if (claims.typ !== "payer" || !claims.sub || !claims.sid) return null;

    try {
      const redis = await this.client();
      const key = PayerSessionService.sessionKey(claims.sid);
      const raw = await redis.get(key);
      if (!raw) return null;
      await redis.expire(key, this.ttlSeconds());
      const nowSeconds = Math.floor(Date.now() / 1000);
      const remainingSeconds = claims.exp ? Math.max(0, claims.exp - nowSeconds) : 0;
      // Role (ADR-0022): the Redis blob is the server-side authority; fall back to the JWT
      // claim, then `null` for a pre-ADR-0022 session (the guard resolves it from the row).
      const role = PayerSessionService.readRole(raw) ?? claims.role ?? null;
      return { payerId: claims.sub, sid: claims.sid, remainingSeconds, role };
    } catch (err) {
      this.logger.error(
        `Payer session Redis error; treating as unauthenticated (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /**
   * Mint a fresh JWT for an already-validated payer+session (rolling refresh).
   *
   * `role` (ADR-0022) is preserved across the refresh so a rolling token does not lose the
   * vertical-authz role it already carried. It is OPTIONAL (existing callers unchanged): the
   * guard passes the role it resolved this request, so once a fallback has run, the refreshed
   * token carries the role and subsequent requests skip the DB hit.
   */
  async mint(payerId: string, sid: string, role?: PayerRole): Promise<PayerSessionToken> {
    const token = await this.jwt.signAsync(
      { sub: payerId, sid, typ: "payer", ...(role ? { role } : {}) },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: this.ttlSeconds() };
  }

  /** Parse the persisted role from the Redis session blob (tolerant of legacy shapes). */
  private static readRole(raw: string): PayerRole | null {
    try {
      const blob = JSON.parse(raw) as { role?: unknown };
      return blob.role === "employer" || blob.role === "agent" ? blob.role : null;
    } catch {
      return null;
    }
  }

  /** Revoke a payer session (logout): delete its Redis record. Best-effort. */
  async revoke(sid: string, payerId?: string): Promise<void> {
    try {
      const redis = await this.client();
      await redis.del(PayerSessionService.sessionKey(sid));
      // Keep the payer→sids index tight when we know the owner (logout supplies it).
      // Omitting it is harmless: revokeAllForPayer prunes members whose session is gone.
      if (payerId) await redis.srem(PayerSessionService.payerIndexKey(payerId), sid);
    } catch (err) {
      this.logger.error(
        `Payer session revoke Redis error (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  /**
   * ADR-0037 — revoke EVERY live session for a payer. Called when a payer is suspended,
   * so an already-issued token stops working immediately rather than at its next
   * expiry (payer sessions slide to a fresh 30 days on every request, so "expiry" is
   * effectively never for an active client).
   *
   * Returns the number of session keys actually deleted, so the caller can log/assert
   * that revocation happened rather than assuming it.
   *
   * THROWS on Redis failure — deliberately unlike {@link revoke}, which is best-effort
   * because a failed logout is an inconvenience. A failed revoke-all during suspension is
   * a security event: the caller must be able to tell that the sessions are still live
   * and refuse to report the suspension as fully enforced.
   */
  async revokeAllForPayer(payerId: string): Promise<number> {
    const redis = await this.client();
    const indexKey = PayerSessionService.payerIndexKey(payerId);
    const sids = await redis.smembers(indexKey);
    if (sids.length === 0) {
      // No index (pre-ADR-0037 session, or none live). Nothing enumerable to delete —
      // those sessions are stopped by the per-request lifecycle gate in PayerAuthGuard.
      await redis.del(indexKey);
      return 0;
    }
    const deleted = await redis.del(...sids.map((s) => PayerSessionService.sessionKey(s)));
    await redis.del(indexKey);
    return deleted;
  }
}
