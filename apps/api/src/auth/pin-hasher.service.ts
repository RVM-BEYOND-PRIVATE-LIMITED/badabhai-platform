import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";

/** The current PIN pepper version (the only version today — TD55 keeps Argon2id deferred). */
export const CURRENT_PIN_PEPPER_VERSION = 1;

/**
 * PIN FORMAT + hashing boundary (ADR-0026 Phase 3). Wraps {@link PiiCryptoService}'s
 * scrypt hash/verify (the slow-KDF; never re-implemented here) and owns the exact-length
 * format gate.
 *
 * THERE IS NO STRENGTH CHECK HERE ANY MORE, AND THAT IS THE POINT (#1462, owner ruling
 * 2026-09-08). `isWeakPin` and its `WEAK_PINS` denylist lived on this class and are deleted:
 * "the worker chooses their own PIN. No strength policy, client or server." Do not re-add one
 * here — the argument, and the compensating controls that make it safe, are written out on
 * `PinService.assertPinPolicy`, which was this class's only caller.
 *
 * PRIVACY (CLAUDE.md §2): the raw PIN never leaves this boundary in any returned value
 * (only `{ pinHash, pepperVersion }`), is never logged, and never reaches an event. The
 * pepper lives only inside PiiCryptoService.
 *
 * FORWARD-COMPAT: `pepperVersion` is threaded through so a future v2 pepper + a
 * rehash-on-verify is a non-breaking ADD (verify branches on the stored version). Today
 * only v1 exists; an unexpected version fails closed (verify returns false).
 */
@Injectable()
export class PinHasher {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * Hash a PIN to a `worker_credentials.pin_hash` token via the scrypt boundary. The
   * CALLER must validate format (exact PIN_LENGTH digits) FIRST — this only hashes. Returns
   * the token + the pepper version that produced it (always the current version today). The
   * raw PIN is not returned, logged, or evented.
   */
  hash(pin: string): { pinHash: string; pepperVersion: number } {
    return { pinHash: this.pii.hashPin(pin), pepperVersion: CURRENT_PIN_PEPPER_VERSION };
  }

  /**
   * Constant-time verify of a PIN against a stored hash for its `pepperVersion`. Today only
   * v1 is supported (the scrypt boundary). An unrecognized version fails closed (false) —
   * never throws — so a future v2 row read by old code can't be coerced to "verified". When
   * v2 lands, this branches on the version and the caller rehashes on a successful v1 verify
   * (a non-breaking add; Argon2id itself stays TD55, NOT built here).
   */
  verify(pin: string, pinHash: string, pepperVersion: number): boolean {
    if (pepperVersion !== CURRENT_PIN_PEPPER_VERSION) return false;
    return this.pii.verifyPin(pin, pinHash);
  }

  /** Exact configured PIN length (digits). The DTO accepts a 4-8 range; the service pins it. */
  pinLength(): number {
    return this.config.PIN_LENGTH;
  }

  /** True when `pin` is exactly PIN_LENGTH digits (the strict format gate the service uses). */
  isCorrectFormat(pin: string): boolean {
    const len = this.config.PIN_LENGTH;
    return new RegExp(`^\\d{${len}}$`).test(pin);
  }
}
