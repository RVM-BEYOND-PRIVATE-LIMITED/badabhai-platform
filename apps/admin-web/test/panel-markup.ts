/**
 * A panel's block structure in server-rendered markup (A1, #2571).
 *
 * `.panel__section + .panel__section` puts 24px and a hairline divider between two sections only
 * when they are SIBLINGS, so a render test asserts an element's direct children rather than that
 * a section appears somewhere inside it.
 */

/** A `PanelSection`'s opening tag. */
export const SECTION = '<section class="panel__section">';

/**
 * The opening tag of every direct child of one element, in order.
 *
 * `start` is that element's own opening tag, matched exactly; `nth` picks a later one when the
 * tag repeats. The scan stops where the element closes. `renderToStaticMarkup` escapes `>` in
 * text and attribute values, so a tag always ends at its first `>`, and it self-closes every
 * void element (`<br/>`, `<wbr/>`), so those never open a level.
 */
export function childTags(html: string, start: string, nth = 0): string[] {
  let from = -1;
  for (let i = 0; i <= nth; i++) {
    from = html.indexOf(start, from + 1);
    if (from === -1) throw new Error(`no element #${i} opens with ${start}`);
  }
  const children: string[] = [];
  let depth = 0;
  for (const [tag, closing] of html.slice(from).matchAll(/<(\/?)[a-z][a-z0-9]*\b[^>]*>/g)) {
    if (closing) {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) children.push(tag);
    if (!tag.endsWith("/>")) depth += 1;
  }
  return children;
}
