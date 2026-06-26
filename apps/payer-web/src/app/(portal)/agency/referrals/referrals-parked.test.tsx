import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { StatTile, ProgressBar, Card } from "../../../../components/ds";
import type { AgencyReferralsSummary } from "../../../../lib/contracts";

/**
 * AGENCY "Referrals & payouts" page — DS3.2 re-skin guardrail test.
 *
 * The funnel is now LIVE (DS StatTiles + a created→clicked ProgressBar) but AGGREGATE-ONLY:
 *  - `requireAgent()` runs FIRST (the employer → neutral 404 gate),
 *  - the k-anon floor is respected — a stage suppressed to 0 surfaces as "<minBucket",
 *    NEVER a literal 0 (no single-invitee oracle), and there are NO per-invitee rows,
 *  - payouts/rev-share stay PARKED (a muted card), not a fake-interactive flow, and
 *  - the page ships NO supply form/input/select/textarea controls.
 *
 * Test env is node (no DOM): we render the async Server Component to a React element tree
 * and walk it. We collect DS primitives by `el.type === X` (the components are hookless, so
 * we expand them one level to read text in non-children props — StatTile `value`/`label`,
 * ProgressBar `label`). RetryButton (error fallback only) is a client hook — stub it.
 */

const requireAgent = vi.fn(async () => ({
  payerId: "22222222-2222-4222-8222-222222222222",
  displayLabel: "HireFast Agency (mock)",
  role: "agent" as const,
}));
const getAgencyReferralsSummary = vi.fn<() => Promise<AgencyReferralsSummary>>();

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../lib/server-config", () => ({
  payerServerConfig: () => ({ agencySupplyEnabled: false }),
}));
vi.mock("../../../../lib/payer-api", () => ({
  getAgencyReferralsSummary: () => getAgencyReferralsSummary(),
}));
vi.mock("../../../../components/retry-button", () => ({ RetryButton: () => null }));
// next/link renders an <a>; stub to a plain anchor so the walk sees it (a nav affordance,
// NOT a referral/payout control).
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));

const { default: AgencyReferralsPage } = await import("./page");

interface Collected {
  types: string[];
  components: unknown[];
  text: string[];
}

/**
 * Walk a rendered tree collecting element-type strings, mounted component refs, and text.
 * The DS primitives (StatTile/ProgressBar) carry their visible text in NON-children props
 * (`value`/`label`), so when we hit one we ALSO push those prop values into `text`.
 */
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
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "string") acc.types.push(el.type);
  else acc.components.push(el.type);
  // Expand DS text-bearing props one level. `value` is a DISPLAYED metric ONLY on a
  // StatTile (the funnel count) — the ProgressBar `value` is a width percentage, not a
  // shown digit, so we do NOT collect it (it would otherwise pollute the k-anon "no 0"
  // assertion with the conversion bar's clamp-to-0 fallback).
  if (el.props) {
    if ("label" in el.props) walk(el.props.label as ReactNode, acc);
    if (el.type === StatTile && "value" in el.props) walk(el.props.value as ReactNode, acc);
    if ("children" in el.props) walk(el.props.children as ReactNode, acc);
  }
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], components: [], text: [] };
  walk(tree, acc);
  return acc;
}

beforeEach(() => {
  requireAgent.mockClear();
  getAgencyReferralsSummary
    .mockReset()
    .mockResolvedValue({ created: 30, clicked: 12, accepted: 5, minBucket: 5 });
});

describe("agency referrals page — DS funnel, aggregate-only, payouts parked", () => {
  it("runs requireAgent FIRST (employer never reaches render)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(AgencyReferralsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAgencyReferralsSummary).not.toHaveBeenCalled();
  });

  it("renders the funnel via DS StatTile + ProgressBar with the parked payouts card", async () => {
    const tree = await AgencyReferralsPage();
    const { types, components, text } = collect(tree);

    // The role gate ran first.
    expect(requireAgent).toHaveBeenCalledOnce();

    // Funnel uses DS primitives: three StatTiles + a conversion ProgressBar, parked Card.
    expect(components.filter((c) => c === StatTile)).toHaveLength(3);
    expect(components).toContain(ProgressBar);
    expect(components).toContain(Card);

    // NO supply form/input/select/textarea controls (no fake referral/payout flow). A
    // back-link <a> is allowed (navigation), but no interactive supply control.
    for (const t of ["button", "input", "form", "select", "textarea"]) {
      expect(types).not.toContain(t);
    }

    // Parked badge for payouts is visible; aggregate-only privacy note present.
    const joined = text.join(" ");
    expect(joined).toMatch(/Parked — Phase 2 \(CEO-gated\)/);
    expect(joined.toLowerCase()).toContain("aggregate only");
    expect(joined).toContain("no per-worker breakdown");

    // No faked supply DATA leaked into the copy (no referral code / payout ledger / KYC
    // status rendered as if real). The page may NAME these as parked concepts only.
    expect(joined).not.toMatch(/\b(referral code|payout ledger row|kyc verified)\b/i);
  });

  it("k-anon: a below-floor stage shows '<minBucket', never a literal 0 (no oracle)", async () => {
    // clicked + accepted suppressed to 0 by the backend → must surface as "<5".
    getAgencyReferralsSummary.mockResolvedValueOnce({
      created: 7,
      clicked: 0,
      accepted: 0,
      minBucket: 5,
    });
    const { text } = collect(await AgencyReferralsPage());
    expect(text).toContain("<5"); // suppressed stages → "<5".
    expect(text).toContain("7"); // created is >= the floor → shown as-is.
    // A bare "0" must never be rendered as a stage value (no single-invitee oracle).
    expect(text).not.toContain("0");
  });

  it("degrades to a neutral 'Service unavailable' card when the funnel read fails", async () => {
    getAgencyReferralsSummary.mockRejectedValueOnce(new Error("upstream 503"));
    const { components, text } = collect(await AgencyReferralsPage());
    // Funnel StatTiles do not render in the failure branch; a DS Card carries the message.
    expect(components.filter((c) => c === StatTile)).toHaveLength(0);
    expect(components).toContain(Card);
    expect(text.join(" ")).toContain("Service unavailable");
  });
});
