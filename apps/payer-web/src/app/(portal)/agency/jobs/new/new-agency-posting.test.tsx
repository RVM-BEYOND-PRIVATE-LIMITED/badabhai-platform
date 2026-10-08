import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { AgencyJob } from "../../../../../lib/contracts";

/**
 * The agency CREATE page's form host. Both of its ways off the page are BUTTONS that navigate —
 * the publish (to the posting it just made) and Cancel (back to the list) — so both go through
 * the shared navigation helper (components/portal-navigation.ts), naming the destination for the
 * shell's "Opening …" cue: a slow destination never answers the click with nothing. A refused
 * create stays on the page.
 */

// Its router mechanics (push, the cue) are components/portal-navigation.ts's own suite.
const navigate = vi.fn();
vi.mock("../../../../../components/portal-navigation", () => ({
  usePortalNavigation: () => ({ pending: false, navigate }),
}));
const createAgencyJobAction = vi.fn();
vi.mock("../../dashboard/jobs-actions", () => ({
  createAgencyJobAction: (...a: unknown[]) => createAgencyJobAction(...a),
}));
const AgencyJobFormStub = vi.fn(() => null);
vi.mock("../../dashboard/agency-job-form", () => ({ AgencyJobForm: AgencyJobFormStub }));

const { NewAgencyPosting } = await import("./new-agency-posting");

const JOB = {
  id: "00000001-0000-4000-8000-000000000009",
  title: "VMC Operator",
} as AgencyJob;
const INPUT = {
  tradeKey: "cnc_operator",
  roleKind: "vmc_operator",
  title: "VMC Operator",
  city: "Pune",
};

type FormProps = {
  mode: string;
  submitLabel: string;
  lead: ReactNode;
  onSubmit: (input: unknown) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
};
function form(): FormProps {
  const el = NewAgencyPosting({ lead: <h1>New posting</h1> }) as ReactElement<FormProps>;
  expect(el.type).toBe(AgencyJobFormStub);
  return el.props;
}

beforeEach(() => {
  navigate.mockClear();
  createAgencyJobAction.mockReset();
});

describe("NewAgencyPosting — leaving the page shows the navigation cue", () => {
  it("draws the shared form in CREATE mode", () => {
    const p = form();
    expect(p.mode).toBe("create");
    expect(p.submitLabel).toBe("Publish posting");
  });

  it("a published posting lands on its own page, named for the cue ('Opening <title>…')", async () => {
    createAgencyJobAction.mockResolvedValueOnce({ ok: true, job: JOB });
    await expect(form().onSubmit(INPUT)).resolves.toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/agency/jobs/${JOB.id}`, {
      pendingLabel: "VMC Operator",
    });
  });

  it("a refused create hands the reason back and stays on the page", async () => {
    createAgencyJobAction.mockResolvedValueOnce({ ok: false, error: "Enter a city." });
    await expect(form().onSubmit(INPUT)).resolves.toEqual({ ok: false, error: "Enter a city." });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Cancel returns to the Postings list ('Opening Postings…') without creating anything", () => {
    form().onCancel();
    expect(navigate).toHaveBeenCalledWith("/agency/jobs", { pendingLabel: "Postings" });
    expect(createAgencyJobAction).not.toHaveBeenCalled();
  });
});
