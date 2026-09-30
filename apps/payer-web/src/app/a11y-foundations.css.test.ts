import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * W2-A — payer-web ACCESSIBILITY FOUNDATIONS (source-level fence over the shared stylesheets).
 *
 * Node env, no layout engine (the repo's `*.css.test.ts` approach): each fix below depends on
 * DECLARED geometry or cascade, so this suite pins it. The layouts were measured in Chromium at
 * 1280/375px (and under emulated forced-colors) when built; the W3-A follow-ups at
 * 320/375/768/1280px, in both themes and under forced colors.
 *   1 · SUBTITLE   — a head's sub sits under its title, grouped with it in `.panel__text` /
 *                    `.section__text` (W3-A: 4px apart, the actions kept on the title row);
 *   2 · TAP        — the small phone controls (sm button, chip, theme toggle, hamburger, balance)
 *                    clear a 44px hit area on phones without their hit areas meeting; 2b adds
 *                    the shared back link, on phones and coarse pointers (W3-A);
 *   3 · FORCED     — every box-shadow focus ring carries a transparent-outline fallback, spent
 *                    as the `--focus-outline` / `--focus-outline-offset` pair (W3-A);
 *   4 · KEYBOARD   — a linked card/tile rings on keyboard focus only, not on a mouse click;
 *   5 · LISTBOX    — the select menu's active option stays visible in forced colors.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => stripComments(readFileSync(join(here, ...p), "utf8"));
/** Every .tsx under a directory (recursive), as [path, source]. */
function tsxUnder(dir: string): [string, string][] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")]);
}
const GLOBALS = read("globals.css");
const DS = read("..", "styles", "ds-components.css");
const TOKENS = read("..", "..", "..", "..", "packages", "design-tokens", "tokens.css");
const G = parseRules(GLOBALS);
const D = parseRules(DS);

const PHONE = "max-width: 600px";
/** The forced-colors focus fallback, as the two payer-web custom properties every ring spends. */
const FOCUS_OUTLINE = "var(--focus-outline)";
const FOCUS_OFFSET = "var(--focus-outline-offset)";
/** What `--focus-outline` must stay in normal mode: the pre-token literal, so nothing re-renders. */
const TRANSPARENT_OUTLINE = "var(--border-bold) solid transparent";

/** Every rule whose selector list is EXACTLY `selector` in the given context ("" = top level). */
function rulesFor(rules: Rule[], selector: string, at = ""): Rule[] {
  const norm = (s: string) => s.replace(/,\s*/g, ",");
  return rules.filter(
    (r) => norm(r.selector) === norm(selector) && (at === "" ? r.at === "" : r.at.includes(at)),
  );
}
function one(rules: Rule[], selector: string, at = ""): Rule {
  const hits = rulesFor(rules, selector, at);
  expect(
    hits,
    `expected exactly one rule for \`${selector}\`${at ? ` in ${at}` : ""}`,
  ).toHaveLength(1);
  return hits[0]!;
}

/** The root font size a rem resolves against: tokens.css leaves `html` at the UA's 16px. */
const ROOT_PX = 16;

/** A token's px value from tokens.css (`--control-md: 44px`; `3.75rem` → 60; bare `0` → 0). */
function tokenPx(name: string): number {
  const v = tokenValue(TOKENS, name);
  expect(v, `token ${name} must be declared in tokens.css`).not.toBeNull();
  if (v === "0") return 0;
  const rem = v!.match(/^([\d.]+)rem$/);
  if (rem) return Number(rem[1]) * ROOT_PX;
  const m = v!.match(/^(-?[\d.]+)px$/);
  expect(m, `token ${name} must be a px length, got "${v}"`).not.toBeNull();
  return Number(m![1]);
}

/** `var(--x)`, a px literal, or `calc(…)` of a sum of those, resolved to px through tokens.css. */
function sumPx(expr: string): number {
  const e = expr.trim();
  const inner = e.startsWith("calc(") && e.endsWith(")") ? e.slice(5, -1) : e;
  return inner
    .split(/\s\+\s/)
    .map((t) => {
      const term = t.trim();
      const lit = term.match(/^(-?[\d.]+)px$/);
      if (lit) return Number(lit[1]);
      const v = term.match(/^var\((--[\w-]+)\)$/);
      expect(v, `only a sum of var() tokens / px is supported here: "${e}"`).not.toBeNull();
      return tokenPx(v![1]!);
    })
    .reduce((a, b) => a + b, 0);
}

/** Does selector `sel` carry class `cls` as a whole class (not a prefix of a longer one)? */
function hasClass(sel: string, cls: string): boolean {
  const needle = `.${cls}`;
  for (let at = sel.indexOf(needle); at >= 0; at = sel.indexOf(needle, at + 1)) {
    const next = sel[at + needle.length];
    if (next === undefined || !/[\w-]/.test(next)) return true;
  }
  return false;
}

/** The declared property names of a rule, sorted. */
function props(r: Rule): string[] {
  return r.body
    .split(";")
    .filter((p) => p.includes(":"))
    .map((p) => p.slice(0, p.indexOf(":")).trim())
    .sort();
}

/** The first whitespace-separated term of a shorthand, respecting parentheses. */
function firstTerm(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (/\s/.test(ch) && depth === 0) return value.slice(0, i);
  }
  return value;
}

/** Split a selector list on TOP-LEVEL commas (a `:has(a, b)` argument stays whole). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The selector with every parenthesised argument removed (`a:has(b:focus)` → `a:has`). */
function outerOnly(sel: string): string {
  let depth = 0;
  let out = "";
  for (const ch of sel) {
    if (ch === "(") depth += 1;
    if (depth === 0) out += ch;
    if (ch === ")") depth -= 1;
  }
  return out;
}

/**
 * Is the ring HOST the focused element itself? True when the selector's subject (last compound,
 * outside any :has() argument) carries :focus / :focus-visible. False for a ring painted on a
 * parent (:has, :focus-within) or a sibling box (`input:focus-visible + .box`) — a host that the
 * global `:focus-visible` fallback never reaches, so it must declare the outline itself.
 */
function hostIsFocused(sel: string): boolean {
  const subject =
    outerOnly(sel)
      .split(/\s*[>+~]\s*|\s+/)
      .pop() ?? "";
  return /:focus(-visible)?(?![\w-])/.test(subject);
}

/* ================================================================== *
 * 1 · SUBTITLE — under its title, grouped with it (W3-A), 4px apart, actions on the title row.
 * ================================================================== */

/**
 * The end offset of the JSX `<div …>` element opening at `at`: nested `<div` / `</div>` are
 * counted (a self-closing `<div … />` opens nothing). The opening tag's end is found outside any
 * `{…}` expression, so an arrow function in an attribute cannot end it early.
 */
function divEnd(src: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < src.length) {
    if (src.startsWith("<div", i) && /[\s>]/.test(src[i + 4] ?? "")) {
      let braces = 0;
      let j = i + 4;
      for (; j < src.length; j += 1) {
        if (src[j] === "{") braces += 1;
        else if (src[j] === "}") braces -= 1;
        else if (src[j] === ">" && braces === 0) break;
      }
      if (src[j - 1] !== "/") depth += 1;
      i = j + 1;
      continue;
    }
    if (src.startsWith("</div>", i)) {
      depth -= 1;
      i += "</div>".length;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return src.length;
}

/** Every `needle` offset in `src` within [from, to). */
function offsets(src: string, needle: string, from = 0, to = src.length): number[] {
  const out: number[] = [];
  for (let at = src.indexOf(needle, from); at >= 0 && at < to; at = src.indexOf(needle, at + 1)) {
    out.push(at);
  }
  return out;
}

/**
 * The files whose heads are NOT migrated onto the wrapper yet: another in-flight branch owns
 * those screens (W3-B). Their bare subs keep the pre-W3-A geometry through the unchanged base
 * rules. An entry must still hold an unwrapped head — migrate a file, then delete its line.
 */
const PENDING_WRAP = new Set([
  "(portal)/account/page.tsx",
  "(portal)/capacity/page.tsx",
  "(portal)/plans/page.tsx",
  "(portal)/team/team-manager.tsx",
]);

interface HeadScan {
  file: string;
  wrapped: boolean;
  problems: string[];
  hasActions: boolean;
}

/** Every panel/section head in one TSX source that carries a subtitle, checked for the wrapper. */
function checkHeads(file: string, src: string): HeadScan[] {
  const out: HeadScan[] = [];
  for (const kind of ["panel", "section"]) {
    for (const hit of offsets(src, `className="${kind}__head`)) {
      const start = src.lastIndexOf("<div", hit);
      const end = divEnd(src, start);
      const subs = offsets(src, `className="${kind}__sub"`, start, end);
      if (subs.length === 0) continue;
      const problems: string[] = [];
      const wraps = offsets(src, `className="${kind}__text"`, start, end);
      const actions = offsets(src, `className="${kind}__actions"`, start, end);
      if (wraps.length !== 1) {
        problems.push(`${file} @${hit}: ${wraps.length} ${kind}__text wrappers`);
      } else {
        const wStart = src.lastIndexOf("<div", wraps[0]!);
        const wEnd = divEnd(src, wStart);
        for (const s of [...subs, ...offsets(src, `className="${kind}__title"`, start, end)]) {
          if (s < wStart || s >= wEnd)
            problems.push(`${file} @${s}: title/sub outside the wrapper`);
        }
        for (const a of actions) {
          if (a < wEnd) problems.push(`${file} @${a}: actions inside/before the wrapper`);
        }
      }
      out.push({ file, wrapped: wraps.length === 1, problems, hasActions: actions.length > 0 });
    }
  }
  return out;
}

/** {@link checkHeads} over every TSX file under src/app (paths `/`-separated, app-relative). */
const scanHeads = (): HeadScan[] =>
  tsxUnder(here).flatMap(([path, src]) => checkHeads(path.split("\\").join("/"), src));

describe("W2-A/W3-A · 1 — a head's subtitle sits under its title, grouped in a text wrapper", () => {
  const WRAP = ".panel__text, .section__text";
  const IN_WRAP = ".panel__text > .panel__sub, .section__text > .section__sub";

  it.each([".panel__head", ".section__head"])("%s is a WRAPPING flex row", (head) => {
    const r = one(G, head);
    expect(decl(r, "display")).toBe("flex");
    expect(decl(r, "flex-wrap")).toBe("wrap");
  });

  it("the wrapper is ONE item with the page-head rhythm: a --space-1 (4px) grid gap", () => {
    // Title → sub was the head's 16px row gap + the sub's 4px margin: 20px, 5× the page head.
    const w = one(G, WRAP);
    expect(decl(w, "display")).toBe("grid");
    expect(decl(w, "gap")).toBe("var(--space-1)");
    expect(decl(w, "gap")).toBe(decl(one(G, ".page-head__text"), "gap"));
    expect(tokenPx("--space-1")).toBe(4);
    expect(decl(w, "min-width")).toBe("0");
  });

  it("the wrapper grows from a ZERO basis, so the actions keep the title row at every width", () => {
    // An `auto` basis is the text's max-content (up to the 68ch sub): wherever that plus the
    // actions overran the row (every phone, the 768px Payouts head) the actions wrapped onto a
    // row of their own under the prose. From 0 the text only ever takes what the actions leave.
    expect(decl(one(G, WRAP), "flex")).toBe("1 1 0");
    for (const a of [".panel__actions", ".section__actions"]) {
      expect(decl(one(G, a), "flex"), a).toBe("none");
    }
  });

  it("inside the wrapper the sub is a plain grid row with a REAL max-width measure", () => {
    const r = one(G, IN_WRAP);
    expect(decl(r, "margin")).toBe("0");
    expect(decl(r, "padding-inline-end")).toBe("0");
    expect(decl(r, "max-width")).toBe("var(--reading-max)");
    // Two classes against the base rule's one: it wins wherever either sits in the file.
    for (const s of splitSelectors(r.selector)) expect(s.split(".").length - 1, s).toBe(2);
  });

  it.each([".panel__sub", ".section__sub"])(
    "a BARE %s (not yet wrapped, or a block `p`): an UNCLAMPED 100%% basis",
    (sub) => {
      const r = one(G, sub);
      expect(decl(r, "flex-basis")).toBe("100%");
      // A max width clamps the 100% basis back to the measure; wherever title + measure fit one
      // row (every desktop) a bare sub then rode up BESIDE the title. None may come back.
      for (const prop of ["max-width", "max-inline-size", "width", "inline-size", "flex"]) {
        expect(decl(r, prop), `${sub} must not declare ${prop}`).toBeNull();
      }
    },
  );

  it.each([".panel__sub", ".section__sub"])(
    "a BARE %s keeps the reading measure with an END PADDING (row − measure, clamps to 0)",
    (sub) => {
      expect(decl(one(G, sub), "padding-inline-end")).toBe("calc(100% - var(--reading-max))");
      // border-box, so the 100% basis INCLUDES that padding: the text box is the measure.
      expect(TOKENS).toMatch(/box-sizing:\s*border-box/);
      expect(tokenValue(TOKENS, "--reading-max")).not.toBeNull();
    },
  );

  it("MARKUP: every head with a sub groups title + sub in its wrapper; actions follow it", () => {
    const problems = scanHeads()
      .filter((h) => !PENDING_WRAP.has(h.file))
      .flatMap((h) => h.problems);
    expect(problems).toEqual([]);
  });

  it("MARKUP: each PENDING file still holds an unwrapped head (delete its entry once migrated)", () => {
    const heads = scanHeads();
    for (const pending of PENDING_WRAP) {
      const mine = heads.filter((h) => h.file === pending);
      expect(mine.length, `${pending} must be scanned`).toBeGreaterThan(0);
      expect(
        mine.some((h) => !h.wrapped),
        `${pending} is fully migrated — remove it from PENDING_WRAP`,
      ).toBe(true);
    }
  });

  it("the markup scan is not vacuous (wrapped heads found, incl. both heads WITH actions)", () => {
    const wrapped = scanHeads().filter((h) => h.wrapped && h.problems.length === 0);
    expect(wrapped.length).toBeGreaterThanOrEqual(13);
    const withActions = wrapped.filter((h) => h.hasActions).map((h) => h.file);
    expect(withActions.some((f) => f.endsWith("payout-panel.tsx"))).toBe(true);
    expect(withActions.some((f) => f.endsWith("applicants/page.tsx"))).toBe(true);
    // …and the checker can FAIL: each violation it exists for is reported on a known snippet.
    const H = (inner: string) => `<div className="panel__head">${inner}</div>`;
    const T = `<h2 className="panel__title">T</h2>`;
    const S = `<p className="panel__sub">S</p>`;
    const A = `<div className="panel__actions"><button onClick={() => go()} /></div>`;
    const W = (inner: string) => `<div className="panel__text">${inner}</div>`;
    expect(checkHeads("ok", H(W(T + S) + A))[0]!.problems).toEqual([]);
    expect(checkHeads("bare", H(T + A + S))[0]!.problems).toHaveLength(1);
    expect(checkHeads("inside", H(W(T + S + A)))[0]!.problems).toHaveLength(1);
    expect(checkHeads("before", H(A + W(T + S)))[0]!.problems).toHaveLength(1);
    expect(checkHeads("sub-out", H(W(T) + S + A))[0]!.problems).toHaveLength(1);
    expect(checkHeads("no-sub", H(T + A))).toEqual([]);
  });

  it("no rule but the base and the wrapper rule re-clamps or re-sizes a subtitle", () => {
    const allowed = new Set([".panel__sub", ".section__sub", IN_WRAP]);
    const touches = (r: Rule) =>
      splitSelectors(r.selector).some((s) => /\.(panel|section)__sub$/.test(s)) &&
      !allowed.has(r.selector.replace(/,\s*/g, ", "));
    for (const r of G.filter(touches)) {
      for (const prop of ["max-width", "max-inline-size", "width", "flex-basis", "flex"]) {
        expect(decl(r, prop), `\`${r.selector}\` (${r.at || "top"}) sets ${prop}`).toBeNull();
      }
    }
    // The wrapper rule sizes the sub by its measure ONLY.
    for (const prop of ["width", "inline-size", "flex-basis", "flex", "min-width"]) {
      expect(decl(one(G, IN_WRAP), prop), prop).toBeNull();
    }
  });
});

/* ================================================================== *
 * 2 · TAP — ≥44px hit areas on phones, desktop untouched.
 * ================================================================== */
describe("W2-A · 2 — small controls clear a 44px hit area on phones (≤600px)", () => {
  const T_BLOCK = "calc((100% - var(--control-md)) / 2)";
  const T_INLINE = "min(0px, calc((100% - var(--control-md)) / 2))";
  const BEHIND = "calc(var(--z-base) - 1)";
  /** [file, host selector (as written), its base class, that file's rules]. */
  const HOSTS: [string, string, string, Rule[]][] = [
    ["ds-components.css", ".bb-btn--sm", "bb-btn--sm", D],
    ["ds-components.css", ".bb-chip", "bb-chip", D],
    ["globals.css", ".theme-toggle__switch", "theme-toggle__switch", G],
    ["globals.css", ".theme-toggle__system", "theme-toggle__system", G],
    ["globals.css", ".pshell__menu", "pshell__menu", G],
    ["globals.css", ".pshell__balance:not(.pshell__balance--static)", "pshell__balance", G],
  ];
  /** The one ≤600px rule whose selector list contains `sel` exactly. */
  function phoneRuleWith(rules: Rule[], sel: string): Rule {
    const hits = rules.filter(
      (r) => r.at.includes(PHONE) && splitSelectors(r.selector).includes(sel),
    );
    expect(hits, `exactly one ≤600px rule must list \`${sel}\``).toHaveLength(1);
    return hits[0]!;
  }
  const controlH = {
    sm: () => sumPx(decl(one(D, ".bb-btn--sm"), "height")!),
    chip: () => sumPx(decl(one(D, ".bb-chip"), "min-height")!),
    switch: () =>
      sumPx(decl(one(G, ".theme-toggle__track"), "height")!) +
      2 * sumPx(decl(one(G, ".theme-toggle__switch"), "padding")!),
    menu: () => sumPx(decl(one(G, ".pshell__menu"), "height")!),
    balance: () => sumPx(decl(one(G, ".pshell__balance"), "height")!),
  };
  const T = () => tokenPx("--control-md");

  it("the hit-area token is at least 44px (WCAG 2.5.5-class target)", () => {
    expect(T()).toBeGreaterThanOrEqual(44);
    // …and a rem token here resolves against the UA's 16px root: nothing re-sizes `html`.
    const root = parseRules(TOKENS).filter((r) => r.selector === "html" || r.selector === ":root");
    for (const r of root) expect(decl(r, "font-size"), `${r.selector} font-size`).toBeNull();
  });

  it("the controls it serves are drawn SHORTER than the target, so the strip extends them", () => {
    for (const [name, h] of Object.entries(controlH)) {
      expect(h(), `${name} (${h()}px) must be extended to ${T()}px, not shrunk`).toBeLessThan(T());
    }
  });

  it.each(HOSTS)(
    "%s `%s`: the phone host is positioned + isolated, and nothing else",
    (_f, host, _c, rules) => {
      expect(props(phoneRuleWith(rules, host))).toEqual(["isolation", "position"]);
      expect(decl(phoneRuleWith(rules, host), "position")).toBe("relative");
      expect(decl(phoneRuleWith(rules, host), "isolation")).toBe("isolate");
    },
  );

  it.each(HOSTS)(
    "%s `%s`: a full-width 44px strip BEHIND the content (never over an inner target)",
    (_f, host, _c, rules) => {
      const hit = phoneRuleWith(rules, `${host}::before`);
      expect(props(hit)).toEqual(["content", "inset-block", "inset-inline", "position", "z-index"]);
      expect(decl(hit, "content")).toBe('""');
      expect(decl(hit, "position")).toBe("absolute");
      expect(decl(hit, "inset-block")).toBe(T_BLOCK);
      // min(): 0 on a control wider than the target (a full-width strip), negative only on a
      // narrower one — the centred-square `inset` left a wide button's ends un-extended.
      expect(decl(hit, "inset-inline")).toBe(T_INLINE);
      // Below the host's content inside its isolated context: a Chip's ✕ stays its own target.
      expect(decl(hit, "z-index")).toBe(BEHIND);
    },
  );

  it.each(HOSTS)(
    "%s `%s`: the pseudo is the hit area's alone, and there is none on desktop",
    (_f, host, cls) => {
      for (const [rules, file] of [
        [D, "ds-components.css"],
        [G, "globals.css"],
      ] as const) {
        const claims = rules.flatMap((r) =>
          splitSelectors(r.selector)
            .filter((s) => hasClass(s, cls) && (s.endsWith("::before") || s.endsWith(":before")))
            .map((s) => ({ s, at: r.at })),
        );
        for (const c of claims) {
          expect(`${file}: ${c.s} (${c.at || "top level"})`).toBe(
            `${file}: ${host}::before (@media (${PHONE}))`,
          );
        }
      }
    },
  );

  it("desktop sizing is unchanged: the drawn controls keep their base heights", () => {
    expect(decl(one(D, ".bb-btn--sm"), "height")).toBe("var(--control-sm)");
    expect(decl(one(D, ".bb-btn--sm"), "min-height")).toBe("var(--control-sm)");
    expect(decl(one(D, ".bb-chip"), "min-height")).toBe("38px");
    expect(decl(one(G, ".pshell__menu"), "height")).toBe("var(--control-sm)");
    expect(decl(one(G, ".pshell__balance"), "height")).toBe("var(--control-sm)");
    expect(decl(one(G, ".theme-toggle__switch"), "padding")).toBe("var(--space-1)");
    expect(decl(one(G, ".theme-toggle__track"), "height")).toBe("var(--space-6)");
  });

  it("ARITHMETIC: the header's strips stay inside it and clear their neighbours", () => {
    const header = one(G, ".pshell__header");
    expect(decl(header, "align-items")).toBe("center");
    // Vertically: the 44px strip fits the header row, so it never reaches the page below.
    expect(sumPx(decl(header, "min-height")!)).toBeGreaterThanOrEqual(T());
    // Horizontally only the 36px hamburger extends (the switch, "System" and the balance are
    // wider than 44px, so their inline inset is 0): 4px each side, into the header's gap to the
    // breadcrumb and into the header's inline padding.
    const menuW = sumPx(decl(one(G, ".pshell__menu"), "width")!);
    const ext = Math.max(0, (T() - menuW) / 2);
    expect(ext).toBeGreaterThan(0);
    expect(ext, "hamburger strip vs the gap to the breadcrumb").toBeLessThanOrEqual(
      sumPx(decl(header, "gap")!),
    );
    expect(ext, "hamburger strip vs the header's inline padding").toBeLessThanOrEqual(
      sumPx(decl(one(G, ".pshell__header", "max-width: 1023px"), "padding-inline")!),
    );
    const switchW =
      sumPx(decl(one(G, ".theme-toggle__track"), "width")!) +
      2 * sumPx(decl(one(G, ".theme-toggle__switch"), "padding")!);
    expect(switchW, "the switch is wider than the strip (no inline extension)").toBeGreaterThan(
      T(),
    );
  });

  it("ARITHMETIC: stacked chip rows never meet — each row gap holds two 3px extensions", () => {
    const ext = (T() - controlH.chip()) / 2;
    for (const row of [
      ".chip-editor__chips",
      ".ai-chat__chips",
      '.match-picker__vocab, .match-picker__related [role="group"]',
    ]) {
      const r = one(G, row);
      expect(decl(r, "flex-wrap"), row).toBe("wrap");
      expect(2 * ext, `${row}: two strips vs the row gap`).toBeLessThanOrEqual(
        sumPx(decl(r, "gap")!),
      );
    }
  });

  const toggleHitBottom = () =>
    sumPx(decl(one(G, ".login-theme"), "top")!) + controlH.switch() / 2 + T() / 2;

  it("ARITHMETIC: /login ≤480px — the toggle's strip ends above the card's reserved row", () => {
    // `.login-theme` sits at its `top`; the switch is centred in its strip; the card starts at
    // the ≤480px wrap's top padding (the reserved row). The strip must end above the card.
    const reserved = sumPx(
      firstTerm(decl(one(G, ".login-wrap--auth", "max-width: 480px"), "padding")!),
    );
    expect(toggleHitBottom(), "the toggle's strip must not reach the card").toBeLessThan(reserved);
  });

  it("ARITHMETIC: /login 481–600px has NO reserved row — the strip can reach only the brand band", () => {
    // Above 480px the ≤480 rules stop: the toggle is FIXED and nothing reserves its row (this
    // is the pre-existing layout, not something the hit area changed).
    expect(decl(one(G, ".login-theme"), "position")).toBe("fixed");
    expect(G.filter((r) => r.selector === ".login-theme").map((r) => r.at)).toEqual([
      "",
      "@media (max-width: 480px)",
    ]);
    expect(G.some((r) => r.selector === ".login-wrap--auth" && r.at === "")).toBe(false);
    // Worst case at rest: a viewport shorter than the card pins the centred card to the wrap's
    // top padding. Then the DRAWN switch already reaches the card, and the strip 6px more…
    const cardTop = sumPx(decl(one(G, ".login-wrap"), "padding")!);
    const drawnBottom = sumPx(decl(one(G, ".login-theme"), "top")!) + controlH.switch();
    expect(drawnBottom, "pre-existing: the drawn switch reaches a pinned card").toBeGreaterThan(
      cardTop,
    );
    expect(toggleHitBottom() - drawnBottom).toBe((T() - controlH.switch()) / 2);
    // …but both end inside the card's navy brand band, which is non-interactive and at least its
    // own vertical padding tall (the lockup inside only makes it taller). No control is reached.
    const band = one(G, ".login-card__brand");
    expect(decl(band, "margin")!.startsWith("calc(-1 * var(--login-pad))")).toBe(true);
    const bandBottom = cardTop + 2 * sumPx(firstTerm(decl(band, "padding")!));
    expect(toggleHitBottom(), "the strip must end inside the brand band").toBeLessThan(bandBottom);
  });
});

/* ================================================================== *
 * 2b · TAP (W3-A) — the shared back link ("← Dashboard").
 * ================================================================== */
describe("W3-A · 2b — the back link clears a 44px hit area on phones AND coarse pointers", () => {
  const CTX = "@media (max-width: 600px), (pointer: coarse)";
  const LINK = ".page-back > a";
  const dsStrip = () =>
    D.find(
      (r) => r.at.includes(PHONE) && splitSelectors(r.selector).includes(".bb-btn--sm::before"),
    )!;

  it("the link host is positioned + isolated, and nothing else, in exactly that context", () => {
    const host = one(G, LINK, CTX);
    expect(host.at).toBe(CTX);
    expect(props(host)).toEqual(["isolation", "position"]);
    expect(decl(host, "position")).toBe("relative");
    expect(decl(host, "isolation")).toBe("isolate");
  });

  it("its strip is the DS strip, declaration for declaration (full width, centred, behind)", () => {
    const strip = one(G, `${LINK}::before`, CTX);
    expect(strip.at).toBe(CTX);
    expect(props(strip)).toEqual(props(dsStrip()));
    for (const p of props(dsStrip())) expect(decl(strip, p), p).toBe(decl(dsStrip(), p));
  });

  it('MARKUP: every page\'s back link is `<p className="page-back">` → a direct <Link> (so `> a` matches)', () => {
    // Measured on all 15 portal pages that render it (320/375/600 + a 1280 coarse pointer): hit
    // 44–45px tall, drawn box unchanged. The selector is a CHILD combinator, so a wrapper span
    // or a second link inside the paragraph would silently lose the hit area — pin the shape.
    const bad: string[] = [];
    let seen = 0;
    for (const [file, src] of tsxUnder(here)) {
      for (const at of offsets(src, 'className="page-back"')) {
        seen += 1;
        const open = src.lastIndexOf("<", at);
        const tagEnd = src.indexOf(">", at);
        const close = src.indexOf("</p>", tagEnd);
        const inner = src.slice(tagEnd + 1, close).trim();
        const ok =
          src.startsWith("<p ", open) &&
          inner.startsWith("<Link ") &&
          inner.endsWith("</Link>") &&
          offsets(inner, "<Link ").length === 1;
        if (!ok) bad.push(`${file} @${at}`);
      }
    }
    expect(bad).toEqual([]);
    expect(seen, "the scan reads every page that renders the back link").toBeGreaterThanOrEqual(15);
  });

  it("the LOOK is untouched: only the two hit-area rules reach past `.page-back` itself", () => {
    const beyond = G.filter((r) =>
      splitSelectors(r.selector).some(
        (s) => s.startsWith(".page-back") && s !== ".page-back" && s !== ".page-back:hover",
      ),
    );
    expect(beyond.map((r) => `${r.selector} (${r.at})`)).toEqual([
      `${LINK} (${CTX})`,
      `${LINK}::before (${CTX})`,
    ]);
    // …and `.page-back` itself is never re-declared for a phone / touch context.
    expect(G.filter((r) => r.selector === ".page-back").map((r) => r.at)).toEqual(["", ""]);
  });

  it("ARITHMETIC: the strip stays in the content column's top padding and ends at the title", () => {
    // The link is one line of the back link's text: its size × the body leading it inherits.
    const backs = G.filter((r) => r.selector === ".page-back" && r.at === "");
    const last = backs[backs.length - 1]!;
    const size = sumPx(decl(last, "font-size")!);
    const leading = Number(tokenValue(TOKENS, "--leading-normal"));
    expect(size * leading).toBeGreaterThan(0);
    const ext = (tokenPx("--control-md") - size * leading) / 2;
    expect(ext).toBeGreaterThan(0);
    // Above: the link is the content column's first child; its top padding (every context).
    const pads = G.filter(
      (r) => r.selector === ".pshell__content" && decl(r, "padding") !== null,
    ).map((r) => sumPx(firstTerm(decl(r, "padding")!)));
    expect(pads.length).toBeGreaterThanOrEqual(2);
    for (const pad of pads) expect(ext, "strip vs the content top padding").toBeLessThan(pad);
    // Below: the back link's --space-3 margin to the page title (the LATER rule wins the
    // cascade). The strip ends within a sub-pixel of it, on the heading — not a target.
    expect(decl(last, "margin-bottom")).toBe("var(--space-3)");
    expect(ext - tokenPx("--space-3")).toBeLessThan(1);
  });
});

/* ================================================================== *
 * 3 · FORCED COLORS — no focus ring vanishes with the box-shadows.
 * ================================================================== */
describe("W2-A · 3 — every focus ring has a forced-colors outline fallback", () => {
  const isRing = (r: Rule) =>
    /:focus/.test(r.selector) && (decl(r, "box-shadow") ?? "").includes("--ring-focus");
  const RINGS = [
    ...D.map((r) => ({ r, file: "ds-components.css" })),
    ...G.map((r) => ({ r, file: "globals.css" })),
  ].filter(({ r }) => isRing(r));

  // A ring whose FOCUSED descendant already draws a real outline that forced colors keep.
  const COVERED_BY_DESCENDANT = new Set([".panel:has(.tablewrap:focus-visible)"]);

  it("the fence sees the rings it is meant to (DS controls, linked surfaces, shell, toggle)", () => {
    const sel = RINGS.map(({ r }) => r.selector);
    for (const s of [
      ".bb-btn:focus-visible",
      ".bb-input:focus",
      ".bb-choice input:focus-visible + .bb-choice__box",
      ".bb-card--link:has(> .bb-stretched-link:focus-visible)",
      ".bb-stat--link:has(> .bb-stretched-link:focus-visible)",
      ".theme-toggle__switch:focus-visible",
      ".pshell__balance:focus-visible",
    ]) {
      expect(sel, `ring rule ${s}`).toContain(s);
    }
    expect(RINGS.length).toBeGreaterThanOrEqual(20);
  });

  it("the global :focus-visible (payer-web's override of the tokens.css base) adds the outline", () => {
    const g = one(G, ":focus-visible");
    expect(decl(g, "outline")).toBe(FOCUS_OUTLINE);
    expect(decl(g, "outline-offset")).toBe(FOCUS_OFFSET);
    // It changes ONLY the outline — the normal-mode ring is still the tokens.css box-shadow.
    expect(decl(g, "box-shadow")).toBeNull();
    const base = parseRules(TOKENS).find((r) => r.selector === ":focus-visible" && r.at === "");
    expect(base && decl(base, "box-shadow")).toBe("var(--ring-focus)");
  });

  it("no ring rule removes the outline (`outline: none` is what made them vanish)", () => {
    const bad = RINGS.filter(({ r }) => decl(r, "outline") === "none");
    expect(bad.map(({ r, file }) => `${file}: ${r.selector}`)).toEqual([]);
  });

  it("every outline a ring declares is the TOKEN pair (invisible in normal mode) and offset", () => {
    for (const { r, file } of RINGS) {
      const o = decl(r, "outline");
      if (o === null) continue;
      expect(o, `${file}: ${r.selector}`).toBe(FOCUS_OUTLINE);
      expect(decl(r, "outline-offset"), `${file}: ${r.selector}`).toBe(FOCUS_OFFSET);
    }
  });

  /* ---- W3-A: the pair is two custom properties, declared once ---- */
  const FORCED = "forced-colors: active";
  const rootDecls = (rules: Rule[], at: string) =>
    rules.filter((r) => r.selector === ":root" && (at === "" ? r.at === "" : r.at.includes(at)));

  it("W3-A: `--focus-outline` / `--focus-outline-offset` are the pre-token literals (normal mode unchanged)", () => {
    const decls = rootDecls(D, "").filter((r) => decl(r, "--focus-outline") !== null);
    expect(decls, "one top-level :root in ds-components.css declares the pair").toHaveLength(1);
    expect(decl(decls[0]!, "--focus-outline")).toBe(TRANSPARENT_OUTLINE);
    expect(decl(decls[0]!, "--focus-outline-offset")).toBe("var(--border-bold)");
  });

  it("W3-A: under forced colors ONLY the colour changes — to the system Highlight", () => {
    const forced = rootDecls(D, FORCED);
    expect(forced).toHaveLength(1);
    expect(forced[0]!.at).toBe(`@media (${FORCED})`);
    expect(props(forced[0]!)).toEqual(["--focus-outline"]);
    const normal = TRANSPARENT_OUTLINE.split(" ");
    const hc = decl(forced[0]!, "--focus-outline")!.split(" ");
    // Same width, same style; the colour is a SYSTEM colour, which forced colors never override.
    expect(hc.slice(0, 2)).toEqual(normal.slice(0, 2));
    expect(hc[2]).toBe("Highlight");
  });

  it("W3-A: nothing else declares the pair — globals.css spends it, never redefines it", () => {
    const declares = (r: Rule) =>
      decl(r, "--focus-outline") !== null || decl(r, "--focus-outline-offset") !== null;
    expect(G.filter(declares).map((r) => r.selector)).toEqual([]);
    expect(D.filter(declares)).toHaveLength(2);
  });

  it("W3-A: no rule spells the transparent outline out any more (every ring spends the token)", () => {
    const literal = [
      ...D.map((r) => ({ r, file: "ds-components.css" })),
      ...G.map((r) => ({ r, file: "globals.css" })),
    ].filter(({ r }) => (decl(r, "outline") ?? "").includes("transparent"));
    expect(literal.map(({ r, file }) => `${file}: ${r.selector}`)).toEqual([]);
    // Non-vacuous: the ~two dozen rings that carried the literal now carry the token.
    const spenders = [...D, ...G].filter((r) => decl(r, "outline") === FOCUS_OUTLINE);
    expect(spenders.length).toBeGreaterThanOrEqual(24);
  });

  it("a ring on a NON-focused host (:has / :focus-within / sibling box) declares it itself", () => {
    const missing = RINGS.filter(
      ({ r }) =>
        !COVERED_BY_DESCENDANT.has(r.selector) &&
        splitSelectors(r.selector).some((s) => !hostIsFocused(s)) &&
        decl(r, "outline") !== FOCUS_OUTLINE,
    );
    expect(missing.map(({ r, file }) => `${file}: ${r.selector}`)).toEqual([]);
  });

  it("the exemption is real: the table scroller draws a solid outline, turned transparent in a panel", () => {
    expect(decl(one(G, ".tablewrap:focus-visible"), "outline")).toMatch(
      /solid var\(--focus-ring\)$/,
    );
    expect(
      decl(
        one(G, ".panel:has(.tablewrap:focus-visible) .tablewrap:focus-visible"),
        "outline-color",
      ),
    ).toBe("transparent");
  });

  it("the host classifier is not vacuous", () => {
    expect(hostIsFocused(".bb-btn:focus-visible")).toBe(true);
    expect(hostIsFocused(".bb-input:focus")).toBe(true);
    expect(hostIsFocused(".bb-card--link:focus-within")).toBe(false);
    expect(hostIsFocused(".bb-card--link:has(> .bb-stretched-link:focus-visible)")).toBe(false);
    expect(hostIsFocused(".bb-choice input:focus-visible + .bb-choice__box")).toBe(false);
  });
});

/* ================================================================== *
 * 4 · KEYBOARD — a linked card/tile rings on keyboard focus, not on a mouse click.
 * ================================================================== */
describe("W2-A · 4 — linked cards/tiles ring on the overlay's :focus-visible only", () => {
  const HAS_SUPPORT_FALLBACK = "@supports not selector(:has(*))";

  it.each(["bb-card", "bb-stat"])(
    ".%s--link: the ring keys on `:has(> .bb-stretched-link:focus-visible)`",
    (b) => {
      const r = one(D, `.${b}--link:has(> .bb-stretched-link:focus-visible)`);
      expect(decl(r, "box-shadow")).toBe("var(--ring-focus)");
      expect(decl(r, "border-color")).toBe("var(--brand)");
      expect(decl(r, "outline")).toBe(FOCUS_OUTLINE);
      expect(decl(r, "outline-offset")).toBe(FOCUS_OFFSET);
    },
  );

  it.each(["bb-card", "bb-stat"])(
    ".%s--link: :focus-within (lit by every mouse click) exists ONLY as the no-:has() fallback",
    (b) => {
      const all = D.filter((r) => r.selector === `.${b}--link:focus-within`);
      expect(all.map((r) => r.at)).toEqual([HAS_SUPPORT_FALLBACK]);
      const keyed = one(D, `.${b}--link:has(> .bb-stretched-link:focus-visible)`);
      const fallback = all[0]!;
      for (const prop of ["box-shadow", "border-color", "outline", "outline-offset"]) {
        expect(decl(fallback, prop), prop).toBe(decl(keyed, prop));
      }
    },
  );

  it("the overlay itself never draws a ring or a forced-colors outline (the parent does)", () => {
    const a = one(D, ".bb-stretched-link:focus-visible");
    expect(decl(a, "outline")).toBe("none");
    expect(decl(a, "box-shadow")).toBe("none");
  });
});

/* ================================================================== *
 * 5 · LISTBOX — the select menu's active option survives forced colors.
 * ================================================================== */
describe("W2-A · 5 — the select menu's active option is visible in forced colors", () => {
  it("precondition: the focused list removes its own outline (the global fallback can't help)", () => {
    expect(decl(one(G, ".bb-selectmenu__list"), "outline")).toBe("none");
  });

  it("the active option pairs its background with an INSET transparent outline", () => {
    const r = one(G, ".bb-selectmenu__option--active");
    expect(decl(r, "background")).toBe("var(--surface-sunken)");
    expect(decl(r, "outline")).toBe(FOCUS_OUTLINE);
    // Negative: the list is a scroller (overflow-y: auto) that would clip an outside outline.
    expect(decl(one(G, ".bb-selectmenu__list"), "overflow-y")).toBe("auto");
    expect(decl(r, "outline-offset")).toBe("calc(-1 * var(--border-bold))");
  });

  it("no other active-option rule, in any context, removes or recolours that outline", () => {
    const others = G.filter(
      (r) =>
        splitSelectors(r.selector).some((s) => hasClass(s, "bb-selectmenu__option--active")) &&
        !(r.selector === ".bb-selectmenu__option--active" && r.at === ""),
    );
    for (const r of others) {
      for (const prop of ["outline", "outline-style", "outline-width", "outline-color"]) {
        expect(decl(r, prop), `\`${r.selector}\` (${r.at || "top"}) sets ${prop}`).toBeNull();
      }
    }
  });
});

describe("W3-A · the ink field error clears AA on the ink card", () => {
  const INK = parseRules(TOKENS).filter((r) => r.selector === '[data-theme="ink"]' && r.at === "");
  /** A token's ink-theme value: its last ink declaration, else the light `:root` one; resolved. */
  function inkValue(name: string): string {
    let v: string | null = null;
    for (const r of INK) v = decl(r, name) ?? v;
    v = v ?? tokenValue(TOKENS, name);
    expect(v, `token ${name} must be declared`).not.toBeNull();
    const chained = v!.match(/^var\((--[\w-]+)\)$/);
    return chained ? inkValue(chained[1]!) : v!;
  }
  /** WCAG 2.x contrast ratio of two #rrggbb colours. */
  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      expect(hex, "expected a #rrggbb literal").toMatch(/^#[0-9a-fA-F]{6}$/);
      const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const f = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(bl!);
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  it("the ink rule re-points ONLY the colour, to the light red; paper keeps --danger", () => {
    const r = D.find((x) => x.selector === '[data-theme="ink"] .bb-field__error' && x.at === "");
    expect(r, "an ink override for the field error").toBeDefined();
    expect(props(r!)).toEqual(["color"]);
    expect(decl(r!, "color")).toBe("var(--red-300)");
    expect(decl(one(D, ".bb-field__error"), "color")).toBe("var(--danger)");
  });

  it("ARITHMETIC: --danger fails AA on the ink card (the reason); --red-300 clears it", () => {
    const card = inkValue("--surface-card");
    // Measured 3.11:1 in Chromium under data-theme="ink" before the override.
    expect(contrast(inkValue("--danger"), card)).toBeLessThan(4.5);
    expect(contrast(inkValue("--red-300"), card)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("solid badges keep their own label colour in the ink theme", () => {
  // The ink tone overrides (`[data-theme="ink"] .bb-badge--brand` …) share the solid rules'
  // specificity and come later, so they repainted SOLID brand/warning labels as light text on a
  // yellow/amber fill (the "Contacted" pill measured 1.35:1). An explicit (0,3,0) restore fixes it.
  const find = (selector: string) => D.find((r) => r.selector === selector && r.at === "");
  it("the solid brand label stays text-on-brand", () => {
    const r = find('[data-theme="ink"] .bb-badge--solid.bb-badge--brand');
    expect(r).toBeDefined();
    expect(decl(r!, "color")).toBe("var(--text-on-brand)");
  });
  it("the solid warning label stays text-inverse", () => {
    const r = find('[data-theme="ink"] .bb-badge--solid.bb-badge--warning');
    expect(r).toBeDefined();
    expect(decl(r!, "color")).toBe("var(--text-inverse)");
  });
});
