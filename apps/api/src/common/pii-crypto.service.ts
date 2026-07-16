import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { getPiiKeyring } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import {
  hashPhone,
  hashIp,
  hmacValue,
  encryptPii,
  decryptPii,
  encryptPiiWithKeyring,
  decryptPiiWithKeyring,
  hashPin,
  verifyPin,
} from "./crypto";
import type { PiiKeyring } from "./crypto";

/**
 * Single boundary for worker-PII crypto. Holds the server-side peppers + AES key
 * (from validated config) so the rest of the app never handles raw secrets:
 *   - hashPhone/hashIp  → keyed HMAC (safe for events + lookups)
 *   - encrypt/decrypt   → AES-256-GCM for phone_e164 at rest (key never in DB)
 *   - hashPin/verifyPin → scrypt (slow KDF) for the device-unlock PIN (ADR-0026 Phase 3)
 */
@Injectable()
export class PiiCryptoService {
  private readonly pepper: string;
  private readonly key: string;
  private readonly pinPepper: string;
  /**
   * TD22-1 — optional key-rotation keyring. null (the default — neither
   * PII_ENCRYPTION_KEYS nor PII_ENCRYPTION_ACTIVE_KID set) keeps EXACTLY the
   * legacy single-key v1 behavior. When configured, encrypt writes v2 tokens
   * under the active kid and decrypt reads BOTH v2 (kid lookup) and legacy v1
   * (PII_ENCRYPTION_KEY). Key material never leaves this boundary.
   */
  private readonly keyring: PiiKeyring | null;

  constructor(@Inject(SERVER_CONFIG) config: ServerConfig) {
    this.pepper = config.PII_HASH_PEPPER;
    this.key = config.PII_ENCRYPTION_KEY;
    this.pinPepper = config.PIN_PEPPER;
    // Throws on a half-set/invalid keyring — defense-in-depth behind main.ts's
    // assertPiiCryptoConfig boot gate: a service constructed with a bad keyring
    // must fail loudly, never silently fall back to the legacy key.
    this.keyring = getPiiKeyring(config);
  }

  hashPhone(phoneE164: string): string {
    return hashPhone(phoneE164, this.pepper);
  }

  hashIp(ip: string): string {
    return hashIp(ip, this.pepper);
  }

  /**
   * Keyed HMAC of a short-lived secret (e.g. an OTP code) using the same server
   * pepper. Lets us store the OTP as a digest only — never plaintext. Compare the
   * result of two `hmac()` calls with a constant-time check (timingSafeEqual).
   */
  hmac(value: string): string {
    return hmacValue(value, this.pepper);
  }

  /**
   * Encrypt PII for storage (e.g. phone_e164). Returns a self-describing token:
   * `v2.<kid>.…` under the keyring's active key when the operator has opted in
   * (TD22-1), else the byte-identical legacy `v1.…` token.
   */
  encrypt(plaintext: string): string {
    return this.keyring
      ? encryptPiiWithKeyring(plaintext, this.keyring)
      : encryptPii(plaintext, this.key);
  }

  /**
   * Decrypt an encrypt() token back to plaintext. Backend-only. With a keyring
   * configured this is READ-BOTH (v2 by kid, legacy v1 via PII_ENCRYPTION_KEY) so
   * rows written before the opt-in keep decrypting; without one it is exactly
   * the legacy single-key path. Fail-closed: an unknown kid throws (the message
   * never echoes the kid nor enumerates known kids).
   */
  decrypt(token: string): string {
    return this.keyring
      ? decryptPiiWithKeyring(token, this.keyring, this.key)
      : decryptPii(token, this.key);
  }

  /**
   * Hash a device-unlock PIN with scrypt (slow KDF) + a per-PIN salt + the PIN pepper.
   * Returns a self-encoded `scrypt-v1.<salt>.<derived>` token for worker_credentials.pin_hash.
   * The raw PIN and the pepper never leave this boundary (ADR-0026 Phase 3, R25a).
   */
  hashPin(pin: string): string {
    return hashPin(pin, this.pinPepper);
  }

  /** Constant-time verify of a PIN against a hashPin() token. Fail-closed (false, never throws). */
  verifyPin(pin: string, token: string): boolean {
    return verifyPin(pin, token, this.pinPepper);
  }
}
