/**
 * The in-process occupation snapshot.
 *
 * The two properties worth the most here are both about what a WORKER ends up seeing:
 * a chip is never NCO's official English title (and is always Latin script, #1679), and every
 * candidate carries its family so the margin can be computed where it means something.
 */
import { describe, expect, it } from "vitest";
import type { ResolvableBinding } from "@badabhai/db";

import { FAMILY_CHIP_LABELS } from "./family-chip-labels";
import { buildOccupationSnapshot, isLatinScript, pickChipLabel } from "./occupation-index";

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

describe("isLatinScript", () => {
  it("accepts Latin with the script-neutral characters every script shares", () => {
    expect(isLatinScript("raj mistri")).toBe(true);
    expect(isLatinScript("CNC Operator-Turning (2)")).toBe(true);
    expect(isLatinScript("café")).toBe(true);
  });

  it("rejects ANY other script, not only Devanagari", () => {
    expect(isLatinScript("नक्शा")).toBe(false);
    expect(isLatinScript("cad कैड")).toBe(false);
    expect(isLatinScript("ਤਰਖਾਣ")).toBe(false); // Gurmukhi
    expect(isLatinScript("१२")).toBe(false); // Devanagari digits are Devanagari, not Common
  });
});

describe("pickChipLabel", () => {
  it("prefers a Latin alias over the occupation's own Devanagari label_hi (#1679)", () => {
    // label_hi used to win outright as "the language of the conversation". The conversation is
    // romanized Hinglish; Devanagari is for read-aloud only.
    expect(pickChipLabel("वेल्डर", ["welder"], "Welder, Gas")).toBe("welder");
  });

  it("ranks by SCRIPT before length — a shorter Devanagari alias never beats a Latin one", () => {
    // The #1675 draughtsman: `नक्शा` is 5 UTF-16 code units and `naksha` is 6, so a pure
    // length ranking offered him the Devanagari word beside a Latin `cad` and `Kuch aur`.
    expect(pickChipLabel(null, ["नक्शा", "naksha", "drafting"], "Draughtsman, General")).toBe(
      "naksha",
    );
  });

  it("falls back to the SHORTEST alias, never the official English title", () => {
    // "Metal Working Machine Tool Setters and Operators" is not something a worker has
    // ever said. The chip becomes their answer of record verbatim.
    const label = pickChipLabel(null, ["kharad", "lathe operator", "turner"], "Metal Working Machine Tool Setters");
    expect(label).toBe("kharad");
  });

  it("SKIPS an alias that is merely label_en again", () => {
    // The seeder writes `label_en` into the alias array, and 77% of occupations have
    // exactly one alias — that title. Without this skip the shortest alias IS the English
    // title for 1,808 of 2,156 blue-collar occupations, and the guarantee this function is
    // named after is delivered for 348 of them.
    expect(pickChipLabel(null, ["Cooks"], "Cooks", { latin: "khana banana", hi: "खाना बनाना" })).toBe(
      "khana banana",
    );
  });

  it("compares against label_en NORMALIZED, not raw", () => {
    // "Welder, Gas" and "welder gas" are the same title wearing different punctuation. A
    // raw comparison would call the second one vernacular and put it on a chip.
    expect(pickChipLabel(null, ["welder gas"], "Welder, Gas", { latin: "welding", hi: null })).toBe(
      "welding",
    );
  });

  it("prefers a genuine vernacular alias OVER the family label", () => {
    // The family label is coarser. When the worker's own word exists, it wins.
    expect(
      pickChipLabel(null, ["kharad", "Lathe Machinist"], "Lathe Machinist", {
        latin: "machine ka kaam",
        hi: "मशीन का काम",
      }),
    ).toBe("kharad");
  });

  it("prefers the family's Latin label over a word in Devanagari", () => {
    // Script first, always. An occupation whose only word is Devanagari is a DATA gap, closed
    // with a Latin twin alias (see family-chip-labels.test.ts), never with a Devanagari chip.
    expect(pickChipLabel(null, ["धान"], "Paddy Farmer", { latin: "fasal ugana", hi: "फसल उगाना" })).toBe(
      "fasal ugana",
    );
  });

  it("prefers the family's Latin label over the occupation's own label_hi", () => {
    expect(pickChipLabel("वेल्डर", [], "Welder, Gas", { latin: "welding", hi: "वेल्डिंग" })).toBe(
      "welding",
    );
  });

  it("keeps the old Devanagari order ONLY for a family with no Latin label", () => {
    // A catalogue seeded from a newer corpus than this build. A label in the wrong script
    // still beats a chip reading NCO's English title.
    const noLatin = { latin: null, hi: "फसल" };
    expect(pickChipLabel("वेल्डर", ["धान"], "X", noLatin)).toBe("वेल्डर");
    expect(pickChipLabel(null, ["धान"], "X", noLatin)).toBe("धान");
    expect(pickChipLabel(null, [], "X", noLatin)).toBe("फसल");
  });

  it("uses label_en only when there is no family label either", () => {
    expect(pickChipLabel(null, ["Cooks"], "Cooks")).toBe("Cooks");
  });

  it("ignores a blank family label in either script", () => {
    expect(pickChipLabel(null, ["Cooks"], "Cooks", { latin: "   ", hi: "  " })).toBe("Cooks");
  });

  it("breaks equal-length ties lexicographically, not by arrival order", () => {
    // Every API instance builds its own snapshot from its own unordered query. Two
    // instances offering different chips for one occupation would record different
    // answers for the same tap.
    expect(pickChipLabel(null, ["welder", "cutter"], "X")).toBe(
      pickChipLabel(null, ["cutter", "welder"], "X"),
    );
    expect(pickChipLabel(null, ["धान", "खेत"], "X")).toBe(pickChipLabel(null, ["खेत", "धान"], "X"));
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

  it("threads the family's LATIN label into the chip when the occupation has no vernacular name", () => {
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_cook", "Cooks", "5120")],
      // The only alias is the English title, which is the shape 84% of the catalogue is in.
      aliases: [{ jobDomainId: "jd_cook", text: "Cooks" }],
      bindings: [{ familyId: "fam_cooking", iscoUnitCode: "5120" }],
      familyLabels: new Map([["fam_cooking", "खाना बनाने का काम"]]),
      familyChipLabels: { fam_cooking: "khana banana" },
    });
    expect(s.domains.get("jd_cook")?.chipLabel).toBe("khana banana");
  });

  it("DEFAULTS to the committed Latin labels, so no caller can forget them", () => {
    // `OccupationIndexService` passes only what the database holds, which is Devanagari. A
    // builder that needed telling would serve Devanagari the day someone forgot to tell it.
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_cook", "Cooks", "5120")],
      aliases: [{ jobDomainId: "jd_cook", text: "Cooks" }],
      bindings: [{ familyId: "fam_cooking", iscoUnitCode: "5120" }],
      familyLabels: new Map([["fam_cooking", "खाना बनाना"]]),
    });
    expect(s.domains.get("jd_cook")?.chipLabel).toBe(FAMILY_CHIP_LABELS.fam_cooking);
    expect(s.familyLabels.get("fam_cooking")).toBe(FAMILY_CHIP_LABELS.fam_cooking);
  });

  it("falls back to the catalogue's label_hi for a family this code has no Latin label for", () => {
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_cook", "Cooks", "5120")],
      aliases: [{ jobDomainId: "jd_cook", text: "Cooks" }],
      bindings: [{ familyId: "fam_new", iscoUnitCode: "5120" }],
      familyLabels: new Map([["fam_new", "खाना बनाना"]]),
      familyChipLabels: {},
    });
    expect(s.domains.get("jd_cook")?.chipLabel).toBe("खाना बनाना");
    expect(s.familyLabels.get("fam_new")).toBe("खाना बनाना");
  });

  it("reads only the map's OWN keys, never its prototype's", () => {
    // `labels["toString"]` is a function on any plain object. Family ids are `fam_*` by a
    // CHECK constraint today; the lookup should not depend on that staying true.
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_cook", "Cooks", "5120")],
      aliases: [{ jobDomainId: "jd_cook", text: "Cooks" }],
      bindings: [{ familyId: "toString", iscoUnitCode: "5120" }],
      familyLabels: new Map([["toString", "खाना बनाना"]]),
      familyChipLabels: {},
    });
    expect(s.domains.get("jd_cook")?.chipLabel).toBe("खाना बनाना");
  });

  it("qualifies with the Latin label even where the catalogue holds a Devanagari one", () => {
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [],
      aliases: [],
      bindings: [],
      familyLabels: new Map<string, string | null>([
        ["fam_masonry", "राज मिस्त्री"],
        ["fam_blank", null],
      ]),
      familyChipLabels: { fam_masonry: "raj mistri", fam_only_latin: "naya kaam" },
    });
    expect(s.familyLabels.get("fam_masonry")).toBe("raj mistri");
    expect(s.familyLabels.get("fam_only_latin")).toBe("naya kaam");
    expect(s.familyLabels.has("fam_blank")).toBe(false);
  });

  it("falls back to label_en when a domain has no family at all", () => {
    const s = buildOccupationSnapshot({
      catalogVersion: "v1",
      domains: [domain("jd_x", "Cooks", "9999")],
      aliases: [{ jobDomainId: "jd_x", text: "Cooks" }],
      bindings: [],
      familyLabels: new Map([["fam_cooking", "खाना बनाने का काम"]]),
    });
    expect(s.domains.get("jd_x")?.chipLabel).toBe("Cooks");
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
