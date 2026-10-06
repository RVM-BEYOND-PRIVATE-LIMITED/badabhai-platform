import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * W3-B — /postings, /plans, /account, /team, /team/accept LAYOUT FENCE. (/capacity is a redirect to
 * /plans' Hiring capacity section now; its tiers render there.)
 *
 * Node env, no layout engine (the approach of w2b-page-polish.css.test.ts): what each fix
 * depends on is DECLARED geometry plus token arithmetic, so this suite pins it —
 *   · /postings: the card's action bar sits under the text; the facts row's separator slot is
 *     clipped at a line start but a wrapped segment's text never is; the idle result region
 *     adds no gap;
 *   · /plans: one catalogue track + price size, the compact phone cards (a tier with its action
 *     is a price row), block spacing around the tier row, the table's role-column floor;
 *   · /account, /team, /team/accept: the phone KYC alert, the result-band spacing/measure;
 *   · touch: every control these screens own is ≥44px; text links take a hit strip that
 *     leaves their focus ring on the text;
 *   · every rule of the block is SCOPED to one of the page wrappers (or is a shared posting-row
 *     control's touch target) and is tokens-only.
 * The layouts were measured in Chromium at 320/375/768/1280px (paper + ink) when built.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, "globals.css"), "utf8");
const CSS = stripComments(RAW);
const TOKENS = stripComments(
  readFileSync(
    join(here, "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
    "utf8",
  ),
);
const RULES = parseRules(CSS);
const DS_RULES = parseRules(
  stripComments(readFileSync(join(here, "..", "styles", "ds-components.css"), "utf8")),
);

/** Every `prop: value` of a block, in order (a string scan, like `decl`). */
function declarations(r: Rule): Array<[string, string]> {
  return r.body.split(";").flatMap((part): Array<[string, string]> => {
    const colon = part.indexOf(":");
    return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
  });
}

/** A raw CSS length — signed or not, in any absolute, font- or viewport-relative unit. */
const RAW_LENGTH =
  /(^|[^\w-])-?\d*\.?\d+(px|rem|em|ex|ch|lh|rlh|vw|vh|vi|vb|vmin|vmax|[sld]v[whib]|[sld]vmin|[sld]vmax|cq[whib]|cqmin|cqmax|pt|pc|cm|mm|in|q)\b/i;

/** Properties whose value can carry a colour. */
const COLOUR_PROP =
  /^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|-webkit-text-fill-color|-webkit-text-stroke(-color)?|text-emphasis(-color)?|scrollbar-color|flood-color|lighting-color|stop-color)$/;
/**
 * Does this declaration's value need the colour check? Every colour property, and EVERY custom
 * property: `--x: red` is a raw colour the moment any rule spends `var(--x)` on a colour.
 */
const carriesColour = (prop: string) => COLOUR_PROP.test(prop) || prop.startsWith("--");
/** The only bare words a colour-bearing value may keep once its `var(--token)`s are removed. */
const NON_COLOUR_WORDS = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "none",
  "inset",
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "calc",
  "min",
  "max",
  "clamp",
]);
/** The words left in a colour-bearing value that are NOT allowed (an allowlist, not a colour list). */
function nonTokenWords(value: string): string[] {
  const bare = value.replace(/var\(--[\w-]+\)/g, " ").replace(/-?\d*\.?\d+[a-z%]*/gi, " ");
  return (bare.match(/[a-z][\w-]*/gi) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => !NON_COLOUR_WORDS.has(w));
}

/** The W3-B block alone: from its banner to the next section's banner. */
const BLOCK_TITLE = "POSTINGS · PLANS · CAPACITY · ACCOUNT · TEAM (W3-B polish)";
const NEXT_TITLE = "AGENCY SUPPLY — WORKER ENGAGEMENT";
function w3bBlock(): string {
  const title = RAW.indexOf(BLOCK_TITLE);
  const next = RAW.indexOf(NEXT_TITLE);
  expect(title, "the W3-B banner must exist").toBeGreaterThan(0);
  expect(next, "the W3-B block must end at the agency-supply banner").toBeGreaterThan(title);
  return RAW.slice(RAW.lastIndexOf("/*", title), RAW.lastIndexOf("/*", next));
}
const BLOCK_RULES = parseRules(stripComments(w3bBlock()));

const PHONE = "max-width: 600px";
const TOUCH = "(max-width: 600px), (pointer: coarse)";
const TABLET_TOUCH = "(pointer: coarse) and (min-width: 601px)";

/** `atNeedle === ""` means TOP LEVEL (not inside any at-rule). */
const inContext = (r: Rule, atNeedle: string) =>
  atNeedle === "" ? r.at === "" : r.at.includes(atNeedle);

/** The ONE rule whose selector list is exactly `selector` in the given context. */
function rule(selector: string, atNeedle = ""): Rule {
  const norm = (s: string) => s.replace(/,\s*/g, ",");
  const hits = RULES.filter((r) => norm(r.selector) === norm(selector) && inContext(r, atNeedle));
  expect(
    hits,
    `expected exactly one rule for \`${selector}\`${atNeedle ? ` in ${atNeedle}` : ""}`,
  ).toHaveLength(1);
  return hits[0]!;
}

/** Resolve a token through its `var()` chain to its literal light-theme value. */
function resolve(name: string): string {
  const v = tokenValue(TOKENS, name);
  expect(v, `token ${name} must be declared in tokens.css`).not.toBeNull();
  const chained = v!.match(/^var\((--[\w-]+)\)$/);
  return chained ? resolve(chained[1]!) : v!;
}

/** A length token in px (rem at the 16px root). */
function px(name: string): number {
  const v = resolve(name);
  const m = v.match(/^([\d.]+)(px|rem)$/);
  expect(m, `${name} was expected to resolve to px or rem, got ${v}`).not.toBeNull();
  return Number(m![1]) * (m![2] === "rem" ? 16 : 1);
}

/** `var(--x)` → `--x` (fails the test for anything else). */
function varName(value: string | null): string {
  const m = (value ?? "").match(/^var\((--[\w-]+)\)$/);
  expect(m, `expected a single var() reference, got ${value}`).not.toBeNull();
  return m![1]!;
}

/* ================================================================== *
 * /postings
 * ================================================================== */
describe("W3-B · /postings — info first, one action bar under a divider", () => {
  it("the card is ONE zero-minimum column (actions can no longer squeeze the title)", () => {
    const card = rule(".postings-page .posting-card");
    expect(decl(card, "display")).toBe("grid");
    expect(decl(card, "grid-template-columns")).toBe("minmax(0, 1fr)");
  });

  it("the action bar is start-aligned under a hairline divider", () => {
    const bar = rule(".postings-page .posting-card__actions");
    expect(decl(bar, "border-top")).toBe("var(--border-hairline) solid var(--border-subtle)");
    expect(decl(bar, "justify-items")).toBe("start");
    expect(decl(rule(".postings-page .posting-card__btns"), "justify-content")).toBe("flex-start");
  });

  it("≤600px each lifecycle button grows to fill its line (no ragged right-aligned stack)", () => {
    expect(decl(rule(".postings-page .posting-card__btns > .bb-btn", PHONE), "flex")).toBe(
      "1 1 auto",
    );
  });

  it("the row's result band adds no margin inside the card", () => {
    expect(decl(rule(".postings-page .posting-card .alert"), "margin-bottom")).toBe("0");
  });

  it("the IDLE result region takes no grid track or gap, yet is never hidden from AT", () => {
    // Measured bug this pins: the empty aria-live box was a grid item, so the text column's gap
    // hung under Details / Edit (~2x the divider-to-buttons space). The column IS a gapped grid:
    const main = rule(".posting-card__main");
    expect(decl(main, "display")).toBe("grid");
    expect(decl(main, "gap")).not.toBeNull();
    const live = rule(".postings-page .posting-card__main > [aria-live]:empty");
    // Out of flow = no track and no gap. (A negative margin would not do it: a grid track
    // cannot shrink below 0, so the gap before it stays.)
    expect(decl(live, "position")).toBe("absolute");
    // Only while EMPTY — a region holding a message is back in flow.
    expect(live.selector.endsWith(":empty")).toBe(true);
    // Never hidden: a live region must stay in the accessibility tree to announce its message.
    for (const hide of ["display", "visibility", "content-visibility", "clip-path", "opacity"]) {
      expect(decl(live, hide), hide).toBeNull();
    }
  });
});

describe("W3-B · /postings — the facts row never starts a line with a dot, never clips a letter", () => {
  const meta = () => rule(".postings-page .posting-card__meta");
  const seg = () => rule(".postings-page .posting-card__meta > span");
  const dot = () => rule(".postings-page .posting-card .posting-card__meta > span::before");

  it("the row is shifted left by ONE slot and clipped by exactly that slot", () => {
    expect(decl(meta(), "--posting-meta-sep")).toBe("var(--space-4)");
    expect(decl(meta(), "margin-inline-start")).toBe("calc(-1 * var(--posting-meta-sep))");
    expect(decl(meta(), "clip-path")).toBe("inset(0 0 0 var(--posting-meta-sep))");
    expect(decl(meta(), "gap")).toBe("var(--space-1) 0");
  });

  it("each segment's text starts AFTER its slot (a wrapped line is never under the clip)", () => {
    // Measured bug this pins: with the dot as an in-flow inline-block, the second line of a
    // wrapped location ("…Pune, / Maharashtra") started inside the clipped slot and lost its "M".
    expect(decl(seg(), "padding-inline-start")).toBe("var(--posting-meta-sep)");
    expect(decl(dot(), "inline-size")).toBe("var(--posting-meta-sep)");
    expect(decl(dot(), "margin-inline-start")).toBe("calc(-1 * var(--posting-meta-sep))");
    expect(decl(dot(), "display")).toBe("inline-block");
    expect(decl(dot(), "content")).toBe('"·"');
  });

  it("the dot rule out-ranks the base `:not(:first-child)` rule by specificity, not order", () => {
    // Base (0,2,2): `.posting-card__meta > span:not(:first-child)::before` carries margin-right.
    // Ours needs 3 classes so its margin reset can never lose to that rule wherever it sits.
    expect(dot().selector.match(/\.[\w-]+/g)).toHaveLength(3);
    expect(decl(dot(), "margin-right")).toBe("0");
  });

  it("the slot is no wider than the card's phone padding, so the row never leaves the card", () => {
    expect(varName(decl(rule(".postings-page .posting-card", PHONE), "padding"))).toBe("--space-4");
    expect(px(varName(decl(meta(), "--posting-meta-sep")))).toBeLessThanOrEqual(px("--space-4"));
  });

  it("the page links left the facts row for their own spaced row", () => {
    const links = rule(".postings-page .posting-card__links");
    expect(decl(links, "display")).toBe("flex");
    expect(decl(links, "column-gap")).toBe("var(--space-5)");
  });
});

/* ================================================================== *
 * /plans + /capacity
 * ================================================================== */
describe("W3-B · /plans — one catalogue: one track, one price size", () => {
  it("tiers, packs and posting plans share ONE track, equal to the packs grid's 240px floor", () => {
    const track = decl(
      rule(".plans-page .plans-grid, .plans-page .capacity-tiers"),
      "grid-template-columns",
    );
    expect(track).toBe("repeat(auto-fill, minmax(min(100%, var(--plans-card-min)), 1fr))");
    expect(decl(rule(".plans-page"), "--plans-card-min")).toBe(
      "calc(var(--stat-min) + var(--space-6))",
    );
    // The shared packs grid (used before this pass) floors at 240px — the alias reproduces it.
    const legacy = decl(rule(".plans-grid"), "grid-template-columns")!.match(/minmax\((\d+)px/);
    expect(legacy).not.toBeNull();
    expect(px("--stat-min") + px("--space-6")).toBe(Number(legacy![1]));
  });

  it("the tier price takes the plan-card price size on /plans", () => {
    expect(decl(rule(".plans-page .capacity-tier__price"), "font-size")).toBe(
      decl(rule(".plan-card__price"), "font-size"),
    );
  });
});

describe("W3-B · /plans — compact product cards on a phone", () => {
  const cards = ".plans-page .plan-card, .plans-page .capacity-tier";

  it("≤600px every product card is a compact grid block on one tight rhythm", () => {
    const card = rule(cards, PHONE);
    expect(decl(card, "display")).toBe("grid");
    expect(decl(card, "row-gap")).toBe("var(--space-1)");
    expect(decl(card, "padding")).toBe("var(--space-4)");
    // A credit pack / posting plan has no action, so no second (empty) track — and no gap for it.
    expect(decl(card, "grid-template-columns")).toBeNull();
    expect(decl(card, "column-gap")).toBeNull();
  });

  it("≤600px a capacity tier (the one card with an action) is a row: price+detail | action", () => {
    const tier = rule(".plans-page .capacity-tier", PHONE);
    expect(decl(tier, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(decl(tier, "grid-template-areas")?.replace(/\s+/g, " ")).toBe(
      '"head head" "price action" "detail action"',
    );
    expect(decl(tier, "column-gap")).toBe("var(--space-4)");
    expect(decl(rule(".plans-page .capacity-tier__price", PHONE), "grid-area")).toBe("price");
    expect(decl(rule(".plans-page .capacity-tier__allowance", PHONE), "grid-area")).toBe("detail");
  });

  it("the tier's action keeps its own width (not the block button's 100%) and a 2-control minimum", () => {
    const btn = rule(".plans-page .capacity-tier > .bb-btn", PHONE);
    expect(decl(btn, "grid-area")).toBe("action");
    expect(decl(btn, "width")).toBe("auto");
    expect(decl(btn, "min-inline-size")).toBe("calc(2 * var(--control-md))");
  });

  it("no rule sizes an action INSIDE a pack or plan card (each section has one door, in its head)", () => {
    const inCard = RULES.flatMap((r) => r.selector.split(",").map((x) => x.trim())).filter((x) =>
      /\.plan-card\s*>\s*\.bb-btn/.test(x),
    );
    expect(inCard).toEqual([]);
  });

  it("the price steps down to the compact KPI figure on every product card", () => {
    const price = rule(
      ".plans-page .plan-card__price, .plans-page .capacity-tier__price",
      PHONE,
    );
    expect(decl(price, "font-size")).toBe("var(--ui-kpi-sm-size)");
    expect(px("--ui-kpi-sm-size")).toBeLessThan(px("--text-2xl"));
  });
});

describe("W3-B · /plans — block rhythm", () => {
  it("the tier row and the result toasts keep a block gap above the 'Recorded only' note", () => {
    expect(
      decl(rule(".plans-page .capacity-tiers"), "margin-bottom"),
    ).toBe("var(--block-gap)");
    const result = rule(".plans-page .capacity-result");
    expect(decl(result, "margin-top")).toBe("0");
    expect(decl(result, "margin-bottom")).toBe("var(--block-gap)");
  });

  it("a section's last block adds no margin to the section gap", () => {
    expect(
      decl(
        rule(".plans-page .section > :last-child"),
        "margin-bottom",
      ),
    ).toBe("0");
  });

  it("the 'Most capacity' badge cannot make its tier's head row taller than the others", () => {
    const badge = rule(
      ".plans-page .capacity-tier__head > .bb-badge",
    );
    expect(decl(badge, "margin-block")).toBe("calc(-1 * var(--space-1))");
  });
});

describe("W3-B · /plans — the per-posting table", () => {
  // (That the whole table also fits a 768px tablet is a Chromium measurement, not a declaration.)
  it("the role column keeps a floor of 3/4 of a tile (≥ 150px)", () => {
    const floor = decl(
      rule(".plans-page .table td:first-child"),
      "min-inline-size",
    );
    expect(floor).toBe("calc(var(--stat-min) * 3 / 4)");
    expect((px("--stat-min") * 3) / 4).toBeGreaterThanOrEqual(150);
  });
});

/* ================================================================== *
 * /account, /team, /team/accept
 * ================================================================== */
describe("W3-B · /account — the KYC action drops under its text on a phone", () => {
  it("≤600px the KYC/bank alert text takes the full row beside the icon (as /dashboard does)", () => {
    const text = rule(".account-page .section .alert__text", PHONE);
    expect(decl(text, "flex-basis")).toBe("calc(100% - var(--text-lg) - var(--space-3))");
    // …which is exactly the dashboard's attention-band recipe (one idea, not two).
    const dash = RULES.find(
      (r) => r.selector === ".attention__text" && r.at.includes("max-width: 375px"),
    );
    expect(dash).toBeDefined();
    expect(decl(text, "flex-basis")).toBe(decl(dash!, "flex-basis"));
    // The shared ≤600px rule is what wraps the band and aligns the action under the text.
    expect(decl(rule(".alert", PHONE), "flex-wrap")).toBe("wrap");
  });
});

describe("W3-B · /team + /team/accept — result bands", () => {
  it("the result band sits a block below its action, at the reading measure", () => {
    const status = rule(".team-page .form-status, .team-accept-page .form-status");
    expect(decl(status, "margin-top")).toBe("var(--block-gap)");
    expect(decl(status, "max-width")).toBe("var(--reading-max)");
    expect(
      decl(
        rule(".team-page .form-status .alert, .team-accept-page .form-status .alert"),
        "margin-bottom",
      ),
    ).toBe("0");
  });

  it("the accepted band keeps its next step at the reading measure", () => {
    expect(decl(rule(".team-accept-page .alert"), "max-width")).toBe("var(--reading-max)");
  });

  it("≤600px the accept action is a full-width thumb target", () => {
    expect(decl(rule(".team-accept-page .form-actions > .bb-btn", PHONE), "flex")).toBe("1 1 auto");
  });
});

/* ================================================================== *
 * Touch + scoping: the W3-B screens and the agency's Postings list
 * ================================================================== */
describe("W3-B · touch — every control ≥44px on phones and coarse pointers", () => {
  const WRAPPERS = [
    "postings-page",
    "plans-page",
    "account-page",
    "team-page",
    "team-accept-page",
    // The agency's Postings list carries the same row controls as /postings (2026-10-01).
    "agency-postings-page",
  ];

  it("a coarse pointer above 600px lifts the DS small button on every W3-B screen + agency list", () => {
    const lift = rule(WRAPPERS.map((w) => `.${w} .bb-btn--sm`).join(", "), TABLET_TOUCH);
    expect(lift.at).toBe(`@media ${TABLET_TOUCH}`);
    expect(decl(lift, "min-height")).toBe("var(--control-md)");
  });

  it("BOTH posting lists' titles head their card with a drawn 44px line on touch", () => {
    // Scoped to the CONTROL, not a page: the company row title and the agency row title are the
    // same target wherever the row renders.
    const title = rule(".posting-card__title, .agency-job__title", TOUCH);
    expect(decl(title, "min-height")).toBe("var(--control-md)");
    expect(decl(title, "display")).toBe("inline-flex");
    expect(px("--control-md")).toBeGreaterThanOrEqual(44);
  });

  /* Text links in a dense row: a posting row's Applicants / Edit, the per-posting table's role
     link, and the quota tile's "Add applicant slots" caption link (15–18px tall on touch before,
     and made SMALLER by the compact phone tile row). */
  const TEXT_LINKS = [".postings-link", ".plans-page .capacity-link", ".plans-page .bb-stat__caption a"];
  const host = () => rule(TEXT_LINKS.join(", "), TOUCH);
  const strip = () => rule(TEXT_LINKS.map((s) => `${s}::before`).join(", "), TOUCH);

  it("every text link gets a 44px hit strip centred on it — the DS small-button recipe", () => {
    expect(decl(host(), "display")).toBe("inline-block");
    expect(decl(host(), "position")).toBe("relative");
    expect(decl(host(), "isolation")).toBe("isolate");
    const s = strip();
    expect(decl(s, "content")).toBe('""');
    expect(decl(s, "position")).toBe("absolute");
    expect(decl(s, "inset-block")).toBe("calc((100% - var(--control-md)) / 2)");
    // Negative only on a link narrower than 44px ("Edit"); never shrinks a wider one.
    expect(decl(s, "inset-inline")).toBe("min(0%, calc((100% - var(--control-md)) / 2))");
    // One idea, not two: the same block reach and layer as the DS small button's strip.
    const ds = DS_RULES.find(
      (r) =>
        r.selector
          .split(",")
          .map((part) => part.trim())
          .includes(".bb-btn--sm::before") && r.at.includes(PHONE),
    );
    expect(ds, "the DS small-button strip must exist").toBeDefined();
    expect(decl(s, "inset-block")).toBe(decl(ds!, "inset-block"));
    expect(decl(s, "z-index")).toBe(decl(ds!, "z-index"));
  });

  it("the link box itself is untouched, so no row grows and the focus ring stays on the text", () => {
    // Measured bug this pins: padding-block + a negative margin-block put the table role link's
    // box — and so its 4px focus ring — on the cell's edges: under the sticky header on the first
    // row, clipped by the scroller on the last. NO rule anywhere may pad or size these links (their
    // pseudo-element strips excepted).
    const BOX = /^(padding|margin|min-height|min-block-size|height|block-size|box-sizing)/;
    const LINK = [".postings-link", ".capacity-link", ".bb-stat__caption a"];
    const linkRules = RULES.filter((r) =>
      r.selector.split(",").some((part) => {
        const p = part.trim();
        return !p.includes("::") && LINK.some((l) => p.endsWith(l) || p.includes(`${l}:`));
      }),
    );
    // Not vacuous: the base .postings-link / .capacity-link rules and this block's host rule.
    expect(linkRules.length).toBeGreaterThanOrEqual(3);
    const sizing = linkRules.flatMap((r) =>
      declarations(r)
        .filter(([prop]) => BOX.test(prop))
        .map(([prop]) => `${r.selector} { ${prop} }`),
    );
    expect(sizing).toEqual([]);
  });

  it("the role link's focus ring fits inside its cell's block padding (row 1 and the last row)", () => {
    const cellPad = px(varName(decl(rule(".table th, .table td"), "padding")!.split(/\s+/)[0]!));
    // --ring-focus is `0 0 0 2px <surface>, 0 0 0 4px <ring>`: its outer band is the reach.
    const spreads = [...resolve("--ring-focus").matchAll(/0 0 0 ([\d.]+)px/g)].map((m) =>
      Number(m[1]),
    );
    expect(spreads.length).toBeGreaterThan(0);
    // With the link box = its text, the ring ends inside the cell: below a sticky header cell on
    // the first row, and above the scroller's clip edge on the last.
    expect(Math.max(...spreads)).toBeLessThan(cellPad);
  });
});

describe("W3-B · the newly focusable scrollers (/plans, /team) draw ONE ring", () => {
  it("inside a panel the scroller cancels the base ring + radius; the panel draws the ring", () => {
    // The tokens.css base gives EVERY focused element the ring and a radius…
    const base = parseRules(TOKENS).find((r) => r.selector === ":focus-visible" && r.at === "");
    expect(base).toBeDefined();
    expect(decl(base!, "box-shadow")).toBe("var(--ring-focus)");
    expect(decl(base!, "border-radius")).not.toBeNull();
    // …so a scroller inside a panel drew a second navy stroke under the panel head and clipped
    // the sticky header's top corners. It now draws neither; the panel's ring is the one ring.
    const inPanel = rule(".panel:has(.tablewrap:focus-visible) .tablewrap:focus-visible");
    expect(decl(inPanel, "box-shadow")).toBe("none");
    expect(decl(inPanel, "border-radius")).toBe("0");
    expect(decl(inPanel, "outline-color")).toBe("transparent");
    expect(decl(rule(".panel:has(.tablewrap:focus-visible)"), "box-shadow")).toBe(
      "var(--ring-focus)",
    );
  });
});

describe("W3-B · scoping + tokens — the block restyles nothing outside its screens", () => {
  it("the block is non-trivial (the fence below is not vacuous)", () => {
    expect(BLOCK_RULES.length).toBeGreaterThan(30);
  });

  /** The posting-row CONTROLS the two lists share — the only unscoped selectors allowed here. */
  const ROW_CONTROLS = [
    ".posting-card__title",
    ".agency-job__title",
    ".postings-link",
    ".postings-link::before",
  ];

  it("every selector starts with a page wrapper, or is one of the shared posting-row controls", () => {
    const scoped = /^\.(postings|plans|account|team|team-accept|agency-postings)-page(\s|$)/;
    const offenders = BLOCK_RULES.flatMap((r) =>
      r.selector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => !scoped.test(s) && !ROW_CONTROLS.includes(s)),
    );
    expect(offenders).toEqual([]);
  });

  it("the unscoped row controls appear ONLY in the touch rules (they size a target, nothing else)", () => {
    const unscoped = BLOCK_RULES.filter((r) =>
      r.selector.split(",").some((s) => ROW_CONTROLS.includes(s.trim())),
    );
    expect(unscoped.length).toBe(3);
    for (const r of unscoped) expect(r.at, r.selector).toBe(`@media ${TOUCH}`);
  });

  it("the block is tokens-only: no hex, colour function, or raw length (signed or not)", () => {
    const bodies = BLOCK_RULES.map((r) => r.body).join("\n");
    expect(bodies).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bodies).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/);
    expect(bodies).not.toMatch(RAW_LENGTH);
  });

  it("the raw-length pattern catches signed and non-px units, and permits token arithmetic", () => {
    // This block's geometry is built on negative offsets: `-4px` is as raw as `4px`.
    for (const bad of [
      "margin-top: -4px;",
      "margin-top: 4px;",
      "max-width: 40ch;",
      "width: 50vw;",
      "max-block-size: 10dvh;",
      "gap: 0.5rem;",
      "top: -.5em;",
      "inset: calc(100% - 2px);",
    ]) {
      expect(bad, bad).toMatch(RAW_LENGTH);
    }
    for (const ok of [
      "margin-block: calc(-1 * var(--space-3));",
      "font-size: var(--text-2xl);",
      "grid-template-columns: minmax(0, 1fr) auto;",
      "grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--plans-card-min)), 1fr));",
      "inset-inline: min(0%, calc((100% - var(--control-md)) / 2));",
      "min-inline-size: calc(var(--stat-min) * 3 / 4);",
      "flex: 1 1 auto;",
    ]) {
      expect(ok, ok).not.toMatch(RAW_LENGTH);
    }
  });

  it("every colour-bearing value in the block is a token (a named colour cannot slip through)", () => {
    const coloured = BLOCK_RULES.flatMap((r) =>
      declarations(r)
        .filter(([prop]) => carriesColour(prop))
        .map(([prop, value]) => ({ where: `${r.selector} { ${prop} }`, value })),
    );
    // Not vacuous: the action bar's hairline divider is a colour-bearing declaration, and the
    // block's own custom properties (the facts-row slot, the card floor) are scanned too.
    expect(coloured.length).toBeGreaterThan(0);
    expect(coloured.some((c) => c.where.includes("{ --posting-meta-sep }"))).toBe(true);
    expect(coloured.some((c) => c.where.includes("{ --plans-card-min }"))).toBe(true);
    const offenders = coloured.filter((c) => nonTokenWords(c.value).length > 0);
    expect(offenders).toEqual([]);
  });

  it("the colour check permits the token forms and rejects a named colour or a var() fallback", () => {
    expect(nonTokenWords("var(--border-hairline) solid var(--border-subtle)")).toEqual([]);
    expect(nonTokenWords("none")).toEqual([]);
    expect(nonTokenWords("red")).toEqual(["red"]);
    expect(nonTokenWords("var(--border-hairline) solid white")).toEqual(["white"]);
    expect(nonTokenWords("0 0 0 2px Navy")).toEqual(["navy"]);
    // A fallback literal hides a raw colour behind a token — it is not a token.
    expect(nonTokenWords("var(--brand, gold)")).toContain("gold");
  });

  it("the colour check covers custom properties and the -webkit- text paint (the #1863 gap)", () => {
    // A named colour in a custom property or in `-webkit-text-fill-color` passed the fence.
    for (const prop of ["--posting-meta-sep", "--anything", "-webkit-text-fill-color"]) {
      expect(carriesColour(prop), prop).toBe(true);
    }
    for (const prop of ["-webkit-text-stroke-color", "scrollbar-color", "text-emphasis-color"]) {
      expect(carriesColour(prop), prop).toBe(true);
    }
    // …while the block's real token arithmetic still passes.
    expect(nonTokenWords("calc(var(--stat-min) + var(--space-6))")).toEqual([]);
    expect(nonTokenWords("var(--space-4)")).toEqual([]);
    expect(nonTokenWords("white")).toEqual(["white"]);
    // Geometry is not colour: the length fence owns those properties.
    for (const prop of ["margin-top", "flex", "grid-template-columns"]) {
      expect(carriesColour(prop), prop).toBe(false);
    }
  });

  it("the shared primitives these screens compose are untouched at the top level", () => {
    expect(decl(rule(".posting-card"), "display")).toBe("flex");
    expect(decl(rule(".stat-row"), "display")).toBe("grid");
    expect(decl(rule(".state"), "max-width")).toBe("46ch");
    expect(decl(rule(".form-status"), "margin-top")).toBeNull();
  });
});

/* ================================================================== *
 * Final sweep D — the company screens' own layout fixes (outside the W3-B block where noted)
 * ================================================================== */
describe("Post with AI — every resume row has ONE layout (F18)", () => {
  // A flex row with wrap put one Continue under its meta and the next one beside it.
  it("the meta takes the row and the Continue its own end column — on every row alike", () => {
    const r = rule(".ai-chat-resume__item");
    expect(decl(r, "display")).toBe("grid");
    expect(decl(r, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(decl(r, "flex-wrap")).toBeNull();
  });

  it("a phone stacks every row the same way: the button under its meta", () => {
    const r = rule(".ai-chat-resume__item", PHONE);
    expect(decl(r, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(decl(r, "justify-items")).toBe("start");
  });
});

describe("W3-B · /team — on a phone each member is a card, its Remove on screen (F38)", () => {
  // At 375px the Manage column sat at x≈471 inside a sideways-scrolling table: the destructive
  // row action was off screen until the table was scrolled.
  const flat = (v: string | null) => (v ?? "").replace(/\s+/g, " ").trim();

  it("the table and its body leave table layout; each row is a two-line card grid", () => {
    expect(decl(rule(".team-page .table, .team-page .table tbody", PHONE), "display")).toBe(
      "block",
    );
    const row = rule(".team-page .table tr", PHONE);
    expect(decl(row, "display")).toBe("grid");
    expect(flat(decl(row, "grid-template-areas"))).toBe(
      '"member member manage" "role status manage"',
    );
    // Each row is its own grid: the flexible middle track keeps every Remove at its card's end.
    expect(decl(row, "grid-template-columns")).toBe("auto minmax(0, 1fr) auto");
  });

  it("each cell takes its area; the Manage cell spans the card's end, beside both lines", () => {
    expect(decl(rule(".team-page .table td:nth-child(1)", PHONE), "grid-area")).toBe("member");
    expect(decl(rule(".team-page .table td:nth-child(2)", PHONE), "grid-area")).toBe("role");
    expect(decl(rule(".team-page .table td:nth-child(3)", PHONE), "grid-area")).toBe("status");
    expect(decl(rule(".team-page .table td.rowactions", PHONE), "grid-area")).toBe("manage");
  });

  it("Remove is always drawn on a phone card (never hover-to-reveal)", () => {
    expect(decl(rule(".team-page .table .rowactions > *", PHONE), "opacity")).toBe("1");
  });

  it("the column heads leave the layout but stay for assistive tech (never display: none)", () => {
    const head = rule(".team-page .table thead", PHONE);
    expect(decl(head, "position")).toBe("absolute");
    expect(decl(head, "clip-path")).toBe("inset(50%)");
    expect(decl(head, "display")).toBeNull();
  });

  it("wider than a phone, the members table is the ordinary table (no rule outside the phone query)", () => {
    expect(RULES.filter((r) => r.selector.startsWith(".team-page .table") && r.at === "")).toEqual(
      [],
    );
  });
});
