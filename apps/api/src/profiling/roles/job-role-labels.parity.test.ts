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

describe("JOB_ROLE_LABELS agrees with the role descriptors", () => {
  it("covers exactly the declared descriptors — same key set, both ways", () => {
    const declared = ROLE_FORM_DESCRIPTORS.map((d) => d.kind).sort();
    expect(Object.keys(JOB_ROLE_LABELS).sort()).toEqual(declared);
    // …and both are the shared constant, so neither can drift from the event spine either.
    expect(declared).toEqual([...TRADE_FORM_KINDS_ALL].sort());
  });

  it.each(TRADE_FORM_KINDS_ALL)("%s — label is the descriptor's displayName", (kind) => {
    const descriptor = descriptorForKind(kind);
    expect(descriptor, `${kind} has no descriptor`).toBeDefined();
    expect(JOB_ROLE_LABELS[kind as TradeFormKindName].label).toBe(descriptor!.displayName);
  });

  it.each(TRADE_FORM_KINDS_ALL)("%s — family is the descriptor's cluster", (kind) => {
    expect(JOB_ROLE_LABELS[kind as TradeFormKindName].family).toBe(
      descriptorForKind(kind)!.cluster,
    );
  });

  it("the six families ARE the API's clusters, in the same order", () => {
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
