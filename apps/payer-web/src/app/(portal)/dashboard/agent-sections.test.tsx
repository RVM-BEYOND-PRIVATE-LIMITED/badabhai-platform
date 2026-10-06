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
 *  - portal-flag gated (off → renders nothing, reads nothing; the shared dashboard
 *    around it is unaffected),
 *  - FACELESS: a worker name/phone in a regressed agency-jobs payload is NEVER rendered
 *    (the section-level assertNoAgencyPII throws → the panel degrades), and
 *  - LIVE: identity / demand summary / a "Your postings" glance / referral funnel / parked
 *    modules all mount; the section holds NO form/input controls at all. Postings are MANAGED on
 *    /agency/jobs and CREATED on /agency/jobs/new — the dashboard links there.
 *  - NEGATIVE: no payout/KYC commercial term (₹500 / 25% / 90d) in the section.
 *  - CARDS-1: the only linked tile is the agency's own account (/account), with NO worker PII in
 *    any href; each glance card opens THAT posting's details and links its REAL applicants (#1956).
 *  - SHORTER (final sweep F15/F21 — 5,354px tall at 375): no tile mirrors a rail destination
 *    (Worker activity, QR invite, batch links), the dead bulk-upload tile is gone (F17), the invite
 *    FORM lives on Referrals only (the dashboard links there once), and the glance holds 3 rows.
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
const InvitePanelStub = () => null;
const ReferralFunnelStub = () => null;
const ParkedModulesStub = () => null;
// Still mocked so a regression that re-mounts the form here is SEEN (as this stub), not rendered.
vi.mock("../agency/dashboard/invite-panel", () => ({ AgencyInvitePanel: InvitePanelStub }));
vi.mock("../agency/dashboard/referral-funnel", () => ({ ReferralFunnel: ReferralFunnelStub }));
vi.mock("../agency/dashboard/parked-modules", () => ({ AgencyParkedModules: ParkedModulesStub }));

const { AgentSections } = await import("./agent-sections");
const { default: LinkStub } = await import("next/link");

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

  /**
   * THE FLAG HIDES THESE SECTIONS; IT DOES NOT KILL THE PAGE.
   *
   * This asserted `notFound()` until an agent hit a 500 on `/dashboard` with the flag off.
   * That was correct while the code guarded a standalone `/agency/dashboard` — a switched-off
   * surface should not exist. Once MERGE-1 moved the modules INLINE onto the SHARED dashboard,
   * the same call took the whole page down for an agent, and because `/agency/dashboard` is now
   * a `redirect()` here, they had no reachable home screen at all.
   *
   * Both halves are asserted, because only the pair is the contract: nothing renders (the
   * rollback works) AND no agency read runs (fail-closed is intact). A version that returned
   * the sections while skipping the fetches, or that fetched and then hid, would satisfy one
   * and not the other.
   */
  it("renders NOTHING (and reads nothing) when the agency portal flag is OFF", async () => {
    agencyFlags.mockReturnValueOnce({ ...flags, agencyPortalEnabled: false });

    await expect(AgentSections()).resolves.toBeNull();

    expect(notFound).not.toHaveBeenCalled();
    expect(getAgencyAccount).not.toHaveBeenCalled();
    expect(listAgencyJobs).not.toHaveBeenCalled();
    expect(getAgencyReferralsSummary).not.toHaveBeenCalled();
  });
});

describe("agent sections — renders identity / demand summary / child modules", () => {
  it("renders identity, demand summary, and mounts the LIVE child modules", async () => {
    const { text, components } = collect(await AgentSections());
    const joined = text.join(" ");
    expect(joined).toContain("Your agency");
    expect(joined).toContain("HireFast Agency");
    expect(joined).toContain("Total postings");
    expect(joined).toContain("Demand summary");
    expect(joined).toContain("Your postings");
    expect(components).toContain(ReferralFunnelStub);
    expect(components).toContain(ParkedModulesStub);
  });

  it("F21: the invite FORM is not on the dashboard — one link to Referrals, where it lives", async () => {
    const tree = await AgentSections();
    expect(collect(tree).components).not.toContain(InvitePanelStub);
    const toReferrals = findAll(tree, LinkStub).filter((a) =>
      String(prop(a).href).startsWith("/agency/referrals"),
    );
    expect(toReferrals.map((a) => prop(a).href)).toEqual(["/agency/referrals"]);
    expect(collect(toReferrals[0]!).text.join(" ")).toContain("Invite workers");
  });

  it("glances at the LIVE jobs (demand summary derives from them; each card → its details)", async () => {
    const tree = await AgentSections();
    const { text } = collect(tree);
    expect(text.join(" ")).toContain("Applicants received");
    const cards = findAll(tree, Card).filter((c) =>
      String(prop(c).className ?? "").split(/\s+/).includes("dash-posting"),
    );
    expect(cards).toHaveLength(1);
    expect(prop(cards[0]!).href).toBe(`/agency/jobs/${JOB.id}`);
    expect(String(prop(cards[0]!).ariaLabel)).toBe("CNC Operator — view posting");
  });

  it("links an agency posting's REAL applicants (#1956 — #1955 made the feed serve them)", async () => {
    const tree = await AgentSections();
    const hrefs = [...findAll(tree, LinkStub), ...findAll(tree, Card)]
      .map((a) => prop(a).href)
      .filter((h): h is string => typeof h === "string");
    expect(hrefs).toContain(`/agency/jobs/${JOB.id}/applicants`);
    // The card itself still opens the posting's details.
    expect(hrefs).toContain(`/agency/jobs/${JOB.id}`);
    expect(collect(tree).text.join(" ")).toContain("Applicants");
  });

  it("offers ONE way to Referrals, not one per funnel stage or invite tool", async () => {
    const tree = await AgentSections();
    const hrefs = [...findAll(tree, LinkStub), ...findAll(tree, Card)]
      .map((a) => prop(a).href)
      .filter((h): h is string => typeof h === "string");
    expect(hrefs.filter((h) => h.startsWith("/agency/referrals"))).toEqual(["/agency/referrals"]);
  });

  it("F21: the glance holds at most THREE postings and links to the full list ONCE", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...JOB,
      id: `00000001-0000-4000-8000-00000000000${i}`,
    }));
    listAgencyJobs.mockResolvedValueOnce(many);
    const tree = await AgentSections();
    const cards = findAll(tree, Card).filter((c) =>
      String(prop(c).className ?? "").split(/\s+/).includes("dash-posting"),
    );
    expect(cards).toHaveLength(3);
    const toList = [...findAll(tree, LinkStub), ...findAll(tree, Card)].filter(
      (a) => prop(a).href === "/agency/jobs",
    );
    expect(toList).toHaveLength(1);
  });

  it("offers NO create control and never the company posting surface", async () => {
    const tree = await AgentSections();
    const joined = collect(tree).text.join(" ");
    expect(joined).not.toMatch(/Post a vacancy|Post vacancy/);
    const hrefs = [
      ...findAll(tree, LinkStub).map((a) => prop(a).href),
      ...findAll(tree, Card).map((c) => prop(c).href),
    ].filter((h): h is string => typeof h === "string");
    expect(hrefs).toContain("/agency/jobs");
    expect(hrefs.filter((h) => h.startsWith("/postings"))).toEqual([]);
    expect(hrefs).not.toContain("/agency/jobs/new");
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
    expect(joined).toContain("Postings are unavailable right now");
  });
});

describe("F15/F17 · no tile mirrors a rail destination, and no door to a dead module", () => {
  it("never advertises bulk upload (dead, ADR-0022 Amdt 3) — no tile, no link, no 'coming soon'", async () => {
    const tree = await AgentSections();
    const joined = collect(tree).text.join(" ");
    // Module 2 is DEAD with NO gate ("no gate ever revives bulk raw-phone ingest/export"):
    // promising it is a promise the product must never keep — and a tile that only says "not
    // available" is a dead end (F17).
    expect(joined).not.toMatch(/coming soon/i);
    expect(joined).not.toMatch(/upload multiple invites/i);
    expect(joined).not.toMatch(/\bat scale\b/i);
    expect(joined).not.toMatch(/bulk/i);
    const hrefs = [...findAll(tree, LinkStub), ...findAll(tree, Card)].map((a) => prop(a).href);
    expect(hrefs).not.toContain("/agency/bulk-upload");
  });

  it("no tile repeats the rail: Worker activity, QR invite and batch links are the rail's (or Referrals')", async () => {
    const tree = await AgentSections();
    const hrefs = [...findAll(tree, LinkStub), ...findAll(tree, Card)].map((a) => prop(a).href);
    for (const railOnly of ["/agency/workers", "/agency/qr", "/agency/referrals#batch-invites"]) {
      expect(hrefs, railOnly).not.toContain(railOnly);
    }
    const labels = findAll(tree, Card).map(labelOf);
    for (const gone of ["Worker activity", "QR invite", "Batch invites", "Bulk invite upload"]) {
      expect(labels, gone).not.toContain(gone);
    }
    expect(collect(tree).text.join(" ")).not.toContain("Invite tools");
  });
});

describe("CARDS-1 · agent tiles are whole-card links to their REAL routes (faceless)", () => {
  it("wires identity → /account; total-postings is a count (the panel links to Postings)", async () => {
    const tree = await AgentSections();
    const cards = findAll(tree, Card);
    const byLabel = (l: string) => cards.find((c) => labelOf(c) === l);

    expect(prop(byLabel("Account")!).href).toBe("/account");
    // The demand tile is a count; "All postings" on the panel is the one door to the list.
    expect(prop(byLabel("Total postings")!).href).toBeUndefined();
    // The Revenue card is gone: the shared top's tile is the dashboard's one way to it.
    expect(byLabel("Revenue")).toBeUndefined();
    expect(cards.map((c) => prop(c).href)).not.toContain("/agency/revenue");
    // F15: Worker activity and QR invite are rail destinations — the rail is their door.
    expect(byLabel("QR invite")).toBeUndefined();
    expect(byLabel("Worker activity")).toBeUndefined();

    // every LINKED tile carries a non-empty accessible name
    for (const c of cards) {
      const href = prop(c).href;
      if (typeof href === "string") {
        expect(String(prop(c).ariaLabel ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("NO worker PII (uuid / phone-shaped / +91) appears in ANY tile or card href", async () => {
    const tree = await AgentSections();
    const cards = findAll(tree, Card);
    const isGlance = (c: ReactElement) =>
      String(prop(c).className ?? "").split(/\s+/).includes("dash-posting");
    const tileHrefs = cards
      .filter((c) => !isGlance(c))
      .map((c) => prop(c).href)
      .filter((h): h is string => typeof h === "string");
    expect(tileHrefs.length).toBeGreaterThan(0);
    for (const h of tileHrefs) {
      expect(h).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(h).not.toMatch(/\b\d{10}\b/);
      expect(h).not.toMatch(/\+91/);
      // every tile href is a static app route (no interpolated id at all)
      expect(h).toMatch(/^\/account$/);
    }
    // A glance card carries exactly ONE id — the posting's OWN — in one fixed shape.
    const glanceHrefs = cards.filter(isGlance).map((c) => String(prop(c).href));
    expect(glanceHrefs.length).toBeGreaterThan(0);
    for (const h of glanceHrefs) {
      expect(h).toMatch(/^\/agency\/jobs\/[0-9a-f-]{36}$/);
      expect(h).not.toMatch(/\b\d{10}\b/);
      expect(h).not.toMatch(/\+91/);
    }
  });
});
