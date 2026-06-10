import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { hashPhone, hashIp, encryptPii, decryptPii } from "./crypto";

/**
 * Single boundary for worker-PII crypto. Holds the server-side pepper + AES key
 * (from validated config) so the rest of the app never handles raw secrets:
 *   - hashPhone/hashIp  → keyed HMAC (safe for events + lookups)
 *   - encrypt/decrypt   → AES-256-GCM for phone_e164 at rest (key never in DB)
 */
@Injectable()
export class PiiCryptoService {
  private readonly pepper: string;
  private readonly key: string;

  constructor(@Inject(SERVER_CONFIG) config: ServerConfig) {
    this.pepper = config.PII_HASH_PEPPER;
    this.key = config.PII_ENCRYPTION_KEY;
  }

  hashPhone(phoneE164: string): string {
    return hashPhone(phoneE164, this.pepper);
  }

  hashIp(ip: string): string {
    return hashIp(ip, this.pepper);
  }

  /** Encrypt PII for storage (e.g. phone_e164). Returns a self-describing token. */
  encrypt(plaintext: string): string {
    return encryptPii(plaintext, this.key);
  }

  /**
   * Decrypt an encrypt() token back to plaintext. Backend-only.
   * Intentionally retained though Phase 1 has no read site yet: it is the
   * recovery path for future SMS/contact use and for a key-rotation backfill.
   */
  decrypt(token: string): string {
    return decryptPii(token, this.key);
  }
}
