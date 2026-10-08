import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { AgencyJob } from "../../../../../../lib/contracts";

/**
 * The agency EDIT page's form host (final sweep F02). It replaced the inline row editor on the
 * Postings list; the assertions that editor's tests made about the SAVE and the form it drew carry
 * over here, against the page:
 *  - the form is the shared AgencyJobForm in EDIT mode (gaps highlighted, never blocking), seeded
 *    from the posting, with the page head as its `lead` (the rail starts level with it);
 *  - the save is `updateAgencyJobAction(job id, input, the loaded posting)` — the posting is the
 *    `initial` the seam diffs into `clear`, so a blanked card field is unset;
 *  - a refused save hands the reason back to the form (no navigation); a saved one lands on the
 *    posting's details, refreshed; Cancel returns there too — each through the shared navigation
 *    helper, naming the posting for the shell's "Opening <title>…" cue.
 * (The inline editor's focus hand-back between a row's Edit/Cancel toggle and its rebuilt header,
 * and "a save closes only ITS editor", have no counterpart: one page holds one form, and leaving it
 * is a navigation.)
 */

// Navigation goes through components/portal-navigation.ts (its router mechanics — push, the
// refresh, the cue — are that module's own suite); here: where to, named what, refreshed or not.
const navigate = vi.fn();
vi.mock("../../../../../../components/portal-navigation", () => ({
  usePortalNavigation: () => ({ pending: false, navigate }),
}));
const updateAgencyJobAction = vi.fn();
vi.mock("../../../dashboard/jobs-actions", () => ({
  updateAgencyJobAction: (...a: unknown[]) => updateAgencyJobAction(...a),
}));
const AgencyJobFormStub = vi.fn(() => null);
vi.mock("../../../dashboard/agency-job-form", () => ({ AgencyJobForm: AgencyJobFormStub }));

const { EditAgencyPosting } = await import("./edit-agency-posting");

const JOB: AgencyJob = {
  id: "00000001-0000-4000-8000-000000000001",
  status: "open",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: "Chakan",
  payMin: 20000,
  payMax: 35000,
  minExperienceYears: 1,
  maxExperienceYears: 5,
  neededBy: "soon",
  applicantsReceived: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const DETAIL = `/agency/jobs/${JOB.id}`;
const INPUT = {
  tradeKey: "cnc_operator",
  roleKind: "cnc_turner",
  title: "CNC Operator",
  city: "Pune",
};

type FormProps = {
  mode: string;
  job: AgencyJob;
  lead: ReactNode;
  submitLabel: string;
  onSubmit: (input: unknown) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
};
function form(): FormProps {
  const el = EditAgencyPosting({
    job: JOB,
    lead: <h1 className="lead-probe">Edit posting</h1>,
  }) as ReactElement<FormProps>;
  expect(el.type).toBe(AgencyJobFormStub);
  return el.props;
}

beforeEach(() => {
  navigate.mockClear();
  updateAgencyJobAction.mockReset();
});

describe("EditAgencyPosting — the shared form, in EDIT mode, headed by the page", () => {
  it("draws AgencyJobForm in edit mode, seeded from the posting, with the page head as its lead", () => {
    const p = form();
    expect(p.mode).toBe("edit");
    expect(p.job).toBe(JOB);
    expect(p.submitLabel).toBe("Save changes");
    expect((p.lead as ReactElement<{ className: string }>).props.className).toBe("lead-probe");
  });
});

describe("EditAgencyPosting — the save", () => {
  it("saves through updateAgencyJobAction with the loaded posting as `initial` (the clear diff)", async () => {
    updateAgencyJobAction.mockResolvedValueOnce({ ok: true, job: JOB });
    await form().onSubmit(INPUT);
    expect(updateAgencyJobAction).toHaveBeenCalledTimes(1);
    expect(updateAgencyJobAction).toHaveBeenCalledWith(JOB.id, INPUT, JOB);
  });

  it("a saved posting lands on its details, refreshed (a later Back never restores the old form)", async () => {
    // The cue names the SAVED posting (its title may be the edit's new one).
    updateAgencyJobAction.mockResolvedValueOnce({ ok: true, job: { ...JOB, title: "CNC Setter" } });
    await expect(form().onSubmit(INPUT)).resolves.toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(DETAIL, { pendingLabel: "CNC Setter", refresh: true });
  });

  it("a refused save hands the server's reason back to the form and stays on the page", async () => {
    updateAgencyJobAction.mockResolvedValueOnce({
      ok: false,
      error: "That posting could not be found.",
    });
    await expect(form().onSubmit(INPUT)).resolves.toEqual({
      ok: false,
      error: "That posting could not be found.",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Cancel returns to the posting's details without saving", () => {
    form().onCancel();
    expect(navigate).toHaveBeenCalledWith(DETAIL, { pendingLabel: JOB.title });
    expect(updateAgencyJobAction).not.toHaveBeenCalled();
  });
});
