import Link from "next/link";

/**
 * Keyset "next page" control, shared by every entity list.
 *
 * The cursor is dropped from the base params and re-added from THIS page's response, so
 * cursors never stack and changing a filter always restarts at page one. Applying page
 * three's cursor to a brand-new query returns an arbitrary slice of it, which looks like
 * data rather than like an error.
 *
 * There is no "previous" link and no page numbers, deliberately: a keyset cursor only
 * moves forward, and rendering 1·2·3 over a table that is being appended to would promise
 * a stable pagination that does not exist.
 */
export function Pager({
  basePath,
  params,
  nextCursor,
  note = "Paging uses a keyset cursor, so rows arriving mid-scan cannot skip or repeat.",
}: {
  basePath: string;
  /** The active filters, WITHOUT any cursor. */
  params: Record<string, string | undefined>;
  nextCursor: string | null | undefined;
  note?: string;
}) {
  if (!nextCursor) return null;

  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  q.set("cursor", nextCursor);

  return (
    <div className="pager">
      <Link className="btn btn--ghost" href={`${basePath}?${q.toString()}`}>
        Next page
      </Link>
      <p className="field__help">{note}</p>
    </div>
  );
}
