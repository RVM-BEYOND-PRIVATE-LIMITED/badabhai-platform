import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { candidateCorrectionValues, candidateRecord } from "../../../../test/candidate-record";
import type { CandidateDetail } from "../../../lib/candidate-detail";
import { CandidateEditDialog } from "./candidate-edit-dialog";

/**
 * #2728 — the structured edit dialog as rendered: repeatable add/remove rows for the eight facts,
 * the closed-set chips, and the promise that a null `correction_values` block offers no structured
 * editor at all. Interactions are the model's own tests (`candidate-edit-model.test.ts`); the
 * dialog is rendered through the server renderer, as the drawer's other tests do.
 */
const detail = (over: Partial<CandidateDetail> = {}) => candidateRecord(over);

const render = (
  sectionId: Parameters<typeof CandidateEditDialog>[0]["sectionId"],
  detailValue = detail(),
) =>
  renderToStaticMarkup(
    <CandidateEditDialog
      open
      sectionId={sectionId}
      detail={detailValue}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );

const structured = detail({ correction_values: candidateCorrectionValues() });

describe("the structured editors", () => {
  it("skills: chips from match_skills, plus an id the list does not know shown raw", () => {
    const html = render("skills", structured);
    expect(html).toContain("TIG Welder");
    expect(html).toContain("Grinder");
    // The correction block's own ids are not match ids in this fixture, so they stay visible.
    expect(html).toContain("skill_mig_welding (current id)");
    expect(html).toContain("2 of 50 selected.");
    expect(html).toMatch(/aria-pressed="true"/);
  });

  it("work history: an employment row, one or more roles, add/remove, and NO voice-note control", () => {
    const html = render("work-history", structured);
    expect(html).toContain("Employment 1");
    expect(html).toContain("Tata Motors");
    expect(html).toContain("Role 1");
    expect(html).toContain("TIG Welder");
    expect(html).toContain("Add role");
    expect(html).toContain("Remove role");
    expect(html).toContain("Add employment");
    expect(html).toContain("Remove employment");
    expect(html).not.toMatch(/<input[^>]*voice/i);
    expect(html).not.toMatch(/<input[^>]*work_done_voice_note_id/i);
  });

  it("education, certifications and training render their repeatable rows", () => {
    const education = render("education", structured);
    expect(education).toContain("Education 1");
    expect(education).toContain("Govt. ITI");
    expect(education).toContain("Add education");

    const certificates = render("certifications", structured);
    expect(certificates).toContain("Certificate 1");
    expect(certificates).toContain("NCVT Welder");
    expect(certificates).toContain("Licence number");
    expect(certificates).toContain("Add certificate");

    const training = render("training", structured);
    expect(training).toContain("Training 1");
    expect(training).toContain("MIG course");
    expect(training).toContain("Add training");
  });

  it("languages: a listed language with its three independent abilities", () => {
    const html = render("languages", structured);
    expect(html).toContain("Language 1");
    expect(html).toContain("Hindi");
    expect(html).toContain("Speak");
    expect(html).toContain("Read");
    expect(html).toContain("Write");
    expect(html).toContain("Add language");
  });

  it("work types and documents render their closed option sets", () => {
    const workTypes = render("work-types", structured);
    for (const label of ["Permanent", "Contract", "Apprenticeship", "Daily wage"]) {
      expect(workTypes).toContain(label);
    }
    expect(workTypes).toContain("1 of 4 selected.");

    const documents = render("documents", structured);
    for (const label of [
      "Aadhaar",
      "PAN",
      "Bank account",
      "UAN / PF",
      "ESIC",
      "ITI certificate",
      "Experience letter",
      "Passport photos",
      "Driving licence",
    ]) {
      expect(documents).toContain(label);
    }
    expect(documents).toContain("2 of 8 selected.");
  });

  it("a null correction_values block offers NO structured editor", () => {
    for (const [section, marker] of [
      ["skills", "of 50 selected"],
      ["work-history", "Add employment"],
      ["education", "Add education"],
      ["certifications", "Add certificate"],
      ["training", "Add training"],
      ["languages", "Add language"],
      ["work-types", "of 4 selected"],
      ["documents", "of 8 selected"],
    ] as const) {
      const html = render(section, detail({ correction_values: null }));
      expect(html, section).not.toContain(marker);
    }
  });

  it("the existing simple sections still render their inputs", () => {
    const html = render("location", structured);
    expect(html).toContain("Current city");
    expect(html).toMatch(/value="Pune"/);
    expect(html).toContain("Wants to work in");
  });
});
