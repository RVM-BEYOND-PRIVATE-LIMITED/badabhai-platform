import { describe, expect, it } from "vitest";
import {
  APPLICANT_STAGES,
  hasSavedStages,
  isApplicantStage,
  STAGE_LABEL,
} from "./applicant-stages";

/**
 * SAVED APPLICANT STAGES — the one vocabulary (#2139). Whether stages are saved is read from the
 * ROWS (the flag is server-side): every row with a `stage` is saved; none, or a mix, is not.
 */

describe("hasSavedStages — the server's flag, as the rows show it", () => {
  it("every row carries a stage → saved (flag on)", () => {
    expect(hasSavedStages([{ stage: "new" }, { stage: "passed" }])).toBe(true);
  });

  it("no row carries one → not saved (flag off: the local board, no stage route)", () => {
    expect(hasSavedStages([{}, {}])).toBe(false);
  });

  it("a mix is not saved — the route is never called on a partial answer", () => {
    expect(hasSavedStages([{ stage: "shortlist" }, {}])).toBe(false);
    expect(hasSavedStages([{}, { stage: "shortlist" }])).toBe(false);
  });

  it("no rows cannot say → not saved", () => {
    expect(hasSavedStages([])).toBe(false);
  });
});

describe("the stage vocabulary", () => {
  it("is the API's three, in board order, named by the copy rulings", () => {
    expect(APPLICANT_STAGES).toEqual(["new", "shortlist", "passed"]);
    expect(APPLICANT_STAGES.map((s) => STAGE_LABEL[s])).toEqual(["New", "Shortlist", "Passed"]);
  });

  it("isApplicantStage accepts exactly the three", () => {
    for (const s of APPLICANT_STAGES) expect(isApplicantStage(s)).toBe(true);
    for (const v of ["", "New", "shortlisted", "archived", ["new"], null, undefined, 1]) {
      expect(isApplicantStage(v)).toBe(false);
    }
  });
});
