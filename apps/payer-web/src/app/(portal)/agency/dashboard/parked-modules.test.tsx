import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { AgencyParkedModules } from "./parked-modules";
import type { AgencyFlags } from "../../../../lib/config";
import { Card } from "../../../../components/ds";

/**
 * "NOT IN THIS RELEASE" module cards. A parked card is the UI-1 `soon-card` primitive + a status
 * `Badge` (the Badge, not the `soon-badge`: "Soon" is the one promise these cards must never make);
 * the walk records native element types and the rendered text in `children`. Asserts:
 *  - the three modules render with their gate note, and the DEAD one (bulk invite upload, ADR-0022
 *    Amdt 3) is NOT among them — it is never framed as parked,
 *  - while nothing is available, NO interactive control exists (no button/input/form/select/
 *    textarea/anchor — the cards are not clickable fake flows),
 *  - NO commercial term is promised (no ₹500 / 25% / 90d),
 *  - KYC and Payouts are BUILT, as mock modules gated by the SERVER flag `AGENCY_PAYOUTS_ENABLED`
 *    (ADR-0022 Amendment 2): the card calls them available — and links to Referrals — ONLY when
 *    the server answered (`payoutsAvailable`, the read /agency/referrals makes before it draws
 *    those panels). The public `NEXT_PUBLIC_ENABLE_AGENCY_KYC/PAYOUTS` flags gate nothing, so they
 *    never claim availability (review M1). The copy never says "test mode" about KYC data, and
 *    never implies entered details are not stored. Outcome tracking IS still unbuilt: its public
 *    flag only re-labels it.
 *  - the disclosure is CLOSED by default (final sweep F21): what is not in this release is the
 *    page's lowest-priority block, and open it was most of the dashboard's height on a phone.
 */

/** Render with the public flags and the server's payouts answer (default: not available). */
const parked = (flags: AgencyFlags, payoutsAvailable = false) =>
  AgencyParkedModules({ flags, payoutsAvailable });

const OFF: AgencyFlags = {
  agencyPortalEnabled: true,
  agencySupplyEnabled: false,
  agencyKycEnabled: false,
  agencyPayoutsEnabled: false,
  agencyBulkUploadEnabled: false,
  agencyOutcomeTrackingEnabled: false,
};

interface Collected {
  types: string[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(node: ReactNode): Collected {
  const acc: Collected = { types: [], text: [] };
  walk(node, acc);
  return acc;
}

describe("AgencyParkedModules — informational, non-interactive", () => {
  it("renders the three parked/deferred modules with their gate note", () => {
    const joined = collect(parked(OFF)).text.join(" ");
    expect(joined).toContain("Payout details (KYC)");
    expect(joined).toContain("Parked: legal/DPDP sign-off required");
    expect(joined).toContain("Payouts");
    expect(joined).toContain("Matching / Outcome Tracking");
    expect(joined).toContain("Deferred by product lock");
  });

  it("never lists bulk invite upload — it is dead, not parked, whatever its flag says", () => {
    for (const agencyBulkUploadEnabled of [false, true]) {
      const joined = collect(
        parked({ ...OFF, agencyBulkUploadEnabled }),
      ).text.join(" ");
      expect(joined).not.toMatch(/bulk/i);
      expect(joined).not.toMatch(/consent violation/i);
    }
  });

  it("has NO interactive control (not clickable fake flows)", () => {
    const { types } = collect(parked(OFF));
    for (const t of ["button", "input", "form", "select", "textarea", "a"]) {
      expect(types).not.toContain(t);
    }
  });

  it("promises NO commercial term (no ₹500 / 25% / 90d)", () => {
    const joined = collect(parked(OFF)).text.join(" ");
    expect(joined).not.toMatch(/₹\s?500/);
    expect(joined).not.toMatch(/25\s?%/);
    expect(joined).not.toMatch(/\b90\s?d\b/i);
  });

  it("is a disclosure that starts CLOSED (F21) — the summary names it, the cards wait inside", () => {
    const el = parked(OFF) as ReactElement<{ open?: boolean; children: ReactNode }>;
    expect(el.type).toBe("details");
    expect(el.props.open).toBeFalsy();
    expect(collect(el).text.join(" ")).toContain("Not in this release");
  });
});

/** Every whole-card link (`Card` with an `href`) in the tree: [href, aria-label]. */
function cardLinks(node: ReactNode, out: Array<[string, string]> = []): Array<[string, string]> {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) cardLinks(c, out);
    return out;
  }
  const el = node as ReactElement<{ href?: string; ariaLabel?: string; children?: ReactNode }>;
  if (el.type === Card && typeof el.props.href === "string") out.push([el.props.href, String(el.props.ariaLabel)]);
  if (el.props && "children" in el.props) cardLinks(el.props.children, out);
  return out;
}

describe("AgencyParkedModules — KYC and Payouts follow the SERVER's payouts answer (review M1)", () => {
  const AVAILABLE = "Available on Referrals — payouts are simulated; no money is paid out yet.";

  it("server answered: KYC and Payouts are available on Referrals (payouts simulated) and link there", () => {
    const tree = parked(OFF, true);
    const joined = collect(tree).text.join(" ");
    expect(joined.split(AVAILABLE)).toHaveLength(3);
    expect(joined).not.toContain("still unbuilt");
    expect(cardLinks(tree)).toEqual([
      ["/agency/referrals", "Payout details (KYC) — available on Referrals"],
      ["/agency/referrals", "Payouts — available on Referrals"],
    ]);
  });

  it("server off (or its read failed): both Parked with their reasons — even with the public flags ON", () => {
    // The public KYC/payout flags gate nothing (the Referrals panels follow AGENCY_PAYOUTS_ENABLED
    // only), so with them on the card used to promise a panel Referrals then did not draw.
    for (const flags of [OFF, { ...OFF, agencyKycEnabled: true, agencyPayoutsEnabled: true }]) {
      const tree = parked(flags, false);
      expect(cardLinks(tree)).toEqual([]);
      const joined = collect(tree).text.join(" ");
      expect(joined).toContain("Parked: legal/DPDP sign-off required");
      expect(joined).toContain("Parked: real payments + product-ratified params required");
      expect(joined).not.toMatch(/available|still unbuilt/i);
      expect(collect(tree).text.filter((t) => t === "Parked")).toHaveLength(3);
    }
  });

  it("never 'test mode' about KYC, never a hint that entered details are not kept", () => {
    const joined = collect(parked({ ...OFF, agencyKycEnabled: true }, true)).text.join(" ");
    expect(joined).not.toMatch(/test mode/i);
    expect(joined).not.toMatch(/not (stored|kept|saved)|no data|discarded|deleted/i);
  });

  it("Outcome tracking IS still unbuilt: its public flag only re-labels the card (no link)", () => {
    const tree = parked({ ...OFF, agencyOutcomeTrackingEnabled: true }, true);
    expect(collect(tree).text.join(" ")).toContain("Flagged on — still unbuilt");
    expect(cardLinks(tree).map(([, label]) => label)).not.toContain(
      "Matching / Outcome Tracking — available on Referrals",
    );
  });

  it("promises NO commercial term in any state (no ₹500 / 25% / 90d)", () => {
    const all = { ...OFF, agencyKycEnabled: true, agencyPayoutsEnabled: true, agencyOutcomeTrackingEnabled: true };
    for (const available of [false, true]) {
      const joined = collect(parked(all, available)).text.join(" ");
      expect(joined).not.toMatch(/₹\s?500/);
      expect(joined).not.toMatch(/25\s?%/);
      expect(joined).not.toMatch(/\b90\s?d\b/i);
    }
  });
});
