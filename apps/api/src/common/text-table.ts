/** The column separator {@link table} prints. */
const SEP = " | ";

/**
 * Rows as aligned columns, a header first, each line indented two spaces — the operator reports'
 * shared table (the free-chat probe, the reply served-rate replay). Every cell should be an enum, a
 * label or a number: a table is printed, so it must never carry text a worker or a model wrote.
 */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return ["  (none)"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    `  ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(SEP)}`.trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}
