import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";

/** The current PIN pepper version (the only version today — TD55 keeps Argon2id deferred). */
export const CURRENT_PIN_PEPPER_VERSION = 1;

/**
 * A small explicit denylist of the most-guessed 4-digit PINs (the structural sequence
 * checks below already cover all-same-digit + straight runs; this names a few extra
 * popular ones). Kept tiny on purpose — the structural rules do the heavy lifting.
 */
const WEAK_PINS = new Set<string>([
  "0000",
  "1111",
  "1234",
  "4321",
  "1212",
  "2580", // the phone-keypad vertical column
  "1004",
  "2000",
  "6969",
]);

/**
 * PIN strength + hashing boundary (ADR-0026 Phase 3). Wraps {@link PiiCryptoService}'s
 * scrypt hash/verify (the slow-KDF; never re-implemented here) and adds a format-agnostic
 * weak-PIN denylist + structural check.
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
   * Reject the obviously-weak PINs: anything on the explicit denylist, all-same-digit
   * (0000/1111/…), and strictly ascending/descending consecutive runs (1234/2345/… and
   * 4321/5432/…). Works for any PIN length (the caller enforces the exact PIN_LENGTH +
   * digits-only first). A non-numeric / wrong-length input is treated as weak (true) so a
   * malformed value can never slip past as "strong".
   */
  isWeakPin(pin: string): boolean {
    if (!/^\d+$/.test(pin)) return true;
    if (WEAK_PINS.has(pin)) return true;

    // All-same-digit (e.g. 0000, 7777).
    if (new Set(pin).size === 1) return true;

    // Strictly ascending or descending consecutive runs (each step is +1 / -1).
    let ascending = true;
    let descending = true;
    for (let i = 1; i < pin.length; i += 1) {
      const diff = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
      if (diff !== 1) ascending = false;
      if (diff !== -1) descending = false;
    }
    return ascending || descending;
  }

  /**
   * Hash a PIN to a `worker_credentials.pin_hash` token via the scrypt boundary. The
   * CALLER must validate format (exact PIN_LENGTH digits) + run the denylist FIRST — this
   * only hashes. Returns the token + the pepper version that produced it (always the
   * current version today). The raw PIN is not returned, logged, or evented.
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
