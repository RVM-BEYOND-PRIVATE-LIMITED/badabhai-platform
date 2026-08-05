/**
 * Opaque keyset-pagination cursor for the admin ENTITY reads (BP-1).
 *
 * Same scheme as the event-spine cursor, on a different sort key: entities are ordered by
 * `(created_at, id)` DESC, events by `(occurred_at, id)`. Kept as its own module rather than
 * generalising the shipped one — a cursor whose field is called `occurredAt` while carrying a
 * `created_at` is the sort of small lie that survives for years and then misleads whoever
 * debugs a paging bug at 2am.
 *
 * `id` is the unique tie-breaker, so the keyset is TOTAL even when many rows share a
 * timestamp — which they will: bulk seeds and backfills insert thousands inside one
 * `defaultNow()` tick, and without the tie-breaker a page boundary landing mid-tick would
 * silently skip or repeat rows.
 */

export interface EntityCursor {
  /** The last row's `created_at`, as an ISO-8601 string (lossless to the DB timestamp). */
  createdAt: string;
  /** The last row's `id` (the unique tie-breaker). */
  id: string;
}

/** Encode an entity keyset cursor as an opaque base64url token. */
export function encodeEntityCursor(cursor: EntityCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt, i: cursor.id }), "utf8").toString(
    "base64url",
  );
}

/**
 * Decode an opaque cursor token. Returns null on ANY malformed/garbage/tampered input, so the
 * caller falls back to "first page" instead of 500ing — a cursor is client-held state and will
 * arrive truncated by a link shortener or hand-edited sooner or later.
 */
export function decodeEntityCursor(token: string | undefined): EntityCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") return null;
    // Validate the timestamp is well-formed BEFORE it reaches a WHERE clause: an unparseable
    // date becomes an Invalid Date, and `created_at < 'Invalid Date'` is not a filter, it is
    // a query that returns nothing (or throws) for reasons nobody can see from the response.
    if (Number.isNaN(Date.parse(parsed.c))) return null;
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}
