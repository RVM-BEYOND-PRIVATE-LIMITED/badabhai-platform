import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { AgencyJob } from "../../../../lib/contracts";
import type { PayerSession } from "../../../../lib/auth/types";
import type * as ConfigModule from "../../../../lib/config";

/**
 * The AGENCY posting pages (owner ruling 2026-10-01: an agency posts agency `jobs` only):
 *   /agency/jobs        "Postings"    — its own postings, managed in one place;
 *   /agency/jobs/new    "New posting" — every agency "post" entry point opens it;
 *   /agency/jobs/<id>   "Posting details".
 * Each gates like every agency page: `requireAgent()` FIRST (anyone else gets the neutral 404),
 * then the agency-portal flag (off → the route does not exist) — both BEFORE any read. The
 * details page also refuses a non-uuid id before the read, and offers NO way to the posting's
 * applicants: the applicant endpoint does not serve agency jobs correctly yet (backend #1898).
 */

const AGENT: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Staffing",
  role: "agent",
  status: "active",
};

const requireAgent = vi.fn<() => Promise<PayerSession>>();
const flags = { agencyPortalEnabled: true };
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const listAgencyJobs = vi.fn<() => Promise<AgencyJob[]>>();
const getAgencyJob = vi.fn<(id: string) => Promise<AgencyJob | null>>();

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, agencyFlags: () => flags };
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../../lib/payer-api", () => ({
  listAgencyJobs: () => listAgencyJobs(),
  getAgencyJob: (id: string) => getAgencyJob(id),
}));
vi.mock("../dashboard/agency-jobs-manager", () => ({ AgencyJobsManager: () => null }));
vi.mock("./new/new-agency-posting", () => ({ NewAgencyPosting: () => null }));
vi.mock("../../../../components/job-card-preview", () => ({ JobCardPreview: () => null }));
vi.mock("../../../../components/retry-button", () => ({ RetryButton: () => null }));

const { PageHeader } = await import("../../../../components/page-header");
const list = await import("./page");
const create = await import("./new/page");
const detail = await import("./[jobId]/page");

const JOB: AgencyJob = {
  id: "00000001-0000-4000-8000-000000000001",
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
  applicantsReceived: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const params = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

function head(tree: unknown): Record<string, unknown> {
  const found: ReactElement[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === PageHeader) found.push(el);
    if (el.props && "children" in el.props) walk(el.props.children);
  })(tree as ReactNode);
  expect(found).toHaveLength(1);
  return found[0]!.props as Record<string, unknown>;
}

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  flags.agencyPortalEnabled = true;
  notFound.mockClear();
  listAgencyJobs.mockReset().mockResolvedValue([JOB]);
  getAgencyJob.mockReset().mockImplementation(async (id) => (id === JOB.id ? JOB : null));
});

const PAGES = [
  ["/agency/jobs", () => list.default()],
  ["/agency/jobs/new", () => create.default()],
  ["/agency/jobs/<id>", () => detail.default(params(JOB.id))],
] as const;

describe("agency posting pages — requireAgent, then the flag, both before any read", () => {
  for (const [name, run] of PAGES) {
    it(`${name}: a non-agent gets requireAgent's neutral 404 and nothing is read`, async () => {
      requireAgent.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
      await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(listAgencyJobs).not.toHaveBeenCalled();
      expect(getAgencyJob).not.toHaveBeenCalled();
    });

    it(`${name}: agency portal OFF → 404 before any read`, async () => {
      flags.agencyPortalEnabled = false;
      await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalledTimes(1);
      expect(listAgencyJobs).not.toHaveBeenCalled();
      expect(getAgencyJob).not.toHaveBeenCalled();
    });

    it(`${name}: an agent with the portal on gets the page`, async () => {
      await expect(run()).resolves.toBeTruthy();
      expect(notFound).not.toHaveBeenCalled();
    });
  }
});

describe("the heads — Posting naming, one door each", () => {
  it("Postings: the rail destination (no back link) with New posting as its one action", async () => {
    const h = head(await list.default());
    expect(h.title).toBe("Postings");
    expect(h.back).toBeUndefined();
    expect(h.primaryAction).toMatchObject({ href: "/agency/jobs/new", label: "New posting", icon: "plus" });
  });

  it("New posting: a rail destination too — no back link, no action (the form is the page)", async () => {
    const h = head(await create.default());
    expect(h.title).toBe("New posting");
    expect(h.back).toBeUndefined();
    expect(h.primaryAction).toBeUndefined();
  });

  it("Posting details: back to Postings, and NO way to its applicants (backend #1898)", async () => {
    const tree = await detail.default(params(JOB.id));
    const h = head(tree);
    expect(h.title).toBe("CNC Operator");
    expect(h.back).toEqual({ href: "/agency/jobs", label: "Postings" });
    expect(h.primaryAction).toBeUndefined();
    expect(h.secondaryActions ?? []).toEqual([]);
    expect(JSON.stringify(tree)).not.toMatch(/applicants"|\/applicants/);
  });
});

describe("/agency/jobs/<id> — the id is checked before it reaches the API", () => {
  it("a non-uuid id is a 404 BEFORE the read", async () => {
    await expect(detail.default(params("../credits"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
  });

  it("an unknown or not-owned job is the same neutral 404", async () => {
    await expect(
      detail.default(params("00000001-0000-4000-8000-0000000000ff")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).toHaveBeenCalledTimes(1);
  });
});

describe("/agency/jobs — a failed read is a retryable state, never an empty list", () => {
  it("the manager is not rendered; the error state is", async () => {
    listAgencyJobs.mockRejectedValue(new Error("upstream 502"));
    const tree = await list.default();
    const s = JSON.stringify(tree);
    expect(s).toContain("Postings are unavailable right now");
    expect(s).not.toContain("upstream 502");
  });
});
