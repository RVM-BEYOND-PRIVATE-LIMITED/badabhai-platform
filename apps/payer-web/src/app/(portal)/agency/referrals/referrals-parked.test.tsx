import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ProgressBar, StatTile } from "../../../../components/ds";
import type { AgencyEarnings, AgencyKyc, AgencyReferralsSummary } from "../../../../lib/contracts";
import { EarningsPanel } from "./earnings-panel";
import { KycPanel } from "./kyc-panel";
import { PayoutPanel } from "./payout-panel";
import { AgencyInvitePanel } from "../dashboard/invite-panel";

/**
 * AGENCY "Referrals" page (ADR-0022 Amendment 2) — role gate + LIVE funnel + GATED supply
 * money.
 *
 *  - `requireAgent()` runs FIRST (an employer never reaches any read);
 *  - the agency-portal flag gates it like every sibling agency page (off → neutral 404, no
 *    read) — the nav hides the item on the same flag;
 *  - the referral LINK (invite mint) + the aggregate, k-anon funnel are LIVE regardless
 *    of the payout gate;
 *  - while payouts are OFF (the earnings read 404s → seam `null`) the money surface is a
 *    graceful "Payouts coming soon" inert card, NOT an error, and the earnings/KYC/payout
 *    panels do NOT render;
 *  - when enabled, the Earnings / KYC / Payout panels render;
 *  - a transient earnings failure degrades to a neutral "unavailable" card;
 *  - the k-anon floor is respected — a suppressed stage surfaces as "<minBucket".
 *
 * Env is node (no DOM): render the async Server Component and walk the element tree. Client
 * panels render as component REFS (leaf nodes), so we assert their presence by ref.
 */

const requireAgent = vi.fn();
const getAgencyReferralsSummary = vi.fn<() => Promise<AgencyReferralsSummary>>();
const getAgencyEarnings = vi.fn<() => Promise<AgencyEarnings | null>>();
const getAgencyKyc = vi.fn<() => Promise<AgencyKyc | null>>();
const listAgencyPayouts = vi.fn();

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const flags = { agencyPortalEnabled: true };
vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("../../../../lib/payer-api", () => ({
  getAgencyReferralsSummary: () => getAgencyReferralsSummary(),
  getAgencyEarnings: () => getAgencyEarnings(),
  getAgencyKyc: () => getAgencyKyc(),
  listAgencyPayouts: () => listAgencyPayouts(),
}));
vi.mock("../../../../components/retry-button", () => ({ RetryButton: () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => notFound(),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));

const { default: AgencyReferralsPage } = await import("./page");

interface Collected {
  components: unknown[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") return void acc.text.push(node);
  if (typeof node === "number") return void acc.text.push(String(node));
  if (Array.isArray(node)) return void node.forEach((c) => walk(c, acc));
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type !== "string") acc.components.push(el.type);
  if (el.props) {
    if ("label" in el.props) walk(el.props.label as ReactNode, acc);
    if (el.type === StatTile && "value" in el.props) walk(el.props.value as ReactNode, acc);
    if ("children" in el.props) walk(el.props.children as ReactNode, acc);
  }
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { components: [], text: [] };
  walk(tree, acc);
  return acc;
}

const SUMMARY: AgencyReferralsSummary = { created: 30, clicked: 12, accepted: 5, minBucket: 5 };
const EARNINGS: AgencyEarnings = {
  totalAccruedInr: 1200,
  requestableInr: 800,
  inRequestInr: 0,
  paidInr: 400,
  accrualCount: 30,
  kycStatus: "verified",
  thresholdInr: 500,
  basisInr: 40,
  rateBps: 2500,
  windowDays: 90,
  payoutsEnabled: true,
  canRequest: true,
  blockedReason: null,
};
const KYC: AgencyKyc = {
  status: "verified",
  panLast4: "234F",
  bankLast4: "6789",
  rejectReason: null,
  updatedAt: "2026-07-23T00:00:00.000Z",
};

beforeEach(() => {
  flags.agencyPortalEnabled = true;
  notFound.mockClear();
  requireAgent.mockReset().mockResolvedValue({ payerId: "p", role: "agent", displayLabel: "A" });
  getAgencyReferralsSummary.mockReset().mockResolvedValue(SUMMARY);
  getAgencyEarnings.mockReset().mockResolvedValue(EARNINGS);
  getAgencyKyc.mockReset().mockResolvedValue(KYC);
  listAgencyPayouts.mockReset().mockResolvedValue([]);
});

describe("agency referrals page — role gate", () => {
  it("runs requireAgent FIRST (employer never reaches a read)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(AgencyReferralsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyEarnings).not.toHaveBeenCalled();
    expect(getAgencyReferralsSummary).not.toHaveBeenCalled();
  });

  it("the agency-portal flag OFF is a neutral 404 BEFORE any read (same gate as its siblings)", async () => {
    flags.agencyPortalEnabled = false;
    await expect(AgencyReferralsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(getAgencyReferralsSummary).not.toHaveBeenCalled();
    expect(getAgencyEarnings).not.toHaveBeenCalled();
    expect(getAgencyKyc).not.toHaveBeenCalled();
    expect(listAgencyPayouts).not.toHaveBeenCalled();
  });

  it("the flag ON renders (the gate permits what it must)", async () => {
    await expect(AgencyReferralsPage()).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("agency referrals page — referral link + funnel are LIVE", () => {
  it("always renders the invite mint panel (shareable referral link)", async () => {
    getAgencyEarnings.mockResolvedValueOnce(null); // even with payouts OFF
    const { components } = collect(await AgencyReferralsPage());
    expect(components).toContain(AgencyInvitePanel);
  });

  it("renders the three funnel StatTiles", async () => {
    const { components } = collect(await AgencyReferralsPage());
    expect(components.filter((c) => c === StatTile)).toHaveLength(3);
  });

  it("respects the k-anon floor — a suppressed stage shows '<minBucket', never a literal 0", async () => {
    getAgencyEarnings.mockResolvedValueOnce(null); // isolate the funnel
    getAgencyReferralsSummary.mockResolvedValueOnce({
      created: 7,
      clicked: 0,
      accepted: 0,
      minBucket: 5,
    });
    const { text } = collect(await AgencyReferralsPage());
    expect(text).toContain("<5");
    expect(text).toContain("7");
    expect(text).not.toContain("0");
  });
});

describe("agency referrals page — GATED supply money", () => {
  it("payouts enabled → renders the Earnings / KYC / Payout panels", async () => {
    const { components, text } = collect(await AgencyReferralsPage());
    expect(components).toContain(EarningsPanel);
    expect(components).toContain(KycPanel);
    expect(components).toContain(PayoutPanel);
    expect(text.join(" ")).not.toMatch(/Payouts coming soon/);
  });

  it("payouts OFF (earnings 404 → null) → 'Payouts coming soon' inert card, panels do NOT render", async () => {
    getAgencyEarnings.mockResolvedValueOnce(null);
    const { components, text } = collect(await AgencyReferralsPage());
    expect(text.join(" ")).toMatch(/Payouts coming soon/);
    expect(components).not.toContain(EarningsPanel);
    expect(components).not.toContain(PayoutPanel);
  });

  it("a transient earnings failure degrades to a neutral 'unavailable' card (not coming-soon)", async () => {
    getAgencyEarnings.mockRejectedValueOnce(new Error("upstream 503"));
    const { components, text } = collect(await AgencyReferralsPage());
    expect(text.join(" ")).toMatch(/could not load/i);
    expect(text.join(" ")).not.toMatch(/Payouts coming soon/);
    expect(components).not.toContain(EarningsPanel);
  });
});

/* ── W2-B sectioning: page namespace, compact funnel tiles, and the k-anon rate floor ───────── */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

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

describe("agency referrals page — W2-B layout", () => {
  it("wraps the screen in `.agency-referrals-page` (the invite-tool framing is scoped to it)", async () => {
    const tree = (await AgencyReferralsPage()) as El;
    expect(tree.props.className).toBe("agency-referrals-page");
  });

  it("the funnel tiles use the compact KPI row (one ledger line per tile on a phone)", async () => {
    const els = elements(await AgencyReferralsPage());
    // The element whose DIRECT children are the three funnel tiles.
    const row = els.find((e) =>
      ([] as ReactNode[])
        .concat(e.props.children as ReactNode)
        .some((c) => c !== null && typeof c === "object" && (c as El).type === StatTile),
    );
    expect(String(row!.props.className).split(/\s+/)).toEqual(["stat-row", "stat-row--kpi"]);
  });
});

describe("agency referrals page — the conversion RATE honours the k-anon floor", () => {
  /** The funnel's conversion ProgressBar props, read off a rendered page tree. */
  const barOf = (tree: ReactNode) =>
    elements(tree).find((e) => e.type === ProgressBar)!.props as {
      value: number;
      showValue: boolean;
    };

  /** Render with payouts OFF (no money panel renders), so only the funnel is in play. */
  async function renderFunnelOnly(): Promise<ReactNode> {
    getAgencyEarnings.mockResolvedValueOnce(null);
    return AgencyReferralsPage();
  }

  it("both stages clear the floor → the rate is shown (clicked / created, rounded)", async () => {
    expect(barOf(await renderFunnelOnly())).toMatchObject({ value: 40, showValue: true }); // 12 / 30
  });

  it("a suppressed stage → NO rate is shown, and the floor is explained instead", async () => {
    getAgencyReferralsSummary.mockResolvedValueOnce({
      created: 7,
      clicked: 0,
      accepted: 0,
      minBucket: 5,
    });
    const tree = await renderFunnelOnly();
    expect(barOf(tree)).toMatchObject({ value: 0, showValue: false });
    expect(collect(tree).text.join(" ")).toMatch(
      /Conversion appears once both stages clear the\s+privacy floor of/,
    );
  });
});
