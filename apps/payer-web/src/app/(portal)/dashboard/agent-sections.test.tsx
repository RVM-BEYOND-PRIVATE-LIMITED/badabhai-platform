import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../../lib/auth/types";
import { Card } from "../../../components/ds";

/**
 * AGENT SECTIONS render tests (MERGE-1 — the agency demand modules of the unified /dashboard).
 * Carried over from the former agency/dashboard/dashboard.test.tsx and retargeted to the
 * extracted server component.
 *
 * Asserts the section is:
 *  - role-gated (requireAgent runs FIRST; an employer 404s before any agency read), as
 *    defence-in-depth on top of the page's own isAgency branch,
 *  - portal-flag gated (off → notFound()),
 *  - FACELESS: a worker name/phone in a regressed agency-jobs payload is NEVER rendered
 *    (the section-level assertNoAgencyPII throws → the panel degrades), and
 *  - LIVE: identity / demand summary / vacancy manager / invite / referral funnel / parked
 *    modules all mount; the section itself holds NO form/input controls (those live in the
 *    child client components, unit-tested separately).
 *  - NEGATIVE: no payout/KYC commercial term (₹500 / 25% / 90d) in the section.
 *  - CARDS-1: the "Total vacancies" tile points at the SAME-PAGE #agency-vacancies anchor on
 *    /dashboard (no longer /agency/dashboard), with NO worker PII in any tile href.
 *
 * Env is node (no DOM); we render the async Server Component to an element tree and walk it.
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

const getAgencyAccount = vi.fn();
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

vi.mock("../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../lib/config", () => ({ agencyFlags: () => agencyFlags() }));
vi.mock("../../../lib/payer-api", () => ({
  getAgencyAccount: () => getAgencyAccount(),
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
// The child Server/Client components are unit-tested directly; here we render the SECTION's
// own composition, so stub the children (which live under ../agency/dashboard/) to plain
// markers. The manual node render does not invoke nested components.
const JobsManagerStub = () => null;
const InvitePanelStub = () => null;
const ReferralFunnelStub = () => null;
const ParkedModulesStub = () => null;
vi.mock("../agency/dashboard/agency-jobs-manager", () => ({ AgencyJobsManager: JobsManagerStub }));
vi.mock("../agency/dashboard/invite-panel", () => ({ AgencyInvitePanel: InvitePanelStub }));
vi.mock("../agency/dashboard/referral-funnel", () => ({ ReferralFunnel: ReferralFunnelStub }));
vi.mock("../agency/dashboard/parked-modules", () => ({ AgencyParkedModules: ParkedModulesStub }));

const { AgentSections } = await import("./agent-sections");

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

/** Collect every element of `type` in the tree (for the CARDS-1 wiring assertions). */
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
const prop = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;
const labelOf = (el: ReactElement): string => {
  const lbl = findAll(el, "span").find((s) =>
    String((prop(s).className as string) ?? "").includes("agency-stat__label"),
  );
  const child = lbl ? (prop(lbl).children as ReactNode) : "";
  return typeof child === "string" ? child : "";
};

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
  listAgencyJobs.mockReset().mockResolvedValue([JOB]);
  getAgencyReferralsSummary
    .mockReset()
    .mockResolvedValue({ created: 7, clicked: 0, accepted: 0, minBucket: 5 });
});

describe("agent sections — role + flag gating (defence-in-depth)", () => {
  it("runs requireAgent FIRST (an employer never reaches an agency read)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(AgentSections()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyAccount).not.toHaveBeenCalled();
    expect(listAgencyJobs).not.toHaveBeenCalled();
  });

  it("404s when the agency portal flag is OFF (before any read)", async () => {
    agencyFlags.mockReturnValueOnce({ ...flags, agencyPortalEnabled: false });
    await expect(AgentSections()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});

describe("agent sections — renders identity / demand summary / child modules", () => {
  it("renders identity, demand summary, and mounts the LIVE child modules", async () => {
    const { text, components } = collect(await AgentSections());
    const joined = text.join(" ");
    expect(joined).toContain("Your agency");
    expect(joined).toContain("HireFast Agency");
    expect(joined).toContain("Total vacancies");
    expect(joined).toContain("Demand summary");
    expect(components).toContain(JobsManagerStub);
    expect(components).toContain(InvitePanelStub);
    expect(components).toContain(ReferralFunnelStub);
    expect(components).toContain(ParkedModulesStub);
  });

  it("passes the LIVE jobs to the vacancy manager (demand summary derives from them)", async () => {
    const { text } = collect(await AgentSections());
    expect(text.join(" ")).toContain("Applicants received");
  });
});

describe("agent sections — NEGATIVE: no section-level inputs, no payout/KYC terms, faceless", () => {
  it("has NO form/input/select/textarea at the section level (controls live in child components)", async () => {
    const { types } = collect(await AgentSections());
    for (const t of ["input", "form", "select", "textarea"]) {
      expect(types).not.toContain(t);
    }
  });

  it("never promises a commercial payout term (no ₹500 / 25% / 90d)", async () => {
    const { text } = collect(await AgentSections());
    const joined = text.join(" ");
    expect(joined).not.toMatch(/₹\s?500/);
    expect(joined).not.toMatch(/25\s?%/);
    expect(joined).not.toMatch(/\b90\s?d\b/i);
  });

  it("does NOT render a worker name/phone even if an agency-jobs payload regresses (faceless)", async () => {
    // A regressed jobs payload carrying PII must NOT surface — the section-level
    // assertNoAgencyPII throws → the vacancy panel degrades; the PII never renders.
    listAgencyJobs.mockResolvedValueOnce([{ ...JOB, name: "Ramesh Kumar", phone: "+919812345678" }]);
    const { text } = collect(await AgentSections());
    const joined = text.join(" ");
    expect(joined).not.toContain("Ramesh Kumar");
    expect(joined).not.toContain("+919812345678");
    expect(joined).toContain("Vacancies are unavailable right now");
  });
});

describe("CARDS-1 · agent tiles are whole-card links to their REAL routes (faceless)", () => {
  it("wires identity → /account and total-vacancies → the SAME-PAGE /dashboard #-anchor", async () => {
    const tree = await AgentSections();
    const cards = findAll(tree, Card);
    const byLabel = (l: string) => cards.find((c) => labelOf(c) === l);

    expect(prop(byLabel("Account")!).href).toBe("/account");
    // MERGE-1: the demand tile now anchors WITHIN /dashboard (not /agency/dashboard).
    expect(prop(byLabel("Total vacancies")!).href).toBe("/dashboard#agency-vacancies");

    // every LINKED tile carries a non-empty accessible name
    for (const c of cards) {
      const href = prop(c).href;
      if (typeof href === "string") {
        expect(String(prop(c).ariaLabel ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("NO worker PII (uuid / phone-shaped / +91) appears in ANY tile href", async () => {
    const tree = await AgentSections();
    const hrefs = findAll(tree, Card)
      .map((c) => prop(c).href)
      .filter((h): h is string => typeof h === "string");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      expect(h).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(h).not.toMatch(/\b\d{10}\b/);
      expect(h).not.toMatch(/\+91/);
      // every tile href is a static app route (no interpolated id at all)
      expect(h).toMatch(/^\/(account|dashboard#agency-vacancies)$/);
    }
  });
});
