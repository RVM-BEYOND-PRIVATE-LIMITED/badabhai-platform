import { describe, expect, it } from "vitest";
import { getDomain, getRole } from "@badabhai/taxonomy";

import { ENABLED_ROLE_DESCRIPTORS } from "./role-registry";
import { canonicalIdsForKind, canonicalIdsForPack } from "./trade-canonical";

describe("trade-canonical (#2202)", () => {
  it("maps the reported trade: cnc_turner → role_cnc_turner_operator + its domain", () => {
    expect(canonicalIdsForKind("cnc_turner")).toEqual({
      canonicalRoleId: "role_cnc_turner_operator",
      canonicalTradeId: "dom_cnc_machining",
    });
  });

  it("every mapped id resolves in the installed taxonomy, and the domain is the role's own", () => {
    for (const kind of ["cnc_turner", "vmc_milling", "cnc_grinding", "cam_programmer", "welder"]) {
      const ids = canonicalIdsForKind(kind);
      expect(ids, kind).not.toBeNull();
      const role = getRole(ids!.canonicalRoleId);
      expect(role, kind).toBeDefined();
      expect(role!.domainId).toBe(ids!.canonicalTradeId);
      expect(getDomain(ids!.canonicalTradeId), kind).toBeDefined();
    }
  });

  it("an unmapped trade fails closed (null) — never a guessed id", () => {
    // cad_draughtsman: no exact taxonomy role (role_designer is generic — see the file note).
    expect(canonicalIdsForKind("cad_draughtsman")).toBeNull();
    expect(canonicalIdsForKind("fitter")).toBeNull();
    expect(canonicalIdsForKind("conventional_machinist")).toBeNull();
    expect(canonicalIdsForKind("tool_die_maker")).toBeNull();
    expect(canonicalIdsForKind("quality_inspector")).toBeNull();
    expect(canonicalIdsForKind("not_a_trade")).toBeNull();
    expect(canonicalIdsForKind("")).toBeNull();
  });

  it("resolves through the pack id the form was built from", () => {
    expect(canonicalIdsForPack("qp_cnc_turning")).toEqual({
      canonicalRoleId: "role_cnc_turner_operator",
      canonicalTradeId: "dom_cnc_machining",
    });
    expect(canonicalIdsForPack("qp_welding_trade")).toEqual({
      canonicalRoleId: "role_welder",
      canonicalTradeId: "dom_welding",
    });
    // A pack whose trade has no taxonomy role fails closed too.
    expect(canonicalIdsForPack("qp_cad_drafting")).toBeNull();
    expect(canonicalIdsForPack("no_such_pack")).toBeNull();
    expect(canonicalIdsForPack(null)).toBeNull();
    expect(canonicalIdsForPack(undefined)).toBeNull();
  });

  it("every enabled role is either mapped or deliberately unmapped (no silent omission)", () => {
    const mapped = new Set([
      "cnc_turner",
      "vmc_milling",
      "cnc_grinding",
      "cam_programmer",
      "welder",
    ]);
    for (const descriptor of ENABLED_ROLE_DESCRIPTORS) {
      const ids = canonicalIdsForKind(descriptor.kind);
      if (mapped.has(descriptor.kind)) {
        expect(ids, descriptor.kind).not.toBeNull();
      } else {
        // Deliberate: the taxonomy has no exact role for this trade (see the file note).
        expect(ids, descriptor.kind).toBeNull();
      }
    }
  });
});
