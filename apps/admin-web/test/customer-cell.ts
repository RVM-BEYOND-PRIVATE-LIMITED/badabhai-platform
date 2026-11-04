/**
 * A customer cell as `CustomerLink` renders it, for page-level render tests (#2032, sweep AW-28):
 * the payer's short id (middle-elided, #2572) linked to `href`, the full id in its title, the
 * copy button beside it, and — only when the row named the payer's role — the persona after that.
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
  const short = `${payerId.slice(0, 4)}…${payerId.slice(-4)}`;
  const link = `<a class="link mono" title="${payerId}" href="${href}">${short}</a>`;
  const copy =
    '<span class="copy-id"><button type="button" class="iconbtn iconbtn--sm copy-id__btn" ' +
    'aria-label="Copy customer id"><i class="ph-fill ph-copy" aria-hidden="true"></i>' +
    '<span class="bb-icon-tip bb-icon-tip--top" aria-hidden="true">Copy customer id</span>' +
    '</button><span class="copy-id__toast" role="status" aria-live="polite"></span></span>';
  const persona = kind ? `<span class="table__meta">${kind}</span>` : "";
  return `${link}${copy}${persona}${closedBy}`;
}
