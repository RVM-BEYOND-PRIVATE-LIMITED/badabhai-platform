import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";
import { decl, globalsCss, resolveToken, rule, rules, tokensCss } from "../../test/css-rules";

/**
 * A1 (#2571) — the admin console's foundation: type, layout, tiles, spacing. The node env has no
 * layout engine, so these pin the DECLARED rules each acceptance criterion rests on:
 *   - no horizontal shift between routes: a reserved scrollbar gutter, one start-aligned content
 *     edge (fluid data pages, start-aligned 1200px reading pages) and a rail that expands OVER
 *     the page rather than pushing it;
 *   - tiles align: the shared `.stats` grid (stat-tiles.css.test.ts);
 *   - buttons, disabled state, KPI face, panel sub-sections and the dev indicator.
 */
const CSS = globalsCss();
const TOKENS = tokensCss();
const ALL = rules(CSS, true);
const top = (selector: string) => {
  const body = rule(CSS, selector);
  expect(body, `${selector} must be declared at top level`).not.toBeNull();
  return body!;
};
const at = (selector: string, media: string) =>
  ALL.find((r) => r.selector === selector && r.atRules.join() === media);
/** Resolve a value against the admin `:root` locals first, then the token layer. */
const resolve = (name: string) => resolveToken(`${TOKENS}\n${CSS}`, name);

// Hover-capable devices only: a touch tablet at these widths keeps the full sidebar.
const RAIL = "@media (min-width: 1024px) and (max-width: 1439px) and (hover: hover)";
const DRAWER = "@media (max-width: 1023px)";
const PHONE = "@media (max-width: 600px)";
const TOUCH = "@media (max-width: 600px), (pointer: coarse)";

describe("buttons — 14px/600 at 40px, small 13px", () => {
  it("draws the console button at 14px semibold, 40px tall", () => {
    const btn = top(".btn");
    expect(decl(btn, "font-size")).toBe("var(--ui-body-size)");
    expect(resolve("--ui-body-size")).toBe("0.875rem");
    expect(decl(btn, "font-weight")).toBe("var(--weight-semibold)");
    expect(decl(btn, "min-height")).toBe("var(--admin-btn-h)");
    expect(resolve("--admin-btn-h")).toBe("40px");
  });

  it("keeps the small button at 13px", () => {
    let size: string | null = null;
    for (const r of rules(CSS)) if (r.selector === ".btn--sm") size = decl(r.body, "font-size") ?? size;
    expect(size).toBe("var(--ui-body-sm-size)");
    expect(resolve("--ui-body-sm-size")).toBe("0.8125rem");
  });

  it("gives a finger 44px on a touch screen, leaving the small button to its strip", () => {
    const touch = at(".btn:not(.btn--sm)", TOUCH);
    expect(touch).toBeDefined();
    expect(decl(touch!.body, "min-height")).toBe("var(--control-md)");
  });
});

describe("a shared row — buttons and inputs one height at each tier", () => {
  /** The cascaded top-level value: the last top-level rule for `selector` that declares `prop`. */
  const cascaded = (selector: string, prop: string) => {
    let value: string | null = null;
    for (const r of rules(CSS)) if (r.selector === selector) value = decl(r.body, prop) ?? value;
    return value;
  };
  /** A declared `var(--token)` resolved to its length. */
  const length = (value: string | null) => {
    expect(value).toMatch(/^var\(--[\w-]+\)$/);
    return resolve(value!.slice("var(".length, -1));
  };
  /** Index of the last top-level rule for `selector` declaring `prop` — a touch rule of the same
   *  specificity wins only by coming after it. */
  const lastTopIndex = (selector: string, prop: string) =>
    ALL.reduce(
      (last, r, i) =>
        r.atRules.length === 0 && r.selector === selector && decl(r.body, prop) !== null ? i : last,
      -1,
    );

  it("draws a filter bar's inputs at the button's 40px for a mouse", () => {
    const button = length(cascaded(".btn", "min-height"));
    expect(button).toBe("40px");
    expect(length(cascaded(".field__input", "min-height"))).toBe(button);
    expect(length(cascaded(".field__input", "height"))).toBe(button);
  });

  it("lifts the inputs to the button's 44px on a touch screen", () => {
    const button = length(decl(at(".btn:not(.btn--sm)", TOUCH)!.body, "min-height"));
    expect(button).toBe("44px");
    const input = at(".field__input", TOUCH);
    expect(input, ".field__input in the touch block").toBeDefined();
    expect(length(decl(input!.body, "min-height"))).toBe(button);
    expect(length(decl(input!.body, "height"))).toBe(button);
    expect(ALL.indexOf(input!)).toBeGreaterThan(lastTopIndex(".field__input", "height"));
  });

  it("keeps the password field's reveal toggle square at the input's height at both tiers", () => {
    const toggle = ".password-input > .iconbtn";
    for (const prop of ["inline-size", "block-size"]) {
      expect(length(cascaded(toggle, prop)), prop).toBe(
        length(cascaded(".field__input", "height")),
      );
      const touch = at(toggle, TOUCH);
      expect(touch, `${toggle} in a touch block`).toBeDefined();
      expect(length(decl(touch!.body, prop)), prop).toBe("44px");
      expect(ALL.indexOf(touch!)).toBeGreaterThan(lastTopIndex(toggle, prop));
    }
  });
});

describe("disabled — the 40% brand tint with a readable label", () => {
  it("is a tint and a Shift Blue label, never a faded opacity", () => {
    const disabled = top(".btn:disabled");
    expect(decl(disabled, "opacity")).toBeNull();
    expect(decl(disabled, "background")).toBe("var(--color-brand-primary-40)");
    expect(decl(disabled, "color")).toBe("var(--text-on-brand)");
    expect(resolve("--text-on-brand")).toBe("#05194c");
  });
});

describe("layout — fluid data pages, 1200px reading pages, one gutter", () => {
  it("reserves the scrollbar gutter so short and long pages lay out at one width", () => {
    expect(decl(top("html"), "scrollbar-gutter")).toBe("stable");
  });

  it("lets the content fill the main column — no centred cap that moves its left edge", () => {
    const content = top(".content");
    expect(decl(content, "max-width")).toBeNull();
    expect(decl(content, "max-inline-size")).toBeNull();
    expect(decl(content, "margin-inline")).toBeNull();
    expect(decl(content, "padding")).toBe("var(--space-7) var(--admin-gutter)");
    expect(resolve("--admin-gutter")).toBe("32px");
  });

  it("caps a reading page at 1200px, start-aligned", () => {
    const reading = top(".page--reading");
    expect(decl(reading, "max-inline-size")).toBe("var(--admin-reading-max)");
    expect(resolve("--admin-reading-max")).toBe("75rem");
    expect(decl(reading, "margin-inline")).toBeNull();
    expect(decl(reading, "margin")).toBeNull();
  });

  it("puts the topbar on the content's gutter at every tier", () => {
    expect(decl(top(".topbar"), "padding")).toBe("var(--space-3) var(--admin-gutter)");
    expect(decl(at(".content", DRAWER)!.body, "padding")).toBe("var(--space-6) var(--admin-gutter)");
    expect(decl(at(":root", DRAWER)!.body, "--admin-gutter")).toBe("var(--space-4)");
    expect(decl(at(".content", PHONE)!.body, "padding")).toBe("var(--space-5) var(--admin-gutter)");
    expect(decl(at(".topbar", PHONE)!.body, "padding-inline")).toBe("var(--admin-gutter)");
  });
});

describe("collapsible icon rail, 1024–1439px", () => {
  it("rests at the collapsed-width token and expands to the full width", () => {
    const rail = at(".sidebar", RAIL);
    expect(rail).toBeDefined();
    expect(decl(rail!.body, "width")).toBe("var(--shell-nav-w-collapsed)");
    expect(decl(rail!.body, "overflow-x")).toBe("hidden");
    for (const open of [at(".sidebar:has(:focus-visible)", RAIL), at(".sidebar:hover", RAIL)]) {
      expect(open).toBeDefined();
      expect(decl(open!.body, "width")).toBe("var(--shell-nav-w)");
    }
  });

  it("expands OVER the page: its flex footprint stays the rail's width", () => {
    // width + margin-inline-end = the collapsed width, so the content never moves.
    for (const open of [at(".sidebar:has(:focus-visible)", RAIL), at(".sidebar:hover", RAIL)]) {
      expect(decl(open!.body, "margin-inline-end")).toBe(
        "calc(var(--shell-nav-w-collapsed) - var(--shell-nav-w))",
      );
    }
  });

  it("animates width over 220ms ease-out; labels fade out first and in after", () => {
    expect(resolve("--duration-base")).toBe("220ms");
    const rail = at(".sidebar", RAIL)!;
    // Closing: the width waits for the labels' fade.
    expect(decl(rail.body, "transition")).toContain(
      "width var(--duration-base) var(--ease-out) var(--duration-fade)",
    );
    const open = at(".sidebar:has(:focus-visible)", RAIL)!;
    expect(decl(open.body, "transition")).toContain("width var(--duration-base) var(--ease-out),");
    const labelsIn = ALL.find(
      (r) => r.atRules.join() === RAIL && r.selector.startsWith(".sidebar:has(:focus-visible) :is(.sidebar__label"),
    );
    expect(decl(labelsIn!.body, "opacity")).toBe("1");
    // Opening: the labels wait for the width.
    expect(decl(labelsIn!.body, "transition")).toBe(
      "opacity var(--duration-fade) var(--ease-enter) var(--duration-base)",
    );
  });
});

describe("KPI face and stat values", () => {
  it("sets KPI numbers in the UI face with tabular figures; mono stays for ids", () => {
    const value = top(".stat__value");
    expect(decl(value, "font-family")).toBe("var(--font-sans)");
    const fonts = ALL.filter((r) => r.selector === ".stat__value").map((r) => decl(r.body, "font-family"));
    expect(fonts).not.toContain("var(--font-mono)");
    const role = ALL.filter((r) => r.selector === ".stat__value").map((r) =>
      decl(r.body, "font-variant-numeric"),
    );
    expect(role.some((v) => v?.includes("tabular-nums"))).toBe(true);
    expect(decl(top(".mono"), "font-family")).toBe("var(--font-mono)");
  });

  it("sets funnel, bucket and spend counts in the UI face, never mono", () => {
    const fonts = ALL.filter((r) => r.selector === ".funnel__distinct").map((r) => decl(r.body, "font-family"));
    expect(fonts).not.toContain("var(--font-mono)");
    expect(decl(top(".funnel__distinct"), "font-family")).toBe("var(--font-sans)");
    expect(decl(top(".funnel__distinct"), "font-variant-numeric")).toContain("tabular-nums");
  });

  it("collapses the rail only where it can be opened — never without hover", () => {
    const railMedia = ALL.filter((r) => r.atRules.join().includes("(max-width: 1439px)")).map((r) => r.atRules.join());
    expect(railMedia.length).toBeGreaterThan(0);
    for (const m of railMedia) expect(m).toBe(RAIL);
  });

  it("fades a value in once on mount, with an opacity-only keyframe", () => {
    expect(decl(top(".stat__value"), "animation")).toBe(
      "stat-value-in var(--duration-fade) var(--ease-enter) both",
    );
    expect(CSS).toMatch(/@keyframes stat-value-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*\}\s*to\s*\{\s*opacity:\s*1;\s*\}\s*\}/);
  });
});

describe("panel sub-sections", () => {
  it("sit 24px apart behind a hairline divider", () => {
    const next = top(".panel__section + .panel__section");
    expect(decl(next, "margin-block-start")).toBe("var(--space-6)");
    expect(decl(next, "padding-block-start")).toBe("var(--space-6)");
    expect(decl(next, "border-block-start")).toBe("var(--border-hairline) solid var(--divider)");
    expect(resolve("--space-6")).toBe("24px");
  });

  it("lets sections side by side in a .cols grid sit level, with no divider over the second", () => {
    const columns = top(".cols > .panel__section + .panel__section");
    expect(decl(columns, "margin-block-start")).toBe("0");
    expect(decl(columns, "padding-block-start")).toBe("0");
    expect(decl(columns, "border-block-start")).toBe("0");
  });

  it("spaces a section's children by its gap alone, so a caption never adds its own margin", () => {
    expect(decl(top(".panel__section"), "gap")).toBe("var(--space-3)");
    const children = top(".panel__section > .panel__sub, .panel__section > .about");
    expect(decl(children, "margin-block-start")).toBe("0");
  });

  it("wraps a section title the way it wraps a panel title", () => {
    const selectors = (prop: string, value: string, media: string) =>
      ALL.filter((r) => r.atRules.join() === media && decl(r.body, prop) === value).flatMap((r) =>
        r.selector.split(",").map((s) => s.trim()),
      );
    for (const [prop, value, media] of [
      ["text-wrap", "balance", ""],
      ["overflow-wrap", "anywhere", PHONE],
    ] as const) {
      expect(selectors(prop, value, media), `${prop}: ${value}`).toEqual(
        expect.arrayContaining([".panel__title", ".panel__section-title"]),
      );
    }
  });
});

describe("hover states ease in over 140ms", () => {
  it("transitions every non-control hover target on --duration-fast", () => {
    expect(resolve("--duration-fast")).toBe("140ms");
    expect(decl(top(".table tbody tr"), "transition")).toBe(
      "background-color var(--duration-fast) var(--ease-out)",
    );
    for (const link of [".link", ".backlink", ".crumb__link"]) {
      expect(decl(top(link), "transition"), link).toBe(
        "text-decoration-color var(--duration-fast) var(--ease-out)",
      );
      expect(decl(top(`${link}:hover`), "text-decoration-color"), link).toBe("currentColor");
    }
  });
});

describe("the Next dev indicator", () => {
  it("sits bottom-right, off the sidebar footer", () => {
    const config = nextConfig as { devIndicators?: { position?: string } };
    expect(config.devIndicators?.position).toBe("bottom-right");
  });
});
