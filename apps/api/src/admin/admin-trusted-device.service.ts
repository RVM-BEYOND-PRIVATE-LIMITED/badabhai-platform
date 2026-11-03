import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import type { AdminUser } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { epochMatches, passwordEpochOf } from "./admin-credential-epoch";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

interface RedisDeviceClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** 32 random bytes → 43 base64url chars (inside the DTO's 20..128 bound). */
const DEVICE_TOKEN_BYTES = 32;
const SECONDS_PER_DAY = 86_400;

/** The Redis record behind one trusted device. Parsed, never trusted, on the way back in. */
const TrustedDeviceRecordSchema = z
  .object({
    admin_id: z.string().min(1),
    created_at_ms: z.number().int().nonnegative(),
    mfa_fp: z.string().min(1),
    // The credential epoch at issue (B2) — `admin-credential-epoch.ts`.
    pwe: z.number().int().nonnegative(),
  })
  .strict();
type TrustedDeviceRecord = z.infer<typeof TrustedDeviceRecordSchema>;

export interface IssuedTrustedDevice {
  /** The raw bearer — returned to the browser ONCE, never stored, logged or evented. */
  token: string;
  expiresInSeconds: number;
}

/** The slice of the admin row a trust decision reads (all from the row the gate already holds). */
export type TrustedDeviceAccount = Pick<
  AdminUser,
  "id" | "mfaEnrolled" | "mfaSecretEnc" | "passwordSetAt"
>;

/**
 * "Trust this device for N days" on the admin two-step step (migration 0144).
 *
 * A browser that passed TOTP with the box ticked gets a 256-bit random token; Redis holds ONLY
 * its keyed HMAC (`admin_trusted_device:<hmac(token)>`) → `{admin_id, created_at_ms, mfa_fp, pwe}`
 * with TTL = ADMIN_TRUSTED_DEVICE_DAYS. Presenting it at the gate skips the TOTP step — never the
 * first factor (password or emailed code), which every sign-in still pays.
 *
 * A device is honoured ONLY while ALL of these hold (each one is a way the trust must die):
 *   - the feature is on (ADMIN_TRUSTED_DEVICE_DAYS > 0) and the record exists (TTL);
 *   - it was issued to THIS admin;
 *   - its credential epoch (`pwe`) still EQUALS the row's `password_set_at` epoch — a password
 *     set, change or reset kills it (equality, not a time comparison: security review B2);
 *   - the admin is `mfa_enrolled` and the record's fingerprint equals a keyed HMAC of the
 *     CURRENT `mfa_secret_enc` — a re-enrolment, an MFA reset or two-step switched off kills it
 *     (the ciphertext changes on every re-save, so even re-saving the same seed rotates it);
 *   - it is younger than the CURRENT day budget (lowering the config shortens live devices too).
 *
 * FAIL SAFE in the only safe direction: any Redis miss/error/garbage is "not trusted" (the admin
 * is asked for TOTP), and a failed issue returns null (the admin is simply asked next time).
 */
@Injectable()
export class AdminTrustedDeviceService {
  private readonly logger = new Logger(AdminTrustedDeviceService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** False when ADMIN_TRUSTED_DEVICE_DAYS is 0 — nothing is issued and nothing is honoured. */
  isEnabled(): boolean {
    return this.config.ADMIN_TRUSTED_DEVICE_DAYS > 0;
  }

  /**
   * Issue a device to an admin who has JUST passed TOTP. Returns null when the feature is off,
   * when there is no seed to fingerprint, or when Redis refuses the write.
   */
  async issue(
    account: Pick<AdminUser, "id" | "mfaSecretEnc" | "passwordSetAt">,
    now: Date = new Date(),
  ): Promise<IssuedTrustedDevice | null> {
    if (!this.isEnabled() || !account.mfaSecretEnc) return null;
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const record: TrustedDeviceRecord = {
      admin_id: account.id,
      created_at_ms: now.getTime(),
      mfa_fp: this.fingerprint(account.mfaSecretEnc),
      pwe: passwordEpochOf(account.passwordSetAt),
    };
    const ttl = this.ttlSeconds();
    try {
      await (await this.client()).set(this.key(token), JSON.stringify(record), "EX", ttl);
    } catch (err) {
      this.logger.warn(
        `admin trusted device not issued admin=${account.id.slice(0, 8)}… reason=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    return { token, expiresInSeconds: ttl };
  }

  /** True only when `token` names a live device for exactly this admin's current credentials. */
  async isTrusted(
    token: string,
    account: TrustedDeviceAccount,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!this.isEnabled() || !account.mfaEnrolled || !account.mfaSecretEnc) return false;
    const record = await this.load(token, account.id);
    if (!record || record.admin_id !== account.id) return false;
    if (!epochMatches(record.pwe, account.passwordSetAt)) return false;
    if (now.getTime() - record.created_at_ms > this.ttlSeconds() * 1000) return false;
    return AdminTrustedDeviceService.sameDigest(
      record.mfa_fp,
      this.fingerprint(account.mfaSecretEnc),
    );
  }

  private async load(token: string, adminId: string): Promise<TrustedDeviceRecord | null> {
    let raw: string | null;
    try {
      raw = await (await this.client()).get(this.key(token));
    } catch (err) {
      this.logger.warn(
        `admin trusted device lookup failed (asking for TOTP) admin=${adminId.slice(0, 8)}… reason=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = TrustedDeviceRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private ttlSeconds(): number {
    return this.config.ADMIN_TRUSTED_DEVICE_DAYS * SECONDS_PER_DAY;
  }

  /** Redis key — the raw token never touches Redis, only its keyed, domain-separated HMAC. */
  private key(token: string): string {
    return `admin_trusted_device:${this.pii.hmac(`admin_trusted_device:${token}`)}`;
  }

  /** Keyed HMAC of the CURRENT seed ciphertext (never the seed itself, never decrypted). */
  private fingerprint(mfaSecretEnc: string): string {
    return this.pii.hmac(`admin_trusted_device_fp:${mfaSecretEnc}`);
  }

  private static sameDigest(a: string, b: string): boolean {
    const x = Buffer.from(a, "utf8");
    const y = Buffer.from(b, "utf8");
    return x.length === y.length && timingSafeEqual(x, y);
  }

  private async client(): Promise<RedisDeviceClient> {
    return (await this.queue.client) as unknown as RedisDeviceClient;
  }
}
