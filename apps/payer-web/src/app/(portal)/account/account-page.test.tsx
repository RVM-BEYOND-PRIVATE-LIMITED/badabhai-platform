import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgencyKyc } from "../../../lib/contracts";
import type { PayerSession } from "../../../lib/auth/types";

/**
 * /account — the agency's Payout details (KYC) card (2026-10-01).
 *
 * The card's two buttons open Referrals, where KYC and the bank account are managed. Referrals is
 * an agency page behind the agency-portal flag, so:
 *   - flag ON: the card shows the real masked status, and each button SAYS where it goes
 *     ("Manage in Referrals" / "Add in Referrals") — two buttons both labelled "Manage" did not;
 *   - flag OFF: the card is not shown, and the KYC status is not even read — its buttons would
 *     lead to a 404;
 *   - a company never gets the card, whatever the flag.
 * Rendered through React's server renderer; the profile form is an inert marker.
 */

const AGENT: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Staffing",
  role: "agent",
  status: "active",
  email: "ops@acme.example",
};

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const getAgencyKyc = vi.fn<() => Promise<AgencyKyc | null>>();
const flags = { agencyPortalEnabled: true };

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/payer-api", () => ({ getAgencyKyc: () => getAgencyKyc() }));
vi.mock("../../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    // Every in-app link is a PortalLink, whose pending cue reads the link's status (idle here).
    useLinkStatus: () => ({ pending: false }),
  };
});
vi.mock("./account-form", () => ({ AccountForm: () => null }));
vi.mock("../../../components/retry-button", () => ({ RetryButton: () => null }));

const { default: AccountPage } = await import("./page");

const KYC: AgencyKyc = {
  status: "verified",
  panLast4: "234F",
  bankLast4: "6789",
  rejectReason: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

async function html(): Promise<string> {
  return renderToStaticMarkup((await AccountPage()) as ReactElement);
}
/** Every link: its href, accessible name (aria-label) and visible text. */
const links = (markup: string) =>
  Array.from(markup.matchAll(/<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g), (m) => ({
    href: m[1]!,
    name: /aria-label="([^"]*)"/.exec(m[2]!)?.[1] ?? null,
    text: m[3]!.replace(/<[^>]+>/g, "").trim(),
  }));

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(AGENT);
  getAgencyKyc.mockReset().mockResolvedValue(KYC);
  flags.agencyPortalEnabled = true;
});

describe("/account — the agency KYC card follows the agency-portal flag", () => {
  it("flag ON: the card shows, and each button says it opens Referrals (its name leads with the label)", async () => {
    const out = await html();
    expect(out).toContain("Payout details (KYC)");
    const toReferrals = links(out).filter((l) => l.href === "/agency/referrals");
    expect(toReferrals).toEqual([
      { href: "/agency/referrals", name: "Manage in Referrals — KYC details", text: "Manage in Referrals" },
      { href: "/agency/referrals", name: "Manage in Referrals — bank details", text: "Manage in Referrals" },
    ]);
    // WCAG 2.5.3: the accessible name contains the visible label.
    for (const l of toReferrals) expect(l.name!.startsWith(l.text)).toBe(true);
  });

  it("no bank account yet: that button says 'Add in Referrals'", async () => {
    getAgencyKyc.mockResolvedValue({ ...KYC, bankLast4: null });
    const bank = links(await html()).filter((l) => l.href === "/agency/referrals")[1]!;
    expect(bank).toEqual({
      href: "/agency/referrals",
      name: "Add in Referrals — bank details",
      text: "Add in Referrals",
    });
  });

  it("flag OFF: no card and no KYC read — its buttons would open a 404", async () => {
    flags.agencyPortalEnabled = false;
    const out = await html();
    expect(getAgencyKyc).not.toHaveBeenCalled();
    expect(out).not.toContain("Payout details (KYC)");
    expect(out).not.toContain("/agency/referrals");
  });

  it("a company never gets the card (and never a KYC read), whatever the flag", async () => {
    requirePayer.mockResolvedValue({ ...AGENT, role: "employer" });
    for (const on of [true, false]) {
      flags.agencyPortalEnabled = on;
      expect(await html()).not.toContain("Payout details (KYC)");
    }
    expect(getAgencyKyc).not.toHaveBeenCalled();
  });

  it("a failed KYC read hides the card (never a fake status)", async () => {
    getAgencyKyc.mockRejectedValue(new Error("kyc 503"));
    const out = await html();
    expect(out).not.toContain("Payout details (KYC)");
    expect(out).toContain("Signed in as");
  });

  it("#2178: a recruiter's 403 renders the neutral owner-only band — no retry, no error", async () => {
    getAgencyKyc.mockRejectedValue(new Error("payer API /payer/agency/kyc returned 403"));
    const out = await html();
    expect(out).toContain("Payout details (KYC)");
    expect(out).toContain("owner can see payouts");
    expect(out).toContain("Owner only");
    expect(out).not.toMatch(/retry/i);
  });

  it("#2178: an explicit recruiter orgRole skips the read and renders owner-only", async () => {
    requirePayer.mockResolvedValue({ ...AGENT, orgRole: "recruiter" });
    const out = await html();
    expect(getAgencyKyc).not.toHaveBeenCalled();
    expect(out).toContain("Payout details (KYC)");
    expect(out).toContain("owner can see payouts");
  });
});
