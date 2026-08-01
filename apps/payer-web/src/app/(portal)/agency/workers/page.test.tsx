import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../../../lib/auth/types";
import type { AgencyWorker } from "../../../../lib/contracts";

/**
 * /agency/workers PAGE tests (ADR-0022 B5).
 *
 * Pins the three things the page is responsible for:
 *  - GATING: `requireAgent()` runs FIRST — an employer session 404s neutrally BEFORE the read
 *    runs (no client-side hiding); the agency-portal flag fail-closes the route too.
 *  - DEGRADE: a failed read (including the 429 this scrape-capped route can answer) renders a
 *    neutral retry Card — NOT an empty table, which would falsely read as "you have no
 *    referrals".
 *  - EMPTY ≠ ERROR: `[]` mounts the list (whose honest empty copy is tested in
 *    worker-activity-list.test.tsx) and shows no count line.
 *
 * Env is node (no DOM); the async Server Component is rendered to an element tree and walked.
 */

const AGENT: PayerSession = {
  payerId: "22222222-2222-4222-8222-222222222222",
  displayLabel: "HireFast Agency",
  role: "agent",
  status: "active",
};

const requireAgent = vi.fn<() => Promise<PayerSession>>();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const listAgencyWorkers = vi.fn();
const flags = {
  agencyPortalEnabled: true,
  agencySupplyEnabled: false,
  agencyKycEnabled: false,
  agencyPayoutsEnabled: false,
  agencyBulkUploadEnabled: false,
  agencyOutcomeTrackingEnabled: false,
};
const agencyFlags = vi.fn(() => flags);

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../../lib/config", () => ({ agencyFlags: () => agencyFlags() }));
vi.mock("../../../../lib/payer-api", () => ({ listAgencyWorkers: () => listAgencyWorkers() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// RetryButton is a client hook component; stub it (its behaviour is not this page's contract).
const RetryStub = () => null;
vi.mock("../../../../components/retry-button", () => ({ RetryButton: RetryStub }));

const { default: AgencyWorkersPage } = await import("./page");
const { WorkerActivityList } = await import("./worker-activity-list");

const WORKER: AgencyWorker = {
  ref: "9f3a71c40b28de55",
  profileComplete: true,
  appliedCount: 4,
  unlockedCount: 2,
  lastActiveOn: "2026-07-28",
};

interface Collected {
  text: string[];
  components: unknown[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type !== "string") acc.components.push(el.type);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { text: [], components: [] };
  walk(tree, acc);
  return acc;
}

function findAll(node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findAll(c, type, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) acc.push(el);
  if (el.props && "children" in el.props) findAll(el.props.children, type, acc);
  return acc;
}

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  notFound.mockClear();
  agencyFlags.mockReturnValue(flags);
  listAgencyWorkers.mockReset().mockResolvedValue([]);
});

describe("/agency/workers — gating (server-enforced, no client hide)", () => {
  it("runs requireAgent FIRST — an employer never reaches the read", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(AgencyWorkersPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listAgencyWorkers).not.toHaveBeenCalled();
  });

  it("404s when the agency portal flag is OFF, before any read", async () => {
    agencyFlags.mockReturnValueOnce({ ...flags, agencyPortalEnabled: false });
    await expect(AgencyWorkersPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(listAgencyWorkers).not.toHaveBeenCalled();
  });
});

describe("/agency/workers — EMPTY is a first-class state, not an error", () => {
  it("mounts the list with an empty array and shows no count line", async () => {
    const tree = await AgencyWorkersPage();
    const mounted = findAll(tree, WorkerActivityList);
    expect(mounted).toHaveLength(1);
    expect((mounted[0]!.props as { workers: AgencyWorker[] }).workers).toEqual([]);
    const joined = collect(tree).text.join(" ");
    expect(joined).not.toMatch(/Showing \d+ referred/);
    expect(joined).not.toMatch(/could not load/i);
  });
});

describe("/agency/workers — a populated read renders the list + a truthful count line", () => {
  it("passes the workers through and states how many are shown", async () => {
    listAgencyWorkers.mockResolvedValueOnce([WORKER]);
    const tree = await AgencyWorkersPage();
    const mounted = findAll(tree, WorkerActivityList);
    expect((mounted[0]!.props as { workers: AgencyWorker[] }).workers).toEqual([WORKER]);
    expect(collect(tree).text.join(" ")).toContain("Showing 1 referred worker.");
  });

  it("says the list is TRUNCATED at the backend cap rather than implying it is complete", async () => {
    listAgencyWorkers.mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, i) => ({ ...WORKER, ref: `ref${i}` })),
    );
    const joined = collect(await AgencyWorkersPage()).text.join(" ");
    expect(joined).toContain("Showing your 200 most recently active referrals.");
  });
});

describe("/agency/workers — a failed read degrades, it does not fake an empty list", () => {
  it("renders the neutral retry Card (and NOT the list) when the read throws", async () => {
    listAgencyWorkers.mockRejectedValueOnce(new Error("payer API /payer/agency/workers returned 429"));
    const tree = await AgencyWorkersPage();
    expect(findAll(tree, WorkerActivityList)).toHaveLength(0);
    const { text, components } = collect(tree);
    const joined = text.join(" ");
    expect(joined).toContain("could not load right now");
    expect(components).toContain(RetryStub);
    // No leaked status/deny reason (no-oracle) — the class of failure is never surfaced.
    expect(joined).not.toMatch(/429|rate|cap|consent|forbidden/i);
  });
});

describe("/agency/workers — FACELESS page copy", () => {
  it("states the privacy boundary and renders no worker PII", async () => {
    listAgencyWorkers.mockResolvedValueOnce([WORKER]);
    const joined = collect(await AgencyWorkersPage()).text.join(" ");
    expect(joined).toContain("private handle, not a person");
    expect(joined).not.toMatch(/\+?\d{7,}/);
  });
});
