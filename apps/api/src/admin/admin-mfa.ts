import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) — implemented with Node `crypto` ONLY (no new dependency; CLAUDE.md §3
 * stack-lock). Used by the Admin Ops Portal second factor (ADR-0025 ADMIN-1, must-fix #1).
 *
 * The secret is a base32 (RFC 4648, no padding) string compatible with Google
 * Authenticator / Authy. Verification is HMAC-SHA1 over the 8-byte big-endian time counter
 * (T = floor(unixSeconds / period)), with a ±1 step skew window and a CONSTANT-TIME compare
 * (timingSafeEqual) so a near-match does not leak via timing.
 *
 * SECURITY NOTES:
 *   - The TOTP secret is sensitive: it is generated here and shown to the admin ONCE at
 *     enrollment (in the otpauth URI / the `secret` field). It must be persisted ENCRYPTED
 *     at rest by the caller (same at-rest discipline as the admin email) and NEVER logged or
 *     put in an event. This module is pure crypto — it does not persist or log anything.
 *   - Codes are zero-padded to `digits` (default 6); compares are length-stable.
 */

const RFC4648_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_SKEW_STEPS = 1;

export interface TotpOptions {
  /** Time step in seconds (RFC 6238 default 30). */
  period?: number;
  /** Number of digits in the code (default 6). */
  digits?: number;
  /** ± this many steps are accepted (clock-skew tolerance; default 1 → ±30s). */
  skewSteps?: number;
}

export interface TotpEnrollment {
  /** Base32 secret (no padding) — store ENCRYPTED; show to the admin once. */
  secret: string;
  /** otpauth:// URI for QR provisioning (carries the secret — treat as sensitive). */
  otpauthUri: string;
}

/**
 * Generate a fresh base32 TOTP secret (default 20 random bytes → 160-bit, RFC 4648 §6.2
 * recommended length) AND its otpauth provisioning URI. `accountLabel` is the admin's
 * account label shown in the authenticator (an opaque handle the CALLER chooses — pass the
 * admin id, NOT the admin email, to keep PII out of the URI/QR).
 */
export function generateTotpEnrollment(
  issuer: string,
  accountLabel: string,
  options: TotpOptions = {},
): TotpEnrollment {
  const secret = base32Encode(randomBytes(20));
  const period = options.period ?? DEFAULT_PERIOD_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const label = `${issuer}:${accountLabel}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
  return { secret, otpauthUri };
}

/**
 * Verify a submitted TOTP code against the base32 `secret` at the given time, allowing a
 * ±`skewSteps` window. Returns true only on a CONSTANT-TIME match within the window. A
 * malformed secret/code returns false (never throws into the auth path).
 */
export function verifyTotp(
  secret: string,
  submittedCode: string,
  options: TotpOptions = {},
  now: Date = new Date(),
): boolean {
  const period = options.period ?? DEFAULT_PERIOD_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const skew = options.skewSteps ?? DEFAULT_SKEW_STEPS;

  const cleaned = (submittedCode ?? "").trim();
  if (!/^\d+$/.test(cleaned) || cleaned.length !== digits) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const counter = Math.floor(now.getTime() / 1000 / period);
  // Check the window [counter - skew, counter + skew]. A constant-time compare per step;
  // we never short-circuit on the FIRST mismatch in a timing-observable way (each step does
  // an equal-length timingSafeEqual), and we OR the boolean results.
  let matched = false;
  for (let offset = -skew; offset <= skew; offset += 1) {
    const expected = generateCodeForCounter(key, counter + offset, digits);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(cleaned, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

/** Generate the current TOTP code for a base32 secret (used in tests / enroll preview). */
export function currentTotpCode(
  secret: string,
  options: TotpOptions = {},
  now: Date = new Date(),
): string {
  const period = options.period ?? DEFAULT_PERIOD_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const counter = Math.floor(now.getTime() / 1000 / period);
  return generateCodeForCounter(base32Decode(secret), counter, digits);
}

// ---------------------------------------------------------------------------
// Internals (HMAC-SHA1 dynamic truncation + base32) — RFC 4226 / RFC 4648.
// ---------------------------------------------------------------------------

/** HOTP value for a counter (RFC 4226 §5.3 dynamic truncation), zero-padded to `digits`. */
function generateCodeForCounter(key: Buffer, counter: number, digits: number): string {
  const counterBuf = Buffer.alloc(8);
  // 8-byte big-endian counter. Use BigInt to avoid 32-bit overflow on the high word.
  counterBuf.writeBigUInt64BE(BigInt(Math.max(0, counter)));
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

/** RFC 4648 base32 encode (no padding). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += RFC4648_BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += RFC4648_BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

/** RFC 4648 base32 decode (ignores casing + whitespace + `=` padding). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = RFC4648_BASE32.indexOf(char);
    if (idx === -1) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
