import { z } from "zod";
import {
  UNLOCK_COMPANY_OUTCOMES,
  type UnlockCompanyOutcome,
  type UnlockOutcome,
} from "@badabhai/types";
import {
  BASE64URL_PATTERN,
  LOWERCASE_UUID_SCHEMA,
  PG_TIMESTAMP_UTC_SCHEMA,
} from "../applications/feed-cursor";

// ---------------------------------------------------------------------------
// POST /payer/unlocks/:unlockId/outcome
// ---------------------------------------------------------------------------

/**
 * The company's answer. `.strict()`: there is no slot for a payer id (the payer is the verified
 * session, XB-A), a worker, a posting, a date or a note. Only the three answers a company gives
 * itself: `not_reached` is the desk's (#2750) and is a `400` here, like any other value.
 */
export const RecordUnlockOutcomeSchema = z
  .object({ outcome: z.enum(UNLOCK_COMPANY_OUTCOMES) })
  .strict();
export type RecordUnlockOutcomeDto = z.infer<typeof RecordUnlockOutcomeSchema>;

/**
 * The answer, the same shape for a change and a repeat, so a retry reads like the first success
 * (`changed` is the difference). Ids, closed values and one date only.
 */
export interface RecordUnlockOutcomeResponseDto {
  unlock_id: string;
  worker_id: string;
  outcome: UnlockCompanyOutcome;
  /** The answer stored before this one; null for the first. */
  previous_outcome: UnlockOutcome | null;
  /** When the stored answer was given (a repeated `still_talking` moves it; any other repeat does not). */
  answered_at: string;
  /** False for a repeat: no new answer was recorded and no event was written. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// GET /payer/unlock-outcomes/due
// ---------------------------------------------------------------------------

/** Page size when the caller names none — the payer list convention (1..50, default 20). */
export const DUE_DEFAULT_LIMIT = 20;
/** The largest page one request can read. */
export const DUE_MAX_LIMIT = 50;

/**
 * THE DUE-LIST CURSOR — the position of the last row served, in the list's order
 * `unlocks.granted_at ASC, unlocks.id ASC` (the longest-waiting contact first, the unlock id as the
 * total-order tiebreak).
 *
 * WIRE FORM: base64url (no padding) of `{"v":1,"t":"<granted_at, microsecond UTC>","id":"<uuid>"}`,
 * the inbox cursor's scheme (`payer-applicant-inbox.cursor.ts`) on this read's own key. It carries
 * only the position of a row the company was already served — never a payer id, never a count. A
 * forged-but-well-formed cursor only moves the position inside the caller's OWN rows. The order is
 * stable while answers remove rows: an answered contact simply drops out, and the position after it
 * stays valid.
 */
export const DUE_CURSOR_VERSION = 1;
/** Bound on the raw query value. A minted cursor is ~110 characters. */
export const DUE_CURSOR_MAX_LENGTH = 256;

const DueCursorSchema = z
  .object({
    v: z.literal(DUE_CURSOR_VERSION),
    t: PG_TIMESTAMP_UTC_SCHEMA,
    id: LOWERCASE_UUID_SCHEMA,
  })
  .strict();

/** The decoded position: the last served row's `granted_at` (microsecond text) and unlock id. */
export interface DueCursor {
  readonly grantedKey: string;
  readonly unlockId: string;
}

/** Mint the wire form. Only the service calls this, from a row it served. */
export function encodeDueCursor(cursor: DueCursor): string {
  return Buffer.from(
    JSON.stringify({ v: DUE_CURSOR_VERSION, t: cursor.grantedKey, id: cursor.unlockId }),
    "utf8",
  ).toString("base64url");
}

/** Parse the wire form, or `null` for anything the server would not have minted. Never throws. */
export function decodeDueCursor(raw: string): DueCursor | null {
  if (raw.length > DUE_CURSOR_MAX_LENGTH || !BASE64URL_PATTERN.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = DueCursorSchema.safeParse(json);
  return parsed.success ? { grantedKey: parsed.data.t, unlockId: parsed.data.id } : null;
}

/**
 * `GET /payer/unlock-outcomes/due` query. Both keys optional; `.strict()`, so a smuggled
 * `payer_id` is a 400 rather than a silently ignored key. A cursor the server did not mint is a
 * 400 and never reaches a query.
 */
export const DueUnlocksQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(DUE_MAX_LIMIT).default(DUE_DEFAULT_LIMIT),
    cursor: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .max(DUE_CURSOR_MAX_LENGTH)
        .transform((raw, ctx) => {
          const cursor = decodeDueCursor(raw);
          if (cursor === null) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cursor is malformed" });
            return z.NEVER;
          }
          return cursor;
        })
        .optional(),
    ),
  })
  .strict();
export type DueUnlocksQueryDto = z.infer<typeof DueUnlocksQuerySchema>;

/** One due contact. Ids only: no name, no phone, no posting title. */
export interface DueUnlockItemDto {
  unlock_id: string;
  worker_id: string;
  /** When the contact was opened (ISO-8601). */
  granted_at: string;
  /** The current answer: null (none yet) or `still_talking` (asked again after the wait). */
  outcome: UnlockOutcome | null;
}

export interface DueUnlocksPageDto {
  items: DueUnlockItemDto[];
  /** Pass back as `?cursor=` for the next page; `null` when this page is the last. */
  nextCursor: string | null;
}
