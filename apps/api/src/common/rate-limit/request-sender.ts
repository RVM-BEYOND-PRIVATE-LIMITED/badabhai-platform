/**
 * WHO is asking — resolved for throttling, and for nothing else (#1035).
 *
 * THE BUG THIS EXISTS FOR. Every per-caller cap on the worker auth routes was keyed on
 * `req.ip`. `TRUST_PROXY_HOP_COUNT` defaults to 0 and the shipped topology has no reverse
 * proxy, so `req.ip` is the socket peer — the NAT egress address. Indian carriers run
 * large-scale CGNAT and a factory or office wifi fronts everyone standing in it, so one
 * public address is shared by a great many workers. A handful of sign-ins exhausted the
 * bucket and every other worker behind that address got a 429 they could only read as
 * "OTP bhejne ki limit ho gayi" — and because the bucket is the NETWORK, changing your
 * phone number did nothing, which is exactly how it was reported.
 *
 * THE DEVICE IS ALREADY ON THE WIRE. `AuthedClient` injects `X-Device-Id` on EVERY request
 * (`apps/worker-app/lib/core/auth/authed_client.dart`), a locally-generated UUID persisted
 * in secure storage (`device_id.dart`). It is the identifier that actually matches the
 * question a send throttle is asking — "is one handset spamming?" — and it separates two
 * workers on one wifi, which an IP cannot.
 *
 * PRIVACY (§2). Nothing here hashes or stores anything: this module only decides WHICH
 * identifier is in play. The value is HMAC'd by {@link IpRateLimit} before it reaches a Redis
 * key, and neither the raw header nor the raw address is ever logged — the same posture
 * `worker_devices.device_hash` already takes for this exact identifier.
 */

/**
 * The throttling identity of one request, and which kind it is.
 *
 * THE KIND IS PART OF THE VALUE, not something a caller infers. Two buckets keyed by two
 * different kinds of identifier must never share a Redis namespace — a device-id hash and
 * an address hash are both 32 hex chars and would be indistinguishable once written — so
 * the discriminant travels with the value and the limiter picks the namespace from it.
 */
export type Sender =
  | { readonly kind: "device"; readonly value: string }
  | { readonly kind: "ip"; readonly value: string };

/** The header the worker app already sends on every request. Lower-case: Node normalises. */
export const DEVICE_ID_HEADER = "x-device-id";

/**
 * The accepted length band for a device id, MATCHING `DeviceInfoSchema.device_id`
 * (`z.string().min(8).max(256)`) — the same identifier arrives in the `/auth/otp/verify`
 * body, and one identifier accepted at two different widths is a bug waiting to happen.
 *
 * The lower bound is what the issue calls "absent/short": a caller that sends a couple of
 * characters is not identifying a handset, and letting it key a bucket would hand every
 * such caller a private allowance. The upper bound is the one that matters for safety —
 * this is an UNAUTHENTICATED front-door header and Node accepts a ~16KB header block, so
 * without it the caller chooses how much work the HMAC below does.
 */
export const DEVICE_ID_MIN_LENGTH = 8;
export const DEVICE_ID_MAX_LENGTH = 256;

/** The minimum an express `Request` must satisfy here — narrowed so tests need no fake app. */
export interface SenderSource {
  header(name: string): string | undefined;
  readonly ip?: string | undefined;
}

/**
 * Resolve the request's throttling identity: the device when it named one, else the address.
 *
 * FALLING BACK TO THE ADDRESS IS NOT A LOOPHOLE, it is the pre-#1035 behaviour preserved for
 * callers that were never asked for the header — an older worker build, a browser, curl. Such
 * a caller lands in the SAME `ip` bucket, at the SAME cap, as before this change; only clients
 * that identify a device get the per-device bucket. A caller can therefore "escape" the device
 * bucket only by dropping the header into the shared network bucket, which is stricter, not
 * looser.
 *
 * ROTATING DEVICE IDS IS THE REAL EVASION, and it is bounded elsewhere on purpose: a
 * reinstall mints a new id, so an abuser can too. What that buys them is more DISTINCT
 * buckets, never more SMS to one number — `OTP_MAX_SENDS_PER_HOUR` (50/number/hour),
 * `OTP_MAX_SENDS_PER_DAY` (50/number/day) and the platform-wide
 * `OTP_GLOBAL_MAX_SENDS_PER_DAY` breaker are what bound spend, and none of them is keyed on
 * the caller. Per-device is therefore strictly better than per-IP without weakening the
 * spend ceiling. The per-network ceiling above it stays as the crude flood backstop.
 *
 * NOTE (owner ruling, 2026-08-27): `senderOf` no longer runs on /auth/otp/request — the SEND
 * path is phone-only. This resolver is still used by /auth/otp/verify and /auth/test-login, so
 * the device-vs-address reasoning above still applies THERE, not on the send path.
 */
export function senderOf(req: SenderSource): Sender {
  const raw = req.header(DEVICE_ID_HEADER);
  const deviceId = typeof raw === "string" ? raw.trim() : "";
  if (deviceId.length >= DEVICE_ID_MIN_LENGTH && deviceId.length <= DEVICE_ID_MAX_LENGTH) {
    return { kind: "device", value: deviceId };
  }
  // `"unknown"` rather than throwing, exactly as every existing call site does: an address
  // express could not determine is one bucket shared by all of them, which is the strict
  // reading and cannot uncap anybody.
  return { kind: "ip", value: req.ip ?? "unknown" };
}
