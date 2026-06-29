import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { JwtService } from "@nestjs/jwt";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { AdminRepository } from "./admin.repository";

/**
 * Admin sessions (ADR-0025 ADMIN-1, Decision 2.2) — the 4th principal's session layer,
 * mirroring {@link import("../payers/payer-session.service").PayerSessionService} EXACTLY:
 * a signed HS256 JWT (`sub` = admin id, `sid` = server-side session id, **`typ:"admin"`**
 * audience pin) + a revocable Redis record (**own namespace** `admin_session:<sid>`,
 * distinct from `payer_session:`/worker `session:`), rolling refresh past the half-life.
 *
 * ISOLATION (the central security property): the admin token is signed with the admin's
 * OWN secret (`ADMIN_JWT_SECRET`, distinct from the worker/payer `JWT_SECRET`) AND pinned
 * to `typ:"admin"` AND stored under a distinct Redis namespace. A worker/payer JWT can
 * therefore NEVER satisfy {@link import("./admin-auth.guard").AdminAuthGuard} (wrong
 * signature + wrong typ + wrong namespace), and an admin JWT can never satisfy the
 * worker/payer guards. The `role` claim carries the RBAC role so AdminRolesGuard gates
 * without a DB hit.
 *
 * FAIL SAFE: any verify/Redis error → null → the guard responds 401.
 */
interface RedisSessionClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** JWT claims. `sub` = admin id, `sid` = server-side session id, `typ` pins the audience. */
interface AdminJwtClaims {
  sub: string;
  sid: string;
  typ: "admin";
  role: AdminRole;
  exp?: number;
}

export interface AdminSessionToken {
  token: string;
  expiresInSeconds: number;
}

export interface ValidatedAdminSession {
  adminId: string;
  sid: string;
  role: AdminRole;
  remainingSeconds: number;
}

@Injectable()
export class AdminSessionService {
  private readonly logger = new Logger(AdminSessionService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly jwt: JwtService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
    private readonly admins: AdminRepository,
  ) {}

  private ttlSeconds(): number {
    return this.config.SESSION_TTL_DAYS * 86400;
  }

  private async client(): Promise<RedisSessionClient> {
    return (await this.queue.client) as unknown as RedisSessionClient;
  }

  /** Own namespace — a payer/worker session key can never collide with an admin one. */
  private static sessionKey(sid: string): string {
    return `admin_session:${sid}`;
  }

  /**
   * Create a new admin session: store the revocable record (admin id + role) and mint the
   * signed `typ:"admin"` JWT. The `role` travels in the Redis blob and the JWT claim for
   * observability/refresh continuity ONLY — it is NOT trusted for authz: `validateAndTouch`
   * re-reads the live `admin_users` row each request and uses the row's status + role (H1).
   */
  async create(adminId: string, role: AdminRole): Promise<AdminSessionToken> {
    const sid = randomUUID();
    const ttl = this.ttlSeconds();
    const redis = await this.client();
    await redis.set(
      AdminSessionService.sessionKey(sid),
      JSON.stringify({ admin_id: adminId, role }),
      "EX",
      ttl,
    );
    const token = await this.jwt.signAsync(
      { sub: adminId, sid, typ: "admin", role },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: ttl };
  }

  /**
   * Verify the token + load its Redis session, slide the TTL, return claims (or null).
   *
   * STALE-PRIVILEGE DEFENSE (ADMIN-3a must-fix H1): the Redis blob + JWT `role` claim are
   * minted at login and NEVER trusted for the live status/role on a subsequent request — a
   * suspended or demoted admin would otherwise keep its old elevated access for the whole
   * rolling-refresh window. So EVERY request re-reads the `admin_users` row (admin traffic is
   * low-volume internal ops, so a per-request row read is the correct security posture) and:
   *   (a) rejects the session if `status !== 'active'` (suspended/pending → null → 401), and
   *   (b) returns the CURRENT `role` FROM THE ROW (so AdminRolesGuard sees a demotion live).
   * The JWT/Redis role is never used for authz once the row is loaded. A missing row (deleted
   * admin) → null → 401.
   */
  async validateAndTouch(token: string): Promise<ValidatedAdminSession | null> {
    let claims: AdminJwtClaims;
    try {
      claims = await this.jwt.verifyAsync<AdminJwtClaims>(token, { algorithms: ["HS256"] });
    } catch {
      return null;
    }
    // Audience pin: a worker/payer JWT (no `typ:"admin"`) can never satisfy this guard.
    if (claims.typ !== "admin" || !claims.sub || !claims.sid) return null;

    try {
      const redis = await this.client();
      const key = AdminSessionService.sessionKey(claims.sid);
      const raw = await redis.get(key);
      if (!raw) return null;

      // Re-load the system-of-record row EACH request (H1) — the JWT/Redis snapshot is never
      // trusted for live status/role. A suspended/pending admin (or a deleted row) → null.
      const row = await this.admins.findById(claims.sub);
      if (!row || row.status !== "active") return null;
      if (!AdminSessionService.isAdminRole(row.role)) return null;

      await redis.expire(key, this.ttlSeconds());
      const nowSeconds = Math.floor(Date.now() / 1000);
      const remainingSeconds = claims.exp ? Math.max(0, claims.exp - nowSeconds) : 0;
      // Authoritative role comes from the ROW (a demotion takes effect on the next request);
      // the JWT/Redis role claim is NOT trusted for authz.
      return { adminId: claims.sub, sid: claims.sid, role: row.role, remainingSeconds };
    } catch (err) {
      this.logger.error(
        `Admin session Redis error; treating as unauthenticated (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /** Mint a fresh JWT for an already-validated admin+session (rolling refresh). */
  async mint(adminId: string, sid: string, role: AdminRole): Promise<AdminSessionToken> {
    const token = await this.jwt.signAsync(
      { sub: adminId, sid, typ: "admin", role },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: this.ttlSeconds() };
  }

  /** Revoke an admin session (logout): delete its Redis record. Best-effort. */
  async revoke(sid: string): Promise<void> {
    try {
      const redis = await this.client();
      await redis.del(AdminSessionService.sessionKey(sid));
    } catch (err) {
      this.logger.error(
        `Admin session revoke Redis error (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  /** Type guard — only the four known roles are ever treated as a role. */
  private static isAdminRole(value: unknown): value is AdminRole {
    return (
      value === "super_admin" ||
      value === "ops_admin" ||
      value === "support" ||
      value === "analyst"
    );
  }
}
