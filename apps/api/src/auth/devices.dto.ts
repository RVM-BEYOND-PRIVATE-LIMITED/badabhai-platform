import { z } from "zod";

/**
 * Optional `device_info` a client MAY send on POST /auth/otp/verify to bind the new
 * session to a trusted device (ADR-0026 Phase 2). Entirely additive + opt-in: a client
 * that omits it logs in exactly as before (no device row, no `did` claim).
 *
 * PRIVACY (CLAUDE.md §2): `device_id` is the client's stable, locally-generated device
 * identifier — it is keyed-HMAC'd server-side into `worker_devices.device_hash` and the
 * RAW value is never stored, logged, or put in an event. `push_token` is stored raw (it
 * must stay usable to push) but is NEVER placed in any event / log / ai_jobs / audit_log.
 */
export const DeviceInfoSchema = z.object({
  device_id: z.string().min(8).max(256),
  platform: z.enum(["android", "ios", "web", "unknown"]).default("unknown"),
  model: z.string().max(128).optional(),
  app_version: z.string().max(64).optional(),
  push_token: z.string().max(512).optional(),
});
export type DeviceInfoDto = z.infer<typeof DeviceInfoSchema>;

/**
 * A trusted-device row as surfaced by GET /auth/devices. PRIVACY: the `device_hash`
 * (HMAC) and the `push_token` are DELIBERATELY excluded — the wire shape carries only
 * the opaque row id, coarse descriptors, timestamps, and whether it is the caller's
 * current device. No raw client device id, no hash, no push token ever leaves here.
 */
export interface DeviceListItem {
  id: string;
  platform: string;
  model: string | null;
  app_version: string | null;
  trusted_at: string;
  last_seen_at: string;
  is_current: boolean;
}

/** Response of GET /auth/devices — the worker's active (non-revoked) trusted devices. */
export interface DeviceListResponse {
  devices: DeviceListItem[];
}
