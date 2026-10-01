/**
 * Source-level CSS helpers for the layout-fence suites (`*.css.test.ts`).
 *
 * The vitest env is `node` — there is no layout engine — so a layout regression fence asserts
 * the DECLARED geometry instead: it flattens a stylesheet into rules (keeping the enclosing
 * `@media`/`@supports`/`@container` prelude, so a phone rule is distinguishable from its desktop
 * base) and
 * reads declarations out of them. Shared so each fence does not carry its own parser.
 */

export interface Rule {
  /** The selector list, whitespace-normalised. */
  selector: string;
  /** The declaration block. */
  body: string;
  /** The enclosing at-rule prelude ("" at top level). */
  at: string;
}

/** Drop `/* … *\/` comments so commented-out declarations never count. */
export const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Flatten a stylesheet into rules, descending through @media/@supports/@container and keeping
 * the prelude.
 */
export function parseRules(css: string, at = ""): Rule[] {
  const out: Rule[] = [];
  let prelude = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      const body = css.slice(i + 1, j - 1);
      const selector = prelude.trim().replace(/\s+/g, " ");
      if (/^@(media|supports|container)\b/.test(selector)) out.push(...parseRules(body, selector));
      else out.push({ selector, body, at });
      prelude = "";
      i = j;
      continue;
    }
    // A `}` closes nothing we track here, and a top-level `;` ends a statement-level at-rule
    // (`@import …;`) — either way the next selector starts fresh.
    if (ch === "}" || ch === ";") {
      prelude = "";
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return out;
}

/**
 * The last declared value of `prop` in a block, or null. A string scan over the declarations,
 * not a RegExp built from `prop` — the helpers stay free of dynamic patterns.
 */
export function decl(r: Rule, prop: string): string | null {
  let last: string | null = null;
  for (const part of r.body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    if (part.slice(0, colon).trim() === prop) last = part.slice(colon + 1).trim();
  }
  return last;
}

/**
 * The FIRST declared value of custom property `name` (e.g. `--navy-600`) in a stylesheet — the
 * light `:root` ramp in tokens.css — or null. A longer property that merely ends in `name`
 * (`--row--gap` when asking for `--gap`) is skipped.
 */
export function tokenValue(css: string, name: string): string | null {
  const needle = `${name}:`;
  let at = css.indexOf(needle);
  while (at > 0 && /[\w-]/.test(css[at - 1]!)) at = css.indexOf(needle, at + 1);
  if (at < 0) return null;
  const start = at + needle.length;
  const end = css.indexOf(";", start);
  return (end < 0 ? css.slice(start) : css.slice(start, end)).trim();
}
