import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PostingActions, PostingFacts, PostingPreviewRail } from "./posting-preview-rail";
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

const rail = (fields: CardFields, draft = {}) =>
  renderToStaticMarkup(
    <PostingPreviewRail
      fields={fields}
      draft={draft}
      facts={[{ label: "Role", value: "CNC Turner" }]}
      actions={
        <PostingActions status={null}>
          {<button type="submit">Publish posting</button>}
        </PostingActions>
      }
      primary={<button type="submit">Publish posting</button>}
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

  it("the actions block keeps an (empty) live region above the buttons", () => {
    const out = renderToStaticMarkup(
      <PostingActions status={<p>Add the city.</p>}>
        <button type="button">Save</button>
      </PostingActions>,
    );
    expect(out).toBe(
      '<div class="posting-actions"><div class="posting-actions__status" aria-live="polite"><p>Add the city.</p></div>' +
        '<div class="posting-actions__buttons"><button type="button">Save</button></div></div>',
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

describe("the phone fold — how many chips the reference phone cuts", () => {
  it("counts a chip whose box runs past the clip line (half a pixel of tolerance)", () => {
    expect(countClippedChips(400, [100, 200, 399.6, 400.4])).toBe(0);
    expect(countClippedChips(400, [100, 401, 460])).toBe(2);
    expect(countClippedChips(400, [])).toBe(0);
    expect(clippedChipsLabel(1)).toBe("1 chip");
    expect(clippedChipsLabel(17)).toBe("17 chips");
  });
});
