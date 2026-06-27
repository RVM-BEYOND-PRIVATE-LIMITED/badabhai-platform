import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

interface RedisKvClient {
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/** TTL (seconds) of the short-lived OTP-pending marker that binds OTP→MFA in one flow. */
const MFA_PENDING_TTL_SECONDS = 300;

/**
 * Stores an admin's TOTP secret ENCRYPTED at rest (ADR-0025 ADMIN-1).
 *
 * DEVIATION (noted): the shipped `admin_users` table (migration 0026) has `mfa_enrolled` but
 * NO column for the TOTP secret, and adding one is a migration (→ database-architect, NOT in
 * ADMIN-1 scope / HARD CONSTRAINT: no db:migrate). To keep the second factor functional WITHOUT
 * a schema change, the secret is persisted in the existing Redis store, **encrypted with the
 * SAME AES-256-GCM PiiCryptoService** used for at-rest PII (the plaintext secret never touches
 * Redis, a log, or an event), in its own namespace `admin_mfa_secret:<admin_id>`. A follow-up
 * (with the database-architect) should add an encrypted `mfa_secret_enc` column to
 * `admin_users` and migrate this; the auth flow reads/writes only through this seam, so that
 * swap is local. The secret is NEVER logged and NEVER returned except once at enrollment.
 */
@Injectable()
export class AdminMfaSecretStore {
  private readonly logger = new Logger(AdminMfaSecretStore.name);

  constructor(
    private readonly pii: PiiCryptoService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private static key(adminId: string): string {
    return `admin_mfa_secret:${adminId}`;
  }

  private static pendingKey(adminId: string): string {
    return `admin_mfa_pending:${adminId}`;
  }

  private async client(): Promise<RedisKvClient> {
    return (await this.queue.client) as unknown as RedisKvClient;
  }

  /** Persist a TOTP secret ENCRYPTED (overwrites any prior, e.g. a re-enroll). */
  async save(adminId: string, secret: string): Promise<void> {
    const redis = await this.client();
    await redis.set(AdminMfaSecretStore.key(adminId), this.pii.encrypt(secret));
  }

  /** Load + decrypt an admin's TOTP secret, or null if none/decrypt fails (fail-closed). */
  async load(adminId: string): Promise<string | null> {
    try {
      const redis = await this.client();
      const enc = await redis.get(AdminMfaSecretStore.key(adminId));
      if (!enc) return null;
      return this.pii.decrypt(enc);
    } catch (err) {
      // A decrypt/Redis error means we cannot verify the second factor → treat as absent
      // (the caller fails the MFA gate closed). Never log the secret/ciphertext.
      this.logger.error(
        `admin MFA secret load failed admin=${adminId.slice(0, 8)}…; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /** Remove an admin's stored secret (e.g. on a reset). Best-effort. */
  async clear(adminId: string): Promise<void> {
    try {
      const redis = await this.client();
      await redis.del(AdminMfaSecretStore.key(adminId));
    } catch {
      /* best-effort */
    }
  }

  /**
   * Mark that this admin just passed OTP and is awaiting the MFA step (a short-lived, single-
   * flow binding). Set by `verifyLogin` on the MFA branch; required + consumed by `verifyMfa`
   * so a leaked TOTP secret alone cannot mint a session without a fresh OTP success in the same
   * flow. TTL-bounded so a stale marker cannot be replayed.
   */
  async markOtpPassed(adminId: string): Promise<void> {
    const redis = await this.client();
    await redis.setex(AdminMfaSecretStore.pendingKey(adminId), MFA_PENDING_TTL_SECONDS, "1");
  }

  /**
   * Atomically CONSUME the OTP-pending marker. Returns true only if it was present (single-use:
   * the marker is deleted). Fail-closed: a Redis error returns false (deny the MFA step).
   */
  async consumeOtpPending(adminId: string): Promise<boolean> {
    try {
      const redis = await this.client();
      const removed = await redis.del(AdminMfaSecretStore.pendingKey(adminId));
      return removed > 0;
    } catch {
      return false;
    }
  }
}
