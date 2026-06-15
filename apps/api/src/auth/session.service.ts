import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { JwtService } from "@nestjs/jwt";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/** Minimal typed view of the raw Redis commands the session store needs. */
interface RedisSessionClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** JWT claims we sign. `sub` = worker id, `sid` = server-side session id. */
interface WorkerJwtClaims {
  sub: string;
  sid: string;
  exp?: number;
}

export interface SessionToken {
  token: string;
  expiresInSeconds: number;
}

export interface ValidatedSession {
  workerId: string;
  sid: string;
  /** Seconds until the CURRENT token expires (per its JWT `exp`). */
  remainingSeconds: number;
}

/**
 * Rolling worker sessions backed by a signed JWT + a Redis session record.
 *
 * The JWT (signed with JWT_SECRET) carries the identity; the Redis key
 * `session:<sid>` is the server-side handle that makes a session revocable and
 * slidable. Every validate touches (resets) that key's TTL so an ACTIVE worker
 * stays logged in (rolling), while an idle session expires after SESSION_TTL_DAYS.
 *
 * FAIL SAFE: any verify/Redis error returns null → the caller responds 401. A JWT
 * that is validly signed but whose Redis session is gone (revoked/expired) is
 * also treated as invalid.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

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
    return `session:${sid}`;
  }

  /** Create a new session for `workerId`: store the record and mint a JWT. */
  async create(workerId: string): Promise<SessionToken> {
    const sid = randomUUID();
    const ttl = this.ttlSeconds();
    const redis = await this.client();
    await redis.set(SessionService.sessionKey(sid), JSON.stringify({ worker_id: workerId }), "EX", ttl);
    const token = await this.jwt.signAsync(
      { sub: workerId, sid },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: ttl };
  }

  /**
   * Verify the token + load its Redis session, RESET the session TTL (sliding —
   * this is the rolling behavior), and return the claims. Returns null on any
   * failure (bad signature, expired JWT, missing/revoked session, Redis error).
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

      // Slide the session TTL forward so an active worker stays logged in.
      await redis.expire(key, this.ttlSeconds());

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
   * Validate the current token and, if valid, mint a FRESH JWT (new full-length
   * exp) for the same session. Returns null when the session is invalid.
   */
  async refresh(token: string): Promise<SessionToken | null> {
    const session = await this.validateAndTouch(token);
    if (!session) return null;
    return this.mint(session.workerId, session.sid);
  }

  /** Mint a fresh JWT for an already-validated worker+session (rolling refresh). */
  async mint(workerId: string, sid: string): Promise<SessionToken> {
    const token = await this.jwt.signAsync(
      { sub: workerId, sid },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: this.ttlSeconds() };
  }

  /** Revoke a session (logout): delete its Redis record. */
  async revoke(sid: string): Promise<void> {
    try {
      const redis = await this.client();
      await redis.del(SessionService.sessionKey(sid));
    } catch (err) {
      // Best-effort: a revoke that can't reach Redis still returns; the session
      // will lapse at its TTL. Never throw out of logout.
      this.logger.error(
        `Session revoke Redis error (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}
