import { describe, it, expect } from "vitest";
import { ROLES, RELATED_ROLE_IDS, getRole, getMachine, DOMAINS } from "./index";

describe("taxonomy", () => {
  it("exposes the 7 initial CNC/VMC roles plus the 6 multi-trade roles", () => {
    // 7 launch roles + role_welder (TAX-WELD-1) + role_cnc_operator (TD94) +
    // role_plumber + role_carpenter + role_designer + role_interior_designer.
    // The id space only ever GROWS (see the file header).
    expect(ROLES).toHaveLength(13);
    expect(getRole("role_vmc_operator")?.name).toBe("VMC Operator");
    expect(getRole("role_welder")?.name).toBe("Welder");
    expect(getRole("role_welder")?.domainId).toBe("dom_welding");
    expect(getRole("role_cnc_operator")?.name).toBe("CNC Operator");
    // The generic sits in the EXISTING CNC machining domain — no domain was minted.
    expect(getRole("role_cnc_operator")?.domainId).toBe("dom_cnc_machining");
  });

  it("the generic CNC operator is adjacent to every CNC specialisation", () => {
    // TD94's `secondaryRoleIds` half. `scoring.ts` gives a secondary match 0.6 where a
    // non-matching primary gets 0.0, so this map is what stops the mint ranking a
    // plain "CNC operator" BELOW the null it replaced. Every entry must be a real
    // role id, and the generic must never list itself (that would be an exact match
    // dressed as a secondary one).
    const ids = new Set<string>(ROLES.map((r) => r.id));
    for (const [roleId, related] of Object.entries(RELATED_ROLE_IDS)) {
      expect(ids.has(roleId)).toBe(true);
      for (const r of related ?? []) {
        expect(ids.has(r)).toBe(true);
        expect(r).not.toBe(roleId);
      }
    }
    expect(RELATED_ROLE_IDS.role_cnc_operator).toEqual([
      "role_vmc_operator",
      "role_hmc_operator",
      "role_cnc_turner_operator",
      "role_cnc_setter_operator",
      "role_cnc_grinding_operator",
    ]);
  });

  it("every role references a known domain", () => {
    const domainIds = new Set(DOMAINS.map((d) => d.id));
    for (const role of ROLES) {
      expect(domainIds.has(role.domainId)).toBe(true);
    }
  });

  it("ids are unique across roles", () => {
    const ids = ROLES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lookup returns undefined for unknown id", () => {
    expect(getMachine("mach_nope")).toBeUndefined();
  });
});
