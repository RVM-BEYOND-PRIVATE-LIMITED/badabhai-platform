import { describe, expect, it } from "vitest";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";

import { roleKindSchema } from "./job-content.schemas";
import { toWorkerRoleKind } from "./worker-role-kind";

/**
 * #3025 — the two closed gates on a posting's `role_kind` read the declared list itself, so the
 * trades of CEO pack v2 flow through with no list of their own to extend.
 */
describe("a posting's role_kind gates", () => {
  it("the worker read passes every declared kind, v1 and v2 alike", () => {
    for (const kind of TRADE_FORM_KINDS_ALL) expect(toWorkerRoleKind(kind)).toBe(kind);
    expect(toWorkerRoleKind("cnc_turner")).toBe("cnc_turner");
    expect(toWorkerRoleKind("quality_engineer")).toBe("quality_engineer");
  });

  it("the worker read fails closed to null on anything undeclared", () => {
    for (const value of ["spaceship_pilot", "WELDER", "", null, undefined, 7, {}]) {
      expect(toWorkerRoleKind(value)).toBeNull();
    }
  });

  it("a posting body accepts every declared kind and refuses anything else", () => {
    for (const kind of TRADE_FORM_KINDS_ALL)
      expect(roleKindSchema.safeParse(kind).success).toBe(true);
    expect(roleKindSchema.safeParse("store_keeper").success).toBe(true);
    expect(roleKindSchema.safeParse("spaceship_pilot").success).toBe(false);
  });
});
