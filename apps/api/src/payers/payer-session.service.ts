import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { JwtService } from "@nestjs/jwt";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
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
interface RedisSessionClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** JWT claims. `sub` = payer id, `sid` = server-side session id, `typ` pins audience. */
interface PayerJwtClaims {
  sub: string;
  sid: string;
  typ: "payer";
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

  /** Create a new payer session: store the record and mint a JWT. */
  async create(payerId: string): Promise<PayerSessionToken> {
    const sid = randomUUID();
    const ttl = this.ttlSeconds();
    const redis = await this.client();
    await redis.set(
      PayerSessionService.sessionKey(sid),
      JSON.stringify({ payer_id: payerId }),
      "EX",
      ttl,
    );
    const token = await this.jwt.signAsync(
      { sub: payerId, sid, typ: "payer" },
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
      return { payerId: claims.sub, sid: claims.sid, remainingSeconds };
    } catch (err) {
      this.logger.error(
        `Payer session Redis error; treating as unauthenticated (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /** Mint a fresh JWT for an already-validated payer+session (rolling refresh). */
  async mint(payerId: string, sid: string): Promise<PayerSessionToken> {
    const token = await this.jwt.signAsync(
      { sub: payerId, sid, typ: "payer" },
      { expiresIn: `${this.config.SESSION_TTL_DAYS}d` },
    );
    return { token, expiresInSeconds: this.ttlSeconds() };
  }

  /** Revoke a payer session (logout): delete its Redis record. Best-effort. */
  async revoke(sid: string): Promise<void> {
    try {
      const redis = await this.client();
      await redis.del(PayerSessionService.sessionKey(sid));
    } catch (err) {
      this.logger.error(
        `Payer session revoke Redis error (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
}
