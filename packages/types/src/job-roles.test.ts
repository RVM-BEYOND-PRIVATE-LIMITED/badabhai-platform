/**
 * The job-posting role labels (migration 0131, ADR-0036 addendum 2026-09-29).
 *
 * `JOB_ROLE_LABELS` is compile-time exhaustive over the 21 declared kinds, so the tests here pin
 * what the type system cannot: no EXTRA key, no duplicated or empty label, every family real and
 * used, and a `jobRoleLabel` that never hands back anything it was not given by the closed set.
 * The label TEXT is pinned against the role descriptors by the API's parity test, which is the
 * only place both sides are importable.
 */
import { describe, expect, it } from "vitest";

import {
  JOB_ROLE_FAMILIES,
  JOB_ROLE_FAMILY_LABELS,
  JOB_ROLE_LABELS,
  TRADE_FORM_KINDS_ALL,
  isTradeFormKindName,
  jobRoleLabel,
} from "./index";

describe("JOB_ROLE_LABELS covers exactly the declared kinds", () => {
  it("has one entry per TRADE_FORM_KINDS_ALL kind — and no other key", () => {
    expect(Object.keys(JOB_ROLE_LABELS).sort()).toEqual([...TRADE_FORM_KINDS_ALL].sort());
    expect(Object.keys(JOB_ROLE_LABELS)).toHaveLength(21);
  });

  it("gives every kind a distinct, non-blank label", () => {
    const labels = Object.values(JOB_ROLE_LABELS).map((e) => e.label);
    for (const label of labels) expect(label.trim()).toBe(label);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    // Two kinds reading the same would make the picker offer one choice twice, with the payer
    // unable to tell which one the posting stores.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("files every kind under a real family, and leaves no family empty", () => {
    const used = new Set(Object.values(JOB_ROLE_LABELS).map((e) => e.family));
    for (const family of used) expect(JOB_ROLE_FAMILIES).toContain(family);
    expect([...used].sort()).toEqual([...JOB_ROLE_FAMILIES].sort());
  });

  it("labels exactly the six families", () => {
    expect(Object.keys(JOB_ROLE_FAMILY_LABELS).sort()).toEqual([...JOB_ROLE_FAMILIES].sort());
    for (const label of Object.values(JOB_ROLE_FAMILY_LABELS))
      expect(label.length).toBeGreaterThan(0);
  });

  it("is frozen — a consumer cannot relabel a role at runtime", () => {
    expect(Object.isFrozen(JOB_ROLE_LABELS)).toBe(true);
    expect(Object.isFrozen(JOB_ROLE_FAMILY_LABELS)).toBe(true);
    expect(Object.isFrozen(JOB_ROLE_FAMILIES)).toBe(true);
  });
});

describe("jobRoleLabel — the closed set in, a label or null out", () => {
  it.each(TRADE_FORM_KINDS_ALL)("reads %s as its label", (kind) => {
    expect(jobRoleLabel(kind)).toBe(JOB_ROLE_LABELS[kind].label);
  });

  it("returns null for anything outside the 21 — and never echoes the input", () => {
    const unknowns: unknown[] = [
      "cnc_operator", // a TRADE key (the agency/legacy vocabulary), not a role kind
      "Welder",
      " welder",
      "welder ",
      "",
      "Ramesh 9876543210",
      "<script>alert(1)</script>",
      null,
      undefined,
      42,
      {},
      ["welder"],
    ];
    for (const value of unknowns) {
      expect(jobRoleLabel(value), JSON.stringify(value) ?? String(value)).toBeNull();
    }
  });

  it("does not resolve inherited Object keys as roles", () => {
    // A plain `kind in LABELS` lookup would answer these from Object.prototype.
    for (const key of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(jobRoleLabel(key), key).toBeNull();
      expect(isTradeFormKindName(key), key).toBe(false);
    }
  });

  it("MUTATION CHECK: a real kind is NOT null, so the null cases above are not vacuous", () => {
    expect(jobRoleLabel("welder")).toBe("Welder");
    expect(isTradeFormKindName("welder")).toBe(true);
  });
});
