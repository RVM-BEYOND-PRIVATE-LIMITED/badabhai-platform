import { z } from "zod";

/**
 * THE `GET /feed` CURSOR (#1961, ADR-0052). Opaque to the client, versioned, and validated with
 * Zod on the way back in, so a cursor the server did not mint is a 400 at the boundary — never a
 * 500 from a bad bind.
 *
 * WIRE FORM: base64url (no padding) of a small JSON object. "Opaque" is a contract, not a
 * secret: the payload carries only sort keys the client was already served (`posted_at`, the
 * card's own id, V1's boost bucket and match tier) and a count. It carries no worker id (the
 * worker always comes from the session), and no payer key: the V1 interleave key never leaves
 * the server (ADR-0036).
 *
 * ONE SHAPE PER SERVED ORDER, discriminated by `m`:
 *
 *   `jobs`   the legacy `jobs` scan        keyset on (posted_at DESC, id ASC)
 *   `union`  ADR-0049 jobs ∪ job_postings  that keyset PER ARM — see `UnionFeedCursor`
 *   `v1`     MATCH_V1 deck                  keyset on its own ORDER BY, plus the served-ahead set
 *
 * `o` is the number of cards already served on this scroll, so `rank` (and the `feed.shown` /
 * `feed.shown_v2` rank) stays the 1-based position in the deck across pages.
 *
 * Pure: no I/O, no clock, no Nest. The service decides which shape it expects.
 */

export const FEED_CURSOR_VERSION = 1;

/** Bound on the raw query value — far above any cursor the server mints (~3 KB worst case). */
export const FEED_CURSOR_MAX_LENGTH = 4096;

/**
 * Most V1 card ids a cursor carries as "already served, beyond the keyset" (see
 * `V1FeedCursor.a`). Equal to the page cap, so one page's pull-forwards always fit. Past the
 * cap the ids furthest down the deck are dropped, which can only RE-SERVE a card — never skip
 * one.
 */
export const FEED_CURSOR_MAX_AHEAD = 50;

/** Bound on `o`. A worker who scrolls past a million cards gets a 400, not an overflowing rank. */
export const FEED_CURSOR_MAX_OFFSET = 1_000_000;

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "not a lowercase uuid");

/**
 * A `timestamptz` at Postgres's full MICROSECOND precision, in UTC. A JS `Date` cannot be the
 * keyset value: it truncates to milliseconds, and two rows inside one millisecond would then be
 * skipped or repeated at a page boundary. The repository projects this text with `to_char`.
 *
 * A REAL INSTANT, NOT MERELY A PARSEABLE ONE (L1, security review of PR #2116). `Date.parse` is
 * not a calendar check: it rolls `2026-02-30` over to 2 March and accepts year `0000`, and
 * Postgres refuses both at the bind (22008) — a forged cursor came back as a 500 from the read.
 * So the text must ROUND-TRIP: re-serialised, the parsed instant reproduces the input to the
 * second (the six fractional digits are the keyset's own and are not compared), and the year is
 * at least 1. Anything else is a 400 at the DTO, before any read.
 */
const PG_TIMESTAMP_UTC = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, "not a microsecond UTC timestamp")
  .refine(isRealUtcInstant, "not a valid timestamp");

/** True when `s` (already the pattern above) names an instant that exists, in year 1 or later. */
function isRealUtcInstant(s: string): boolean {
  const ms = Date.parse(s);
  if (Number.isNaN(ms) || Number(s.slice(0, 4)) < 1) return false;
  return new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
}

const OFFSET = z.number().int().min(0).max(FEED_CURSOR_MAX_OFFSET);

/** The last served position in one `posted_at DESC, id ASC` arm. */
const PostedKeySchema = z.object({ t: PG_TIMESTAMP_UTC, id: UUID }).strict();
export type PostedKey = z.infer<typeof PostedKeySchema>;

const JobsFeedCursorSchema = z
  .object({
    v: z.literal(FEED_CURSOR_VERSION),
    m: z.literal("jobs"),
    o: OFFSET,
    j: PostedKeySchema,
  })
  .strict();
export type JobsFeedCursor = z.infer<typeof JobsFeedCursorSchema>;

/**
 * The union's position: the last served key of EACH arm, `null` for an arm that has served
 * nothing yet (it resumes from its own head). Never both null — that is the first page, which
 * has no cursor.
 *
 * Why per arm and not one merged key: `mergeNewestFirst` compares heads on a millisecond JS
 * `Date`, while each arm is in Postgres's microsecond order. Two cards from different arms in the
 * same millisecond can be merged in an order a single microsecond keyset disagrees with, and
 * one of them would then fall behind the cursor (a gap). Each arm's prefix is exact whatever
 * the merge comparator does, so resuming each arm after ITS last served card is gap- and
 * duplicate-free by construction. Both arms still take the same keyset predicate.
 */
const UnionFeedCursorSchema = z
  .object({
    v: z.literal(FEED_CURSOR_VERSION),
    m: z.literal("union"),
    o: OFFSET,
    j: PostedKeySchema.nullable(),
    p: PostedKeySchema.nullable(),
  })
  .strict()
  .refine((c) => c.j !== null || c.p !== null, "a union cursor names at least one arm");
export type UnionFeedCursor = z.infer<typeof UnionFeedCursorSchema>;

/** The V1 sort tuple of one served row — `MatchFeedRepository.listFeed`'s ORDER BY, verbatim. */
const V1KeySchema = z
  .object({
    /** The boost bucket the row was served in (`boosted_until > now()` at that read). */
    b: z.boolean(),
    /** `job_reach.match_tier`. */
    r: z.union([z.literal(1), z.literal(2)]),
    /** `published_at`, or null (it sorts NULLS LAST). */
    t: PG_TIMESTAMP_UTC.nullable(),
    id: UUID,
  })
  .strict();
export type V1Key = z.infer<typeof V1KeySchema>;

/**
 * The V1 position. `k` is the FRONTIER: every row up to and including it in SQL order has been
 * served. `a` is the AHEAD set: rows served beyond the frontier, because the E14 company
 * interleave pulled them forward over a deferred row. The next page reads after `k` and drops
 * `a`, so neither a deferred row (a gap) nor a pulled-forward one (a duplicate) is lost.
 */
const V1FeedCursorSchema = z
  .object({
    v: z.literal(FEED_CURSOR_VERSION),
    m: z.literal("v1"),
    o: OFFSET,
    k: V1KeySchema,
    a: z.array(UUID).max(FEED_CURSOR_MAX_AHEAD),
  })
  .strict();
export type V1FeedCursor = z.infer<typeof V1FeedCursorSchema>;

export const FeedCursorSchema = z.union([
  JobsFeedCursorSchema,
  UnionFeedCursorSchema,
  V1FeedCursorSchema,
]);
export type FeedCursor = z.infer<typeof FeedCursorSchema>;
export type FeedCursorMode = FeedCursor["m"];

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Mint the wire form. Only the service calls this, with a cursor it built. */
export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Parse the wire form, or `null` for anything the server would not have minted: not base64url,
 * not JSON, an unknown version, a missing or extra key, an out-of-range value. Never throws.
 */
export function decodeFeedCursor(raw: string): FeedCursor | null {
  if (raw.length > FEED_CURSOR_MAX_LENGTH || !BASE64URL.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = FeedCursorSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The cursor primitives, shared with the payer inbox cursor
 * (`payer-portal/payer-applicant-inbox.cursor.ts`) so "a keyset timestamp" and "a served id" are
 * one definition, not two that can drift.
 */
export {
  UUID as LOWERCASE_UUID_SCHEMA,
  PG_TIMESTAMP_UTC as PG_TIMESTAMP_UTC_SCHEMA,
  BASE64URL as BASE64URL_PATTERN,
};
