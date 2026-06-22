import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { AgencyParkedModules } from "./parked-modules";
import type { AgencyFlags } from "../../../../lib/config";

/**
 * PARKED / DEAD / DEFERRED module cards — informational, NON-interactive. Asserts:
 *  - all four modules render with their gate note,
 *  - NO interactive control exists (no button/input/form/select/textarea/anchor —
 *    they are not clickable fake flows),
 *  - NO commercial term is promised (no ₹500 / 25% / 90d),
 *  - a flipped-ON flag only re-LABELS the card; it never builds the flow.
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
  it("renders all four parked/dead/deferred modules with their gate note", () => {
    const joined = collect(AgencyParkedModules({ flags: OFF })).text.join(" ");
    expect(joined).toContain("KYC");
    expect(joined).toContain("Parked: legal/DPDP sign-off required");
    expect(joined).toContain("Payouts");
    expect(joined).toContain("Bulk Invite Upload");
    expect(joined).toContain("Not available: consent violation");
    expect(joined).toContain("Matching / Outcome Tracking");
    expect(joined).toContain("Deferred by product lock");
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

  it("a flipped-ON flag only re-labels the card (still unbuilt)", () => {
    const joined = collect(
      AgencyParkedModules({ flags: { ...OFF, agencyKycEnabled: true } }),
    ).text.join(" ");
    expect(joined).toContain("Flagged on — still unbuilt");
  });
});
