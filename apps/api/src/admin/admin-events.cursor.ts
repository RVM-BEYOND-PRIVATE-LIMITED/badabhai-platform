/**
 * Opaque keyset-pagination cursor for the admin event-spine reads (ADR-0025 ADMIN-2).
 *
 * The spine is paginated by KEYSET on `(occurred_at, id)` — NEVER by OFFSET — so a deep page
 * stays index-backed and O(page) instead of O(offset). The cursor encodes the last row's
 * `(occurred_at, id)`; the next query asks for rows strictly "after" it under the sort order.
 * It is base64url-encoded so it is URL-safe and opaque to the client (no internal coupling).
 *
 * Both list reads order DESC (newest-first), so "after the cursor" means strictly OLDER:
 *   (occurred_at, id) < (cursorOccurredAt, cursorId)   [lexicographic on the tuple]
 * `id` is the unique tie-breaker, so the keyset is total even when many rows share a timestamp.
 */

export interface KeysetCursor {
  /** The last row's `occurred_at`, as an ISO-8601 string (lossless to the DB timestamp). */
  occurredAt: string;
  /** The last row's `id` (the unique tie-breaker). */
  id: string;
}

/** Encode a keyset cursor as an opaque base64url token. */
export function encodeCursor(cursor: KeysetCursor): string {
  const json = JSON.stringify({ o: cursor.occurredAt, i: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor token. Returns null on any malformed/garbage input (the caller then
 * treats it as "no cursor" / first page rather than 500ing on a tampered token) — fail-safe.
 */
export function decodeCursor(token: string | undefined): KeysetCursor | null {
  if (!token) return null;
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { o?: unknown; i?: unknown };
    if (typeof parsed.o !== "string" || typeof parsed.i !== "string") return null;
    // Validate the timestamp + id are well-formed before trusting them in a WHERE clause.
    if (Number.isNaN(Date.parse(parsed.o))) return null;
    return { occurredAt: parsed.o, id: parsed.i };
  } catch {
    return null;
  }
}
