/**
 * A customer cell as `CustomerLink` renders it, for page-level render tests (#2032, sweep AW-28):
 * the payer's short id linked to `href`, the full id in its title, and — only when the row named
 * the payer's role — the persona beside it.
 *
 * Pass the markup that CLOSES the cell (`</td>`, `</dd>`) as `closedBy` to pin that NOTHING
 * follows the link, which is how a test says "no persona was claimed" without listing every
 * label it must not be.
 */
export function customerCell(
  payerId: string,
  href: string,
  kind: "Company" | "Agency" | null,
  closedBy = "",
): string {
  const link = `<a class="link mono" title="${payerId}" href="${href}">${payerId.slice(0, 8)}…</a>`;
  const persona = kind ? `<span class="table__meta">${kind}</span>` : "";
  return `${link}${persona}${closedBy}`;
}
