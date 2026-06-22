import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

/**
 * NEGATIVE test (E3): the agency "Referrals & payouts" page is PARKED — it must render
 * NO referral / payout / KYC functionality (no interactive controls, no faked data).
 *
 * Supply is Phase-2, CEO-gated (D2/D3). This guards against scope-creep: if someone
 * adds a "Generate referral link" button, a payout table, a KYC form, or any input,
 * this test fails. We also assert the parked badge is present and `requireAgent()` runs
 * FIRST (the employer → neutral 404 gate). The test env is node (no DOM), so we render
 * the async Server Component to a React element tree and walk it.
 */

const requireAgent = vi.fn(async () => ({
  payerId: "22222222-2222-4222-8222-222222222222",
  displayLabel: "HireFast Agency (mock)",
  role: "agent" as const,
}));

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../lib/server-config", () => ({
  payerServerConfig: () => ({ agencySupplyEnabled: false }),
}));

const { default: AgencyReferralsPage } = await import("./page");

/** Collect every element-type string and all rendered text from a React tree. */
function walk(node: ReactNode, types: string[], text: string[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") {
    text.push(node);
    return;
  }
  if (typeof node === "number") {
    text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, types, text);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "string") types.push(el.type);
  if (el.props && "children" in el.props) walk(el.props.children, types, text);
}

beforeEach(() => {
  requireAgent.mockClear();
});

describe("agency referrals page — parked, no supply controls", () => {
  it("renders the parked state with NO interactive referral/payout/KYC controls", async () => {
    const tree = await AgencyReferralsPage();
    const types: string[] = [];
    const text: string[] = [];
    walk(tree, types, text);

    // The role gate ran first (employer would 404 before any render).
    expect(requireAgent).toHaveBeenCalledOnce();

    // NO interactive controls at all — the page is a static informational panel.
    const interactive = ["button", "input", "form", "select", "textarea"];
    for (const t of interactive) {
      expect(types).not.toContain(t);
    }
    // No links either (a "Generate referral link" / "View payouts" affordance).
    expect(types).not.toContain("a");

    // The parked Phase-2 (CEO-gated) badge is visible.
    const joined = text.join(" ");
    expect(joined).toMatch(/Parked — Phase 2 \(CEO-gated\)/);

    // No faked supply DATA leaked into the copy (no amounts/links/KYC states rendered
    // as if real). The page may NAME these as parked concepts but ships no values.
    expect(joined).not.toMatch(/\b(referral code|payout ledger row|kyc verified)\b/i);
  });
});
