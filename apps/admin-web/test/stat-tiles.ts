/**
 * Stat tiles out of server-rendered markup, for page-level render tests.
 *
 * `Stat` renders `<div class="stat[ …]"><span class="stat__value[ …]">VALUE</span>
 * <span class="stat__label">LABEL</span></div>` (pinned exactly in components/stat.render.test).
 * This walks every such tile in a page with string scans — no DOM in the node env, and no RegExp
 * built from data — so a page test can ask questions of each tile ("does every ₹ figure carry the
 * simulated tag?") instead of grepping the page for one occurrence.
 */
export interface RenderedStat {
  /** The tile's class list (`stat`, `stat stat--warn stat--wide`, …). */
  className: string;
  /** The value span's inner HTML — the figure plus any adornment. */
  valueHtml: string;
  /** The label's text as rendered (entities left as React emitted them). */
  label: string;
}

const OPEN = '<div class="';
const VALUE = '<span class="stat__value';
const LABEL = '<span class="stat__label">';
const CLOSE = "</span>";

export function statTiles(html: string): RenderedStat[] {
  const out: RenderedStat[] = [];
  const tile = `${OPEN}stat`;
  for (let at = html.indexOf(tile); at >= 0; at = html.indexOf(tile, at + 1)) {
    // `stat"` or `stat stat--…` — not `stats`, not a `stat__…` part.
    const next = html[at + tile.length];
    if (next !== '"' && next !== " ") continue;
    const classEnd = html.indexOf('"', at + OPEN.length);
    const valueOpen = html.indexOf(VALUE, classEnd);
    const valueStart = html.indexOf(">", valueOpen) + 1;
    const labelOpen = html.indexOf(LABEL, valueStart);
    if (valueOpen < 0 || labelOpen < 0) throw new Error("a .stat tile without Stat's value/label");
    const labelStart = labelOpen + LABEL.length;
    out.push({
      className: html.slice(at + OPEN.length, classEnd),
      valueHtml: html.slice(valueStart, labelOpen - CLOSE.length),
      label: html.slice(labelStart, html.indexOf(CLOSE, labelStart)),
    });
  }
  return out;
}

/** `MockMoneyTag`'s rendered pill (components/payments-posture.tsx). */
export const SIMULATED_TAG =
  '<span class="pill pill--warn" title="Real payments are disabled — this is mock money.">simulated</span>';

/** Does a tile's value print a rupee figure? */
export const isRupeeTile = (t: RenderedStat) => t.valueHtml.includes("₹");
