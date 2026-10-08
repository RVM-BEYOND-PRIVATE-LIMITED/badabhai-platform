/**
 * #2113 — which of an erased worker's refresh tokens get an ERASED-CREDENTIAL TOMBSTONE.
 *
 * THE PROBLEM. `POST /auth/pin/verify` resolves identity from the device-bound refresh token. A
 * normal erasure (`AccountDeletionService.execute`) revokes every session FIRST, which DELs every
 * `refresh:<hash>` — so a deleted worker's app presents a token that no longer resolves, and the
 * only answer verifyPin could give was the neutral 401 ("PIN nahi chala"). The worker was sent
 * back to the keypad to guess a PIN that can never succeed.
 *
 * THE MECHANISM (owner ruling 2026-10-08, ADR-0026 D2 amendment). On a COMPLETED erasure the
 * server writes `refresh_erased:<sha256(token)>` = "1" for each token selected here, and verifyPin
 * reads it ONLY when the presented token does not resolve: a hit answers the reserved 410
 * WORKER_ACCOUNT_DELETED.
 *
 * THIS FILE IS THE SELECTION, AND NOTHING ELSE. It is pure — no Redis, no Nest, no clock of its
 * own, and deliberately NO import from session.service.ts (which imports it), so there is no
 * cycle and every rule below is testable as a plain function.
 *
 * WHAT IS KEPT, and why each rule exists:
 *   - `used === false` — only the live TIP of a family. A rotated (used:true) token is a
 *     credential the server already superseded; a holder of one stays on the neutral 401.
 *   - `worker_id === workerId` — a record indexed under this worker's lineage that names a
 *     DIFFERENT worker is never tombstoned on this worker's erasure.
 *   - a non-empty `device_id` — mirrors verifyPin's own gate (a): an unbound token can never
 *     unlock with a PIN, so it never needs the 410 either.
 *   - `sid`, `family_id` non-empty and `created_at_ms` finite — a well-formed record only.
 *   - at most {@link MAX_TOMBSTONES_PER_DEVICE} per device (newest first): the newest is the token
 *     the device holds; the second covers a PIN unlock whose response was lost, because
 *     `create()` mints a new family and leaves the older one alive.
 *   - at most {@link MAX_TOMBSTONES_PER_WORKER} per worker, as a hard bound on what one erasure
 *     can write.
 *
 * TTL = min(floor(the token's natural remaining life), horizon). Unused tips are only ever SET at
 * mint or as the new record at rotation, both with `created_at_ms = now` and `EX refreshTtl`, so
 * `created_at_ms + refreshTtl - now` IS the record's remaining life. `floor` (never `ceil`) so a
 * tombstone never outlives the token it stands in for; anything under 1s is dropped.
 *
 * WHAT IS NOT IN THE OUTPUT. Each entry is `{ tokenHash, ttlSeconds }` and nothing else: no
 * worker id, device id, sid or family id. The tombstone key is unlinkable server-side precisely
 * because nothing beside the hash survives the erasure.
 */

/** Newest-first tips kept per bound device (the held token + one lost-response predecessor). */
export const MAX_TOMBSTONES_PER_DEVICE = 2;

/** Hard ceiling on tombstones one erasure can write. */
export const MAX_TOMBSTONES_PER_WORKER = 64;

/** One tombstone to write: the refresh-token hash and its TTL. Deliberately nothing else. */
export interface ErasableRefreshToken {
  tokenHash: string;
  ttlSeconds: number;
}

/** A `refresh:<hash>` record as read from Redis, before it is parsed (`raw` null = missing). */
export interface RefreshTokenCandidate {
  tokenHash: string;
  raw: string | null;
}

export interface SelectErasableOptions {
  /** The worker being erased — a record naming any other worker is never kept. */
  workerId: string;
  /** "Now" in epoch ms, injected so the selection is deterministic under test. */
  nowMs: number;
  /** AUTH_REFRESH_TTL_DAYS in seconds — the natural life of every unused tip. */
  refreshTtlSeconds: number;
  /** ACCOUNT_DELETION_TOKEN_TOMBSTONE_SECONDS. 0 (or less) = the kill switch: nothing is kept. */
  horizonSeconds: number;
}

export interface SelectErasableResult {
  entries: ErasableRefreshToken[];
  /** Candidates not kept, for any reason. `entries.length + dropped === candidates.length`. */
  dropped: number;
}

/** The narrow shape the selector needs from a parsed refresh record. */
interface LiveDeviceBoundTip {
  worker_id: string;
  sid: string;
  family_id: string;
  used: false;
  device_id: string;
  created_at_ms: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Local type guard — the parsed JSON is untrusted until every field this file reads checks out. */
function isLiveDeviceBoundTip(v: unknown): v is LiveDeviceBoundTip {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.used === false &&
    isNonEmptyString(r.worker_id) &&
    isNonEmptyString(r.sid) &&
    isNonEmptyString(r.family_id) &&
    isNonEmptyString(r.device_id) &&
    typeof r.created_at_ms === "number" &&
    Number.isFinite(r.created_at_ms)
  );
}

function parseCandidate(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

interface Kept {
  tokenHash: string;
  deviceId: string;
  createdAtMs: number;
  ttlSeconds: number;
}

/** Newest first; ties broken by tokenHash ascending, so the selection is fully deterministic. */
function newestFirst(a: Kept, b: Kept): number {
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  if (a.tokenHash < b.tokenHash) return -1;
  if (a.tokenHash > b.tokenHash) return 1;
  return 0;
}

/**
 * Select the refresh tokens an erasure tombstones. Pure and total: never throws, whatever the
 * candidates contain.
 */
export function selectErasableRefreshTokens(
  candidates: readonly RefreshTokenCandidate[],
  opts: SelectErasableOptions,
): SelectErasableResult {
  if (!(opts.horizonSeconds > 0)) return { entries: [], dropped: candidates.length };

  const eligible: Kept[] = [];
  for (const candidate of candidates) {
    const rec = parseCandidate(candidate.raw);
    if (!isLiveDeviceBoundTip(rec)) continue;
    if (rec.worker_id !== opts.workerId) continue;

    const naturalRemainingSeconds = Math.floor(
      (rec.created_at_ms + opts.refreshTtlSeconds * 1000 - opts.nowMs) / 1000,
    );
    const ttlSeconds = Math.min(naturalRemainingSeconds, opts.horizonSeconds);
    if (!(ttlSeconds >= 1)) continue;

    eligible.push({
      tokenHash: candidate.tokenHash,
      deviceId: rec.device_id,
      createdAtMs: rec.created_at_ms,
      ttlSeconds,
    });
  }

  const byDevice = new Map<string, Kept[]>();
  for (const k of eligible) {
    const group = byDevice.get(k.deviceId) ?? [];
    group.push(k);
    byDevice.set(k.deviceId, group);
  }
  const perDevice: Kept[] = [];
  for (const group of byDevice.values()) {
    perDevice.push(...group.sort(newestFirst).slice(0, MAX_TOMBSTONES_PER_DEVICE));
  }

  const entries = perDevice
    .sort(newestFirst)
    .slice(0, MAX_TOMBSTONES_PER_WORKER)
    .map((k): ErasableRefreshToken => ({ tokenHash: k.tokenHash, ttlSeconds: k.ttlSeconds }));

  return { entries, dropped: candidates.length - entries.length };
}
