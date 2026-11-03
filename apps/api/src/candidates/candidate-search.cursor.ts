import { createHash } from "node:crypto";
import { z } from "zod";
import { BASE64URL_PATTERN, LOWERCASE_UUID_SCHEMA } from "../applications/feed-cursor";

/**
 * THE `POST /payer/candidates/search` CURSOR — "after the candidate you were last served, in the
 * search you were running".
 *
 * WIRE FORM: base64url (no padding) of `{"v":1,"f":"<fingerprint>","w":"<uuid>","o":<served>}`.
 *  - `w` is the last worker id on the page — one the payer has already been shown;
 *  - `o` is how many rows the search has served so far (the fallback position, below);
 *  - `f` fingerprints the search that minted it (see {@link searchFingerprint}).
 *
 * WHY AN ANCHOR AND NOT THE SORT KEYS. A cursor is decodable by design (opaque is a contract, not
 * a secret). Carrying the anchor row's sort keys would hand a payer facts the card never shows —
 * at `limit=1` paging, a worker's last-active day, one cursor per worker. So the cursor names only
 * WHO was last served; the server re-reads that worker's CURRENT keys and pages strictly after
 * them. If he has since left the population (opted out, turned his skills off), the page resumes
 * at position `o` of the current order instead — exact when he is the one who left (everyone
 * after him moved up one place); a row can repeat or be skipped only when OTHERS ahead of him
 * also changed between the two pages.
 *
 * BOUND TO ITS SEARCH. A cursor minted under one set of filters is refused (a 400) under another:
 * a position in one order is meaningless in a different one. The fingerprint is checked by the
 * service, which knows the resolved filters; the DTO only decodes the shape.
 *
 * Validated with Zod on the way back in: anything the server would not have minted is `null`,
 * which the DTO turns into a 400 — never a 500 from a bad bind.
 */

export const CANDIDATE_CURSOR_VERSION = 1;

/** Bound on the raw value. A minted cursor is ~100 characters. */
export const CANDIDATE_CURSOR_MAX_LENGTH = 256;

/** The fingerprint is a 22-character base64url prefix of a SHA-256 (132 bits). */
const FINGERPRINT = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "not a search fingerprint");

/** Rows served so far: bounded so a forged value stays inside an int4 bind. */
const SERVED = z.number().int().min(1).max(1_000_000);

const CandidateCursorSchema = z
  .object({
    v: z.literal(CANDIDATE_CURSOR_VERSION),
    f: FINGERPRINT,
    w: LOWERCASE_UUID_SCHEMA,
    o: SERVED,
  })
  .strict();

/** The decoded position. */
export interface CandidateCursor {
  fingerprint: string;
  /** The last worker served. */
  workerId: string;
  /** Rows served so far, this one included. */
  served: number;
}

/** Mint the wire form. Only the service calls this, from a row it served. */
export function encodeCandidateCursor(cursor: CandidateCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CANDIDATE_CURSOR_VERSION,
      f: cursor.fingerprint,
      w: cursor.workerId,
      o: cursor.served,
    }),
    "utf8",
  ).toString("base64url");
}

/** Parse the wire form, or `null` for anything the server would not have minted. Never throws. */
export function decodeCandidateCursor(raw: string): CandidateCursor | null {
  if (raw.length > CANDIDATE_CURSOR_MAX_LENGTH || !BASE64URL_PATTERN.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = CandidateCursorSchema.safeParse(json);
  if (!parsed.success) return null;
  return { fingerprint: parsed.data.f, workerId: parsed.data.w, served: parsed.data.o };
}

/** Everything that decides the ORDER and the MEMBERSHIP of a search's rows. */
export interface SearchShape {
  skillIds: readonly string[];
  relatedSkillIds: readonly string[];
  experience: string | null;
  industryId: string | null;
  industryExperience: string | null;
  /** The asked city, canonicalised (so "pune" and "Pune" are one search). */
  city: string | null;
  strict: boolean;
  tierFloorMonths: number;
}

/**
 * A stable fingerprint of a search: order-insensitive in its lists, sensitive to every value
 * that changes which rows are served or in what order.
 */
export function searchFingerprint(shape: SearchShape): string {
  const canonical = JSON.stringify([
    [...shape.skillIds].sort(),
    [...shape.relatedSkillIds].sort(),
    shape.experience,
    shape.industryId,
    shape.industryExperience,
    shape.city === null ? null : shape.city.toLowerCase(),
    shape.strict,
    shape.tierFloorMonths,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 22);
}
