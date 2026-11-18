import { z } from "zod";
import {
  BASE64URL_PATTERN,
  LOWERCASE_UUID_SCHEMA,
  PG_TIMESTAMP_UTC_SCHEMA,
} from "../applications/feed-cursor";

/**
 * #2746 PR 6 — THE TWO CAMPUS-DRIVE REQUEST CURSORS: the position of the last row served.
 *
 *   `company`  the company's own list, `created_at DESC, id DESC` (newest first), served by
 *              `campus_drive_requests_payer_idx`;
 *   `campus`   Campus's feed, `updated_at ASC, id ASC` (change order), served by
 *              `campus_drive_requests_changed_idx`.
 *
 * WIRE FORM: base64url (no padding) of `{"v":1,"k":"company"|"campus","t":"<microsecond UTC>",
 * "id":"<uuid>"}` — the `GET /feed` and applicant-inbox scheme (#1961). `t` is Postgres's
 * microsecond text (`to_char`), never a JS `Date`, which would truncate to milliseconds and skip or
 * repeat rows inside one millisecond at a page boundary. `k` names the list, so a cursor minted by
 * one list is refused by the other instead of being read in the wrong order.
 *
 * Opaque is a contract, not a secret: it carries only the position of a row already served. Never
 * a company id (the company is always the session's), a filter or a count. Validated with zod on
 * the way back in: anything the server would not have minted is `null`, which the query schema
 * turns into a 400 — never a 500 from a bad bind. A forged-but-well-formed cursor only moves the
 * position inside rows the caller may read anyway.
 */

export const DRIVE_CURSOR_VERSION = 1;

/** Bound on the raw query value. A minted cursor is about 130 characters. */
export const DRIVE_CURSOR_MAX_LENGTH = 256;

export type DriveCursorKind = "company" | "campus";

const DriveCursorSchema = z
  .object({
    v: z.literal(DRIVE_CURSOR_VERSION),
    k: z.enum(["company", "campus"]),
    t: PG_TIMESTAMP_UTC_SCHEMA,
    id: LOWERCASE_UUID_SCHEMA,
  })
  .strict();

/** The decoded position: the last served row's sort timestamp (microsecond text) and id. */
export interface DriveCursor {
  at: string;
  id: string;
}

/** Mint the wire form. Only the services call this, from a row they served. */
export function encodeDriveCursor(kind: DriveCursorKind, cursor: DriveCursor): string {
  return Buffer.from(
    JSON.stringify({ v: DRIVE_CURSOR_VERSION, k: kind, t: cursor.at, id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

/** Parse the wire form for `kind`, or `null` for anything the server would not have minted. */
export function decodeDriveCursor(kind: DriveCursorKind, raw: string): DriveCursor | null {
  if (raw.length > DRIVE_CURSOR_MAX_LENGTH || !BASE64URL_PATTERN.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = DriveCursorSchema.safeParse(json);
  if (!parsed.success || parsed.data.k !== kind) return null;
  return { at: parsed.data.t, id: parsed.data.id };
}
