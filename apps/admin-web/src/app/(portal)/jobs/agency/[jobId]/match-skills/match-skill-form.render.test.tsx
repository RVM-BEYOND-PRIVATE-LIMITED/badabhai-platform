import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the match-skill picker RENDERS: one checkbox row per vocabulary skill
 * (label + raw id), the current selection checked, stale saved ids as raw
 * untickable rows, and the live count against the cap. Submits are exercised
 * in `actions.test.ts` (a Server Action, not this form); `useRouter` is
 * stubbed because this renderer provides no app-router context.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { MatchSkillForm } = await import("./match-skill-form");

const VOCABULARY = {
  skills: [
    {
      skill_id: "mskill_cnc_operate",
      label: "CNC operating",
      industry_id: "ind_manufacturing",
      related_skill_ids: [],
    },
    {
      skill_id: "mskill_vmc_setting",
      label: "VMC setting",
      industry_id: "ind_manufacturing",
      related_skill_ids: [],
    },
  ],
  max_skills_per_posting: 5,
};

const render = (current: readonly string[], vocabulary = VOCABULARY) =>
  renderToStaticMarkup(
    <MatchSkillForm
      jobId="11111111-1111-4111-8111-111111111111"
      current={current}
      vocabulary={vocabulary}
    />,
  );

describe("the picker", () => {
  it("lists every vocabulary skill with its label and raw id", () => {
    const html = render([]);
    expect(html).toContain("CNC operating");
    expect(html).toContain("mskill_cnc_operate");
    expect(html).toContain("VMC setting");
    expect(html).toContain('type="checkbox"');
  });

  it("checks the current selection and counts it against the cap", () => {
    const html = render(["mskill_cnc_operate"]);
    expect(html).toContain("1 selected");
    expect(html).toContain("at most 5");
  });

  it("a saved id the vocabulary no longer names renders raw and untickable", () => {
    const html = render(["mskill_retired"]);
    expect(html).toContain("mskill_retired");
    expect(html).toContain("unrecognized");
  });

  it("an empty selection offers save with nothing checked", () => {
    const html = render([]);
    expect(html).toContain("0 selected");
    expect(html).toContain("Save match skills");
  });
});
