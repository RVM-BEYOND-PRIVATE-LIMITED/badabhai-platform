import { createHash } from "node:crypto";

/**
 * Hash helpers for PII that must be referenced but never stored/transmitted in
 * the clear (e.g. in events). Phase 1 uses a plain SHA-256; a keyed HMAC with a
 * server-side pepper should be introduced before production (TODO).
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash an E.164 phone number for use as a stable, non-reversible key. */
export function hashPhone(phoneE164: string): string {
  return sha256Hex(`phone:${phoneE164}`);
}

/** Hash an IP address for consent/audit records. */
export function hashIp(ip: string): string {
  return sha256Hex(`ip:${ip}`);
}
