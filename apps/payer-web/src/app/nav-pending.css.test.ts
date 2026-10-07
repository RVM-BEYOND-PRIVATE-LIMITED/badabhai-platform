import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decl, parseRules, stripComments, type Rule } from "../../test/css-rules";

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
