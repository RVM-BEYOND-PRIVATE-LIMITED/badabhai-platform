import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

/**
 * Crypto helpers for PII that must be referenced or stored but never exposed in
 * the clear.
 *
 * - Hashing (`hashPhone`/`hashIp`) uses a **keyed HMAC-SHA256** with a
 *   server-side pepper, so a low-entropy value (a 10-digit phone) is NOT
 *   brute-forceable from the digest without the pepper. The digest is what may
 *   appear in events/lookups — never the raw value.
 * - At-rest secrecy (`encryptPii`/`decryptPii`) uses **AES-256-GCM**. The key
 *   lives only in backend config (never in the database), so a full DB read does
 *   not reveal the plaintext. GCM is authenticated (tamper-evident).
 *
 * The secrets (pepper, key) are injected by `PiiCryptoService` from server
 * config; these functions stay pure for testability.
 */

/** Unkeyed SHA-256 (hex). Retained for non-PII digests; do NOT use for PII. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Keyed HMAC-SHA256 (hex). */
export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Stable, peppered, non-reversible key for an E.164 phone (safe for events/lookups). */
export function hashPhone(phoneE164: string, pepper: string): string {
  return hmacSha256Hex(pepper, `phone:${phoneE164}`);
}

/** Peppered hash of an IP for consent/audit records. */
export function hashIp(ip: string, pepper: string): string {
  return hmacSha256Hex(pepper, `ip:${ip}`);
}

const ENC_VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

/** Decode + validate a base64 AES-256 key. Throws (fail-closed) on a bad key. */
function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`PII encryption key must be ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return key;
}

/**
 * AES-256-GCM encrypt. Returns a self-describing token:
 *   "v1.<iv_b64>.<authTag_b64>.<ciphertext_b64>"
 * A fresh random IV per call makes the output non-deterministic (so equal
 * plaintexts do not produce equal ciphertexts — uniqueness/lookup must use the
 * HMAC hash, not the ciphertext).
 */
export function encryptPii(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

/** AES-256-GCM decrypt of an `encryptPii` token. Throws on wrong key or tamper. */
export function decryptPii(token: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const [version, ivB64, tagB64, ctB64] = token.split(".");
  if (version !== ENC_VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("malformed PII ciphertext token");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Is this string an `encryptPii` token (vs legacy plaintext)? Useful for backfills. */
export function isEncryptedPii(value: string): boolean {
  return typeof value === "string" && value.startsWith(`${ENC_VERSION}.`) && value.split(".").length === 4;
}

/** Constant-time hex-digest comparison (avoids timing leaks on hash checks). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
