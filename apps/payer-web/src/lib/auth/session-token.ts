import { createHmac, timingSafeEqual } from "node:crypto";
import type { PayerSession } from "./types";

/**
 * PURE session-token codec for the mock seam — HMAC-signed, tamper-resistant
 * encode/decode of a {@link PayerSession}. No `server-only`, no cookies, no I/O, so
 * it is unit-testable in a node env. The mock provider wraps this with the cookie
 * store. The signing key is server-only env; a bad signature ⇒ null (fail closed).
 *
 * SECURITY (XB-H): the client cannot forge or tamper a session — the HMAC key
 * never leaves the server, and `decode` constant-time-compares the MAC. The token
 * carries ONLY the opaque payerId + a non-PII label (invariant #2 / B-R2).
 */

function signingKey(): string {
  return process.env.PAYER_SESSION_SECRET ?? "dev-mock-payer-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function encodeSession(session: PayerSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(raw: string): PayerSession | null {
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PayerSession).payerId === "string" &&
      typeof (parsed as PayerSession).displayLabel === "string" &&
      ((parsed as PayerSession).role === "employer" ||
        (parsed as PayerSession).role === "agent")
    ) {
      return parsed as PayerSession;
    }
    return null;
  } catch {
    return null;
  }
}
