import { describe, it, expect } from "vitest";
import { ROLES, getRole, getMachine, DOMAINS } from "./index";

describe("taxonomy", () => {
  it("exposes the 7 initial CNC/VMC roles", () => {
    expect(ROLES).toHaveLength(7);
    expect(getRole("role_vmc_operator")?.name).toBe("VMC Operator");
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
