import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgencyJob, ApplicantFeed } from "../../../../../../lib/contracts";
import type { PayerSession } from "../../../../../../lib/auth/types";

/**
 * /agency/jobs/[jobId]/applicants PAGE tests (#1956).
 *
 * Since #1955 an owned agency `jobs` row returns only the workers who APPLIED, so this page's
 * copy says "applied" and the empty state is "No one has applied yet" — never "suggested
 * workers". The gates mirror the agency detail page (requireAgent → portal flag → uuid → own
 * the job), an unknown OR foreign job is the SAME neutral 404, and the agency job id is passed
 * to the shared applicant pipeline as the disclosure/unlock context.
 *
 * `ApplicantActions` is stubbed to a marker so the page's own composition is what is asserted;
 * next/link is stubbed to a plain anchor.
 */

const AGENT: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Staffing",
  role: "agent",
  status: "active",
};

const JOB_ID = "00000001-0000-4000-8000-000000000001";
const JOB: AgencyJob = {
  id: JOB_ID,
  status: "open",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: null,
  payMin: 20000,
  payMax: 35000,
  minExperienceYears: 1,
  maxExperienceYears: 5,
  neededBy: "soon",
  applicantsReceived: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const FEED: ApplicantFeed = {
  postingId: JOB_ID,
  roleTitle: "Applicants",
  applicants: [
    { workerId: "a1b2c3d4-0000-4000-8000-000000000001", rank: 1, score: 0.8, hot: false, signals: [] },
  ],
};

const requireAgent = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn(() => "recruiter");
const flags = { agencyPortalEnabled: true };
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const getAgencyJob = vi.fn<(id: string) => Promise<AgencyJob | null>>();
const getApplicantFeed = vi.fn<(id: string) => Promise<ApplicantFeed | null>>();
const getCredits = vi.fn();

vi.mock("../../../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../../../lib/auth/org-roles", () => ({ getOrgRole: () => getOrgRole() }));
vi.mock("../../../../../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../../../../lib/payer-api", () => ({
  getAgencyJob: (id: string) => getAgencyJob(id),
  getApplicantFeed: (id: string) => getApplicantFeed(id),
  getCredits: () => getCredits(),
}));
vi.mock("../../../../../../components/retry-button", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return { RetryButton: () => React.createElement("button", { type: "button" }, "Retry") };
});
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({ children, href }: { children: ReactNode; href: string }) =>
      React.createElement("a", { href }, children),
  };
});
vi.mock("../../../../postings/[id]/applicants/applicant-actions", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    ApplicantActions: (props: {
      postingId: string;
      applicants: unknown[];
      balance: number;
      header: { back: { href: string; label: string }; description: string };
    }) =>
      React.createElement("div", {
        "data-testid": "applicant-actions",
        "data-posting": props.postingId,
        "data-count": props.applicants.length,
        "data-balance": props.balance,
        "data-back": props.header.back.href,
        "data-back-label": props.header.back.label,
        "data-desc": props.header.description,
      }),
  };
});

const { default: AgencyJobApplicantsPage } = await import("./page");

const params = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

async function html(jobId: string = JOB_ID): Promise<string> {
  const tree = (await AgencyJobApplicantsPage(params(jobId))) as ReactElement;
  return renderToStaticMarkup(tree);
}
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ");

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  getOrgRole.mockReset().mockReturnValue("recruiter");
  flags.agencyPortalEnabled = true;
  notFound.mockClear();
  getAgencyJob.mockReset().mockImplementation(async (id) => (id === JOB_ID ? JOB : null));
  getApplicantFeed.mockReset().mockResolvedValue(FEED);
  getCredits.mockReset().mockResolvedValue({ payerId: AGENT.payerId, balance: 5 });
});

describe("agency applicants page — the gates run in order", () => {
  it("requireAgent first: no reads when it rejects", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
    expect(getApplicantFeed).not.toHaveBeenCalled();
  });

  it("portal flag off → neutral not-found, no reads", async () => {
    flags.agencyPortalEnabled = false;
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
  });

  it("a non-uuid id is a 404 BEFORE the read", async () => {
    await expect(html("../credits")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
    expect(getApplicantFeed).not.toHaveBeenCalled();
  });

  it("an unknown or not-owned job is the same neutral 404 with no feed read", async () => {
    await expect(html("00000001-0000-4000-8000-0000000000ff")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getApplicantFeed).not.toHaveBeenCalled();
  });
});

describe("agency applicants page — the feed + the empty state", () => {
  it("renders the shared pipeline with the agency job id as the unlock context", async () => {
    const out = await html();
    expect(out).toContain('data-testid="applicant-actions"');
    expect(out).toContain(`data-posting="${JOB_ID}"`);
    expect(out).toContain('data-count="1"');
    expect(out).toContain('data-balance="5"');
    // The head (rendered by the shared pipeline) is back to the posting, by its own name.
    expect(out).toContain(`data-back="/agency/jobs/${JOB_ID}"`);
    expect(out).toContain('data-back-label="CNC Operator"');
    expect(out).toContain("Everyone who applied to CNC Operator");
  });

  it("a job nobody applied to says 'No one has applied yet' with nothing to press", async () => {
    getApplicantFeed.mockResolvedValueOnce({ ...FEED, applicants: [] });
    const out = await html();
    expect(out).toContain("No one has applied yet");
    const state = out.slice(out.indexOf('class="state"'));
    expect(state).not.toMatch(/<a |<button /);
    // The head still names the posting and goes back to it.
    expect(out).toContain(`href="/agency/jobs/${JOB_ID}"`);
    expect(textOf(out)).toContain("CNC Operator");
    // Nothing implying "suggested workers".
    expect(out).not.toMatch(/suggested workers/i);
  });

  it("a null feed is the union neutral not-found (unknown OR not-owned), with no back link", async () => {
    getApplicantFeed.mockResolvedValueOnce(null);
    const out = await html();
    expect(out).toContain("No posting found here");
    expect(out).toContain("It may not exist, or it isn’t one of your postings.");
    expect(out).not.toContain("No one has applied yet");
    expect(out).not.toContain("applicants-list");
  });

  it("a failed feed read is a retryable error, never the not-found copy", async () => {
    getApplicantFeed.mockRejectedValueOnce(new Error("upstream 502"));
    const out = await html();
    expect(out).toContain("We couldn’t load applicants");
    expect(out).toContain("Retry");
    expect(out).not.toContain("No posting found here");
  });

  it("a failed balance read keeps Unlock enabled (balance defaults to 1, never blanked)", async () => {
    getCredits.mockRejectedValueOnce(new Error("credits 503"));
    const out = await html();
    expect(out).toContain('data-balance="1"');
  });
});
