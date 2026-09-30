import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * W3-B — /postings, /plans, /capacity, /account, /team, /team/accept LAYOUT FENCE.
 *
 * Node env, no layout engine (the approach of w2b-page-polish.css.test.ts): what each fix
 * depends on is DECLARED geometry plus token arithmetic, so this suite pins it —
 *   · /postings: the card's action bar sits under the text; the facts row's separator slot is
 *     clipped at a line start but a wrapped segment's text never is; the page links are ≥44px
 *     on touch;
 *   · /plans + /capacity: one catalogue track + price size on /plans, the phone price rows,
 *     block spacing around the tier row, the table's role-column floor and link hit box;
 *   · /account, /team, /team/accept: the phone KYC alert, the result-band spacing/measure;
 *   · every rule of the block is SCOPED to one of the six page wrappers and is tokens-only.
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

describe("W3-B · /plans + /capacity — phone price rows", () => {
  const cards = ".plans-page .plan-card, .plans-page .capacity-tier, .capacity-page .capacity-tier";

  it("≤600px each product card is a two-track row: name across, price+detail | action", () => {
    const card = rule(cards, PHONE);
    expect(decl(card, "display")).toBe("grid");
    expect(decl(card, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(decl(card, "grid-template-areas")?.replace(/\s+/g, " ")).toBe(
      '"head head" "price action" "detail action"',
    );
  });

  it("the action keeps its own width (not the block button's 100%) and a 2-control minimum", () => {
    const btn = rule(
      ".plans-page .plan-card > .bb-btn, .plans-page .capacity-tier > .bb-btn, .capacity-page .capacity-tier > .bb-btn",
      PHONE,
    );
    expect(decl(btn, "grid-area")).toBe("action");
    expect(decl(btn, "width")).toBe("auto");
    expect(decl(btn, "min-inline-size")).toBe("calc(2 * var(--control-md))");
  });

  it("the price steps down to the compact KPI figure so ₹ amounts fit beside the action", () => {
    const price = rule(
      ".plans-page .plan-card__price, .plans-page .capacity-tier__price, .capacity-page .capacity-tier__price",
      PHONE,
    );
    expect(decl(price, "font-size")).toBe("var(--ui-kpi-sm-size)");
    expect(px("--ui-kpi-sm-size")).toBeLessThan(px("--text-2xl"));
  });
});

describe("W3-B · /plans + /capacity — block rhythm", () => {
  it("the tier row and the result toasts keep a block gap above the 'Recorded only' note", () => {
    expect(
      decl(rule(".plans-page .capacity-tiers, .capacity-page .capacity-tiers"), "margin-bottom"),
    ).toBe("var(--block-gap)");
    const result = rule(".plans-page .capacity-result, .capacity-page .capacity-result");
    expect(decl(result, "margin-top")).toBe("0");
    expect(decl(result, "margin-bottom")).toBe("var(--block-gap)");
  });

  it("a section's last block adds no margin to the section gap", () => {
    expect(
      decl(
        rule(".plans-page .section > :last-child, .capacity-page .section > :last-child"),
        "margin-bottom",
      ),
    ).toBe("0");
  });

  it("the 'Most capacity' badge cannot make its tier's head row taller than the others", () => {
    const badge = rule(
      ".plans-page .capacity-tier__head > .bb-badge, .capacity-page .capacity-tier__head > .bb-badge",
    );
    expect(decl(badge, "margin-block")).toBe("calc(-1 * var(--space-1))");
  });
});

describe("W3-B · /plans + /capacity — the per-posting table", () => {
  it("the role column keeps a floor of 3/4 of a tile (≥ 150px, and the table fits 768px)", () => {
    const floor = decl(
      rule(".plans-page .table td:first-child, .capacity-page .table td:first-child"),
      "min-inline-size",
    );
    expect(floor).toBe("calc(var(--stat-min) * 3 / 4)");
    expect((px("--stat-min") * 3) / 4).toBeGreaterThanOrEqual(150);
  });

  it("on touch the role link's hit box is ≥44px and adds nothing to the row height", () => {
    const link = rule(".plans-page .capacity-link, .capacity-page .capacity-link", TOUCH);
    expect(decl(link, "display")).toBe("inline-block");
    expect(decl(link, "padding-block")).toBe("var(--space-3)");
    expect(decl(link, "margin-block")).toBe("calc(-1 * var(--space-3))");
    expect(decl(link, "box-sizing")).toBe("border-box");
    expect(decl(link, "min-block-size")).toBe("var(--control-md)");
    expect(px("--control-md")).toBeGreaterThanOrEqual(44);
    // The floor is load-bearing: one table line + the padding alone falls short of 44px.
    const line = px("--ui-td-size") * Number(resolve("--ui-td-leading"));
    expect(line + 2 * px("--space-3")).toBeLessThan(44);
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
 * Touch + scoping, all six screens
 * ================================================================== */
describe("W3-B · touch — every control ≥44px on phones and coarse pointers", () => {
  const WRAPPERS = [
    "postings-page",
    "plans-page",
    "capacity-page",
    "account-page",
    "team-page",
    "team-accept-page",
  ];

  it("a coarse pointer above 600px lifts the DS small button on every W3-B screen", () => {
    const lift = rule(WRAPPERS.map((w) => `.${w} .bb-btn--sm`).join(", "), TABLET_TOUCH);
    expect(lift.at).toBe(`@media ${TABLET_TOUCH}`);
    expect(decl(lift, "min-height")).toBe("var(--control-md)");
  });

  it("the posting title and the Details / Edit links are ≥44px targets on touch", () => {
    const both = rule(".postings-page .posting-card__title, .postings-page .postings-link", TOUCH);
    expect(decl(both, "min-height")).toBe("var(--control-md)");
    expect(decl(both, "display")).toBe("inline-flex");
    // "Edit" is 26px of text: the link also takes the 44px width floor.
    expect(decl(rule(".postings-page .postings-link", TOUCH), "min-inline-size")).toBe(
      "var(--control-md)",
    );
  });
});

describe("W3-B · scoping + tokens — the block restyles nothing outside its six screens", () => {
  it("the block is non-trivial (the fence below is not vacuous)", () => {
    expect(BLOCK_RULES.length).toBeGreaterThan(30);
  });

  it("every selector in the block starts with one of the six page wrappers", () => {
    const scoped = /^\.(postings|plans|capacity|account|team|team-accept)-page(\s|$)/;
    const offenders = BLOCK_RULES.flatMap((r) =>
      r.selector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => !scoped.test(s)),
    );
    expect(offenders).toEqual([]);
  });

  it("the block is tokens-only: no hex, rgb()/hsl(), or raw px/rem/em lengths", () => {
    const bodies = BLOCK_RULES.map((r) => r.body).join("\n");
    expect(bodies).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bodies).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(bodies).not.toMatch(/(^|[^\w-])\d*\.?\d+(px|rem|em)\b/);
  });

  it("the shared primitives these screens compose are untouched at the top level", () => {
    expect(decl(rule(".posting-card"), "display")).toBe("flex");
    expect(decl(rule(".stat-row"), "display")).toBe("grid");
    expect(decl(rule(".state"), "max-width")).toBe("46ch");
    expect(decl(rule(".form-status"), "margin-top")).toBeNull();
  });
});
