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
 *  - on the icon rail the dot pins to the row's corner instead of pushing the centred icon.
 */
const here = dirname(fileURLToPath(import.meta.url));
const G = parseRules(stripComments(readFileSync(join(here, "globals.css"), "utf8")));
const REDUCE = "@media (prefers-reduced-motion: reduce)";
const ICON_RAIL_COLLAPSED = "@media (min-width: 1024px)";
const ICON_RAIL_BAND = "@media (max-width: 1279px) and (min-width: 1024px)";

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

  it("on the icon rail (collapsed, and the 1024–1279px band) it pins to the row's corner", () => {
    for (const [at, prefix] of [
      [ICON_RAIL_COLLAPSED, ".pshell--collapsed "],
      [ICON_RAIL_BAND, ""],
    ] as const) {
      const pin = G.find(
        (r) =>
          r.at === at && r.selector.split(", ").includes(`${prefix}.pnav__link > .nav-pending--on`),
      );
      expect(decl(pin!, "position"), at).toBe("absolute");
      const row = G.find(
        (r) =>
          r.at === at &&
          r.selector.split(", ").includes(`${prefix}.pnav__link`) &&
          decl(r, "position") !== null,
      );
      expect(decl(row!, "position"), at).toBe("relative");
    }
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
