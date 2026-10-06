import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgencyJob, ApplicantFeed, UnlockHistoryItem } from "../../../../../../lib/contracts";
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
 * ALREADY UNLOCKED (the company feed's F10): the payer's own LIVE grants for THIS feed's workers
 * are handed to the pipeline, so a reload does not offer a fresh spend on a worker the agency
 * already holds. A failed history read starts every row locked; it is never an error state.
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
const getUnlocks = vi.fn<() => Promise<UnlockHistoryItem[]>>();

vi.mock("../../../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../../../lib/auth/org-roles", () => ({ getOrgRole: () => getOrgRole() }));
vi.mock("../../../../../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../../../../lib/payer-api", () => ({
  getAgencyJob: (id: string) => getAgencyJob(id),
  getApplicantFeed: (id: string) => getApplicantFeed(id),
  getCredits: () => getCredits(),
  getUnlocks: () => getUnlocks(),
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
      unlocked?: Record<string, unknown>;
    }) =>
      React.createElement("div", {
        "data-testid": "applicant-actions",
        "data-posting": props.postingId,
        "data-count": props.applicants.length,
        "data-balance": props.balance,
        "data-back": props.header.back.href,
        "data-back-label": props.header.back.label,
        "data-desc": props.header.description,
        // The worker ids whose rows start unlocked (none when the prop is absent).
        "data-unlocked": Object.keys(props.unlocked ?? {}).join(" "),
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
  getUnlocks.mockReset().mockResolvedValue([]);
});

describe("agency applicants page — the gates run in order", () => {
  it("requireAgent first: no reads when it rejects", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
    expect(getApplicantFeed).not.toHaveBeenCalled();
    expect(getUnlocks).not.toHaveBeenCalled();
  });

  it("portal flag off → neutral not-found, no reads", async () => {
    flags.agencyPortalEnabled = false;
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
    expect(getUnlocks).not.toHaveBeenCalled();
  });

  it("a non-uuid id is a 404 BEFORE the read", async () => {
    await expect(html("../credits")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
    expect(getApplicantFeed).not.toHaveBeenCalled();
    expect(getUnlocks).not.toHaveBeenCalled();
  });

  it("an unknown or not-owned job is the same neutral 404 with no feed read", async () => {
    await expect(html("00000001-0000-4000-8000-0000000000ff")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getApplicantFeed).not.toHaveBeenCalled();
    expect(getUnlocks).not.toHaveBeenCalled();
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

describe("agency applicants page — rows the agency already unlocked stay unlocked after a reload", () => {
  const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
  const PAST = new Date(Date.now() - 7 * 864e5).toISOString();
  const A = FEED.applicants[0]!.workerId;
  const B = "b2c3d4e5-0000-4000-8000-000000000002";
  const OFF_FEED = "c3d4e5f6-0000-4000-8000-000000000003";
  const FEED_AB: ApplicantFeed = {
    ...FEED,
    applicants: [
      FEED.applicants[0]!,
      { workerId: B, rank: 2, score: 0.6, hot: false, signals: [] },
    ],
  };
  // As getUnlocks maps the wire: revealed folds into granted, and no job/posting context is
  // carried (one grant per payer × worker — ADR-0010 — so the worker id alone names the row).
  const unlock = (workerId: string, over: Partial<UnlockHistoryItem> = {}): UnlockHistoryItem => ({
    unlockId: `${workerId.slice(0, 8)}-1111-4111-8111-111111111111`,
    workerId,
    status: "granted",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: FUTURE,
    ...over,
  });
  /** The props the page hands the client pipeline (they ride the RSC payload to the browser). */
  async function feedProps(): Promise<Record<string, unknown>> {
    const tree = (await AgencyJobApplicantsPage(params(JOB_ID))) as ReactElement<{
      children: ReactElement<Record<string, unknown>>;
    }>;
    return tree.props.children.props;
  }

  it("a live grant starts that worker's row unlocked; the others stay locked", async () => {
    getApplicantFeed.mockResolvedValue(FEED_AB);
    getUnlocks.mockResolvedValue([unlock(A)]);
    expect(await html()).toContain(`data-unlocked="${A}"`);
    expect((await feedProps()).unlocked).toEqual({
      [A]: { kind: "granted", unlockId: unlock(A).unlockId, expiresAt: FUTURE },
    });
  });

  it("an expired grant stays locked — a lapsed window (stored status still granted) or an expired status", async () => {
    getApplicantFeed.mockResolvedValue(FEED_AB);
    getUnlocks.mockResolvedValue([
      unlock(A, { expiresAt: PAST }),
      unlock(B, { status: "expired" }),
    ]);
    expect(await html()).toContain('data-unlocked=""');
    // The history WAS read and yielded no live grant — not merely "no prop".
    expect(await feedProps()).toHaveProperty("unlocked", {});
    expect(getUnlocks).toHaveBeenCalled();
  });

  it("a failed unlocks read starts every row locked and the feed still renders (never an error)", async () => {
    getUnlocks.mockRejectedValue(new Error("unlocks 503"));
    const out = await html();
    expect(getUnlocks).toHaveBeenCalledTimes(1);
    expect(out).toContain('data-testid="applicant-actions"');
    expect(out).toContain('data-count="1"');
    expect(out).toContain('data-balance="5"');
    expect(out).toContain('data-unlocked=""');
    expect(out).not.toContain("We couldn’t load applicants");
    expect(await feedProps()).toHaveProperty("unlocked", {});
  });

  it("serialises to the client ONLY grants for workers on this feed", async () => {
    getUnlocks.mockResolvedValue([unlock(A), unlock(OFF_FEED)]);
    const props = await feedProps();
    expect(Object.keys((props.unlocked ?? {}) as Record<string, unknown>)).toEqual([A]);
    // Nothing of the off-feed grant reaches the payload — neither its worker nor its unlock id.
    const payload = JSON.stringify(props);
    expect(payload).not.toContain(OFF_FEED);
    expect(payload).not.toContain(unlock(OFF_FEED).unlockId);
  });
});
