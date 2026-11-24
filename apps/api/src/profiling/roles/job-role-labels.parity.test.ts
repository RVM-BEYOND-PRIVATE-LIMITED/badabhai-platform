/**
 * `JOB_ROLE_LABELS` (packages/types) ⇔ the role descriptors (this directory) — ONE name per role.
 *
 * WHY TWO COPIES EXIST AT ALL. The descriptors are the authority for a role's English name
 * (`displayName`, printed on the résumé sheet and the handover card) and its family (`cluster`),
 * but they live in `apps/api`, and the payer web / admin web / event contract need the same
 * names from a package — a package cannot import from an app. So `JOB_ROLE_LABELS` COPIES them
 * (migration 0131, ADR-0036 addendum 2026-09-29), and this test is what makes the copy safe:
 * an edit to either side alone turns it red.
 *
 * What it guards against is the failure the descriptor comment names — a worker told he is one
 * thing and shown another: the employer's picker offering "Tool & Die Maker" while the worker's
 * résumé prints something else for the same kind.
 */
import { describe, expect, it } from "vitest";
import {
  JOB_ROLE_FAMILIES,
  JOB_ROLE_LABELS,
  TRADE_FORM_KINDS_ALL,
  type TradeFormKindName,
} from "@badabhai/types";

import { ROLE_CLUSTERS } from "./role-form-descriptor";
import { ROLE_FORM_DESCRIPTORS, descriptorForKind } from "./role-registry";

/**
 * #2999 declares the 36 new kinds so the shared vocabulary and the two CHECK lists
 * can widen before their forms exist. The descriptors are #3004's files; until that
 * PR lands, the parity guard checks every existing descriptor and documents the 36
 * staged kinds instead of failing on them. #3004 deletes this set and the two
 * `it.each` skips, and the existing assertions then cover all 63.
 */
const PENDING_DESCRIPTOR_KINDS: ReadonlySet<string> = new Set([
  "gear_cutting_operator",
  "boring_machine_operator",
  "spm_finishing_operator",
  "cnc_router_operator",
  "fabricator",
  "tube_bending_operator",
  "foundry_operator",
  "die_casting_operator",
  "forging_operator",
  "plating_operator",
  "plastic_extrusion_operator",
  "cmm_operator",
  "ndt_technician",
  "calibration_technician",
  "material_lab_technician",
  "quality_engineer",
  "robot_operator_programmer",
  "instrumentation_technician",
  "hvac_rac_technician",
  "utility_operator",
  "maintenance_engineer",
  "service_engineer",
  "production_engineer",
  "process_engineer",
  "npd_engineer",
  "safety_officer",
  "project_site_engineer",
  "technical_sales_engineer",
  "ppc_engineer",
  "store_keeper",
  "purchase_engineer",
  "dispatch_logistics_executive",
  "forklift_operator",
  "crane_operator",
  "cae_analyst",
  "piping_designer",
]);

describe("JOB_ROLE_LABELS agrees with the role descriptors", () => {
  it("covers exactly the declared descriptors and the 36 staged kinds", () => {
    const declared = ROLE_FORM_DESCRIPTORS.map((d) => d.kind).sort();
    const expected = [...declared, ...PENDING_DESCRIPTOR_KINDS].sort();
    expect(Object.keys(JOB_ROLE_LABELS).sort()).toEqual(expected);
    // …and both are the shared constant, so neither can drift from the event spine either.
    expect(expected).toEqual([...TRADE_FORM_KINDS_ALL].sort());
  });

  it.each(TRADE_FORM_KINDS_ALL)("%s — label is the descriptor's displayName", (kind) => {
    if (PENDING_DESCRIPTOR_KINDS.has(kind)) return;
    const descriptor = descriptorForKind(kind);
    expect(descriptor, `${kind} has no descriptor`).toBeDefined();
    expect(JOB_ROLE_LABELS[kind as TradeFormKindName].label).toBe(descriptor!.displayName);
  });

  it.each(TRADE_FORM_KINDS_ALL)("%s — family is the descriptor's cluster", (kind) => {
    if (PENDING_DESCRIPTOR_KINDS.has(kind)) return;
    expect(JOB_ROLE_LABELS[kind as TradeFormKindName].family).toBe(
      descriptorForKind(kind)!.cluster,
    );
  });

  it.each([...PENDING_DESCRIPTOR_KINDS])(
    "%s — staged for #3004, no descriptor yet but a real label",
    (kind) => {
      expect(descriptorForKind(kind)).toBeUndefined();
      const entry = JOB_ROLE_LABELS[kind as TradeFormKindName];
      expect(entry.label.length).toBeGreaterThan(0);
      expect(JOB_ROLE_FAMILIES).toContain(entry.family);
    },
  );

  it("the nine families ARE the API's clusters, in the same order", () => {
    expect([...JOB_ROLE_FAMILIES]).toEqual([...ROLE_CLUSTERS]);
  });

  it("carries no form-enabled flag — every declared role is postable, form or not", () => {
    // Whether a worker-side FORM exists is a profiling concern; the owner ruled all 21 postable.
    for (const entry of Object.values(JOB_ROLE_LABELS)) {
      expect(Object.keys(entry).sort()).toEqual(["family", "label"]);
    }
    // Vacuity guard: at least one declared role really has NO form today, so the ruling is live.
    expect(ROLE_FORM_DESCRIPTORS.some((d) => !d.formEnabled)).toBe(true);
  });
});
