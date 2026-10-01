import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PostingActions,
  PostingFacts,
  PostingPreviewRail,
  zeroReachLabel,
} from "./posting-preview-rail";
import { railScrollState } from "../lib/rail-scroll";
import { focusControl, revealWholeControl } from "../lib/form-focus";
import type { CardFields } from "../lib/job-card-view";
import { agencyPostingFacts, companyPostingFacts } from "../lib/posting-facts";
import { countClippedChips, clippedChipsLabel } from "../lib/job-card-fold";

/**
 * The preview rail every posting form shares: the card + "Also in your posting" + the actions
 * (desktop rail), and the dock that summarises the SAME card on a phone (the sheet opens on tap —
 * not rendered until then). Rendered to static markup (node env); the browser behaviour (sticky,
 * the sheet's focus trap, the fold count) is measured in Chromium — see the PR.
 */

const CARD: CardFields = {
  role_title: "CNC Turner",
  role_kind: "cnc_turner",
  city: "Pune",
  area: "Chakan MIDC",
  pay_min: 18000,
  pay_max: 26000,
  pay_type: "in_hand",
  min_experience_years: 2,
  max_experience_years: 5,
  shift: "day",
  needed_by: "soon",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

const rail = (
  fields: CardFields,
  draft = {},
  status: ReactNode = null,
  outcome: ReactNode = null,
) =>
  renderToStaticMarkup(
    <PostingPreviewRail
      fields={fields}
      draft={draft}
      facts={[{ label: "Role", value: "CNC Turner" }]}
      actions={
        <PostingActions status={status} outcome={outcome}>
          {<button type="submit">Publish posting</button>}
        </PostingActions>
      }
      primary={
        <button type="submit" id="the-primary">
          Publish posting
        </button>
      }
      status={status}
      outcome={outcome}
    />,
  );

describe("PostingPreviewRail", () => {
  it("draws the rail (card + facts + pinned actions) and the phone dock; the sheet only on demand", () => {
    const out = rail(CARD);
    expect(out).toContain(
      '<aside class="posting-preview posting-preview--rail" aria-label="Live card preview">',
    );
    expect(out).toContain('class="posting-preview__scroll"');
    expect(out).toContain('class="posting-preview__foot"');
    expect(out).toContain('class="posting-dock"');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).not.toContain('role="dialog"'); // closed until the dock is tapped
    // ONE card (the rail's) until the sheet opens.
    expect(out.match(/class="jcp"/g)).toHaveLength(1);
  });

  it("the dock carries the primary button itself, and the status ABOVE its row (phones)", () => {
    const out = rail(
      CARD,
      {},
      <p className="posting-actions__msg">Pick the pay type.</p>,
      <p className="posting-actions__msg">Could not publish.</p>,
    );
    const dock = out.slice(out.indexOf('<div class="posting-dock">'));
    expect(dock).toContain(
      '<div class="posting-dock__primary"><button type="submit" id="the-primary">',
    );
    // status, then the outcome, then the row: both sit right above the button the payer pressed.
    expect(dock.indexOf("posting-dock__status")).toBeLessThan(dock.indexOf("posting-dock__live"));
    expect(dock.indexOf("posting-dock__live")).toBeLessThan(dock.indexOf("posting-dock__row"));
    // The field-owned reason is NOT live (focus moves to its field, which reads it); the outcome
    // no field owns is.
    expect(dock).toContain(
      '<div class="posting-dock__status"><p class="posting-actions__msg">Pick the pay type.</p></div>',
    );
    expect(dock).toContain(
      '<div class="posting-dock__live" aria-live="polite"><p class="posting-actions__msg">Could not publish.</p></div>',
    );
  });

  it("while a publish/save is in flight the dock's preview waits (the answer must land live)", () => {
    const idle = rail(CARD);
    expect(idle).toMatch(/<button type="button" class="posting-dock__summary" aria-haspopup="dialog">/);
    const busy = renderToStaticMarkup(
      <PostingPreviewRail
        fields={CARD}
        facts={[]}
        actions={<PostingActions>{<button type="submit">Publish posting</button>}</PostingActions>}
        primary={<button type="submit">Publish posting</button>}
        busy
      />,
    );
    expect(busy).toMatch(
      /<button type="button" class="posting-dock__summary" aria-haspopup="dialog" disabled="">/,
    );
  });

  it("the live slots are ALWAYS drawn, even empty — a region must exist before its text lands", () => {
    const out = rail(CARD);
    expect(out).toContain('<div class="posting-dock__live" aria-live="polite"></div>');
    expect(out).toContain('<div class="posting-actions__live" aria-live="polite"></div>');
    // …and exactly two of them: the rail footer's and the dock's (one per breakpoint).
    expect(out.match(/aria-live="polite"/g)).toHaveLength(2);
  });

  it("the scroll region is a labelled region with a hidden-until-needed 'More below' cue", () => {
    const out = rail(CARD);
    expect(out).toContain(
      '<div class="posting-preview__scroll" role="region" aria-label="Card preview and the rest of your posting">',
    );
    expect(out).toContain(
      '<p class="posting-preview__more" aria-hidden="true"><span>More below ↓</span></p>',
    );
    // Not a Tab stop by markup — only the browser's overflow check (rail-scroll.ts) makes it one.
    expect(out).not.toContain("tabindex");
  });

  it("the zero-reach label keeps its whole text in the button (the dock hides the detail visually)", () => {
    const out = renderToStaticMarkup(<button type="button">{zeroReachLabel}</button>);
    expect(out).toBe(
      '<button type="button">Publish anyway <span class="posting-cta__detail">— reaches nobody yet</span></button>',
    );
  });

  it("the dock's summary is the SAME card: title · band · Area, City", () => {
    const out = rail(CARD);
    expect(out).toContain('<span class="posting-dock__title">CNC Turner</span>');
    expect(out).toContain(
      '<span class="posting-dock__meta">₹18,000–26,000/mah · Chakan MIDC, Pune</span>',
    );
  });

  it("the dock names a pay issue instead of a band, and has honest copy when nothing is set", () => {
    expect(rail({ ...CARD, pay_min: null }, { payIssue: "Pay needs a whole number" })).toContain(
      "Pay needs a whole number · Chakan MIDC, Pune",
    );
    const empty = rail({
      ...CARD,
      role_title: null,
      city: null,
      area: null,
      pay_min: null,
      pay_max: null,
    });
    expect(empty).toContain("Your role title");
    expect(empty).toContain("Pay and place not set yet");
  });

  it("the form's end repeats the BUTTONS only — no second live status region", () => {
    const out = renderToStaticMarkup(
      <PostingActions>
        <button type="button">Save</button>
      </PostingActions>,
    );
    expect(out).toBe(
      '<div class="posting-actions"><div class="posting-actions__buttons"><button type="button">Save</button></div></div>',
    );
  });

  it("the actions block: the field-owned status (not live), then an always-drawn live outcome", () => {
    const out = renderToStaticMarkup(
      <PostingActions status={<p>Add the city.</p>}>
        <button type="button">Save</button>
      </PostingActions>,
    );
    expect(out).toBe(
      '<div class="posting-actions"><div class="posting-actions__status"><p>Add the city.</p></div>' +
        '<div class="posting-actions__live" aria-live="polite"></div>' +
        '<div class="posting-actions__buttons"><button type="button">Save</button></div></div>',
    );
    const failed = renderToStaticMarkup(
      <PostingActions status={null} outcome={<p>The server said no.</p>}>
        <button type="button">Save</button>
      </PostingActions>,
    );
    expect(failed).toContain(
      '<div class="posting-actions__live" aria-live="polite"><p>The server said no.</p></div>',
    );
  });
});

describe("Also in your posting — not on the worker's card", () => {
  it("company: role, openings, skills (labels, never ids), location note, description + where workers read it", () => {
    const facts = companyPostingFacts({
      roleKind: "tool_die_maker",
      openings: " 5 ",
      locationNote: "",
      matchSkills: {
        ids: ["mskill_cnc_turning", "mskill_unknown"],
        vocabulary: [
          {
            skill_id: "mskill_cnc_turning",
            label: "CNC turning",
            industry_id: "i",
            related_skill_ids: [],
          },
        ],
      },
      description: "Two machines.",
    });
    expect(facts).toEqual([
      { label: "Role", value: "Tool & Die Maker" },
      { label: "Openings", value: "5" },
      { label: "Skills", value: "CNC turning" },
      { label: "Location note", value: null },
      {
        label: "Description",
        value: "Two machines.",
        note: "Workers read this when they open the job.",
      },
    ]);
    const out = renderToStaticMarkup(<PostingFacts facts={facts} />);
    expect(out).toContain("Tool &amp; Die Maker");
    expect(out).toContain("Not set");
    expect(out).not.toContain("mskill_unknown");
    expect(out).toContain('title="Two machines."');
  });

  it("Openings shows the count the form will SEND — never the raw box ('21k' is 'Not set')", () => {
    const openings = (raw: string) =>
      companyPostingFacts({
        roleKind: null,
        openings: raw,
        locationNote: "",
        matchSkills: null,
        description: "",
      }).find((f) => f.label === "Openings")!.value;
    expect(openings("21k")).toBeNull();
    expect(openings("1.5")).toBeNull();
    expect(openings("0")).toBeNull();
    expect(openings("1,000")).toBe("1000");
    expect(openings(" 12 ")).toBe("12");
  });

  it("an unknown role kind is never echoed; the skills row is omitted when there is no vocabulary", () => {
    const facts = companyPostingFacts({
      roleKind: "not_a_role",
      openings: "",
      locationNote: "",
      matchSkills: null,
      description: "",
    });
    expect(facts.map((f) => f.label)).toEqual(["Role", "Openings", "Location note", "Description"]);
    expect(facts.every((f) => f.value === null)).toBe(true);
  });

  it("agency: role, the trade it matches on, description", () => {
    expect(
      agencyPostingFacts({ roleKind: "welder", tradeKey: "cnc_operator", description: "" }),
    ).toEqual([
      { label: "Role", value: "Welder" },
      { label: "Trade (matching)", value: "CNC Operator" },
      { label: "Description", value: null, note: "Workers read this when they open the job." },
    ]);
  });
});

describe("the rail's scroll region — focusable and cued only while it overflows", () => {
  it("overflows / has more below, from its scroll geometry", () => {
    expect(railScrollState(0, 558, 702)).toEqual({ overflows: true, more: true });
    expect(railScrollState(144, 558, 702)).toEqual({ overflows: true, more: false });
    expect(railScrollState(0, 769, 769)).toEqual({ overflows: false, more: false });
    expect(railScrollState(0, 769, 770)).toEqual({ overflows: false, more: false }); // sub-pixel
  });
});

describe("focus helpers", () => {
  it("revealWholeControl scrolls the whole control into view, minimally", () => {
    const scrollIntoView = vi.fn();
    revealWholeControl({ currentTarget: { scrollIntoView } as unknown as Element });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("focusControl is a no-op outside a browser", () => {
    expect(() => focusControl("payType")).not.toThrow();
  });
});

describe("the phone fold — how many chips the reference phone cuts", () => {
  it("counts a chip whose box runs past the clip line (half a pixel of tolerance)", () => {
    expect(countClippedChips(400, [100, 200, 399.6, 400.4])).toBe(0);
    expect(countClippedChips(400, [100, 401, 460])).toBe(2);
    expect(countClippedChips(400, [])).toBe(0);
    expect(clippedChipsLabel(1)).toBe("1 chip");
    expect(clippedChipsLabel(17)).toBe("17 chips");
  });
});
