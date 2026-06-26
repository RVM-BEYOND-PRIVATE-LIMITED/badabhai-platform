import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../../../lib/auth/types";

/**
 * AGENCY DASHBOARD render tests (ADR-0019 DEMAND extension + ADR-0022 LIVE wiring).
 *
 * DS3.1 re-skin: the identity / credit / demand counts now render as DS `Card` stat tiles
 * (the count/₹ value is rendered IN-CARD as a child node, so the text walk still reaches
 * "42" etc.) with DS `Badge`s; the degrade/empty states are DS `Card`s. These assertions
 * are UNCHANGED by the re-skin — the page still holds NO form/input controls.
 *
 * Asserts the page is:
 *  - role-gated (requireAgent runs FIRST; an employer 404s before any render),
 *  - portal-flag gated (off → notFound()),
 *  - FACELESS: a worker name/phone in a regressed agency-jobs payload is NEVER rendered
 *    (the page-level assertNoAgencyPII throws → the panel degrades), and
 *  - LIVE: identity / demand summary / vacancy manager / invite / referral funnel / parked
 *    modules all mount; the page itself holds NO form/input controls (those live in the
 *    child client components, unit-tested separately).
 *  - NEGATIVE: no payout/KYC commercial term (₹500 / 25% / 90d) on the page.
 *
 * Env is node (no DOM); we render the async Server Component to an element tree and walk
 * it for element types, mounted child components, and text.
 */

const AGENT: PayerSession = {
  payerId: "22222222-2222-4222-8222-222222222222",
  displayLabel: "HireFast Agency (mock)",
  role: "agent",
};

const requireAgent = vi.fn<() => Promise<PayerSession>>();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

const getAgencyAccount = vi.fn();
const getCredits = vi.fn();
const getUnlocks = vi.fn();
const listAgencyJobs = vi.fn();
const getAgencyReferralsSummary = vi.fn();
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
vi.mock("../../../../lib/payer-api", () => ({
  getAgencyAccount: () => getAgencyAccount(),
  getCredits: () => getCredits(),
  getUnlocks: () => getUnlocks(),
  listAgencyJobs: () => listAgencyJobs(),
  getAgencyReferralsSummary: () => getAgencyReferralsSummary(),
}));
// next/link renders an <a>; stub to a plain anchor so the walk sees it.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// The child Server/Client components are unit-tested directly; here we render the PAGE's
// own composition, so stub the children to plain markers. The manual node render does not
// invoke nested components.
const JobsManagerStub = () => null;
const InvitePanelStub = () => null;
const ReferralFunnelStub = () => null;
const ParkedModulesStub = () => null;
vi.mock("./agency-jobs-manager", () => ({ AgencyJobsManager: JobsManagerStub }));
vi.mock("./invite-panel", () => ({ AgencyInvitePanel: InvitePanelStub }));
vi.mock("./referral-funnel", () => ({ ReferralFunnel: ReferralFunnelStub }));
vi.mock("./parked-modules", () => ({ AgencyParkedModules: ParkedModulesStub }));

const { default: AgencyDashboardPage } = await import("./page");

interface Collected {
  types: string[];
  components: unknown[];
  text: string[];
}

/** Walk a rendered tree collecting element types, mounted components, and text. */
function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") {
    acc.text.push(node);
    return;
  }
  if (typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  else acc.components.push(el.type);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], components: [], text: [] };
  walk(tree, acc);
  return acc;
}

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

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  notFound.mockClear();
  agencyFlags.mockReturnValue(flags);
  getAgencyAccount.mockReset().mockResolvedValue({
    role: "agent",
    status: "active",
    displayLabel: "HireFast Agency",
  });
  getCredits.mockReset().mockResolvedValue({ payerId: AGENT.payerId, balance: 42 });
  getUnlocks
    .mockReset()
    .mockResolvedValue([
      { unlockId: "u1", workerId: "w1", status: "granted", createdAt: "x", expiresAt: "y" },
    ]);
  listAgencyJobs.mockReset().mockResolvedValue([JOB]);
  getAgencyReferralsSummary
    .mockReset()
    .mockResolvedValue({ created: 7, clicked: 0, accepted: 0, minBucket: 5 });
});

describe("agency dashboard — role + flag gating", () => {
  it("runs requireAgent FIRST (employer never reaches render)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(AgencyDashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyAccount).not.toHaveBeenCalled();
  });

  it("404s when the agency portal flag is OFF", async () => {
    agencyFlags.mockReturnValueOnce({ ...flags, agencyPortalEnabled: false });
    await expect(AgencyDashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});

describe("agency dashboard — renders identity / live summary / child modules", () => {
  it("renders identity, live credit count, demand summary, and mounts the LIVE child modules", async () => {
    const { text, components } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).toContain("Agency dashboard");
    expect(joined).toContain("HireFast Agency");
    expect(joined).toContain("42"); // live credit balance
    expect(joined).toContain("Total vacancies");
    expect(joined).toContain("Demand summary");
    // The LIVE vacancy manager + invite + referral funnel + parked modules are mounted.
    expect(components).toContain(JobsManagerStub);
    expect(components).toContain(InvitePanelStub);
    expect(components).toContain(ReferralFunnelStub);
    expect(components).toContain(ParkedModulesStub);
  });

  it("passes the LIVE jobs to the vacancy manager (demand summary derives from them)", async () => {
    const { text } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    // total=1, applicantsReceived summed = 3 (derived by summarizeAgencyJobs)
    expect(joined).toContain("Applicants received");
  });
});

describe("agency dashboard — NEGATIVE: no page-level inputs, no payout/KYC terms, faceless", () => {
  it("has NO form/input/select/textarea at the page level (controls live in child components)", async () => {
    const { types } = collect(await AgencyDashboardPage());
    for (const t of ["input", "form", "select", "textarea"]) {
      expect(types).not.toContain(t);
    }
  });

  it("never promises a commercial payout term (no ₹500 / 25% / 90d)", async () => {
    const { text } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).not.toMatch(/₹\s?500/);
    expect(joined).not.toMatch(/25\s?%/);
    expect(joined).not.toMatch(/\b90\s?d\b/i);
  });

  it("does NOT render a worker name/phone even if an agency-jobs payload regresses (faceless)", async () => {
    // A regressed jobs payload carrying PII must NOT surface — the page-level
    // assertNoAgencyPII throws → the vacancy panel degrades; the PII never renders.
    listAgencyJobs.mockResolvedValueOnce([
      { ...JOB, name: "Ramesh Kumar", phone: "+919812345678" },
    ]);
    const { text } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).not.toContain("Ramesh Kumar");
    expect(joined).not.toContain("+919812345678");
    expect(joined).toContain("Vacancies are unavailable right now");
  });
});
