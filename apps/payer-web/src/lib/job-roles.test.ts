import { describe, expect, it } from "vitest";
import { TRADE_FORM_KINDS_ALL as SHARED } from "@badabhai/types";
import {
  JOB_ROLE_FAMILIES,
  JOB_ROLE_LABELS,
  TRADE_FORM_KINDS_ALL,
  jobRoleLabel,
  roleKindInputSchema,
  roleOptionGroups,
} from "./job-roles";

/**
 * The role surface re-export is the single seam onto the shared `@badabhai/types` vocabulary. These
 * pin that it does NOT drift: the 21 kinds ARE the shared set, the picker groups all 21 exactly once,
 * and the boundary schema accepts a role kind but rejects a trade key.
 */

describe("job-roles — re-exports the shared 21-role vocabulary without drift", () => {
  it("the 21 kinds ARE TRADE_FORM_KINDS_ALL (same values, same order)", () => {
    expect([...TRADE_FORM_KINDS_ALL]).toEqual([...SHARED]);
    expect(TRADE_FORM_KINDS_ALL.length).toBe(21);
  });

  it("every kind has a label + a family, and jobRoleLabel returns the shared label", () => {
    for (const kind of TRADE_FORM_KINDS_ALL) {
      expect(JOB_ROLE_LABELS[kind].label.length).toBeGreaterThan(0);
      expect(JOB_ROLE_FAMILIES).toContain(JOB_ROLE_LABELS[kind].family);
      expect(jobRoleLabel(kind)).toBe(JOB_ROLE_LABELS[kind].label);
    }
  });

  it("jobRoleLabel returns null for a non-kind (never echoes a raw id)", () => {
    expect(jobRoleLabel("cnc_operator")).toBeNull(); // a trade key, not a role kind
    expect(jobRoleLabel("__proto__")).toBeNull();
    expect(jobRoleLabel(null)).toBeNull();
  });
});

describe("roleOptionGroups — groups all 21 kinds by family exactly once", () => {
  it("covers every kind exactly once, only under its own family", () => {
    const groups = roleOptionGroups();
    const seen: string[] = [];
    for (const group of groups) {
      expect(JOB_ROLE_FAMILIES).toContain(group.family);
      expect(group.label.length).toBeGreaterThan(0);
      for (const opt of group.options) {
        expect(JOB_ROLE_LABELS[opt.value].family).toBe(group.family);
        expect(opt.label).toBe(JOB_ROLE_LABELS[opt.value].label);
        seen.push(opt.value);
      }
    }
    expect(seen.sort()).toEqual([...TRADE_FORM_KINDS_ALL].sort());
    expect(seen.length).toBe(21);
  });
});

describe("roleKindInputSchema — the form/action boundary guard", () => {
  it("accepts every one of the 21 kinds", () => {
    for (const kind of TRADE_FORM_KINDS_ALL) {
      expect(roleKindInputSchema.safeParse(kind).success).toBe(true);
    }
  });

  it("rejects a trade key and an arbitrary string (distinct vocabularies)", () => {
    expect(roleKindInputSchema.safeParse("cnc_operator").success).toBe(false);
    expect(roleKindInputSchema.safeParse("rocket_scientist").success).toBe(false);
    expect(roleKindInputSchema.safeParse("").success).toBe(false);
  });
});
