/**
 * The column headers a data grid drew (A4, #2574), in order: their LABELS, however each one is
 * drawn — a plain header, a sort link, a header carrying its full label in a `title`.
 *
 * Shared because a page test that matched the raw markup (`<th scope="col">Customer</th>`) passes
 * VACUOUSLY the day that markup changes — a `not.toContain` most of all, which is how a retired
 * column name could come back unnoticed. So this refuses to guess: a column header it cannot read
 * throws, and the test that relied on it fails loudly instead of passing on nothing.
 */
export function columnHeaders(html: string): string[] {
  const drawn = html.split('<th scope="col"').length - 1;
  const labels = [
    ...html.matchAll(/<th scope="col"[^>]*>(?:<a [^>]*>)?<span class="grid__head">([^<]*)<\/span>/g),
  ].map((m) => m[1]!);
  if (labels.length !== drawn) {
    throw new Error(
      `columnHeaders read ${labels.length} of ${drawn} column headers — the grid's header markup changed`,
    );
  }
  return labels;
}
