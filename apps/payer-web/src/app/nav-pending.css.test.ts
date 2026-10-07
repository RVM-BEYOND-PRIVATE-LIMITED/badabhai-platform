import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { decl, parseRules, stripComments, type Rule } from "../../test/css-rules";
import { portalLinkTags } from "../../test/portal-link-usage";

/**
 * The navigation pending cue's DECLARED rules (components/nav-pending.tsx; the node env has no
 * layout engine — the cue was measured on a production build). What must hold:
 *  - idle draws nothing; on, the dot waits out the delay before it shows (no flash on a
 *    prefetched navigation), in the link's own colour;
 *  - reduced motion drops the pulse and the growing bar but KEEPS the delay — which is why the
 *    delay is not a motion token (those collapse to 0ms there);
 *  - the bar is fixed along the top, above the open drawer, and never takes a click;
 *  - the dot TAKES NO SPACE (review of #2115): out of flow on its link's corner, its link anchored
 *    whether or not it is pending — measured before: a header action grew 24px on click, a title
 *    16px, and on a phone the actions row could wrap.
 */
const here = dirname(fileURLToPath(import.meta.url));
const G = parseRules(stripComments(readFileSync(join(here, "globals.css"), "utf8")));
const D = parseRules(
  stripComments(readFileSync(join(here, "..", "styles", "ds-components.css"), "utf8")),
);
const REDUCE = "@media (prefers-reduced-motion: reduce)";

/** The last compound of each selector in a list — the element a rule styles. */
function subjects(selector: string): string[] {
  let flat = selector;
  // Fold every (…) — :where(), :has(), :not() — so a combinator inside one never splits the part.
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, "{}");
  return flat.split(",").map(
    (part) =>
      part
        .trim()
        .split(/\s*[\s>+~]\s*/)
        .pop()!,
  );
}
/** Every rule, in either stylesheet and any media context, that styles the dot itself. */
const DOT_RULES = [...G, ...D].filter(
  (r) =>
    !r.selector.startsWith("@") && subjects(r.selector).some((s) => s.includes(".nav-pending")),
);
const props = (r: Rule) =>
  r.body
    .split(";")
    .map((p) => p.slice(0, p.indexOf(":")).trim())
    .filter(Boolean);

function one(selector: string, at = ""): Rule {
  const found = G.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toHaveLength(1);
  return found[0]!;
}

describe("the dot on the link", () => {
  it("idle, it draws nothing", () => {
    expect(decl(one(".nav-pending"), "display")).toBe("none");
  });

  it("on, it is hidden until the delay has passed, then revealed — in the link's own colour", () => {
    const on = one(".nav-pending--on");
    expect(decl(on, "visibility")).toBe("hidden");
    const animation = decl(on, "animation")!;
    expect(animation).toMatch(/^nav-pending-reveal 0s linear var\(--nav-pending-delay\) forwards,/);
    // The pulse starts when the dot appears, not before.
    expect(animation).toMatch(/nav-pending-pulse .* var\(--nav-pending-delay\) infinite/);
    expect(decl(on, "background")).toBe("currentColor");
    const reveal = G.find((r) => r.selector === "@keyframes nav-pending-reveal");
    expect(reveal?.body.replace(/\s+/g, "")).toBe("to{visibility:visible;}");
  });

  it("the delay is its own value, never a motion token (those are 0ms under reduced motion)", () => {
    expect(decl(one(".nav-pending--on"), "--nav-pending-delay")).toMatch(/^\d+ms$/);
  });

  it("under reduced motion: no pulse, but still the delayed reveal", () => {
    expect(decl(one(".nav-pending--on", REDUCE), "animation")).toBe(
      "nav-pending-reveal 0s linear var(--nav-pending-delay) forwards",
    );
  });
});

describe("the dot takes no space — a click never moves anything (review of #2115)", () => {
  it("the scan sees the dot's rules (it is not vacuous)", () => {
    expect(DOT_RULES.map((r) => `${r.selector} (${r.at || "top"})`)).toEqual(
      expect.arrayContaining([".nav-pending (top)", ".nav-pending--on (top)"]),
    );
  });

  it("on, it is out of flow: absolutely positioned on its link's corner", () => {
    const on = one(".nav-pending--on");
    expect(decl(on, "position")).toBe("absolute");
    expect(decl(on, "inset-block-start")).not.toBeNull();
    expect(decl(on, "inset-inline-end")).not.toBeNull();
  });

  it("no rule gives the dot a margin, padding, flex or float, or puts it back in flow", () => {
    const offenders = DOT_RULES.flatMap((r) =>
      props(r)
        .filter(
          (p) =>
            /^(margin|padding|flex|float|order)/.test(p) ||
            (p === "position" && decl(r, "position") !== "absolute") ||
            (p === "display" && !["none", "block"].includes(decl(r, "display")!)),
        )
        .map((p) => `${r.selector} (${r.at || "top"}): ${p}: ${decl(r, p)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("only the absolutely positioned rule sizes the dot", () => {
    const sizing = DOT_RULES.filter((r) =>
      props(r).some((p) => /^(min-|max-)?(width|height|inline-size|block-size)$/.test(p)),
    ).map((r) => `${r.selector} (${r.at || "top"})`);
    expect(sizing).toEqual([".nav-pending--on (top)"]);
  });

  it("every link that carries a cue anchors it in BOTH states — its box never depends on pending", () => {
    // Keyed on the always-present span, with zero specificity so a link's own position wins.
    expect(decl(one(":where(a:has(> .nav-pending))"), "position")).toBe("relative");
    const keyedOnPending = [...G, ...D]
      .filter((r) => r.selector.includes(":has(") && r.selector.includes("nav-pending--on"))
      .map((r) => r.selector);
    expect(keyedOnPending).toEqual([]);
  });

  it("a rail row clips its overflow, so there the dot sits INSIDE the corner", () => {
    const rail = one(".pnav__link > .nav-pending--on, .pshell__brandlink > .nav-pending--on");
    expect(decl(rail, "inset-block-start")).toBe("var(--space-1)");
    expect(decl(rail, "inset-inline-end")).toBe("var(--space-1)");
  });
});

describe("the bar along the top of the viewport", () => {
  it("is fixed to the top edge, above the open drawer, and never takes a click", () => {
    const bar = one(".nav-progress");
    expect(decl(bar, "position")).toBe("fixed");
    expect(decl(bar, "inset-block-start")).toBe("0");
    expect(decl(bar, "z-index")).toBe("var(--z-toast)");
    expect(decl(bar, "pointer-events")).toBe("none");
    expect(decl(bar, "opacity")).toBe("0");
    expect(decl(one(".nav-progress--on"), "opacity")).toBe("1");
  });

  it("under reduced motion it does not grow — it just shows", () => {
    expect(decl(one(".nav-progress--on", REDUCE), "animation")).toBe("none");
  });
});

/* ---- follow-up to #2115: every in-app link is a PortalLink, so every link carries the cue ---- */

/**
 * Every stylesheet the app loads: globals.css and what it `@import`s (workspace packages resolve
 * through the app's node_modules, relative paths beside globals.css). Read as text — no RegExp is
 * built from a value.
 */
function stylesheets(): Array<[string, Rule[]]> {
  const app = join(here, "..", "..");
  const globals = readFileSync(join(here, "globals.css"), "utf8");
  const out: Array<[string, Rule[]]> = [["globals.css", G]];
  for (const line of globals.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("@import ")) continue;
    const spec = t.slice(t.indexOf('"') + 1, t.lastIndexOf('"'));
    const path = spec.startsWith(".") ? join(here, spec) : join(app, "node_modules", spec);
    out.push([spec, parseRules(stripComments(readFileSync(path, "utf8")))]);
  }
  return out;
}

/** The classes in a compound selector (`a.pnav__link:hover` → ["pnav__link"]). */
function classesOf(compound: string): string[] {
  const out: string[] = [];
  for (let i = compound.indexOf("."); i >= 0; i = compound.indexOf(".", i + 1)) {
    let j = i + 1;
    while (j < compound.length && /[\w-]/.test(compound[j]!)) j += 1;
    if (j > i + 1) out.push(compound.slice(i + 1, j));
  }
  return out;
}

/**
 * The classes `code` gives its `<PortalLink>`s — however it names the wrapper
 * (`{ PortalLink as L }`, `<P.PortalLink>`; test/portal-link-usage.ts) — read from the syntax
 * tree: each string piece of a `className`, so a conditional or template class
 * (`pnav__link--active`, `bb-btn--primary`'s stem) counts too.
 */
function portalLinkClasses(code: string, file = "x.tsx"): Set<string> {
  const out = new Set<string>();
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const isPortalLink = portalLinkTags(sf);
  const strings = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) node.text.split(/\s+/).forEach((c) => c && out.add(c));
    if (ts.isTemplateExpression(node)) {
      for (const piece of [node.head, ...node.templateSpans.map((s) => s.literal)]) {
        piece.text.split(/\s+/).forEach((c) => c && out.add(c));
      }
    }
    ts.forEachChild(node, strings);
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      isPortalLink(node.tagName)
    ) {
      for (const a of node.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText(sf) === "className" && a.initializer) {
          strings(a.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every class a cued link can carry: those of each `PortalLink` in src (the only in-app link —
 * app/every-link-shows-the-cue.test.ts).
 */
function cuedLinkClasses(): Set<string> {
  const src = join(here, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const out = new Set<string>();
  for (const f of walk(src).filter((p) => p.endsWith(".tsx") && !p.endsWith(".test.tsx"))) {
    const code = readFileSync(f, "utf8");
    if (!code.includes("portal-link")) continue;
    for (const c of portalLinkClasses(code, f)) out.add(c);
  }
  return out;
}

/**
 * Does a rule take its subject out of positioning? `static`, and every keyword that computes to it
 * on a link (`initial`, `unset`, `revert`, `revert-layer`; `inherit` from a static parent) — or an
 * `all` reset, which takes `position` with it (review of #2125).
 */
const STATIC_POSITIONS: ReadonlySet<string> = new Set([
  "static",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "inherit",
]);
function unanchors(r: Rule): boolean {
  const position = decl(r, "position");
  return (position !== null && STATIC_POSITIONS.has(position)) || decl(r, "all") !== null;
}

describe("every cued link stays the dot's anchor (re-review of #2115, nit)", () => {
  const CUED = cuedLinkClasses();
  const SHEETS = stylesheets();
  /** Every rule, in any loaded stylesheet and any media context, that styles a cued link itself. */
  const LINK_RULES = SHEETS.flatMap(([sheet, rules]) =>
    rules
      .filter((r) => !r.selector.startsWith("@"))
      .filter((r) =>
        subjects(r.selector).some(
          (s) =>
            classesOf(s).some((c) => CUED.has(c)) ||
            // A bare type selector on `a` styles every link, cued ones included.
            s === "a" ||
            s.startsWith("a:") ||
            s.startsWith("a."),
        ),
      )
      .map((r) => [sheet, r] as const),
  );

  it("the scans are not vacuous: the cued links' classes and their rules are seen", () => {
    for (const c of [
      "pnav__link",
      "pshell__brandlink",
      "pshell__balance",
      "bb-stretched-link",
      "bb-btn",
      "posting-card__title",
      "postings-link",
      "quick__card",
      "account-menu__link",
      "capacity-link",
    ]) {
      expect(CUED, c).toContain(c);
    }
    expect(SHEETS.map(([s]) => s)).toEqual(
      expect.arrayContaining(["globals.css", "../styles/ds-components.css"]),
    );
    expect(LINK_RULES.length).toBeGreaterThan(30);
  });

  it("no rule on a cued link sets `position: static` (or resets it with `all`) — the zero-specificity anchor would lose", () => {
    // `:where(a:has(> .nav-pending)) { position: relative }` has NO specificity on purpose (a
    // link's own position wins: the card overlay stays absolute). So any rule that names a cued
    // link and says `static` beats it, and the dot would hang off the nearest positioned
    // ancestor instead — far from the link that was clicked.
    const offenders = LINK_RULES.filter(([, r]) => unanchors(r)).map(
      ([sheet, r]) => `${sheet}: ${r.selector} (${r.at || "top"})`,
    );
    expect(offenders).toEqual([]);
  });

  it("every keyword that computes to static counts, not only the word itself (review of #2125)", () => {
    const rule = (body: string): Rule => ({ selector: ".x", body, at: "" });
    for (const p of ["static", "initial", "unset", "revert", "revert-layer", "inherit"]) {
      expect(unanchors(rule(`position: ${p};`)), p).toBe(true);
    }
    expect(unanchors(rule("all: unset;"))).toBe(true);
    for (const p of ["relative", "absolute", "sticky", "fixed"]) {
      expect(unanchors(rule(`position: ${p};`)), p).toBe(false);
    }
    expect(unanchors(rule("color: red;"))).toBe(false);
  });

  it("a cued link's classes are read however the file names the wrapper (review of #2125)", () => {
    expect(
      portalLinkClasses(
        'import { PortalLink as L } from "../components/portal-link";\nconst x = <L className="aliased-link" href="/x" pendingLabel="X" />;',
      ),
    ).toEqual(new Set(["aliased-link"]));
    expect(
      portalLinkClasses(
        'import * as P from "@/components/portal-link.tsx";\nconst x = <P.PortalLink className={`ns-link ${on ? "ns-link--on" : ""}`} href="/x" pendingLabel="X" />;',
      ),
    ).toEqual(new Set(["ns-link", "ns-link--on"]));
    // A component that merely shares the name is not the wrapper.
    expect(
      portalLinkClasses(
        'import { PortalLink } from "./other";\nconst x = <PortalLink className="not-a-link" />;',
      ),
    ).toEqual(new Set());
  });

  it("a card's whole-surface overlay keeps its own absolute position (it IS the dot's anchor)", () => {
    const overlay = D.filter((r) => r.selector === ".bb-stretched-link" && r.at === "");
    expect(overlay).toHaveLength(1);
    expect(decl(overlay[0]!, "position")).toBe("absolute");
  });

  it("the overlay's dot sits INSIDE the card's corner, in a colour of its own (the overlay is transparent)", () => {
    const dot = one(".bb-stretched-link > .nav-pending--on");
    expect(decl(dot, "inset-block-start")).toBe("var(--space-1)");
    expect(decl(dot, "inset-inline-end")).toBe("var(--space-1)");
    // `currentColor` on a `color: transparent` overlay would draw an invisible dot.
    expect(decl(dot, "background")).toBe("var(--text-heading)");
  });

  it("the account menu's panel, kept mounted while closed, is really hidden then", () => {
    // account-menu.tsx: the Account link outlives the click that closes the menu, so its cue
    // does too; the panel's own `display: grid` would otherwise override `[hidden]`.
    expect(decl(one(".account-menu__panel[hidden]"), "display")).toBe("none");
    expect(decl(one(".account-menu__panel"), "display")).toBe("grid");
  });
});
