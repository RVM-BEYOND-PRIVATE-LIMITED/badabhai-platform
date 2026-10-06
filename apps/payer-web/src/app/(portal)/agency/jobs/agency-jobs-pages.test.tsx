import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { AgencyJob } from "../../../../lib/contracts";
import type { PayerSession } from "../../../../lib/auth/types";
import type * as ConfigModule from "../../../../lib/config";

/**
 * The AGENCY posting pages (owner ruling 2026-10-01: an agency posts agency `jobs` only):
 *   /agency/jobs        "Postings"    — its own postings, managed in one place;
 *   /agency/jobs/new    "New posting" — every agency "post" entry point opens it;
 *   /agency/jobs/<id>   "Posting details";
 *   /agency/jobs/<id>/edit "Edit posting" (final sweep F02 — it replaced the inline row editor).
 * Each gates like every agency page: `requireAgent()` FIRST (anyone else gets the neutral 404),
 * then the agency-portal flag (off → the route does not exist) — both BEFORE any read. The
 * details and edit pages also refuse a non-uuid id before the read. The details header has the
 * company detail's contract (F14): the primary opens the posting's REAL applicants (#1956 — the
 * feed serves them since #1955), the secondary edits it.
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
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: (to: string) => redirect(to),
}));
vi.mock("../../../../lib/payer-api", () => ({
  listAgencyJobs: () => listAgencyJobs(),
  getAgencyJob: (id: string) => getAgencyJob(id),
}));
vi.mock("../dashboard/agency-jobs-manager", () => ({ AgencyJobsManager: () => null }));
const NewAgencyPostingStub = vi.fn(() => null);
vi.mock("./new/new-agency-posting", () => ({ NewAgencyPosting: NewAgencyPostingStub }));
const EditAgencyPostingStub = vi.fn(() => null);
vi.mock("./[jobId]/edit/edit-agency-posting", () => ({ EditAgencyPosting: EditAgencyPostingStub }));
vi.mock("../../../../components/job-card-preview", () => ({ JobCardPreview: () => null }));
vi.mock("../../../../components/retry-button", () => ({ RetryButton: () => null }));

const { PageHeader } = await import("../../../../components/page-header");
const list = await import("./page");
const create = await import("./new/page");
const detail = await import("./[jobId]/page");
const edit = await import("./[jobId]/edit/page");

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

/** The page's ONE PageHeader — in its children, or in the `lead` it hands a posting form. */
function head(tree: unknown): Record<string, unknown> {
  const found: ReactElement[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<{ children?: ReactNode; lead?: ReactNode }>;
    if (el.type === PageHeader) found.push(el);
    if (el.props && "children" in el.props) walk(el.props.children);
    if (el.props && "lead" in el.props) walk(el.props.lead);
  })(tree as ReactNode);
  expect(found).toHaveLength(1);
  return found[0]!.props as Record<string, unknown>;
}

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  flags.agencyPortalEnabled = true;
  notFound.mockClear();
  redirect.mockClear();
  EditAgencyPostingStub.mockClear();
  listAgencyJobs.mockReset().mockResolvedValue([JOB]);
  getAgencyJob.mockReset().mockImplementation(async (id) => (id === JOB.id ? JOB : null));
});

const PAGES = [
  ["/agency/jobs", () => list.default()],
  ["/agency/jobs/new", () => create.default()],
  ["/agency/jobs/<id>", () => detail.default(params(JOB.id))],
  ["/agency/jobs/<id>/edit", () => edit.default(params(JOB.id))],
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

  it("New posting (F01): the head LEADS the form column, so the card rail starts at the top", async () => {
    // Rendered above the form instead, the head pushed the rail 76px down and the publish button
    // out of a 720px viewport (measured: rail top 161 vs the company form's 85).
    const tree = (await create.default()) as ReactElement<{ lead?: ReactNode }>;
    expect(tree.type).toBe(NewAgencyPostingStub);
    const lead = tree.props.lead as ReactElement<{ title: string }>;
    expect(lead.type).toBe(PageHeader);
    expect(lead.props.title).toBe("New posting");
  });

  it("Posting details (F14): status · primary Applicants (#1956) · secondary Edit posting", async () => {
    const tree = await detail.default(params(JOB.id));
    const h = head(tree);
    expect(h.title).toBe("CNC Operator");
    expect(h.back).toEqual({ href: "/agency/jobs", label: "Postings" });
    expect(h.status).toBeDefined();
    expect(h.primaryAction).toEqual({
      href: `/agency/jobs/${JOB.id}/applicants`,
      label: "Applicants",
      icon: "users-three",
    });
    expect(h.secondaryActions).toEqual([
      { href: `/agency/jobs/${JOB.id}/edit`, label: "Edit posting", icon: "pencil-simple" },
    ]);
  });

  it("Posting details: a closed or suspended posting offers no edit door (as on its list row)", async () => {
    for (const status of ["closed", "suspended"] as const) {
      getAgencyJob.mockResolvedValueOnce({ ...JOB, status });
      const h = head(await detail.default(params(JOB.id)));
      expect(h.primaryAction).toMatchObject({ label: "Applicants" });
      expect(h.secondaryActions, status).toEqual([]);
    }
  });

  it("Edit posting (F02): back to the posting's details, H1 'Edit posting', no header action", async () => {
    const h = head(await edit.default(params(JOB.id)));
    expect(h.back).toEqual({ href: `/agency/jobs/${JOB.id}`, label: "Posting details" });
    expect(h.title).toBe("Edit posting");
    expect(h.primaryAction).toBeUndefined();
    expect(h.secondaryActions ?? []).toEqual([]);
  });
});

describe("/agency/jobs/<id>/edit — the dedicated edit page (F02, replaces the inline row editor)", () => {
  type FormProps = { job: AgencyJob; lead: ReactNode };
  async function form(): Promise<ReactElement<FormProps>> {
    const tree = (await edit.default(params(JOB.id))) as ReactElement<FormProps>;
    expect(tree.type).toBe(EditAgencyPostingStub);
    return tree;
  }

  it("hands the form the posting it read, and its head as the form column's LEAD (rail at the top)", async () => {
    const el = await form();
    expect(el.props.job).toEqual(JOB);
    expect((el.props.lead as ReactElement).type).toBe(PageHeader);
  });

  it("keys the form on the saved revision — a newer copy of the posting is a NEW form", async () => {
    const first = await form();
    getAgencyJob.mockResolvedValueOnce({ ...JOB, updatedAt: "2026-09-02T00:00:00.000Z" });
    const second = await form();
    expect(first.key).toBe(JOB.updatedAt);
    expect(second.key).toBe("2026-09-02T00:00:00.000Z");
  });

  it("a non-uuid id is a 404 BEFORE the read", async () => {
    await expect(edit.default(params("../credits"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyJob).not.toHaveBeenCalled();
  });

  it("an unknown or not-owned job is the same neutral 404", async () => {
    await expect(edit.default(params("00000001-0000-4000-8000-0000000000ff"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(getAgencyJob).toHaveBeenCalledTimes(1);
  });

  it("a closed or suspended posting is not edited here — the page sends the payer to its details", async () => {
    for (const status of ["closed", "suspended"] as const) {
      getAgencyJob.mockResolvedValueOnce({ ...JOB, status });
      await expect(edit.default(params(JOB.id))).rejects.toThrow(`NEXT_REDIRECT /agency/jobs/${JOB.id}`);
    }
    expect(EditAgencyPostingStub).not.toHaveBeenCalled();
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

describe("/agency/jobs — FACELESS: a payload that regressed to carry worker PII never renders", () => {
  it("a row with a forbidden key trips the page's guard: the error state renders, the value never does", async () => {
    // A regressed list payload (the guard's job): assertNoAgencyPII throws on the forbidden keys
    // (dev / test), the page degrades to its neutral retry state, and neither the manager nor
    // the markup ever receives the values.
    listAgencyJobs.mockResolvedValue([
      JOB,
      { ...JOB, id: "00000001-0000-4000-8000-000000000002", name: "Ramesh Kumar", phone: "+919812345678" } as AgencyJob,
    ]);
    const tree = await list.default();
    const s = JSON.stringify(tree);
    expect(s).toContain("Postings are unavailable right now");
    expect(s).not.toContain("Ramesh Kumar");
    expect(s).not.toContain("+919812345678");
    // …and the manager (which would receive the rows as props) is not rendered at all.
    expect(s).not.toContain("CNC Operator");
  });

  it("the guard does not fire on a faceless payload (the manager renders it)", async () => {
    const s = JSON.stringify(await list.default());
    expect(s).not.toContain("Postings are unavailable right now");
    expect(s).toContain("CNC Operator");
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
