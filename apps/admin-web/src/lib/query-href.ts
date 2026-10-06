/**
 * A list route with its query string: every SET value, in the order given, `undefined` and empty
 * values dropped — `/workers` when nothing is set, never `/workers?`.
 *
 * The one way a list page writes "the current query" for its recoveries (Retry, Back to the first
 * page). Pass the active filters WITHOUT the page cursor: `RetryActions` adds the cursor back for
 * Retry, and the first page is this href as it is.
 */
export function queryHref(
  basePath: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, value);
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}
