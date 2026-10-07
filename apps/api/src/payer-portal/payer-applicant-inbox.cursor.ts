import { z } from "zod";
import {
  BASE64URL_PATTERN,
  LOWERCASE_UUID_SCHEMA,
  PG_TIMESTAMP_UTC_SCHEMA,
} from "../applications/feed-cursor";

/**
 * THE `GET /payer/reach/applicants` CURSOR — the position of the last row served, in the inbox's
 * order `applications.created_at DESC, applications.id DESC` (newest application first, the
 * application id as the total-order tiebreak).
 *
 * WIRE FORM: base64url (no padding) of `{"v":1,"t":"<created_at, microsecond UTC>","id":"<uuid>"}`.
 * The `GET /feed` cursor's scheme (#1961), on this read's own key. Opaque is a contract, not a
 * secret: it carries only the position of a row the payer was already served — never a payer id
 * (the payer is always the session's), never a filter, never a count.
 *
 *  - `t` is Postgres's MICROSECOND text, projected with `to_char`. A JS `Date` truncates to
 *    milliseconds, and two applications inside one millisecond would then be skipped or
 *    repeated at a page boundary.
 *  - `id` is the application id that breaks a timestamp tie. Every row is one application and an
 *    application is listed at most once, so the key is unique and the order total.
 *
 * Validated with Zod on the way back in: anything the server would not have minted (not
 * base64url, not JSON, another version, a missing or extra key) is `null`, which the query DTO
 * turns into a 400 — never a 500 from a bad bind. A forged-but-well-formed cursor only moves the
 * position inside the caller's OWN rows: ownership is decided by the session, not the cursor.
 */

export const INBOX_CURSOR_VERSION = 1;

/** Bound on the raw query value. A minted cursor is ~110 characters. */
export const INBOX_CURSOR_MAX_LENGTH = 256;

const InboxCursorSchema = z
  .object({
    v: z.literal(INBOX_CURSOR_VERSION),
    t: PG_TIMESTAMP_UTC_SCHEMA,
    id: LOWERCASE_UUID_SCHEMA,
  })
  .strict();

/** The decoded position: the last served row's `created_at` (microsecond text) and id. */
export interface InboxCursor {
  appliedKey: string;
  applicationId: string;
}

/** Mint the wire form. Only the service calls this, from a row it served. */
export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(
    JSON.stringify({ v: INBOX_CURSOR_VERSION, t: cursor.appliedKey, id: cursor.applicationId }),
    "utf8",
  ).toString("base64url");
}

/** Parse the wire form, or `null` for anything the server would not have minted. Never throws. */
export function decodeInboxCursor(raw: string): InboxCursor | null {
  if (raw.length > INBOX_CURSOR_MAX_LENGTH || !BASE64URL_PATTERN.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = InboxCursorSchema.safeParse(json);
  return parsed.success ? { appliedKey: parsed.data.t, applicationId: parsed.data.id } : null;
}
