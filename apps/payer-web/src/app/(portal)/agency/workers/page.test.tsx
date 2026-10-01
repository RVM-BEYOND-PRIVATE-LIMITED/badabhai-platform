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
const { REFERRED_WORKERS_HEADING_ID, WorkerActivityList } = await import("./worker-activity-list");

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

/* ── W2-B hierarchy: the privacy boundary is ONE alert before the data; the head is the count ─ */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Every host/component element in render order. */
function elements(node: ReactNode, acc: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => elements(c, acc));
    return acc;
  }
  const el = node as El;
  acc.push(el);
  if (el.props && "children" in el.props) elements(el.props.children as ReactNode, acc);
  return acc;
}
const byClass = (tree: ReactNode, cls: string) =>
  elements(tree).filter(
    (e) =>
      typeof e.props?.className === "string" &&
      (e.props.className as string).split(/\s+/).includes(cls),
  );
const textIn = (el: El) => collect(el.props.children as ReactNode).text.join(" ");

describe("/agency/workers — W2-B: the privacy boundary is an alert that precedes the table", () => {
  it("renders an info alert whose headline is the first privacy sentence, BEFORE the panel", async () => {
    listAgencyWorkers.mockResolvedValueOnce([WORKER]);
    const tree = (await AgencyWorkersPage()) as El;
    expect(tree.props.className).toBe("agency-workers-page");
    const [alert] = byClass(tree, "alert--info");
    expect(alert).toBeDefined();
    expect(textIn(byClass(alert, "alert__title")[0]!)).toBe(
      "Every row is a private handle, not a person.",
    );
    expect(textIn(alert!)).toMatch(
      /never shows an agency a worker.s name, phone number or employer/,
    );
    // The job entity is a Posting everywhere (owner ruling 2026-10-01).
    expect(textIn(alert!)).toMatch(/which\s+posting they applied to/);
    expect(textIn(alert!)).not.toMatch(/\bjobs?\b/);
    // Reading order: the boundary is stated before any row is shown.
    const top = childrenOf(tree).map((k) => String(k.props.className ?? ""));
    expect(top.indexOf("alert alert--info")).toBeLessThan(top.indexOf("panel panel--table"));
  });

  it("the panel heading carries the id the table's region is named by", async () => {
    listAgencyWorkers.mockResolvedValueOnce([WORKER]);
    const heading = elements(await AgencyWorkersPage()).find(
      (e) => e.type === "h2" && textIn(e) === "Referred workers",
    );
    expect(heading).toBeDefined();
    expect(heading!.props.id).toBe(REFERRED_WORKERS_HEADING_ID);
  });

  it("the panel head is the title + the truthful count only (the prose moved to the alert)", async () => {
    listAgencyWorkers.mockResolvedValueOnce([WORKER]);
    const tree = await AgencyWorkersPage();
    const subs = byClass(tree, "panel__sub");
    expect(subs.map(textIn)).toEqual(["Showing 1 referred worker."]);
  });

  it("the handle-uniqueness line rides the count line: present when populated, absent when empty", async () => {
    listAgencyWorkers.mockResolvedValueOnce([WORKER]);
    const populated = collect(await AgencyWorkersPage()).text.join(" ");
    expect(populated).toContain("Handles are unique to your agency");
    const empty = collect(await AgencyWorkersPage()).text.join(" ");
    expect(empty).not.toContain("Handles are unique to your agency");
    // …while the boundary itself is stated in BOTH states.
    expect(empty).toContain("private handle, not a person");
  });
});

/** The direct child elements of a host element, in source order. */
function childrenOf(el: El): El[] {
  const kids = ([] as ReactNode[]).concat(el.props.children as ReactNode);
  return kids.filter((k): k is El => k !== null && typeof k === "object" && !Array.isArray(k));
}
