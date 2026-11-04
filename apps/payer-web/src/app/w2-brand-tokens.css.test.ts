import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * W2 (#2582) — payer-web CSS token sweep, as a source-level lint fence (node env, no layout
 * engine; the repo carries no stylelint, so the rules are enforced here instead):
 *   - no raw px font size and nothing under 11px in app CSS;
 *   - no raw hex colour in app CSS outside the named exceptions below;
 *   - table headers never take the muted step (≥ 4.5:1 on the sunken fill);
 *   - ONE active-nav definition, painted by CSS from the server-rendered class (readable with JS
 *     disabled, no sliding plate);
 *   - no hover lift on static containers; every hover transform sits under `(hover: hover)`;
 *   - KPI values take the compact size on phones.
 */

const here = dirname(fileURLToPath(import.meta.url));
const raw = (...p: string[]) => readFileSync(join(here, ...p), "utf8");
const GLOBALS = stripComments(raw("globals.css"));
const DS = stripComments(raw("..", "styles", "ds-components.css"));
const TOKENS = stripComments(
  raw("..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
);
const SIDEBAR = raw("(portal)", "sidebar-nav.tsx");

const RULES: Rule[] = [...parseRules(GLOBALS), ...parseRules(DS)];

/** The job-card preview is a scaled replica of the worker app's card (pinned to the app's own
 *  values by job-card-preview.css.test.ts); its sizes are `calc(N * --jcp-u)` and its colours
 *  are the app's. It is the one component exempt from the token sweep. */
const isJcp = (r: Rule) => r.selector.split(",").every((s) => s.trim().startsWith(".jcp"));

/** Hex colours that intentionally stay literal in payer-web (owner: colour changes are scoped
 *  to the Flutter apps — the payer-web ramp and the AI card wash are kept as they are). */
const HEX_EXCEPTIONS: ReadonlyArray<(r: Rule) => boolean> = [
  (r) => r.selector === ":root" && decl(r, "--navy-900") !== null, // the payer-web navy ramp
  (r) => r.selector === ".mw-ai", // the AI card's wash
];

const px = (value: string, root = 16): number | null => {
  const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
  if (m === null) return null;
  return m[2] === "rem" ? Number(m[1]) * root : Number(m[1]);
};

/** Resolve `var(--token)` against tokens.css (and payer-web's own `:root`) to a px number. */
function resolvePx(value: string, depth = 0): number | null {
  const v = value.replace(/!important/, "").trim();
  const direct = px(v);
  if (direct !== null) return direct;
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m === null || depth > 4) return null;
  const t = tokenValue(GLOBALS, m[1]!) ?? tokenValue(TOKENS, m[1]!);
  if (t === null) return null;
  return resolvePx(t.replace(/\s*\/\*.*$/, ""), depth + 1);
}

function hexOf(name: string, depth = 0): string {
  const v = (tokenValue(GLOBALS, name) ?? tokenValue(TOKENS, name) ?? "").trim();
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m !== null && depth < 5) return hexOf(m[1]!, depth + 1);
  return v;
}

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const full = n.length === 3 ? [...n].map((c) => c + c).join("") : n;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("W2 #2582 — font sizes", () => {
  const sized = RULES.filter((r) => !isJcp(r) && decl(r, "font-size") !== null);

  it("no raw px font size in app CSS — every size is a token", () => {
    const offenders = sized
      .filter((r) => /\d(px|pt)\b/.test(decl(r, "font-size")!))
      .map((r) => `${r.selector} → ${decl(r, "font-size")}`);
    expect(offenders).toEqual([]);
  });

  it("no font size under 11px", () => {
    const offenders = sized
      .map((r) => ({ r, size: resolvePx(decl(r, "font-size")!) }))
      .filter(({ size }) => size !== null && size > 0 && size < 11)
      .map(({ r, size }) => `${r.selector} → ${size}px`);
    expect(offenders).toEqual([]);
  });
});

describe("W2 #2582 — colours", () => {
  it("no raw hex colour in app CSS outside the named exceptions", () => {
    const offenders = RULES.filter((r) => !isJcp(r))
      .filter((r) => /#[0-9a-fA-F]{3,8}\b/.test(r.body))
      .filter((r) => !HEX_EXCEPTIONS.some((ok) => ok(r)))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("table headers never take the muted step — the old `.pshell__content .table thead th` override is gone", () => {
    const headers = RULES.filter((r) => /(^|[\s,])(thead )?th(\s*,|$)|\bth$/.test(r.selector));
    expect(headers.length).toBeGreaterThan(0);
    for (const r of headers) {
      const color = decl(r, "color");
      if (color === null) continue;
      expect(color, r.selector).not.toMatch(/--text-(muted|faint)\b/);
    }
    expect(RULES.some((r) => r.selector === ".pshell__content .table thead th")).toBe(false);
  });

  it("the header step clears 4.5:1 on the sunken fill", () => {
    const fg = hexOf("--ink-600");
    const bg = hexOf("--paper-3");
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("W2 #2582 — active nav", () => {
  const active = RULES.filter((r) =>
    /\.pnav__link--active(?![\w-])/.test(r.selector.replace(/:not\(\.pnav__link--active\)/g, "")),
  );

  it("exactly one rule paints the active row's background, at top level, not behind .pshell", () => {
    const painters = active.filter((r) => decl(r, "background") !== null);
    expect(painters.map((r) => r.selector)).toEqual([
      ".pnav__link--active, .pnav__link--active:hover",
    ]);
    expect(painters[0]!.at).toBe("");
    expect(decl(painters[0]!, "background")).not.toBe("transparent");
  });

  it("the active label is readable on its own plate (≥ 4.5:1) — no script needed", () => {
    const painter = active.find((r) => decl(r, "background") !== null)!;
    const bg = hexOf(decl(painter, "background")!.replace(/^var\((--[\w-]+)\)$/, "$1"));
    const fg = hexOf(decl(painter, "color")!.replace(/^var\((--[\w-]+)\)$/, "$1"));
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("no measured/sliding plate and no load-time icon pop", () => {
    expect(SIDEBAR).not.toContain("pnav__plate");
    expect(SIDEBAR).not.toMatch(/useLayoutEffect|getBoundingClientRect/);
    expect(RULES.some((r) => r.selector.includes("pnav__plate"))).toBe(false);
    expect(active.some((r) => decl(r, "animation") !== null)).toBe(false);
  });
});

describe("W2 #2582 — hover", () => {
  const STATIC = [
    ".panel",
    ".posting-card",
    ".applicant",
    ".credit-pack",
    ".capacity-tier",
    ".agency-job",
  ];

  it("static containers have no hover lift", () => {
    const offenders = RULES.filter((r) => r.selector.includes(":hover"))
      .filter((r) => STATIC.some((c) => new RegExp(`\\${c}(?![\\w-])[^ ]*:hover`).test(r.selector)))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("every hover transform sits under (hover: hover) — nothing stays lifted after a tap", () => {
    const offenders = RULES.filter((r) => r.selector.includes(":hover"))
      .filter((r) => !r.selector.includes("bb-tooltip")) // positions the tooltip, not a lift
      .filter((r) => {
        const t = decl(r, "transform");
        return t !== null && t !== "none";
      })
      .filter((r) => !r.at.includes("(hover: hover)"))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("the hover lift runs on the fast (140ms) motion token", () => {
    expect(tokenValue(TOKENS, "--duration-fast")).toBe("140ms");
  });
});

describe("W2 #2582 — KPI values on phones", () => {
  it("dashboard KPI values take the compact size at phone width", () => {
    const phone = RULES.find(
      (r) =>
        r.at === "@media (max-width: 600px)" &&
        r.selector === ".stat-row--kpi .dash-kpi .bb-stat__value",
    );
    expect(phone).toBeDefined();
    expect(decl(phone!, "font-size")).toBe("var(--ui-kpi-sm-size)");
  });
});
