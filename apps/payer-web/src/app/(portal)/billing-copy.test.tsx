import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { Capacity, Dashboard } from "../../lib/contracts";
import type { PayerSession } from "../../lib/auth/types";

/**
 * NO "MOCK" WORDING ON PLANS AND CREDITS — owner ruling 2026-10-07 ("mock wording is not needing
 * on plans and credit"; sweep finding F35).
 *
 * /plans (with the Hiring capacity panel it renders) and /credits must not show a customer any
 * "mock" / "(mock)" / "Buy (mock)" / "staging preview" copy — in EITHER payment posture
 * (`paymentsEnableReal` off or on), with the live catalog or the cached fallback, and when a read
 * fails. No replacement disclaimer is asserted either way: the ruling says the wording is not
 * needed, and the purchase behaviour itself is pinned by the panels' own suites.
 *
 * The pages are rendered through React's server renderer WITH their real client panels (only the
 * Server Actions behind them are inert), so a label inside a panel is fenced too. The panels'
 * confirm dialogs are closed on a server render; their copy is fenced in the panel suites.
 */

const OWNER: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Manufacturing",
  role: "employer",
  status: "active",
};

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const requireOwner = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn<(s: unknown) => "owner" | "recruiter">();
const getCapacity = vi.fn<() => Promise<Capacity>>();
const getDashboard = vi.fn<(o: unknown) => Promise<Dashboard>>();
const getCreditTopUps = vi.fn();
const getLiveCatalog = vi.fn();
const payerServerConfig = vi.fn();

vi.mock("../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../lib/auth/org-roles", () => ({
  requireOwner: () => requireOwner(),
  getOrgRole: (s: unknown) => getOrgRole(s),
}));
vi.mock("../../lib/payer-api", () => ({
  getCapacity: () => getCapacity(),
  getDashboard: (o: unknown) => getDashboard(o),
  getCreditTopUps: () => getCreditTopUps(),
}));
vi.mock("../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
vi.mock("../../lib/server-config", () => ({ payerServerConfig: () => payerServerConfig() }));
// The panels' Server Actions are inert here (a server render never fires them).
vi.mock("./credits/actions", () => ({
  topUpAction: vi.fn(),
  createOrderAction: vi.fn(),
  verifyPaymentAction: vi.fn(),
}));
vi.mock("./credits/razorpay-checkout", () => ({
  loadCheckoutScript: vi.fn(),
  openCheckout: vi.fn(),
}));
vi.mock("./capacity/actions", () => ({ upgradeCapacityAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({
      children,
      href,
      className,
    }: {
      children: ReactNode;
      href: string;
      className?: string;
    }) => React.createElement("a", { href, className }, children),
    // Every in-app link is a PortalLink, whose pending cue reads the link's status (idle here).
    useLinkStatus: () => ({ pending: false }),
  };
});

const { default: PlansPage } = await import("./plans/page");
const { default: CreditsPage } = await import("./credits/page");

const POSTURES = [false, true] as const;
const CATALOGS = [true, false] as const; // live, then the cached fallback

function capacity(): Capacity {
  return {
    payerId: OWNER.payerId,
    activeVacancies: 2,
    activeVacancyAllowance: 3,
    applicantQuotaTotal: 10,
    applicantQuotaUsed: 4,
    postings: [],
  };
}

function setPosture(paymentsEnableReal: boolean): void {
  payerServerConfig.mockReturnValue({
    apiBaseUrl: "http://localhost:3001",
    paymentsEnableReal,
    agencySupplyEnabled: false,
  });
}

async function plansMarkup(): Promise<string> {
  return renderToStaticMarkup((await PlansPage()) as ReactElement);
}
async function creditsMarkup(): Promise<string> {
  return renderToStaticMarkup((await CreditsPage()) as ReactElement);
}

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(OWNER);
  requireOwner.mockReset().mockResolvedValue(OWNER);
  getOrgRole.mockReset().mockReturnValue("owner");
  getCapacity.mockReset().mockResolvedValue(capacity());
  getDashboard.mockReset().mockResolvedValue({
    credits: { payerId: OWNER.payerId, balance: 50 },
    unlocks: [],
    postings: [],
  });
  getCreditTopUps.mockReset().mockResolvedValue([]);
  getLiveCatalog.mockReset();
  payerServerConfig.mockReset();
});

describe("/plans — no mock wording, in either payment posture", () => {
  it("renders the capacity tiers with no 'mock' / 'staging preview' copy anywhere", async () => {
    for (const real of POSTURES) {
      for (const live of CATALOGS) {
        setPosture(real);
        getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live });
        const out = await plansMarkup();
        const label = `real=${real} live=${live}`;
        // The capacity panel really rendered (its tier cards), so its labels are in the fence.
        expect(out, label).toContain("capacity-tier");
        expect(out, label).not.toMatch(/\bmock\b/i);
        expect(out, label).not.toMatch(/staging preview/i);
      }
    }
  });

  it("stays clean for a recruiter and when the capacity read fails", async () => {
    for (const real of POSTURES) {
      setPosture(real);
      getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
      getOrgRole.mockReturnValue("recruiter");
      getCapacity.mockRejectedValueOnce(new Error("capacity down"));
      const out = await plansMarkup();
      expect(out, `real=${real}`).toContain("state--error");
      expect(out, `real=${real}`).not.toMatch(/\bmock\b/i);
      expect(out, `real=${real}`).not.toMatch(/staging preview/i);
    }
  });
});

describe("/credits — no mock wording, in either payment posture", () => {
  it("renders the credit packs with no 'mock' / 'staging preview' copy anywhere", async () => {
    for (const real of POSTURES) {
      for (const live of CATALOGS) {
        setPosture(real);
        getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live });
        const out = await creditsMarkup();
        const label = `real=${real} live=${live}`;
        // The credits panel really rendered (its pack cards), so its buttons are in the fence.
        expect(out, label).toContain("credit-pack");
        expect(out, label).not.toMatch(/\bmock\b/i);
        expect(out, label).not.toMatch(/staging preview/i);
      }
    }
  });

  it("stays clean when the balance read fails", async () => {
    for (const real of POSTURES) {
      setPosture(real);
      getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
      getDashboard.mockRejectedValueOnce(new Error("balance down"));
      const out = await creditsMarkup();
      expect(out, `real=${real}`).toContain("state--error");
      expect(out, `real=${real}`).not.toMatch(/\bmock\b/i);
      expect(out, `real=${real}`).not.toMatch(/staging preview/i);
    }
  });

  it("a pack's buy button reads plainly — 'Buy' — in both postures", async () => {
    for (const real of POSTURES) {
      setPosture(real);
      getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
      const out = await creditsMarkup();
      const labels = Array.from(
        out.matchAll(
          /<button[^>]*class="bb-btn bb-btn--primary bb-btn--block"[^>]*>([\s\S]*?)<\/button>/g,
        ),
        (m) => m[1]!.replace(/<[^>]+>/g, "").trim(),
      );
      expect(labels.length, `real=${real}`).toBe(3);
      expect(new Set(labels), `real=${real}`).toEqual(new Set(["Buy"]));
    }
  });
});
