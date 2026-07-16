import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";

/**
 * Crypto helpers for PII that must be referenced or stored but never exposed in
 * the clear. This is the SINGLE source of truth for BadaBhai's at-rest PII crypto.
 *
 * It lives in `@badabhai/db` (the package that DEFINES the ciphertext columns —
 * `workers.phone_e164`, `payers.email_enc`, …) so any code that writes those
 * columns — the NestJS `PiiCryptoService` (which re-exports these), backfills, and
 * the demand seed — shares ONE implementation and one token format. `apps/api`'s
 * `common/crypto.ts` re-exports from here, so its import path is unchanged.
 *
 * - Hashing (`hashPhone`/`hashIp`) uses a **keyed HMAC-SHA256** with a
 *   server-side pepper, so a low-entropy value (a 10-digit phone) is NOT
 *   brute-forceable from the digest without the pepper. The digest is what may
 *   appear in events/lookups — never the raw value.
 * - At-rest secrecy (`encryptPii`/`decryptPii`) uses **AES-256-GCM**. The key
 *   lives only in backend config (never in the database), so a full DB read does
 *   not reveal the plaintext. GCM is authenticated (tamper-evident).
 *
 * The secrets (pepper, key) are supplied by the caller (e.g. `PiiCryptoService`
 * from server config, or a seed script from the environment); these functions
 * stay pure for testability.
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

/**
 * Generic peppered keyed-HMAC for a short-lived secret (e.g. an OTP code) so it
 * is stored as a digest, never plaintext. Domain-separated from phone/IP hashes
 * by a distinct prefix; uses the SAME server pepper (no new secret is invented).
 * Verification MUST be constant-time (see `safeEqualHex`).
 */
export function hmacValue(value: string, pepper: string): string {
  return hmacSha256Hex(pepper, `otp:${value}`);
}

const ENC_VERSION = "v1";
const ENC_VERSION_V2 = "v2"; // TD22-1 — key-id-carrying token: "v2.<kid>.<iv>.<tag>.<ct>"
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256
const AUTH_TAG_BYTES = 16; // 128-bit GCM auth tag (the standard, pinned explicitly)

/**
 * PII key id ("kid") charset for v2 tokens — 1-32 chars of [A-Za-z0-9_-], DOT-FREE
 * by construction ("." is the token delimiter; a dotted kid would silently corrupt
 * token parsing). Enforced at encrypt time here AND at boot by
 * `assertPiiCryptoConfig` in `@badabhai/config` (which duplicates this pattern —
 * config cannot depend on this package; keep the two in sync).
 */
export const PII_KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * TD22-1 — a keyring for staged AES key rotation. `keys` maps a key id ("kid") to
 * a base64-encoded 32-byte AES-256 key; `activeKid` names the entry new v2 tokens
 * are WRITTEN under (it MUST be a key of `keys`). Old kids stay in the map so
 * their tokens keep decrypting until a re-encrypt backfill (TD22-2) retires them.
 * Supplied by the caller (config) — these functions stay pure, no env reads here.
 * The keyring's key material must NEVER appear in the DB, logs, events, or errors.
 */
export interface PiiKeyring {
  /** The kid new v2 tokens are written under. MUST be a key of `keys`. */
  activeKid: string;
  /** kid → base64-encoded 32-byte AES-256 key. */
  keys: Record<string, string>;
}

/** Decode + validate a base64 AES-256 key. Throws (fail-closed) on a bad key. */
function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`PII encryption key must be ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return key;
}

/**
 * AES-256-GCM core (shared by the v1 and v2 token builders so both formats are
 * byte-identical in their crypto). authTagLength is explicit (the GCM 128-bit
 * standard). Pinning it makes the decrypt side reject any token whose tag is not
 * exactly 16 bytes, closing the truncated-tag forgery window a default-length GCM
 * would tolerate.
 */
function gcmEncrypt(key: Buffer, plaintext: string): { ivB64: string; tagB64: string; ctB64: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ivB64: iv.toString("base64"), tagB64: tag.toString("base64"), ctB64: ct.toString("base64") };
}

/** AES-256-GCM decrypt core (both token versions). Throws on wrong key or tamper. */
function gcmDecrypt(key: Buffer, ivB64: string, tagB64: string, ctB64: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * AES-256-GCM encrypt under a SINGLE key (the legacy/v1 path). Returns a
 * self-describing token:
 *   "v1.<iv_b64>.<authTag_b64>.<ciphertext_b64>"
 * A fresh random IV per call makes the output non-deterministic (so equal
 * plaintexts do not produce equal ciphertexts — uniqueness/lookup must use the
 * HMAC hash, not the ciphertext). Byte-identical to the pre-TD22-1 format —
 * every deployment without a keyring keeps writing exactly this.
 */
export function encryptPii(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const { ivB64, tagB64, ctB64 } = gcmEncrypt(key, plaintext);
  return [ENC_VERSION, ivB64, tagB64, ctB64].join(".");
}

/**
 * TD22-1 — AES-256-GCM encrypt under the keyring's ACTIVE key. Returns the
 * key-id-carrying token:
 *   "v2.<kid>.<iv_b64>.<authTag_b64>.<ciphertext_b64>"
 * The kid is validated (fail-closed) at encrypt time: a dotted/oversized/empty kid
 * would corrupt the dot-delimited token grammar, so it is rejected before any
 * ciphertext is minted. Only call this when the operator has opted in to a
 * keyring — the legacy `encryptPii` stays the default write path.
 */
export function encryptPiiWithKeyring(plaintext: string, keyring: PiiKeyring): string {
  const { activeKid, keys } = keyring;
  if (!PII_KID_PATTERN.test(activeKid)) {
    // NEVER echo the offending kid (nor any keyring contents) — see CLAUDE.md §2.
    throw new Error("invalid PII key id (must be 1-32 chars of A-Za-z0-9_-)");
  }
  const keyB64 = Object.prototype.hasOwnProperty.call(keys, activeKid)
    ? keys[activeKid]
    : undefined;
  if (typeof keyB64 !== "string") {
    throw new Error("PII keyring has no key for its active key id");
  }
  const key = decodeKey(keyB64);
  const { ivB64, tagB64, ctB64 } = gcmEncrypt(key, plaintext);
  return [ENC_VERSION_V2, activeKid, ivB64, tagB64, ctB64].join(".");
}

/**
 * AES-256-GCM decrypt of a LEGACY v1 `encryptPii` token under a single key.
 * Throws on wrong key or tamper. v1-ONLY by design (zero behavior change for
 * existing call sites) — use `decryptPiiWithKeyring` for the read-both path.
 */
export function decryptPii(token: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const [version, ivB64, tagB64, ctB64] = token.split(".");
  if (version !== ENC_VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("malformed PII ciphertext token");
  }
  return gcmDecrypt(key, ivB64, tagB64, ctB64);
}

/**
 * TD22-1 — READ-BOTH decrypt dispatch:
 *   - "v1." + 4 parts → the legacy single key (`legacyKeyB64`); rows written
 *     before the keyring opt-in keep decrypting forever (until a TD22-2 backfill).
 *   - "v2." + 5 parts → look the token's kid up in `keyring.keys`.
 * Fail-closed everywhere: an unknown kid throws WITHOUT echoing the unknown kid
 * value and WITHOUT enumerating known kids; a malformed token throws with no
 * secret material in the message.
 */
export function decryptPiiWithKeyring(
  token: string,
  keyring: PiiKeyring,
  legacyKeyB64?: string,
): string {
  const parts = token.split(".");
  if (parts[0] === ENC_VERSION && parts.length === 4) {
    if (!legacyKeyB64) {
      throw new Error("v1 PII token but no legacy PII encryption key is configured");
    }
    return decryptPii(token, legacyKeyB64);
  }
  if (parts[0] === ENC_VERSION_V2 && parts.length === 5) {
    const [, kid, ivB64, tagB64, ctB64] = parts;
    if (!kid || !PII_KID_PATTERN.test(kid) || !ivB64 || !tagB64 || !ctB64) {
      throw new Error("malformed PII ciphertext token");
    }
    const keyB64 = Object.prototype.hasOwnProperty.call(keyring.keys, kid)
      ? keyring.keys[kid]
      : undefined;
    if (typeof keyB64 !== "string") {
      // Constant message: no unknown-kid echo, no known-kid enumeration (§2).
      throw new Error("unknown PII key id");
    }
    return gcmDecrypt(decodeKey(keyB64), ivB64, tagB64, ctB64);
  }
  throw new Error("malformed PII ciphertext token");
}

/**
 * Is this string an `encryptPii`/`encryptPiiWithKeyring` token (vs legacy
 * plaintext)? Accepts BOTH v1 (4 parts) and v2 (5 parts, valid kid charset).
 * This is the future TD22-2 backfill's row discriminator — a false negative here
 * would silently skip rows later, so both shipped formats MUST stay accepted.
 */
export function isEncryptedPii(value: string): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts[0] === ENC_VERSION && parts.length === 4) return true;
  if (parts[0] === ENC_VERSION_V2 && parts.length === 5) return PII_KID_PATTERN.test(parts[1]!);
  return false;
}

/** Constant-time hex-digest comparison (avoids timing leaks on hash checks). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// PIN hashing (ADR-0026 Phase 3 — device-unlock 4-digit PIN).
//
// A 4-digit PIN is a 10^4 space, so the hash MUST be a SLOW, MEMORY-HARD KDF +
// per-user random salt + a server-side pepper — otherwise a leak of `pin_hash`
// is trivially brute-forced offline. We use Node stdlib **scrypt** (memory-hard,
// OWASP-listed) — the ADR-0026 R3 reconciliation (Argon2id is the spec default;
// scrypt delivers the same slow-KDF + salt + pepper property with ZERO new
// dependency; a future Argon2id swap is non-breaking via the version prefix).
//
// SELF-ENCODED token (no separate pin_salt / pin_algo column):
//   "scrypt-v1.<salt_b64>.<derived_b64>"
// The salt is random per PIN (so equal PINs across workers hash differently); the
// pepper is mixed into the KDF input (a leak of the row still can't brute-force the
// PIN without the server pepper). The version prefix lets verify detect an old
// param/algo and rehash-on-verify later. The RAW PIN and the pepper NEVER appear in
// the token, an event, a log, ai_jobs, or audit_logs (CLAUDE.md §2).
// ---------------------------------------------------------------------------
const PIN_HASH_VERSION = "scrypt-v1";
const PIN_SALT_BYTES = 16;
const PIN_KEY_BYTES = 32;
// scrypt cost: N=2^15 (CPU/memory hardness), r=8, p=1 → ~32MB, a few ms server-side.
// maxmem is raised to fit N (128*N*r = 32MB) so scrypt does not throw on the cost.
const PIN_SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Mix the pepper into the KDF input so the row alone cannot be brute-forced. */
function pinKdfInput(pin: string, pepper: string): string {
  return `pin:${pepper}:${pin}`;
}

/**
 * Hash a PIN to a self-encoded scrypt token (`scrypt-v1.<salt>.<derived>`). The raw
 * PIN and the pepper are never stored. Pure (secrets supplied by the caller).
 */
export function hashPin(pin: string, pepper: string): string {
  const salt = randomBytes(PIN_SALT_BYTES);
  const derived = scryptSync(pinKdfInput(pin, pepper), salt, PIN_KEY_BYTES, PIN_SCRYPT);
  return [PIN_HASH_VERSION, salt.toString("base64"), derived.toString("base64")].join(".");
}

/**
 * Constant-time verify of a PIN against a `hashPin` token. Returns false on any
 * malformed token, wrong version, or mismatch (fail-closed — never throws). The
 * scrypt recompute uses the token's own salt; the comparison is timing-safe.
 */
export function verifyPin(pin: string, token: string, pepper: string): boolean {
  const [version, saltB64, derivedB64] = token.split(".");
  if (version !== PIN_HASH_VERSION || !saltB64 || !derivedB64) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(derivedB64, "base64");
    if (expected.length !== PIN_KEY_BYTES) return false;
    actual = scryptSync(pinKdfInput(pin, pepper), Buffer.from(saltB64, "base64"), expected.length, PIN_SCRYPT);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Is this a `hashPin` token (vs an empty/legacy value)? For rehash-on-verify checks. */
export function isPinHash(value: string): boolean {
  return typeof value === "string" && value.startsWith(`${PIN_HASH_VERSION}.`) && value.split(".").length === 3;
}
