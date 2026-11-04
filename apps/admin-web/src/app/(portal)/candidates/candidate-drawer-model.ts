import type {
  CandidateRecordResult,
  CandidateRecordStatus,
} from "../../../lib/candidate-detail";

/**
 * The Candidates drawer's rules (A7, #2577), pure so they are tested without a DOM: where ↑/↓
 * go, which key presses are a move, and how the drawer reads one record from the browser.
 */

/** The search param the drawer is addressed by: `/candidates?…&c=<worker id>`. */
export const CANDIDATE_PARAM = "c";

/**
 * How long a MOVE waits for the next one before reading its record. Every read that reaches the API
 * is audited and spends one name of the admin's hourly budget — even one the drawer aborts because
 * it moved on, since the API records the view before it answers; aborting cancels only a read not
 * yet sent. So the read waits out a skim: ↓ pressed at an ordinary scanning pace (about four a
 * second, 250ms apart) reads only the row it stops on. The title and the skeleton change at once —
 * only the read waits.
 */
export const RECORD_SETTLE_MS = 350;

/** One row of the list under the drawer: its worker id, and what the drawer is titled while it loads. */
export interface DrawerRow {
  id: string;
  title: string;
}

/** Where the drawer's id sits among the rows on this page, and the rows either side of it. */
export interface Neighbours {
  /** 0-based; -1 when the open candidate is not on this page (a pasted link, a later page). */
  index: number;
  prev: DrawerRow | null;
  next: DrawerRow | null;
}

export function neighbours(rows: readonly DrawerRow[], id: string | null): Neighbours {
  const index = id === null ? -1 : rows.findIndex((r) => r.id === id);
  if (index < 0) return { index: -1, prev: null, next: null };
  return { index, prev: rows[index - 1] ?? null, next: rows[index + 1] ?? null };
}

/** What a key press needs to say for the drawer to decide whether it is a move. */
export interface DrawerKeyPress {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** A held key's auto-repeat — never a move: holding ↓ would read row after row. */
  repeat: boolean;
  /** The pressed element takes the arrows itself: a text field, a select, an editable region. */
  inField: boolean;
  /** The press did not happen in the drawer — inside a confirm opened over it, or elsewhere. */
  outside: boolean;
}

/**
 * ↑ is the previous row and ↓ the next (#2577) — while the drawer has the keyboard. Not with a
 * modifier, not on auto-repeat, not in a field that uses the arrows, and not from a confirm on
 * top. At the first or last row there is nowhere to go, so the arrow keeps its own meaning (it
 * scrolls the drawer).
 */
export function drawerMove(press: DrawerKeyPress, around: Neighbours): DrawerRow | null {
  if (press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return null;
  if (press.repeat || press.inField || press.outside) return null;
  if (press.key === "ArrowUp") return around.prev;
  if (press.key === "ArrowDown") return around.next;
  return null;
}

/** Does this element take the arrow keys itself? (`<input>`, `<textarea>`, `<select>`, editable.) */
export function takesArrows(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

// ---------------------------------------------------------------------------
// reading one record from the browser
// ---------------------------------------------------------------------------

/** The same-origin read route (`[id]/record/route.ts`). */
export function recordHref(id: string): string {
  return `/candidates/${encodeURIComponent(id)}/record`;
}

const STATUSES: ReadonlySet<CandidateRecordStatus> = new Set([
  "ok",
  "not_found",
  "forbidden",
  "signed_out",
  "error",
]);

/**
 * The route's body, narrowed. The ROUTE parsed the API's response through the full schema
 * (`lib/candidate-detail.ts`); this checks only the envelope it wrapped it in, and anything else
 * — an HTML error page from a proxy, a truncated body — is the honest `error`.
 */
export function narrowRecordResult(body: unknown): CandidateRecordResult {
  if (typeof body !== "object" || body === null) return { status: "error" };
  const { status, detail } = body as { status?: unknown; detail?: unknown };
  if (typeof status !== "string" || !STATUSES.has(status as CandidateRecordStatus)) {
    return { status: "error" };
  }
  if (status === "ok") {
    return typeof detail === "object" && detail !== null
      ? ({ status: "ok", detail } as CandidateRecordResult)
      : { status: "error" };
  }
  return { status } as CandidateRecordResult;
}

/**
 * Read one record. Never throws for a failed read (the result says what failed); rejects only when
 * `signal` aborts it — the drawer moved on and nobody will look at the answer. The route passes the
 * abort on to its API call, which it cancels only if the API has not received it yet.
 */
export async function fetchCandidateRecord(
  id: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CandidateRecordResult> {
  try {
    const res = await fetchImpl(recordHref(id), {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
    return narrowRecordResult(await res.json());
  } catch (err) {
    if (signal.aborted) throw err;
    return { status: "error" };
  }
}
