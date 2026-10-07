import { z } from "zod";
import type { AgencyJob, CandidateInboxRow, InboxPostingRef, PostingSummary } from "./contracts";
import { isPayerBadRequest } from "./payer-errors";

/**
 * PURE reads for the Candidates tab (`/candidates`, the cross-posting applicant inbox) — no I/O,
 * no React. The page reads the URL, the inbox and the payer's own postings list; these decide what
 * the URL asks for, what a failed read refused, which page each row's posting opens, and what the
 * posting filter offers.
 *
 * AFFORDANCE ONLY: nothing here authorizes anything. The inbox endpoint decides which rows the
 * session sees and the unlock endpoint decides every spend; this module only mirrors the portal's
 * own page gates so a row never links to a page that would refuse this session.
 */

/** The route. Labels only — the per-posting page stays "Applicants". */
export const CANDIDATES_PATH = "/candidates";

/** The one query key the filter writes. */
export const POSTING_FILTER_PARAM = "postingId";
/** The previous page's `nextCursor`, carried verbatim. */
export const CURSOR_PARAM = "cursor";

/** What the URL asks the inbox for. */
export type CandidateFilter =
  | { kind: "all" }
  | { kind: "posting"; postingId: string }
  /**
   * A value that cannot be a posting id (or a repeated param). It matches nothing — the SAME
   * neutral empty result an unknown or another payer's id gets from the server — decided before
   * any read, so a hand-edited URL never becomes an API 400 and a "Retry" that cannot succeed.
   */
  | { kind: "unknown"; raw: string };

export interface CandidatesQuery {
  filter: CandidateFilter;
  /** The page's cursor, or null for the newest page. */
  cursor: string | null;
}

/** The SHAPE of a cursor the server mints: base64url, at most 256 characters (its own bound). */
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{1,256}$/;
const uuid = z.string().uuid();

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Read `/candidates?postingId=&cursor=`. An empty `postingId` is "all" (the filter form's "All
 * postings" option submits it). A posting id is lowercased — the form of every id the payer's
 * own data carries — so an uppercase spelling selects its option rather than adding a second one.
 *
 * A cursor of any other shape is dropped: the page reads the newest page. A cursor OF that shape
 * is sent as it is — only the server can tell whether it minted one (it is opaque) — so a
 * hand-edited one is still refused, and that 400 is the page's cursor refusal
 * ({@link inboxRefusal}): the way out is the first page, never a Retry.
 */
export function parseCandidatesQuery(params: SearchParams): CandidatesQuery {
  const rawPosting = params[POSTING_FILTER_PARAM];
  const rawCursor = params[CURSOR_PARAM];
  let filter: CandidateFilter;
  if (rawPosting === undefined || rawPosting === "") filter = { kind: "all" };
  else if (typeof rawPosting === "string" && uuid.safeParse(rawPosting).success)
    filter = { kind: "posting", postingId: rawPosting.toLowerCase() };
  else filter = { kind: "unknown", raw: Array.isArray(rawPosting) ? rawPosting.join(",") : rawPosting };
  const cursor = typeof rawCursor === "string" && CURSOR_SHAPE.test(rawCursor) ? rawCursor : null;
  return { filter, cursor };
}

/**
 * What a failed inbox read REFUSED — the admin console's rule (docs/design/NAVIGATION.md, "A
 * refused read is not an outage"), on this page's address:
 *  - the posting filter: never the refused part of a read. A value that cannot be an id is never
 *    sent — it is `unknown`, decided before any read, and its state's "All postings" is the way
 *    out (the filter-cleared page) — and a well-formed id is never refused;
 *  - `"cursor"` — a 400 with a page cursor in the address: the server did not mint that cursor
 *    (hand-edited, or from another list). Repeating the request cannot succeed, so the way out is
 *    the first page, the posting filter kept — never Retry;
 *  - `null` — anything else: a 400 with no cursor (nothing in the address the server could have
 *    refused, so it is not the payer's), a 5xx, an unreadable answer. An outage, with Retry.
 * A 429 is neither: the page tells it apart first (`isPayerRateLimited`).
 */
export type InboxRefusal = "cursor" | null;

export function inboxRefusal(err: unknown, query: Pick<CandidatesQuery, "cursor">): InboxRefusal {
  return isPayerBadRequest(err) && query.cursor !== null ? "cursor" : null;
}

/** The filter's selected value (null = all postings). */
export function selectedPosting(filter: CandidateFilter): string | null {
  if (filter.kind === "posting") return filter.postingId;
  if (filter.kind === "unknown") return filter.raw;
  return null;
}

/** `/candidates` with only the keys that are set — never an empty `postingId=` or `cursor=`. */
export function candidatesHref({
  postingId,
  cursor,
}: {
  postingId?: string | null;
  cursor?: string | null;
}): string {
  const q = new URLSearchParams();
  if (postingId) q.set(POSTING_FILTER_PARAM, postingId);
  if (cursor) q.set(CURSOR_PARAM, cursor);
  const qs = q.toString();
  return qs ? `${CANDIDATES_PATH}?${qs}` : CANDIDATES_PATH;
}

/** The session facts a row's posting link depends on — the same ones the portal's gates read. */
export interface CandidateViewer {
  /** `session.role === "agent"`. */
  isAgency: boolean;
  /** `agencyFlags().agencyPortalEnabled` — every agency page's gate. */
  agencyPortalEnabled: boolean;
}

/**
 * The posting a Candidates card names, as THIS session may use it.
 *  - `id` — the unlock's `job_id` and the resume disclosure's context (the row's own posting);
 *  - `title` — the payer's own title for it;
 *  - `href` — the posting's details page, or null when this session has no such page;
 *  - `viewOnly` — true when the posting's own Applicants page offers this session no unlock, so the
 *    card offers none either.
 */
export interface ApplicantPosting {
  id: string;
  title: string;
  href: string | null;
  viewOnly: boolean;
}

/**
 * A row's posting, mirroring the portal's own gates (docs/design/NAVIGATION.md):
 *  - a COMPANY posting is a company's: details at `/postings/<id>`, its Applicants feed unlocks.
 *    For an AGENCY it is an older posting from before agencies had their own (owner ruling
 *    2026-10-01): view-only, and nothing in an agency's portal links to it — so no link, no spend.
 *  - an AGENCY job is an agency's: details at `/agency/jobs/<id>` while the agency portal is on.
 *    Any other session has no page for it (every `/agency/*` page is agent-only): no link, no spend.
 * The server still decides every unlock; this only keeps the card from offering a door the
 * posting's own page does not.
 */
export function candidatePosting(ref: InboxPostingRef, viewer: CandidateViewer): ApplicantPosting {
  const own =
    ref.kind === "company_posting"
      ? !viewer.isAgency
      : viewer.isAgency && viewer.agencyPortalEnabled;
  if (!own) return { id: ref.id, title: ref.title, href: null, viewOnly: true };
  const base = ref.kind === "company_posting" ? "/postings" : "/agency/jobs";
  return { id: ref.id, title: ref.title, href: `${base}/${ref.id}`, viewOnly: false };
}

/** One option of the posting filter. */
export interface PostingOption {
  id: string;
  label: string;
}

const STATUS_WORD: Record<string, string> = {
  draft: "draft",
  paused: "paused",
  closed: "closed",
  suspended: "suspended",
};

/** "CNC Turner", or "CNC Turner (paused)" for anything but open — two postings may share a title. */
function optionLabel(title: string, status: string): string {
  const word = STATUS_WORD[status];
  return word ? `${title} (${word})` : title;
}

/** A company's filter: its own company postings, in the list read's order (newest first). */
export function companyPostingOptions(postings: readonly PostingSummary[]): PostingOption[] {
  return postings.map((p) => ({ id: p.id, label: optionLabel(p.roleTitle, p.status) }));
}

/** An agency's filter: its own agency postings (`jobs`), in the list read's order. */
export function agencyPostingOptions(jobs: readonly AgencyJob[]): PostingOption[] {
  return jobs.map((j) => ({ id: j.id, label: optionLabel(j.title, j.status) }));
}

/**
 * The options with the CURRENT selection always present, so the control says what the list shows.
 * A selected id the list read does not hold (that read failed, an agency's older company posting,
 * or an id that matches nothing) is named from the inbox rows when one carries it, else generically
 * — an id is never resolved to a title from anywhere but the payer's own data.
 */
export function withSelectedOption(
  options: readonly PostingOption[],
  selected: string | null,
  rows: readonly Pick<CandidateInboxRow, "posting">[],
): PostingOption[] {
  if (selected === null || options.some((o) => o.id === selected)) return [...options];
  const named = rows.find((r) => r.posting.id === selected)?.posting.title;
  return [...options, { id: selected, label: named ?? "Selected posting" }];
}
