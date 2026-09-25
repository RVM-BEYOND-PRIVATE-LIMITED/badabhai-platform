import { describe, expect, it } from "vitest";

import { TRADE_RESUME_MAPS } from "./trade-resume-map";
import {
  packUsesUniversalSheet,
  readResumeGlance,
  templateIdForPack,
  toResumeDocument,
  tradeKindForPack,
  TRADE_KIND_BY_PACK,
} from "./resume-document";
import type { ResumeRenderInput } from "./resume-renderer.service";

/**
 * ═══ THE RESUME AS STRUCTURED DATA ═══
 *
 * Two things are being defended here.
 *
 * ONE: THE TEMPLATE GATE. `bb_trade` had been shipped and immutable for sixteen packets while
 * both create branches hardcoded "classic", so the trade sheet was dark code. Selecting it is the
 * change that makes every role pack authored so far actually reach paper — and the gate has to be
 * exactly "does this pack have a resume map", because anything looser silently re-lays-out every
 * worker in the country.
 *
 * TWO: TWO FORMATS, N TRADES. `format` is what a client switches on and there are two of them,
 * because there are two layouts. `trade` is what it labels with and is open-ended. Adding a trade
 * must add a `trade` value and no client branch — a union keyed on the trade would make every new
 * trade a new case in Dart, which is what "scalable" has to rule out.
 */

const BASE: ResumeRenderInput = {
  templateId: "bb_trade",
  displayName: "Ramesh Kumar Yadav",
  canonicalRole: "CNC Turner",
  location: "Faridabad",
  experienceYears: 8,
  availability: "available in 15 days",
  summary: "A summary.",
  skills: ["Turning"],
  machines: ["CNC lathe"],
  controllers: ["Fanuc"],
  educationLevel: "ITI",
  educationField: "Machinist",
  education: ["ITI — Machinist"],
  certifications: ["CNC Turning & Setting"],
  responsibilities: [],
  trade: "CNC Machining",
  experiences: [],
  preferredLocations: ["Faridabad"],
  expectedSalary: 32000,
};

describe("the template gate (Layer A (i) — no map, no cliff)", () => {
  it("selects the trade sheet for a pack that has a resume map", () => {
    for (const map of TRADE_RESUME_MAPS) {
      expect(packUsesUniversalSheet(map.pack_id)).toBe(true);
      expect(templateIdForPack(map.pack_id)).toBe("bb_trade");
    }
    // Not a vacuous loop.
    expect(TRADE_RESUME_MAPS.length).toBeGreaterThan(0);
  });

  it("selects it for an UNMAPPED pack too — the cliff this closes", () => {
    // ~102 packs have no bespoke capability map. They used to fall back to `classic` and lose
    // the verdict line, the terms rows, Zone 5, the QR and the footer — none of which a map
    // drives. The template gate is now the PACK, and the no-map capability zone collapses
    // (buildTradeCapabilityRows already handles that) rather than costing the whole sheet.
    expect(templateIdForPack("qp_universal")).toBe("bb_trade");
    expect(templateIdForPack("qp_welding")).toBe("bb_trade");
    expect(packUsesUniversalSheet("qp_universal")).toBe(true);
  });

  it("keeps classic only when there is no pack at all", () => {
    // A profile with no pack answers has nothing the universal sheet adds; this is the only
    // remaining `classic` case.
    expect(templateIdForPack(null)).toBe("classic");
    expect(packUsesUniversalSheet(null)).toBe(false);
  });

  it("names every pack that has a sheet", () => {
    // A pack with a map but no name still renders — a labelling gap is not a render fault — but
    // shipping one is an authoring oversight, so it is asserted rather than left to be noticed.
    for (const map of TRADE_RESUME_MAPS) {
      expect(TRADE_KIND_BY_PACK[map.pack_id]).toBeDefined();
    }
  });

  it("names an unmapped pack's sheet with the generic label rather than refusing", () => {
    // Layer A (i): EVERY pack renders the universal sheet, so an unmapped pack is a labelling
    // gap — "trade" — not a reason to withhold the layout. A null pack is still generic.
    expect(tradeKindForPack(null)).toBeNull();
    expect(tradeKindForPack("qp_universal")).toBe("trade");
  });
});

describe("toResumeDocument", () => {
  it("projects a generic profile with no pack at all", () => {
    const doc = toResumeDocument(BASE, null);
    expect(doc.format).toBe("generic");
    expect(doc.trade).toBeNull();
    if (doc.format !== "generic") throw new Error("unreachable");
    expect(doc.summary).toBe("A summary.");
    expect(doc.machines).toEqual(["CNC lathe"]);
    expect(doc.expectedSalary).toBe(32000);
  });

  it("projects a turner as a trade sheet, named", () => {
    const doc = toResumeDocument(
      {
        ...BASE,
        headlineLine: "CNC Turner · 8 yrs · Fanuc",
        subheadLine: "Faridabad · available in 15 days · expects ₹32,000",
        capSectionTitle: "Machines, controllers & capability",
        capChipRows: [{ label: "Machines", values: ["CNC lathe"] }],
        capTickRows: [{ label: "Setting", values: ["Tool offset"] }],
        capFactRows: [{ label: "Tolerance held", value: "±0.02 mm" }],
        availFactRows: [{ label: "Available from", value: "15 days" }],
        qualFactRows: [{ label: "Education", value: "ITI — Machinist" }],
        qualTickRows: [{ label: "Documents ready", values: ["Aadhaar"] }],
        phone: "+91 98765 43210",
        trustBadge: "RVM-attested",
        footerMeta: "Generated 29 August 2026 · Ref RK8M2Q",
      },
      "qp_cnc_turning",
    );

    expect(doc.format).toBe("trade_sheet");
    expect(doc.trade).toBe("cnc_turner");
    if (doc.format !== "trade_sheet") throw new Error("unreachable");
    expect(doc.headline).toEqual({
      line1: "CNC Turner · 8 yrs · Fanuc",
      line2: "Faridabad · available in 15 days · expects ₹32,000",
    });
    expect(doc.header).toEqual({
      name: "Ramesh Kumar Yadav",
      phone: "+91 98765 43210",
      trustBadge: "RVM-attested",
    });
    expect(doc.footerMeta).toBe("Generated 29 August 2026 · Ref RK8M2Q");
  });

  it("keeps the sheet's zones in the order the sheet prints them", () => {
    const doc = toResumeDocument(BASE, "qp_cnc_turning");
    if (doc.format !== "trade_sheet") throw new Error("unreachable");
    expect(doc.sections.map((s) => s.id)).toEqual(["capability", "terms", "qualifications"]);
  });

  it("keeps an empty zone rather than dropping it", () => {
    // Whether an empty section shows a heading is a decision for the surface that can see the
    // screen; dropping it here would take that decision away from the client.
    const doc = toResumeDocument(BASE, "qp_cnc_turning");
    if (doc.format !== "trade_sheet") throw new Error("unreachable");
    const terms = doc.sections.find((s) => s.id === "terms");
    expect(terms).toBeDefined();
    expect(terms?.factRows).toEqual([]);
  });

  it("a second trade is a new label, not a new format", () => {
    // The scalability property, asserted rather than asserted in prose: adding the milling pack
    // produced another `trade` value and the SAME `format`, so the client needs no new branch.
    const turner = toResumeDocument(BASE, "qp_cnc_turning");
    const miller = toResumeDocument(BASE, "qp_vmc_milling");
    expect(turner.format).toBe(miller.format);
    expect(turner.trade).not.toBe(miller.trade);
  });

  it("carries no field the render input does not hold", () => {
    // The whole point: the screen and the paper are projections of ONE input. A document that
    // fetched anything for itself could assert a fact the PDF cannot.
    const doc = toResumeDocument(BASE, "qp_cnc_turning");
    if (doc.format !== "trade_sheet") throw new Error("unreachable");
    expect(doc.header.phone).toBeNull();
    expect(doc.header.trustBadge).toBeNull();
    expect(doc.employments).toEqual([]);
    expect(doc.employmentsMore).toBeNull();
  });
});

/**
 * #1714 — THE HISTORY CARD'S FACTS, recorded with the render.
 *
 * Two properties. The glance is the Verdict Line's facts and nothing the input does not hold, so
 * a card cannot say what the sheet does not. And a stored document is read back VALIDATED: every
 * row rendered before this shipped has no glance, and that must read as "nothing recorded".
 */
describe("the glance (#1714)", () => {
  const FACTS = {
    role: "VMC Operator",
    years: 2,
    tools: ["VMC"],
    axes: ["3-axis", "4-axis"],
    city: "Manesar",
  } as const;
  const WITH_FACTS: ResumeRenderInput = { ...BASE, verdictFacts: FACTS };

  it("projects the Verdict Line's facts and the page count onto BOTH formats", () => {
    const expected = {
      role: "VMC Operator",
      experienceYears: 2,
      machines: ["VMC"],
      axes: ["3-axis", "4-axis"],
      city: "Manesar",
      pageCount: 1,
    };
    expect(toResumeDocument(WITH_FACTS, "qp_vmc_milling", 1).glance).toEqual(expected);
    expect(toResumeDocument(WITH_FACTS, null, 1).glance).toEqual(expected);
  });

  it("reads the facts off `verdictFacts`, NOT the classic slots that share their names", () => {
    // BASE's own slots say "CNC Turner", 8 years, "CNC lathe", "Faridabad". A glance built from
    // them would describe a different sheet from the Verdict Line this input prints.
    const glance = toResumeDocument(WITH_FACTS, "qp_vmc_milling").glance;
    expect(glance.role).toBe("VMC Operator");
    expect(glance.experienceYears).toBe(2);
    expect(glance.machines).toEqual(["VMC"]);
    expect(glance.city).toBe("Manesar");
  });

  it("records nothing it was not given: no facts, no count", () => {
    expect(toResumeDocument(BASE, "qp_cnc_turning").glance).toEqual({
      role: null,
      experienceYears: null,
      machines: [],
      axes: [],
      city: null,
      pageCount: null,
    });
  });

  it("round-trips through the jsonb column", () => {
    const stored: unknown = JSON.parse(
      JSON.stringify(toResumeDocument(WITH_FACTS, "qp_vmc_milling", 2)),
    );
    expect(readResumeGlance(stored)).toEqual({
      role: "VMC Operator",
      experienceYears: 2,
      machines: ["VMC"],
      axes: ["3-axis", "4-axis"],
      city: "Manesar",
      pageCount: 2,
    });
  });

  it("reads a document rendered BEFORE #1714 as nothing recorded — and a row with none at all", () => {
    const legacy = JSON.parse(JSON.stringify(toResumeDocument(WITH_FACTS, "qp_vmc_milling")));
    delete legacy.glance;
    expect(readResumeGlance(legacy)).toBeNull();
    expect(readResumeGlance(null)).toBeNull();
    expect(readResumeGlance(undefined)).toBeNull();
    expect(readResumeGlance("not a document")).toBeNull();
  });

  it("refuses a malformed glance whole, rather than showing part of one", () => {
    const good = JSON.parse(JSON.stringify(toResumeDocument(WITH_FACTS, "qp_vmc_milling", 1)));
    // Not vacuous: the unmodified document reads back.
    expect(readResumeGlance(good)).not.toBeNull();
    const broken: Record<string, unknown>[] = [
      { pageCount: 0 },
      { pageCount: 1.5 },
      { pageCount: "1" },
      { experienceYears: -1 },
      { experienceYears: 0 },
      { machines: "VMC" },
      { axes: [3] },
      { city: 7 },
      { role: undefined },
    ];
    for (const change of broken) {
      expect(readResumeGlance({ ...good, glance: { ...good.glance, ...change } })).toBeNull();
    }
  });
});
