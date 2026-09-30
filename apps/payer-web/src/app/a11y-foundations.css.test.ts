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
 * 1280/375px (and under emulated forced-colors) when built.
 *   1 · SUBTITLE   — `.panel__sub` / `.section__sub` always take their own line under the title;
 *   2 · TAP        — the small phone controls (sm button, chip, theme toggle, hamburger, balance)
 *                    clear a 44px hit area on phones without their hit areas meeting;
 *   3 · FORCED     — every box-shadow focus ring carries a transparent-outline fallback;
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
 * 1 · SUBTITLE — its own line under the title, at every width.
 * ================================================================== */
describe("W2-A · 1 — a panel/section subtitle always sits on its own line", () => {
  it.each([".panel__head", ".section__head"])("%s is a WRAPPING flex row", (head) => {
    const r = one(G, head);
    expect(decl(r, "display")).toBe("flex");
    expect(decl(r, "flex-wrap")).toBe("wrap");
  });

  it.each([".panel__sub", ".section__sub"])(
    "%s: an UNCLAMPED 100%% basis (no line can hold anything beside it)",
    (sub) => {
      const r = one(G, sub);
      expect(decl(r, "flex-basis")).toBe("100%");
      // A max width clamps the 100% basis back to the measure; wherever title + measure fit one
      // row (every desktop) the sub then rode up BESIDE the title. None may come back.
      for (const prop of ["max-width", "max-inline-size", "width", "inline-size", "flex"]) {
        expect(decl(r, prop), `${sub} must not declare ${prop}`).toBeNull();
      }
    },
  );

  it.each([".panel__sub", ".section__sub"])(
    "%s keeps the reading measure with an END PADDING (row − measure, clamps to 0)",
    (sub) => {
      expect(decl(one(G, sub), "padding-inline-end")).toBe("calc(100% - var(--reading-max))");
      // border-box, so the 100% basis INCLUDES that padding: the text box is the measure.
      expect(TOKENS).toMatch(/box-sizing:\s*border-box/);
      expect(tokenValue(TOKENS, "--reading-max")).not.toBeNull();
    },
  );

  it("MARKUP: in every head, the actions come BEFORE the sub (so they stay on the title row)", () => {
    // The sub takes a whole row, so an actions group AFTER it drops onto a row of its own under
    // the prose. Heuristic over the TSX: a sub is a <p>, so the first `</div>` after it closes
    // its head — a HEAD actions group (`panel__actions` / `section__actions`, not e.g. a body
    // `state__actions`) opening before that means the actions follow the sub.
    const late: string[] = [];
    for (const [file, src] of tsxUnder(here)) {
      for (const kind of ["panel", "section"]) {
        const sub = `className="${kind}__sub"`;
        for (let at = src.indexOf(sub); at >= 0; at = src.indexOf(sub, at + 1)) {
          const close = src.indexOf("</div>", at);
          const between = src.slice(at, close < 0 ? src.length : close);
          const heads = ['className="panel__actions"', 'className="section__actions"'];
          if (heads.some((h) => between.includes(h))) late.push(`${file} @${at}`);
        }
      }
    }
    expect(late).toEqual([]);
  });

  it("the markup scan is not vacuous (it reads the consumers, incl. the Payouts head)", () => {
    const files = tsxUnder(here);
    const subs = files.filter(([, s]) => s.includes('className="panel__sub"'));
    expect(subs.length).toBeGreaterThanOrEqual(8);
    const payout = files.find(([f]) => f.endsWith("payout-panel.tsx"));
    expect(payout, "payout-panel.tsx must be scanned").toBeDefined();
    expect(payout![1]).toContain('className="panel__actions"');
  });

  it("no other rule, in any context, re-clamps or re-sizes a subtitle", () => {
    const touches = (r: Rule) =>
      splitSelectors(r.selector).some((s) => /\.(panel|section)__sub$/.test(s)) &&
      r.selector !== ".panel__sub" &&
      r.selector !== ".section__sub";
    for (const r of G.filter(touches)) {
      for (const prop of ["max-width", "max-inline-size", "width", "flex-basis", "flex"]) {
        expect(decl(r, prop), `\`${r.selector}\` (${r.at || "top"}) sets ${prop}`).toBeNull();
      }
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
    expect(decl(g, "outline")).toBe(TRANSPARENT_OUTLINE);
    expect(decl(g, "outline-offset")).toBe("var(--border-bold)");
    // It changes ONLY the outline — the normal-mode ring is still the tokens.css box-shadow.
    expect(decl(g, "box-shadow")).toBeNull();
    const base = parseRules(TOKENS).find((r) => r.selector === ":focus-visible" && r.at === "");
    expect(base && decl(base, "box-shadow")).toBe("var(--ring-focus)");
  });

  it("no ring rule removes the outline (`outline: none` is what made them vanish)", () => {
    const bad = RINGS.filter(({ r }) => decl(r, "outline") === "none");
    expect(bad.map(({ r, file }) => `${file}: ${r.selector}`)).toEqual([]);
  });

  it("every outline a ring declares is TRANSPARENT (invisible in normal mode) and offset", () => {
    for (const { r, file } of RINGS) {
      const o = decl(r, "outline");
      if (o === null) continue;
      expect(o, `${file}: ${r.selector}`).toBe(TRANSPARENT_OUTLINE);
      expect(decl(r, "outline-offset"), `${file}: ${r.selector}`).toBe("var(--border-bold)");
    }
  });

  it("a ring on a NON-focused host (:has / :focus-within / sibling box) declares it itself", () => {
    const missing = RINGS.filter(
      ({ r }) =>
        !COVERED_BY_DESCENDANT.has(r.selector) &&
        splitSelectors(r.selector).some((s) => !hostIsFocused(s)) &&
        decl(r, "outline") !== TRANSPARENT_OUTLINE,
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
      expect(decl(r, "outline")).toBe(TRANSPARENT_OUTLINE);
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
    expect(decl(r, "outline")).toBe(TRANSPARENT_OUTLINE);
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
