import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../../lib/auth/types";
import { Card, StatTile } from "../../../components/ds";
import { PortalLink } from "../../../components/portal-link";
import { linkCues } from "../../../../test/link-cues";

/**
 * AGENCY DASHBOARD (designr8) — the agency branch of the unified /dashboard.
 *
 * The section owns its role/flag gates, reads only aggregate agency data, and keeps every
 * worker-facing payload faceless. The KPI strip, pipeline panel, referral funnel and recent
 * unlocks are asserted as COMPOSITION here; their child panels are plain markup.
 */

const AGENT: PayerSession = {
  payerId: "22222222-2222-4222-8222-222222222222",
  displayLabel: "HireFast Agency (mock)",
  role: "agent",
  status: "active",
};

const requireAgent = vi.fn<() => Promise<PayerSession>>();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const listAgencyJobs = vi.fn();
const getAgencyReferralsSummary = vi.fn();
const flags = { agencyPortalEnabled: true };
const agencyFlags = vi.fn(() => flags);

vi.mock("../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../lib/config", () => ({ agencyFlags: () => agencyFlags() }));
vi.mock("../../../lib/payer-api", () => ({
  listAgencyJobs: () => listAgencyJobs(),
  getAgencyReferralsSummary: () => getAgencyReferralsSummary(),
}));

const { AgentSections } = await import("./agent-sections");

const JOB = {
  id: "00000001-0000-4000-8000-000000000001",
  status: "open" as const,
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: null,
  payMin: null,
  payMax: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  neededBy: null,
  applicantsReceived: 3,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

const PROPS = {
  credits: { payerId: "p", balance: 50 },
  unlocks: [],
};

interface Collected {
  types: string[];
  components: unknown[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") return void acc.text.push(node);
  if (typeof node === "number") return void acc.text.push(String(node));
  if (Array.isArray(node)) return void node.forEach((c) => walk(c, acc));
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  else acc.components.push(el.type);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], components: [], text: [] };
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

function findByClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findByClass(c, cls, acc));
    return acc;
  }
  const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
  const cn = el.props?.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
  if (el.props && "children" in el.props) findByClass(el.props.children, cls, acc);
  return acc;
}

const p = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;
const textOf = (node: ReactNode): string => collect(node).text.join(" ");

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  notFound.mockClear();
  agencyFlags.mockReturnValue(flags);
  listAgencyJobs.mockReset().mockResolvedValue([JOB]);
  getAgencyReferralsSummary
    .mockReset()
    .mockResolvedValue({ created: 7, clicked: 0, accepted: 0, minBucket: 5 });
});

describe("agency dashboard — role + flag gating", () => {
  it("runs requireAgent FIRST (an employer never reaches an agency read)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(AgentSections(PROPS)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listAgencyJobs).not.toHaveBeenCalled();
    expect(getAgencyReferralsSummary).not.toHaveBeenCalled();
  });

  it("renders NOTHING (and reads nothing) when the agency portal flag is OFF", async () => {
    agencyFlags.mockReturnValueOnce({ ...flags, agencyPortalEnabled: false });
    await expect(AgentSections(PROPS)).resolves.toBeNull();
    expect(notFound).not.toHaveBeenCalled();
    expect(listAgencyJobs).not.toHaveBeenCalled();
    expect(getAgencyReferralsSummary).not.toHaveBeenCalled();
  });
});

describe("agency dashboard — designr8 KPI strip", () => {
  it("renders the four counters from the credit, unlock, jobs and referral reads", async () => {
    const tree = await AgentSections({
      ...PROPS,
      unlocks: [
        { unlockId: "u1", workerId: "worker-uuid", status: "granted", createdAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-12-20T00:00:00.000Z", grantedAt: "2026-06-20T00:00:00.000Z", jobPostingId: null },
        { unlockId: "u2", workerId: "worker-uuid-2", status: "expired", createdAt: "2026-05-01T00:00:00.000Z", expiresAt: "2026-06-01T00:00:00.000Z", grantedAt: "2026-05-01T00:00:00.000Z", jobPostingId: null },
      ] as never,
    });
    const tiles = findAll(tree, StatTile);
    expect(tiles).toHaveLength(4);
    const byLabel = (l: string) => tiles.find((t) => p(t).label === l);
    expect(p(byLabel("Credit balance")!).value).toBe(50);
    expect(p(byLabel("Contacts unlocked")!).value).toBe(2);
    expect(p(byLabel("Demand summary")!).value).toBe(1);
    expect(p(byLabel("Worker referrals")!).value).toBe("7");
    expect(textOf(p(byLabel("Contacts unlocked")!).caption as ReactNode)).toContain(
      "1 credit / 1 profile",
    );
    // #2744: a read balance carries no per-unlock price — no caption at all.
    expect(p(byLabel("Credit balance")!).caption).toBeUndefined();
  });

  it("the credit card's Top-up is the one /credits door in the strip", async () => {
    const cues = linkCues(await AgentSections(PROPS));
    expect(cues.get("/credits")).toEqual(["Credits", "Credits"]);
  });
});

describe("agency dashboard — postings pipeline", () => {
  it("renders the three pipeline figures and the empty state when there are no postings", async () => {
    listAgencyJobs.mockResolvedValueOnce([]);
    const tree = await AgentSections(PROPS);
    const text = textOf(tree);
    expect(text).toContain("Your Postings & Recruitment Pipeline");
    expect(text).toContain("TOTAL POSTINGS");
    expect(text).toContain("ACTIVE OPEN");
    expect(text).toContain("APPLICANTS RECEIVED");
    expect(text).toContain("No active postings yet");
    const hrefs = [...findAll(tree, PortalLink), ...findAll(tree, Card)]
      .map((a) => p(a).href)
      .filter(Boolean);
    expect(hrefs).toContain("/agency/jobs/new");
    expect(hrefs).toContain("/agency/jobs");
  });

  it("glances at up to three agency jobs, each opening its own details + applicants", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...JOB,
      id: `00000001-0000-4000-8000-00000000000${i}`,
    }));
    listAgencyJobs.mockResolvedValueOnce(many);
    const tree = await AgentSections(PROPS);
    const cards = findByClass(tree, "dash-posting");
    expect(cards).toHaveLength(3);
    const hrefs = [...findAll(tree, PortalLink), ...findAll(tree, Card)]
      .map((a) => p(a).href)
      .filter(Boolean);
    expect(hrefs).toContain(`/agency/jobs/${many[0]!.id}`);
    expect(hrefs).toContain(`/agency/jobs/${many[0]!.id}/applicants`);
  });

  it("never links the company posting surface", async () => {
    const tree = await AgentSections(PROPS);
    const hrefs = [...findAll(tree, PortalLink), ...findAll(tree, Card)]
      .map((a) => p(a).href)
      .filter(Boolean) as string[];
    expect(hrefs.filter((h) => h.startsWith("/postings"))).toEqual([]);
  });

  it("does NOT render a worker name/phone even if an agency-jobs payload regresses", async () => {
    listAgencyJobs.mockResolvedValueOnce([{ ...JOB, name: "Ramesh Kumar", phone: "+919812345678" }]);
    const text = textOf(await AgentSections(PROPS));
    expect(text).not.toContain("Ramesh Kumar");
    expect(text).not.toContain("+919812345678");
    expect(text).toContain("Postings are unavailable right now");
  });
});

describe("agency dashboard — referral funnel + recent unlocks", () => {
  it("shows the k-anon stages and ONE Invite workers door", async () => {
    const tree = await AgentSections(PROPS);
    const text = textOf(tree);
    expect(text).toContain("Referral Funnel & Growth");
    expect(text).toContain("INVITES SENT");
    expect(text).toContain("<5");
    const referrals = findAll(tree, PortalLink).filter((a) =>
      String(p(a).href).startsWith("/agency/referrals"),
    );
    expect(referrals).toHaveLength(1);
    expect(textOf(referrals[0]!)).toContain("Invite workers");
  });

  it("renders the recent-unlock empty state, and rows when unlocks exist", async () => {
    const empty = await AgentSections(PROPS);
    expect(textOf(empty)).toContain("No contacts unlocked yet");
    const withRows = await AgentSections({
      ...PROPS,
      unlocks: [
        { unlockId: "u1", workerId: "worker-uuid", status: "granted", createdAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-12-20T00:00:00.000Z", grantedAt: "2026-06-20T00:00:00.000Z", jobPostingId: null },
      ] as never,
    });
    expect(findByClass(withRows, "dash-unlock")).toHaveLength(1);
    expect(textOf(withRows)).toContain("Unlocked contact");
  });

  it("carries no worker id anywhere in the DOM or props", async () => {
    const tree = await AgentSections({
      ...PROPS,
      unlocks: [
        { unlockId: "u1", workerId: "worker-uuid-AAAA", status: "granted", createdAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-12-20T00:00:00.000Z", grantedAt: "2026-06-20T00:00:00.000Z", jobPostingId: null },
      ] as never,
    });
    expect(textOf(tree)).not.toContain("worker-uuid");
    const serialized = JSON.stringify(
      [...findAll(tree, PortalLink), ...findAll(tree, Card)].map((a) => ({
        href: p(a).href,
        label: p(a)["aria-label"],
      })),
    );
    expect(serialized).not.toContain("worker-uuid");
  });

  it("has no form/input/select/textarea", async () => {
    const { types } = collect(await AgentSections(PROPS));
    for (const t of ["input", "form", "select", "textarea"]) expect(types).not.toContain(t);
  });
});

describe("agency dashboard — navigation pending cues", () => {
  it("every in-app link names its destination", async () => {
    const cues = linkCues(await AgentSections(PROPS));
    expect(cues.get("/agency/jobs")).toEqual(["Postings"]);
    expect(cues.get("/agency/jobs/new")).toEqual(["New posting"]);
    expect(cues.get("/agency/referrals")).toEqual(["Referrals"]);
    expect([...cues].filter(([, labels]) => labels.length === 0)).toEqual([]);
  });
});

describe("#2581 — one label per destination, no unbacked claim", () => {
  it("every door to the agency form reads New posting, with postings and when there are none", async () => {
    for (const jobs of [[JOB], []]) {
      listAgencyJobs.mockResolvedValueOnce(jobs);
      const doors = findAll(await AgentSections(PROPS), PortalLink).filter(
        (a) => p(a).href === "/agency/jobs/new",
      );
      expect(doors.length, `${jobs.length} jobs`).toBeGreaterThan(0);
      for (const door of doors) {
        expect(textOf(door).trim(), `${jobs.length} jobs`).toBe("New posting");
      }
    }
  });

  it("the pipeline foot claims no matching speed and offers no drafting help", async () => {
    const text = textOf(await AgentSections(PROPS));
    for (const gone of ["Learn how", "talent engine", "within minutes", "Need help drafting"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("the unlock tile and the empty recent unlocks promise no direct phone, email or WhatsApp", async () => {
    const tree = await AgentSections(PROPS);
    const tile = findAll(tree, StatTile).find((t) => p(t).label === "Contacts unlocked");
    expect(tile).toBeDefined();
    // `textOf` walks children only, so the StatTile's `foot` prop is read on its own.
    expect(textOf(p(tile!).foot as ReactNode)).not.toMatch(/phone|email/i);
    const empty = findByClass(tree, "agency-empty-panel").find((el) =>
      textOf(el).includes("No contacts unlocked yet"),
    );
    expect(empty).toBeDefined();
    expect(textOf(empty!)).not.toMatch(/phone|email|mobile|whatsapp/i);
  });
});
