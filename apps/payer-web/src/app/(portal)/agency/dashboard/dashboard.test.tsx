import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../../../lib/auth/types";

/**
 * AGENCY DASHBOARD render tests (ADR-0019 DEMAND extension).
 *
 * Asserts the page is:
 *  - role-gated (requireAgent runs FIRST; an employer 404s before any render),
 *  - portal-flag gated (off → notFound()),
 *  - FACELESS: a worker name/phone in a mocked payload is NEVER rendered,
 *  - HONEST: identity / demand summary / parked cards render; the invite control is
 *    DISABLED and its copy carries the consent requirement,
 *  - NEGATIVE: there is NO referral / payout / KYC / bulk input control on the page.
 *
 * Env is node (no DOM); we render the async Server Component to an element tree and
 * walk it for element types, prop flags (disabled), and text.
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
const getPostings = vi.fn();
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
  getPostings: () => getPostings(),
}));
// next/link renders an <a>; stub to a plain anchor so the walk sees it.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// The child Server/Client components are unit-tested directly (invite-panel.test,
// parked-modules.test). Here we render the PAGE's own composition, so we stub the
// children to plain markers — the manual node render does not invoke nested
// components. The invite/parked COPY + disabled control are asserted in their own
// tests; this file owns the page-level gating, faceless, and negative assertions.
const InvitePanelStub = () => null;
const ParkedModulesStub = () => null;
const PostingsManagerStub = () => null;
vi.mock("./invite-panel", () => ({ AgencyInvitePanel: InvitePanelStub }));
vi.mock("./parked-modules", () => ({ AgencyParkedModules: ParkedModulesStub }));
vi.mock("../../postings/postings-manager", () => ({ PostingsManager: PostingsManagerStub }));

const { default: AgencyDashboardPage } = await import("./page");

interface Collected {
  types: string[];
  /** Function-component references encountered (mounted child components). */
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

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue(AGENT);
  notFound.mockClear();
  agencyFlags.mockReturnValue(flags);
  getAgencyAccount.mockReset().mockResolvedValue({
    role: "agent",
    status: "active",
    displayLabel: "HireFast Agency",
  });
  getCredits.mockReset().mockResolvedValue({
    payerId: AGENT.payerId,
    balance: 42,
  });
  getUnlocks
    .mockReset()
    .mockResolvedValue([
      { unlockId: "u1", workerId: "w1", status: "granted", createdAt: "x", expiresAt: "y" },
    ]);
  getPostings.mockReset().mockResolvedValue([
    {
      id: "00000001-0000-4000-8000-000000000001",
      roleTitle: "CNC Operator",
      locationLabel: "Pune",
      vacancyBand: "1-5",
      status: "open",
      applicantCount: 0,
      createdAt: "2026-06-22T00:00:00.000Z",
    },
  ]);
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

describe("agency dashboard — renders identity / summary / child modules", () => {
  it("renders the agency identity, live counts, and mounts the invite + parked modules", async () => {
    const { text, components } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).toContain("Agency dashboard");
    expect(joined).toContain("HireFast Agency");
    expect(joined).toContain("Agency"); // role label
    expect(joined).toContain("42"); // live credit balance
    // The invite + parked module + postings sections are mounted (their content is
    // unit-tested in invite-panel.test / parked-modules.test).
    expect(components).toContain(InvitePanelStub);
    expect(components).toContain(ParkedModulesStub);
    expect(components).toContain(PostingsManagerStub);
  });

  it("shows honest '—' for counts with NO backend source (not fabricated)", async () => {
    const { text } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).toContain("Workers reached");
    expect(joined).toContain("Not available yet");
    expect(joined).toContain("—");
  });
});

describe("agency dashboard — NEGATIVE: no parked/dead controls, no PII", () => {
  it("has NO form/input/select/textarea anywhere (no referral/payout/KYC/bulk input)", async () => {
    const { types } = collect(await AgencyDashboardPage());
    for (const t of ["input", "form", "select", "textarea"]) {
      expect(types).not.toContain(t);
    }
  });

  it("never promises a commercial term (no ₹500 / 25% / 90d)", async () => {
    const { text } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).not.toMatch(/₹\s?500/);
    expect(joined).not.toMatch(/25\s?%/);
    expect(joined).not.toMatch(/\b90\s?d\b/i);
  });

  it("does NOT render a worker name/phone even if a payload regresses (faceless)", async () => {
    // A regressed postings payload carrying PII must NOT surface — the dashboard
    // catches the faceless-guard throw and degrades the panel.
    getPostings.mockResolvedValueOnce([
      {
        id: "00000001-0000-4000-8000-000000000001",
        roleTitle: "CNC Operator",
        locationLabel: "Pune",
        vacancyBand: "1-5",
        status: "open",
        applicantCount: 0,
        createdAt: "2026-06-22T00:00:00.000Z",
        name: "Ramesh Kumar",
        phone: "+919812345678",
      },
    ]);
    const { text } = collect(await AgencyDashboardPage());
    const joined = text.join(" ");
    expect(joined).not.toContain("Ramesh Kumar");
    expect(joined).not.toContain("+919812345678");
  });
});
