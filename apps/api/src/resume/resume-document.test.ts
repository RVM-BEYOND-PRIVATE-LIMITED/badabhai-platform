import { describe, expect, it } from "vitest";

import { ROLE_FORM_DESCRIPTORS } from "../profiling/roles/role-registry";
import { TRADE_RESUME_MAPS } from "./trade-resume-map";
import {
  packIsPredefinedRole,
  packUsesUniversalSheet,
  readResumeGlance,
  renderTemplateId,
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

  it("selects the trade sheet for EVERY one of the 21 predefined roles, form or not", () => {
    // The 21 are the owner's line, not the 16 with a form live today: the five polymer roles are
    // declared but formless, and they stay on the trade sheet with the rest of the 21.
    expect(ROLE_FORM_DESCRIPTORS).toHaveLength(21);
    for (const role of ROLE_FORM_DESCRIPTORS) {
      expect(packIsPredefinedRole(role.packId), role.packId).toBe(true);
      expect(templateIdForPack(role.packId), role.packId).toBe("bb_trade");
    }
  });

  it("selects the GENERAL sheet for every other pack — the owner's format of 2026-09-25", () => {
    // ~102 packs are outside the 21: the universal fallback and every family pack without a
    // trade form. They rendered through `bb_trade` with its capability zone collapsed; they now
    // get the owner's general format. Still a BadaBhai sheet — verdict line, terms rows, QR and
    // footer all print — so the cliff Layer A (i) closed stays closed.
    expect(templateIdForPack("qp_universal")).toBe("bb_general");
    // A FAMILY pack beside a role pack is not the role: `qp_welding` is the chat's welding
    // family, `qp_welding_trade` is the Welder form.
    expect(templateIdForPack("qp_welding")).toBe("bb_general");
    expect(templateIdForPack("qp_welding_trade")).toBe("bb_trade");
    expect(packUsesUniversalSheet("qp_universal")).toBe(true);
    expect(packIsPredefinedRole("qp_universal")).toBe(false);
  });

  it("renders a stored general sheet as the trade sheet once the worker holds a role pack", () => {
    // The id is fixed at generation; the pack is re-elected on every render. A worker profiled
    // in the chat who later takes a role form must not get the role's capability rows printed
    // through the general layout until his next generation lands.
    expect(renderTemplateId("bb_general", "qp_cnc_turning")).toBe("bb_trade");
    expect(renderTemplateId("bb_general", "qp_maintenance_tech")).toBe("bb_trade");
    // Unchanged while he is still outside the 21, or the pack could not be loaded.
    expect(renderTemplateId("bb_general", "qp_universal")).toBe("bb_general");
    expect(renderTemplateId("bb_general", null)).toBe("bb_general");
    // ONE WAY: a trade sheet is never downgraded, and every other id renders as recorded.
    expect(renderTemplateId("bb_trade", "qp_universal")).toBe("bb_trade");
    expect(renderTemplateId("bb_trade", null)).toBe("bb_trade");
    expect(renderTemplateId("classic", "qp_cnc_turning")).toBe("classic");
    expect(renderTemplateId("fallback", "qp_cnc_turning")).toBe("fallback");
    expect(renderTemplateId(null, "qp_cnc_turning")).toBeNull();
  });

  it("never mistakes an inherited object key for a role pack", () => {
    // The pack id is data read back from `worker_attributes`; `in` would say yes to these.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(packIsPredefinedRole(key), key).toBe(false);
      expect(templateIdForPack(key), key).toBe("bb_general");
    }
  });

  it("gives a profile with NO pack the general sheet — never classic", () => {
    // THE DEFECT THIS PINS. A chat interview for a role outside the taxonomy writes its answers
    // with no `pack_id`, so the elected pack is null. That used to map to `classic`, and the first
    // production résumé after `bb_general` shipped — a "Captain", 2026-09-26 — rendered the old
    // serif layout for exactly the worker the general sheet was built for.
    expect(templateIdForPack(null)).toBe("bb_general");
    // `classic` is selected for nobody now; it only renders rows already stored with it.
    for (const pack of [null, "qp_universal", "qp_welding", "qp_cnc_turning"]) {
      expect(templateIdForPack(pack), String(pack)).not.toBe("classic");
    }
    // The DOCUMENT format is a separate, pack-keyed decision and is unchanged: no pack → generic.
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
