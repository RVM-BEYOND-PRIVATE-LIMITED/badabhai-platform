import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { candidateRecord } from "../../../../test/candidate-record";

/**
 * A7 (#2577) — the admin edit dialog's structured sections: multi-selects pre-filled from
 * the record's raw codes, language rows with their ability ticks, and work-history rows
 * with their nested roles. The T2 review, reason and per-fact POST flow is unchanged —
 * these tests pin that the new inputs render pre-filled and namespaced per row.
 */
vi.mock("../../../lib/candidate-edit-client", () => ({
  postCandidateCorrection: vi.fn(async () => ({ ok: true as const })),
}));

const { CandidateEditDialog } = await import("./candidate-edit-dialog");

const render = (sectionId: "languages" | "history" | "pay" | "skills") =>
  renderToStaticMarkup(
    <CandidateEditDialog
      open={true}
      sectionId={sectionId}
      detail={candidateRecord()}
      onClose={() => undefined}
      onSaved={() => undefined}
    />,
  );

describe("the languages editor", () => {
  it("pre-fills one row per stored language, with its ability ticks", () => {
    const out = render("languages");
    expect(out).toContain('value="hindi"');
    // Two checkboxes in the row are ticked (speaks, reads), writes is not.
    const checked = out.match(/checked=""/g) ?? [];
    expect(checked.length).toBe(2);
    expect(out).toContain("Speaks");
    expect(out).toContain("Reads");
    expect(out).toContain("Writes");
  });

  it("offers every language in the closed vocabulary", () => {
    const out = render("languages");
    expect(out).toContain('value="marathi"');
    expect(out).toContain('value="rajasthani"');
  });
});

describe("the work history editor", () => {
  it("pre-fills the stored employment and role, without the employer name", () => {
    const out = render("history");
    expect(out).toContain('value="Pune"');
    expect(out).toContain('value="TIG Welder"');
    expect(out).toContain("Type the name the worker gave");
    // The name is never shown: no pre-filled value for it.
    expect(out).not.toContain('value="Tata');
  });

  it("offers role rows under each employment", () => {
    const out = render("history");
    expect(out).toContain("Add role");
    expect(out).toContain("Add employments");
  });
});

describe("the pay section's multi-selects", () => {
  it("ticks the stored work types and documents", () => {
    const out = render("pay");
    expect(out).toContain("Work types");
    expect(out).toContain("Documents ready");
    // contract + aadhaar + pan ticked.
    const checked = out.match(/checked=""/g) ?? [];
    expect(checked.length).toBe(3);
  });
});

describe("the skills editor", () => {
  it("pre-fills the stored skill ids as a comma list", () => {
    const out = render("skills");
    expect(out).toContain("skill_tig_welder, skill_arc_welding");
  });
});
