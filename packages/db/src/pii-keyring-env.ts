/**
 * The PII keys an OPS RUNNER reads from its environment, validated the way the API validates them
 * at boot — and the codec built from them, which encrypts and decrypts exactly as the API does.
 *
 * WHY THIS IS A MODULE. It began as private helpers inside `reencrypt-pii-backfill.ts` (TD22-2).
 * The #1432 title-case backfill is the second runner that has to decrypt a stored token and write
 * one back, and a second hand-copied keyring validator is how the two drift apart — the copy that
 * forgets the duplicate-kid check boots clean and fails only at read time, on rows written under
 * the shadowed key. One copy, two callers.
 *
 * WHY IT IS NOT `@badabhai/config`. `packages/db` cannot depend on `packages/config` (see
 * `crypto.ts`'s `PII_KID_PATTERN` note), so this is a LOCAL MIRROR of `assertPiiCryptoConfig` and
 * `PiiCryptoService`. Keep it in step with both by hand.
 *
 * NEVER ECHOES KEY MATERIAL. Every error is a constant string; no kid, no key, no token, ever.
 */
import {
  PII_KID_PATTERN,
  decryptPii,
  decryptPiiWithKeyring,
  encryptPii,
  encryptPiiWithKeyring,
  type PiiKeyring,
} from "./crypto";

/**
 * Counts top-level `key:` members in a JSON object's raw text (ignores nested
 * braces/brackets and string contents). `JSON.parse` silently keeps the LAST
 * value for a repeated top-level key, so comparing this count to
 * `Object.keys(parsed).length` is how a duplicate kid is caught at all — a
 * straight `JSON.parse` would boot clean and fail only later, at READ time, on
 * rows written under the shadowed key. Byte-for-byte the same algorithm as
 * `packages/config/src/server.ts`'s `countTopLevelJsonMembers` (kept in sync by
 * hand — packages/db cannot depend on packages/config).
 */
export function countTopLevelJsonMembers(raw: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let count = 0;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === ":" && depth === 1) count += 1;
  }
  return count;
}

/**
 * Validate a keyring from the raw `PII_ENCRYPTION_KEYS` / `PII_ENCRYPTION_ACTIVE_KID` values.
 * Fails closed; never echoes key material. `tag` prefixes every message (`[reencrypt] …`), so each
 * runner's errors read exactly as they did before this was shared.
 */
export function parsePiiKeyring(rawKeys: string, rawKid: string, tag: string): PiiKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error(`[${tag}] PII_ENCRYPTION_KEYS is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[${tag}] PII_ENCRYPTION_KEYS must be a JSON object`);
  }
  const parsedEntries = Object.entries(parsed as Record<string, unknown>);
  if (countTopLevelJsonMembers(rawKeys) !== parsedEntries.length) {
    throw new Error(`[${tag}] PII_ENCRYPTION_KEYS contains a duplicate key id`);
  }
  const keys: Record<string, string> = {};
  for (const [kid, key] of parsedEntries) {
    if (!PII_KID_PATTERN.test(kid)) {
      throw new Error(`[${tag}] PII_ENCRYPTION_KEYS contains an invalid key id`);
    }
    if (typeof key !== "string" || Buffer.from(key, "base64").length !== 32) {
      throw new Error(
        `[${tag}] PII_ENCRYPTION_KEYS contains a key that is not base64 of exactly 32 bytes`,
      );
    }
    if (Buffer.from(key, "base64").every((b) => b === 0)) {
      throw new Error(`[${tag}] PII_ENCRYPTION_KEYS contains an all-zero key`);
    }
    keys[kid] = key;
  }
  if (!PII_KID_PATTERN.test(rawKid) || !Object.prototype.hasOwnProperty.call(keys, rawKid)) {
    throw new Error(
      `[${tag}] PII_ENCRYPTION_ACTIVE_KID is not a valid key id present in PII_ENCRYPTION_KEYS`,
    );
  }
  return { activeKid: rawKid, keys };
}

/**
 * The keyring when the operator has opted in, `null` when they have not — BOTH OR NEITHER, the rule
 * `assertPiiCryptoConfig` enforces at API boot. Half a keyring throws, and so does an EMPTY string:
 * "set to nothing" is a configuration error, never a silent "off" (the TD67 lesson).
 */
export function readOptionalPiiKeyring(
  env: Readonly<Record<string, string | undefined>>,
  tag: string,
): PiiKeyring | null {
  const rawKeys = env["PII_ENCRYPTION_KEYS"];
  const rawKid = env["PII_ENCRYPTION_ACTIVE_KID"];
  if (rawKeys === "") {
    throw new Error(
      `[${tag}] PII_ENCRYPTION_KEYS must not be an empty string (unset it to disable the keyring)`,
    );
  }
  if (rawKid === "") {
    throw new Error(
      `[${tag}] PII_ENCRYPTION_ACTIVE_KID must not be an empty string (unset it to disable the keyring)`,
    );
  }
  if (rawKeys === undefined && rawKid === undefined) return null;
  if (rawKeys === undefined || rawKid === undefined) {
    throw new Error(
      `[${tag}] PII_ENCRYPTION_KEYS and PII_ENCRYPTION_ACTIVE_KID must be set together, or neither`,
    );
  }
  return parsePiiKeyring(rawKeys, rawKid, tag);
}

/** Encrypt/decrypt one PII value. Both throw on failure; neither message carries the value. */
export interface PiiCodec {
  encrypt(plaintext: string): string;
  decrypt(token: string): string;
}

/**
 * The codec `PiiCryptoService` is, minus Nest. With a keyring: write v2 under the active kid, read
 * BOTH v2 (by kid) and legacy v1 (via `legacyKey`). Without one: exactly the legacy single-key v1
 * path. So a runner writes the token format the API would write against the same configuration —
 * a row it touches looks like a row the API touched, and nothing else about the estate moves.
 */
export function piiCodec(legacyKey: string, keyring: PiiKeyring | null): PiiCodec {
  return keyring
    ? {
        encrypt: (plaintext) => encryptPiiWithKeyring(plaintext, keyring),
        decrypt: (token) => decryptPiiWithKeyring(token, keyring, legacyKey),
      }
    : {
        encrypt: (plaintext) => encryptPii(plaintext, legacyKey),
        decrypt: (token) => decryptPii(token, legacyKey),
      };
}
