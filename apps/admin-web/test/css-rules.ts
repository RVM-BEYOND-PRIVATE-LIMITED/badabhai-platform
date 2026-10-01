/**
 * Source-level CSS helpers for admin-web's `*.css.test.ts` fences.
 *
 * The vitest env is `node` — there is no layout engine — so a CSS fence asserts the DECLARED
 * rules instead: it flattens a stylesheet into `{ selector, body }` pairs (keeping the chain of
 * at-rule preludes each one sits in, so a phone rule is distinguishable from its desktop base)
 * and reads declarations out of them. Shared so each fence does not carry its own parser, and so
 * every lookup stays a STRING match: no RegExp is ever built from a selector or a property name.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Rule = { selector: string; body: string; atRules: string[] };

/** Drop `/* … *\/` comments so a commented-out declaration never counts. */
export const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** admin-web's globals.css, comments stripped. */
export function globalsCss(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return stripComments(readFileSync(join(here, "..", "src", "app", "globals.css"), "utf8"));
}

/**
 * The shared token layer, resolved exactly the way globals.css imports it
 * (`@badabhai/design-tokens/tokens.css`), comments stripped.
 */
export function tokensCss(): string {
  const require = createRequire(import.meta.url);
  return stripComments(readFileSync(require.resolve("@badabhai/design-tokens/tokens.css"), "utf8"));
}

/**
 * Flat `{ selector, body }` pairs of the style rules in `css`. With `nested`, every at-rule body
 * (`@media`, `@container`, `@supports`, nested to any depth) is walked too, and each rule carries
 * the chain of at-rule preludes it sits in; without it, at-rule blocks are skipped.
 */
export function rules(css: string, nested = false, atRules: string[] = []): Rule[] {
  const out: Rule[] = [];
  let prelude = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      for (; j < css.length && depth > 0; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
      }
      const selector = prelude.trim().replace(/\s+/g, " ");
      const body = css.slice(i + 1, j - 1);
      if (!selector.startsWith("@")) out.push({ selector, body, atRules });
      else if (nested) out.push(...rules(body, true, [...atRules, selector]));
      prelude = "";
      i = j;
      continue;
    }
    if (ch === "}" || ch === ";") prelude = "";
    else prelude += ch;
    i++;
  }
  return out;
}

/**
 * The declarations of the first rule in `css` whose selector list is EXACTLY `selector`
 * (whitespace-normalised). A string match, not a RegExp built from the selector.
 */
export function rule(css: string, selector: string): string | null {
  return rules(css).find((r) => r.selector === selector)?.body ?? null;
}

/** The last declared value of `prop` in a declaration block, or null. A string scan. */
export function decl(body: string, prop: string): string | null {
  let last: string | null = null;
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    if (part.slice(0, colon).trim() === prop) last = part.slice(colon + 1).trim();
  }
  return last;
}

/** Every property name declared in a declaration block, in order (duplicates kept). */
export function declaredProperties(body: string): string[] {
  return body
    .split(";")
    .filter((part) => part.includes(":"))
    .map((part) => part.slice(0, part.indexOf(":")).trim())
    .filter(Boolean);
}

/**
 * The whitespace-separated components of a declared value, with any `fn(…)` kept whole:
 * `calc(0px + var(--x)) solid` is two tokens, so a zero INSIDE a function is never read as a
 * component of its own.
 */
export function valueTokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * The value of custom property `name` as the cascade would resolve it for an element inside
 * `[data-theme="<theme>"]` (or with no theme): the last declaration in a matching theme block
 * wins, else the last one in a `:root` block. `var()` references are resolved recursively, a
 * fallback (`var(--x, y)`) used only when `--x` is undeclared. Throws on an unknown token, so a
 * renamed token fails the fence loudly instead of resolving to nothing.
 */
export function resolveToken(css: string, name: string, theme?: string): string {
  const all = rules(css);
  const find = (selector: string) => {
    let value: string | null = null;
    for (const r of all) if (r.selector === selector) value = decl(r.body, name) ?? value;
    return value;
  };
  const raw = (theme ? find(`[data-theme="${theme}"]`) : null) ?? find(":root");
  if (raw === null) throw new Error(`token ${name} is not declared`);
  return substituteVars(css, raw, theme);
}

function substituteVars(css: string, value: string, theme?: string): string {
  let out = value;
  for (let at = out.indexOf("var("); at >= 0; at = out.indexOf("var(")) {
    let depth = 0;
    let end = at + 3;
    for (; end < out.length; end++) {
      if (out[end] === "(") depth++;
      else if (out[end] === ")" && --depth === 0) break;
    }
    const inner = out.slice(at + 4, end);
    const comma = inner.indexOf(",");
    const ref = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    let resolved: string;
    try {
      resolved = resolveToken(css, ref, theme);
    } catch (err) {
      if (comma < 0) throw err;
      resolved = substituteVars(css, inner.slice(comma + 1).trim(), theme);
    }
    out = out.slice(0, at) + resolved + out.slice(end + 1);
  }
  return out;
}
