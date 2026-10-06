import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { AgencyParkedModules } from "./parked-modules";
import type { AgencyFlags } from "../../../../lib/config";
import { Card } from "../../../../components/ds";

/**
 * PARKED / DEAD / DEFERRED module cards — informational, NON-interactive.
 * Each card is the UI-1 `soon-card` primitive + a status `Badge` (the Badge, not the
 * `soon-badge`: "Soon" is the one promise these cards must never make). The assertions are
 * UNCHANGED by the re-skin — the walk records only native string element types and the
 * rendered text in `children`, and a `soon-card` is a plain <div>, so the
 * no-interactive-control + no-commercial-term + re-label guards all still hold. Asserts:
 *  - the three parked/deferred modules render with their gate note, and the DEAD one (bulk
 *    invite upload, ADR-0022 Amdt 3) is NOT among them — it is never framed as parked,
 *  - NO interactive control exists (no button/input/form/select/textarea/anchor —
 *    they are not clickable fake flows),
 *  - NO commercial term is promised (no ₹500 / 25% / 90d),
 *  - KYC and Payouts are BUILT, as mock launch-gated modules on /agency/referrals (ADR-0022
 *    Amendment 2, accepted 2026-07-23): with their flag on, the card says so — test mode, no real
 *    payout — and links to Referrals. The card used to call them "Flagged on — still unbuilt",
 *    which stopped being true in July. Outcome tracking IS still unbuilt: its flag only re-labels.
 *  - the disclosure is CLOSED by default (final sweep F21): what is not in this release is the
 *    page's lowest-priority block, and open it was most of the dashboard's height on a phone.
 */

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
    const joined = collect(AgencyParkedModules({ flags: OFF })).text.join(" ");
    expect(joined).toContain("Payout details (KYC)");
    expect(joined).toContain("Parked: legal/DPDP sign-off required");
    expect(joined).toContain("Payouts");
    expect(joined).toContain("Matching / Outcome Tracking");
    expect(joined).toContain("Deferred by product lock");
  });

  it("never lists bulk invite upload — it is dead, not parked, whatever its flag says", () => {
    for (const agencyBulkUploadEnabled of [false, true]) {
      const joined = collect(
        AgencyParkedModules({ flags: { ...OFF, agencyBulkUploadEnabled } }),
      ).text.join(" ");
      expect(joined).not.toMatch(/bulk/i);
      expect(joined).not.toMatch(/consent violation/i);
    }
  });

  it("has NO interactive control (not clickable fake flows)", () => {
    const { types } = collect(AgencyParkedModules({ flags: OFF }));
    for (const t of ["button", "input", "form", "select", "textarea", "a"]) {
      expect(types).not.toContain(t);
    }
  });

  it("promises NO commercial term (no ₹500 / 25% / 90d)", () => {
    const joined = collect(AgencyParkedModules({ flags: OFF })).text.join(" ");
    expect(joined).not.toMatch(/₹\s?500/);
    expect(joined).not.toMatch(/25\s?%/);
    expect(joined).not.toMatch(/\b90\s?d\b/i);
  });

  it("is a disclosure that starts CLOSED (F21) — the summary names it, the cards wait inside", () => {
    const el = AgencyParkedModules({ flags: OFF }) as ReactElement<{ open?: boolean; children: ReactNode }>;
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

describe("AgencyParkedModules — KYC and Payouts are BUILT (mock, launch-gated) — ADR-0022 Amdt 2", () => {
  it("KYC flag ON: available in TEST MODE, no real payout, and the card opens Referrals", () => {
    const tree = AgencyParkedModules({ flags: { ...OFF, agencyKycEnabled: true } });
    const joined = collect(tree).text.join(" ");
    expect(joined).not.toContain("still unbuilt");
    expect(joined).toContain("Test mode");
    expect(joined).toMatch(/no real payout/i);
    expect(cardLinks(tree)).toEqual([
      ["/agency/referrals", "Payout details (KYC) — available in test mode on Referrals"],
    ]);
  });

  it("Payouts flag ON: the same — test mode, no real payout, a link to Referrals", () => {
    const tree = AgencyParkedModules({ flags: { ...OFF, agencyPayoutsEnabled: true } });
    const joined = collect(tree).text.join(" ");
    expect(joined).not.toContain("still unbuilt");
    expect(joined).toMatch(/no real (money|payout)/i);
    expect(cardLinks(tree)).toEqual([["/agency/referrals", "Payouts — available in test mode on Referrals"]]);
  });

  it("flag OFF: each stays Parked with its reason, and nothing links anywhere", () => {
    const tree = AgencyParkedModules({ flags: OFF });
    expect(cardLinks(tree)).toEqual([]);
    expect(collect(tree).text.filter((t) => t === "Parked")).toHaveLength(3);
  });

  it("Outcome tracking IS still unbuilt: its flag only re-labels the card (no link)", () => {
    const tree = AgencyParkedModules({ flags: { ...OFF, agencyOutcomeTrackingEnabled: true } });
    expect(collect(tree).text.join(" ")).toContain("Flagged on — still unbuilt");
    expect(cardLinks(tree)).toEqual([]);
  });

  it("promises NO commercial term with every flag on either (no ₹500 / 25% / 90d)", () => {
    const joined = collect(
      AgencyParkedModules({
        flags: { ...OFF, agencyKycEnabled: true, agencyPayoutsEnabled: true, agencyOutcomeTrackingEnabled: true },
      }),
    ).text.join(" ");
    expect(joined).not.toMatch(/₹\s?500/);
    expect(joined).not.toMatch(/25\s?%/);
    expect(joined).not.toMatch(/\b90\s?d\b/i);
  });
});
