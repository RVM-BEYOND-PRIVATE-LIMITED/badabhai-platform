import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * #2584 (W4) — the posting flow on phones: the stylesheet half (node env, no layout engine, so
 * the DECLARED geometry and motion are fenced). The behaviour half lives in the posting form,
 * edit form, AI chat and postings-manager suites and lib/posting-draft.test.ts.
 *
 * Acceptance: Publish is reachable without scrolling the whole form at 375 and 768 — at ≤1100px
 * (both widths) the dock carrying Publish is pinned to the bottom of the screen along the form.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RULES: Rule[] = parseRules(stripComments(readFileSync(join(here, "globals.css"), "utf8")));
const NARROW = "@media (max-width: 1100px)";
const WIDE = "@media (min-width: 1101px)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";

function rule(selector: string, at = ""): Rule {
  const found = RULES.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toHaveLength(1);
  return found[0]!;
}
const keyframes = (name: string): string => {
  const r = RULES.find((x) => x.selector === `@keyframes ${name}`);
  expect(r, name).toBeDefined();
  return r!.body;
};

describe("the phone/tablet publish bar (≤1100px — covers 375 and 768)", () => {
  it("the dock is shown and pinned to the bottom of the screen, sharing the form's grid cell", () => {
    const dock = rule(".mw-layout > .posting-dock[data-mw-hidden]", NARROW);
    expect(decl(dock, "display")).toBe("flex");
    expect(decl(dock, "position")).toBe("sticky");
    expect(decl(dock, "bottom")).toBe("var(--space-2)");
    expect(decl(dock, "grid-row")).toBe("1");
    expect(decl(dock, "grid-column")).toBe("1");
    expect(decl(dock, "align-self")).toBe("end");
    const main = rule(".mw-layout > .mw-main", NARROW);
    expect(decl(main, "grid-row")).toBe("1");
    expect(decl(main, "padding-bottom")).toBe("calc(var(--posting-dock-h) + var(--space-4))");
  });

  it("the rail's own Publish and the 'panel on the right' hint step aside; the bar hint shows", () => {
    const off = rule(".mw-layout .mw-rail__actions, .mw-card__foothint--wide", NARROW);
    expect(decl(off, "display")).toBe("none");
    expect(decl(rule(".mw-card__foothint--narrow", WIDE), "display")).toBe("none");
  });

  it("focus scrolling keeps fields clear of the bar", () => {
    expect(decl(rule("html:has(.mw-layout)", NARROW), "scroll-padding-bottom")).toBe(
      "calc(var(--posting-dock-h) + var(--space-8))",
    );
  });

  it("the bar slides up once (220ms token, ≤ 6px), and not at all under reduced motion", () => {
    const dock = rule(".mw-layout > .posting-dock[data-mw-hidden]", NARROW);
    expect(decl(dock, "animation")).toBe("mw-dock-in var(--duration-base) var(--ease-enter) both");
    expect(keyframes("mw-dock-in")).toContain("translateY(var(--motion-rise))");
    const reduced = rule(
      ".mw-layout > .posting-dock[data-mw-hidden], .mw-form > .mw-card:not([hidden])",
      REDUCED,
    );
    expect(decl(reduced, "animation")).toBe("none");
  });
});

describe("step change and the draft cue", () => {
  it("the incoming step rises in over the 220ms token; its heading lands below the header", () => {
    expect(decl(rule(".mw-form > .mw-card:not([hidden])"), "animation")).toBe(
      "mw-step-in var(--duration-base) var(--ease-enter) both",
    );
    expect(keyframes("mw-step-in")).toContain("translateY(var(--motion-rise))");
    expect(decl(rule(".mw-card__title"), "scroll-margin-top")).toBe("var(--posting-rail-top)");
  });

  it("'Draft saved' fades (opacity only, 200ms token) and is still under reduced motion", () => {
    const cue = rule(".mw-draft-cue");
    expect(decl(cue, "opacity")).toBe("0");
    expect(decl(cue, "transition")).toBe("opacity var(--duration-page) var(--ease-exit)");
    expect(decl(rule('.mw-draft-cue[data-shown="true"]'), "opacity")).toBe("1");
    expect(decl(rule(".mw-draft-cue", REDUCED), "transition")).toBe("none");
  });
});

describe("the AI chat's draft panel", () => {
  it("sticks BELOW the shell header (it slid under it), and stops sticking in one column", () => {
    const side = rule(".ai-chat__side");
    expect(decl(side, "position")).toBe("sticky");
    expect(decl(side, "top")).toBe("var(--posting-rail-top)");
    expect(decl(rule(".ai-chat__side", "@media (max-width: 60rem)"), "position")).toBe("static");
  });
});
