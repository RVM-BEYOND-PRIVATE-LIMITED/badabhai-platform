/**
 * BadaBhai's at-rest PII crypto now lives in `@badabhai/db` (the package that defines
 * the ciphertext columns it protects — `workers.phone_e164`, `payers.email_enc`, …),
 * so the API, the demand seed, and any future backfill share ONE implementation and
 * one token format. This module RE-EXPORTS it to keep the `./crypto` import path stable
 * for `PiiCryptoService` and the crypto tests — the functions are byte-identical.
 */
export {
  sha256Hex,
  hmacSha256Hex,
  hashPhone,
  hashIp,
  hmacValue,
  encryptPii,
  decryptPii,
  encryptPiiWithKeyring,
  decryptPiiWithKeyring,
  isEncryptedPii,
  safeEqualHex,
  hashPin,
  verifyPin,
  isPinHash,
  PII_KID_PATTERN,
} from "@badabhai/db";
export type { PiiKeyring } from "@badabhai/db";
