/**
 * The in-process occupation snapshot.
 *
 * The two properties worth the most here are both about what a WORKER ends up seeing:
 * a chip is never NCO's official English title, and every candidate carries its family so
 * the margin can be computed where it means something.
 */
import { describe, expect, it } from "vitest";
import type { ResolvableBinding } from "@badabhai/db";

import { buildOccupationSnapshot, pickChipLabel } from "./occupation-index";

const BINDINGS: ResolvableBinding[] = [
  { familyId: "fam_welding", iscoUnitCode: "7212" },
  { familyId: "fam_metal_tail", iscoMinorCode: "722" },
  { familyId: "fam_universal", isUniversal: true },
];

const domain = (id: string, labelEn: string, unit: string | null, labelHi: string | null = null) => ({
  jobDomainId: id,
  labelEn,
  labelHi,
  iscoUnitCode: unit,
});

describe("pickChipLabel", () => {
  it("prefers label_hi — the language the conversation is actually in", () => {
    expect(pickChipLabel("वेल्डर", ["welder"], "Welder, Gas")).toBe("वेल्डर");
  });

  it("falls back to the SHORTEST alias, never the official English title", () => {
    // "Metal Working Machine Tool Setters and Operators" is not something a worker has
    // ever said. The chip becomes their answer of record verbatim.
    const label = pickChipLabel(null, ["kharad", "lathe operator", "turner"], "Metal Working Machine Tool Setters");
    expect(label).toBe("kharad");
  });

  it("breaks equal-length ties lexicographically, not by arrival order", () => {
    // Every API instance builds its own snapshot from its own unordered query. Two
    // instances offering different chips for one occupation would record different
    // answers for the same tap.
    expect(pickChipLabel(null, ["welder", "cutter"], "X")).toBe(
      pickChipLabel(null, ["cutter", "welder"], "X"),
    );
  });

  it("ignores blank aliases and blank label_hi", () => {
    expect(pickChipLabel("   ", ["", "  ", "mistri"], "Mason")).toBe("mistri");
  });

  it("falls back to label_en only when there is no alias at all", () => {
    expect(pickChipLabel(null, [], "Mason")).toBe("Mason");
  });
});

describe("buildOccupationSnapshot", () => {
  const snap = () =>
    buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_weld", "Welder, Gas", "7212"), domain("jd_sheet", "Sheet Metal Worker", "7223")],
      aliases: [
        { jobDomainId: "jd_weld", text: "welder" },
        { jobDomainId: "jd_weld", text: "welding" },
        { jobDomainId: "jd_sheet", text: "sheet metal worker" },
        { jobDomainId: "jd_ghost", text: "ghost trade" },
      ],
      bindings: BINDINGS,
    });

  it("resolves every domain's family at BUILD time, not per turn", () => {
    const s = snap();
    expect(s.domains.get("jd_weld")?.familyId).toBe("fam_welding");
  });

  it("uses the fallback chain, so a minor-level binding still yields a family", () => {
    // 7223 has no unit binding; 722 does. Falling through to universal here would mean
    // the margin is computed against the wrong thing for 1,530 occupations.
    expect(snap().domains.get("jd_sheet")?.familyId).toBe("fam_metal_tail");
  });

  it("drops aliases whose domain is not in the snapshot", () => {
    // A hit resolving to an id the snapshot cannot describe would surface as an
    // unlabelled chip.
    const s = snap();
    expect(s.aliasCount).toBe(3);
    expect(s.spans.exact.has("ghost trade")).toBe(false);
  });

  it("indexes aliases for L0 and L1 through the shared span builder", () => {
    const s = snap();
    expect(s.spans.exact.get("welder")).toEqual(["jd_weld"]);
    expect(s.spans.skeleton.size).toBeGreaterThan(0);
  });

  it("carries the catalog version through unchanged", () => {
    expect(snap().catalogVersion).toBe("v1");
  });

  it("gives a domain with no family binding a null family rather than inventing one", () => {
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_x", "Something", "1111")],
      aliases: [{ jobDomainId: "jd_x", text: "something" }],
      bindings: [{ familyId: "fam_welding", iscoUnitCode: "7212" }],
    });
    expect(s.domains.get("jd_x")?.familyId).toBeNull();
  });

  it("is empty rather than throwing when given nothing", () => {
    const s = buildOccupationSnapshot({
      catalogVersion: "v0",
      domains: [],
      aliases: [],
      bindings: [],
    });
    expect(s.domains.size).toBe(0);
    expect(s.aliasCount).toBe(0);
  });
});
