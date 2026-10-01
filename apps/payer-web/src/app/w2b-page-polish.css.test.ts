import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * W2-B — /postings/[id]/applicants, /agency/referrals, /agency/workers LAYOUT FENCE.
 *
 * Node env, no layout engine (the approach of screen-polish-layout.css.test.ts): what each fix
 * depends on is DECLARED geometry, so this suite pins it —
 *   · the applicant list/card are zero-minimum tracks (at 375px the page body rendered 585px
 *     wide and scrolled sideways before this pass — measured in Chromium);
 *   · the card's focal spend band bleeds by exactly the card inset, and its text clears AA
 *     (ARITHMETIC over the real token values: the muted step does not, which is WHY the band
 *     overrides it);
 *   · every control on the applicants screen is a ≥44px target on touch / phones;
 *   · the agency pages' framing is SCOPED to their page wrappers, so the shared invite panels
 *     keep their look on /dashboard and no shared primitive is restyled globally.
 * The layouts were measured in a real browser at 320/375/768/1280px when built.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = stripComments(readFileSync(join(here, "globals.css"), "utf8"));
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

const PHONE = "max-width: 600px";
const COARSE = "pointer: coarse";

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

function px(name: string): number {
  const v = resolve(name);
  expect(v, `${name} was expected to resolve to px`).toMatch(/^[\d.]+px$/);
  return Number(v.replace("px", ""));
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

/* ================================================================== *
 * /postings/[id]/applicants
 * ================================================================== */
describe("W2-B · applicants — the card can never widen the page", () => {
  it("the list and the card are single ZERO-minimum tracks", () => {
    expect(decl(rule(".applicants-list"), "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(decl(rule(".applicant"), "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(decl(rule(".applicant"), "min-width")).toBe("0");
  });

  it("the identity column shrinks; the relevance column is capped at half the head", () => {
    const head = rule(".applicant__head");
    expect(decl(head, "display")).toBe("grid");
    // `fit-content(50%)`, not `auto`: a long E18 label wraps inside half the head instead of
    // taking nearly the whole row from the trade/bands column (measured at 601–767px).
    expect(decl(head, "grid-template-columns")).toBe("auto minmax(0, 1fr) fit-content(50%)");
    expect(decl(rule(".applicant__head", PHONE), "grid-template-columns")).toBe(
      "auto minmax(0, 1fr)",
    );
    expect(decl(rule(".applicant__relevance"), "flex-wrap")).toBe("wrap");
  });

  it("W3-A ≤600px: the relevance cluster takes the WHOLE card width, not the text column", () => {
    // In column 2 beside the 44px avatar it stacked rank / tier / tenure onto three lines at
    // 320px (measured: 3 → 2 lines at 320, 2 → 1 at 360–375). The full row is the left edge the
    // tag list below already starts on; its start alignment stays.
    const rel = rule(".applicant__relevance", PHONE);
    expect(decl(rel, "grid-column")).toBe("1 / -1");
    expect(decl(rel, "justify-content")).toBe("flex-start");
  });

  it("E18: a long related-skill badge (or skill tag) wraps in full — never clipped or widening", () => {
    const badge = rule(".applicant__relevance .bb-badge, .applicant__signals .bb-badge");
    expect(decl(badge, "white-space")).toBe("normal");
    expect(decl(badge, "overflow")).toBeNull();
    expect(decl(badge, "text-overflow")).toBeNull();
    expect(decl(rule(".applicant__trade"), "overflow-wrap")).toBe("anywhere");
  });
});

describe("W2-B · applicants — ONE focal spend band per card", () => {
  it("the band bleeds by exactly the card inset (and a phone inset moves both together)", () => {
    const card = rule(".applicant");
    expect(decl(card, "--applicant-pad")).toBe("var(--space-5)");
    expect(decl(card, "padding")).toBe("var(--applicant-pad)");
    const band = rule(".applicant__contact");
    expect(decl(band, "margin")).toBe(
      "0 calc(-1 * var(--applicant-pad)) calc(-1 * var(--applicant-pad))",
    );
    expect(decl(band, "padding")).toBe("var(--space-4) var(--applicant-pad) var(--applicant-pad)");
    expect(decl(rule(".applicant", PHONE), "--applicant-pad")).toBe("var(--space-4)");
    expect(decl(rule(".applicant", PHONE), "padding")).toBeNull();
  });

  it("the band is a flip-safe token surface, distinct from the Ivory page", () => {
    // The fill is the card-scoped alias, which names the Shift Blue tint step.
    expect(decl(rule(".applicant__contact"), "background")).toBe("var(--applicant-band)");
    expect(decl(rule(".applicant"), "--applicant-band")).toBe("var(--info-tint)");
    expect(resolve("--info-tint")).not.toBe(resolve("--surface-page"));
    expect(TOKENS, "--info-tint must flip under the ink theme").toMatch(
      /\[data-theme="ink"\][\s\S]*--info-tint:/,
    );
  });

  it("MEASURED: muted text fails AA on the band, so every muted line in it takes the secondary step", () => {
    const alias = decl(rule(".applicant"), "--applicant-band")!.match(/^var\((--[\w-]+)\)$/);
    expect(alias, "--applicant-band must be a single token reference").not.toBeNull();
    const band = resolve(alias![1]!);
    expect(contrast(resolve("--text-muted"), band)).toBeLessThan(4.5);
    expect(contrast(resolve("--text-secondary"), band)).toBeGreaterThanOrEqual(4.5);
    const override = rule(
      ".applicant__contact .applicant__hint, .applicant__contact .applicant__neutral, .applicant__contact .applicant__until",
    );
    expect(decl(override, "color")).toBe("var(--text-secondary)");
  });

  it("the inline error takes the light red in the ink theme (the paper red is ~3:1 on ink)", () => {
    expect(decl(rule('[data-theme="ink"] .applicant__error'), "color")).toBe("var(--red-300)");
  });

  it("≤600px the spend + reveal actions stretch to full-width thumb targets", () => {
    expect(decl(rule(".applicant__unlock, .applicant__reveal", PHONE), "justify-items")).toBe(
      "stretch",
    );
  });

  it("W3-A: the spend actions are one wrapping row (Unlock, + Top up on a zero balance)", () => {
    const row = rule(".applicant__unlock-actions");
    expect(decl(row, "display")).toBe("flex");
    expect(decl(row, "flex-wrap")).toBe("wrap");
    expect(decl(row, "gap")).toBe("var(--space-2)");
    // Phones: each action GROWS — a lone Unlock stays the full-width thumb target it was (the
    // row is stretched by the parent's `justify-items: stretch`); a pair that cannot share the
    // row stacks, each full width.
    expect(decl(rule(".applicant__unlock-actions > *", PHONE), "flex")).toBe("1 1 auto");
  });
});

describe("W2-B · applicants — touch targets and static tags", () => {
  const TABLET_TOUCH = "(pointer: coarse) and (min-width: 601px)";

  it("the DS small button's 44px strip covers ≤600px, so this page adds it only ABOVE 600px", () => {
    // The DS owns `.bb-btn--sm`'s phone hit area (a ≤600px ::before strip)…
    const dsStrip = DS_RULES.filter(
      (r) => r.at.includes("max-width: 600px") && r.selector.includes(".bb-btn--sm::before"),
    );
    expect(dsStrip).toHaveLength(1);
    // …and the page lifts the button for a coarse pointer from 601px up: the two ranges meet
    // with no gap and no overlap, and there is no page rule for it at phone widths.
    const lift = rule(".applicants-page .bb-btn--sm", TABLET_TOUCH);
    expect(lift.at).toBe(`@media ${TABLET_TOUCH}`);
    expect(decl(lift, "min-height")).toBe("var(--control-md)");
    expect(RULES.filter((r) => r.selector.includes(".applicants-page .bb-btn--sm"))).toHaveLength(
      1,
    );
    expect(px("--control-md")).toBeGreaterThanOrEqual(44);
  });

  it("the tab and the toast close (no DS hit area at any width) are ≥ 44px on phones and touch", () => {
    for (const host of ["bb-tab", "bb-toast__close"]) {
      expect(
        DS_RULES.filter((r) => r.selector.includes(`.${host}::before`)),
        `${host} has no DS hit strip, which is why this page adds one`,
      ).toEqual([]);
    }
    const tab = rule(".applicants-page .bb-tab", COARSE);
    expect(tab.at).toContain(PHONE);
    expect(decl(tab, "min-height")).toBe("var(--control-md)");
    const close = rule(".applicants-page .bb-toast__close", COARSE);
    expect(close.at).toContain(PHONE);
    expect(decl(close, "min-width")).toBe("var(--control-md)");
    expect(decl(close, "min-height")).toBe("var(--control-md)");
  });

  it("the skill/signal tags are a plain list: no chip styling survives, the list is reset", () => {
    expect(RULES.filter((r) => r.selector.includes(".applicant__signals .bb-chip"))).toEqual([]);
    const list = rule(".applicant__signals");
    expect(decl(list, "list-style")).toBe("none");
    expect(decl(list, "padding")).toBe("0");
    expect(decl(list, "margin")).toBe("0");
  });

  it("the phone toast spans the rail instead of hugging the left edge", () => {
    const toast = rule(".applicants-page .unlock-toast-region", PHONE);
    expect(decl(toast, "left")).toBe("var(--gutter)");
    expect(decl(toast, "right")).toBe("var(--gutter)");
  });
});

/* ================================================================== *
 * /agency/referrals + /agency/workers
 * ================================================================== */
describe("W2-B · agency referrals — forms in panels, one heading size", () => {
  it("the invite tools are framed with exactly the panel's surface tokens", () => {
    const framed = rule(".agency-referrals-page .agency-section");
    const panel = rule(".panel");
    for (const prop of ["background", "border", "border-radius", "box-shadow"]) {
      expect(decl(framed, prop), prop).toBe(decl(panel, prop));
    }
    expect(decl(framed, "padding")).toBe(decl(rule(".panel__body"), "padding"));
  });

  it("every block heading on the page shares the panel-title role", () => {
    const title = rule(".agency-referrals-page .agency-section__title");
    expect(decl(title, "font-size")).toBe(decl(rule(".panel__title"), "font-size"));
    expect(decl(title, "font-size")).toBe(decl(rule(".section__title"), "font-size"));
  });

  it("the consent note inside a framed panel is an inset callout, not a second bordered box", () => {
    const note = rule(".agency-referrals-page .agency-invite__note");
    expect(decl(note, "background")).toBe("var(--surface-sunken)");
    expect(decl(note, "border-color")).toBe("transparent");
  });
});

describe("W2-B/W3-A · agency referrals — the Payouts head keeps its action on the title row", () => {
  const HEAD = ".panel__head.agency-referrals-payout__head";

  it("above 600px it is the SHARED head: the modifier has no rule outside the phone step", () => {
    // W3-A: the shared `.panel__text` pattern keeps the button on the title row at every width,
    // so the modifier's old all-widths grid is gone; only its phone re-lay remains.
    const own = RULES.filter((r) => r.selector.includes("agency-referrals-payout__head"));
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.at, r.selector).toBe(`@media (${PHONE})`);
  });

  it("≤600px: title + button share row 1, the description spans row 2 (not a 110px column)", () => {
    const head = rule(HEAD, PHONE);
    expect(decl(head, "display")).toBe("grid");
    expect(decl(head, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(decl(head, "grid-template-areas")).toMatch(/^"title actions"\s+"sub sub"$/);
    // The row gap is the wrapper's own rhythm; the shared head's 16px gap stays the column gap.
    expect(decl(head, "row-gap")).toBe("var(--space-1)");
    // The wrapper steps aside so its two children become the head's grid items.
    const scoped = (sel: string) => rule(`.agency-referrals-payout__head ${sel}`, PHONE);
    expect(decl(scoped("> .panel__text"), "display")).toBe("contents");
    expect(decl(scoped(".panel__title"), "grid-area")).toBe("title");
    expect(decl(scoped(".panel__sub"), "grid-area")).toBe("sub");
    expect(decl(scoped("> .panel__actions"), "grid-area")).toBe("actions");
  });

  it("ORDER: the modifier out-ranks the later shared `.panel__head` by specificity, not position", () => {
    // Two classes (0,2,0) vs one (0,1,0): it wins wherever it sits. A single-class selector here
    // would silently lose to the shared flex rule, which comes later in the file.
    const at = (sel: string, ctx: string) =>
      RULES.findIndex((r) => r.selector === sel && inContext(r, ctx));
    expect(at(".panel__head", "")).toBeGreaterThan(at(HEAD, PHONE));
    expect(RULES.some((r) => r.selector === ".agency-referrals-payout__head")).toBe(false);
  });
});

describe("W2-B · scoping — no shared primitive was restyled globally", () => {
  it("the shared agency section (also on /dashboard) is still unframed", () => {
    const bare = rule(".agency-section");
    expect(decl(bare, "background")).toBeNull();
    expect(decl(bare, "border")).toBeNull();
    expect(decl(bare, "padding")).toBeNull();
  });

  it("every globals rule that sizes a DS small button / tab / toast close is page-scoped", () => {
    // The page wrappers allowed to size a shared control ON THEIR OWN SCREEN: W2-B's, and the
    // W3-B screens' coarse-pointer lift — with the agency's Postings list, whose rows share the
    // company list's controls (see w3b-page-polish.css.test.ts).
    const PAGE_SCOPE =
      /^\.(applicants-page|login-roletabs|applicants-pipeline|postings-page|agency-postings-page|plans-page|account-page|team-page|team-accept-page)\s/;
    const offenders = RULES.filter((r) =>
      r.selector.split(",").some((part) => {
        const p = part.trim();
        const touchesShared = /\.bb-btn--sm|\.bb-toast__close|\.bb-tab(?![\w-])/.test(p);
        return touchesShared && !PAGE_SCOPE.test(p);
      }),
    ).map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("the workers empty state widens only on its own page", () => {
    expect(decl(rule(".agency-workers-page .state"), "max-width")).toBe("var(--reading-max)");
    expect(decl(rule(".state"), "max-width")).toBe("46ch");
  });

  it("W3-A: a PROSE state reads start-aligned; the base state stays centred", () => {
    const prose = rule(".state--prose");
    expect(decl(prose, "text-align")).toBe("start");
    expect(decl(prose, "justify-items")).toBe("start");
    expect(decl(rule(".state--prose .state__actions"), "justify-content")).toBe("flex-start");
    // Alignment only: the block keeps its place and measure.
    for (const p of ["max-width", "margin", "margin-inline", "padding", "width"]) {
      expect(decl(prose, p), p).toBeNull();
    }
    expect(decl(rule(".state"), "text-align")).toBe("center");
    expect(decl(rule(".state"), "justify-items")).toBe("center");
  });
});
