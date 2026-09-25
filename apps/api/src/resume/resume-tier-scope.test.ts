import { mkdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PROFILING_TIERS, type ProfilingTier } from "@badabhai/types";

import { rawCorpusPack } from "../profiling/form/corpus-pack.test-support";
import {
  PROFILING_TIER_FOOTER_LABEL,
  type ItemTierMap,
} from "../profiling/tiers/profiling-tier.policy";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";
import { buildResumeRenderInput, type TradeSheetContext } from "./resume-render-input";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { buildSheetFooterMeta } from "./resume-sheet-footer";
import { applyTierScope, type ResumeTierScope } from "./resume-tier-scope";
import { QUAL_SECTION_TITLES } from "./resume-tier-headings";
import { tradeResumeMapFor } from "./trade-resume-map";

/**
 * ═══ THE TIER-AWARE SHEET, AGAINST THE APPROVED TARGETS ═══
 *
 * `docs/profiling-tiers/profiling-tiers/{RINKU_KUMAR,FANA_KAUR}_RESUME_{EASY,MEDIUM,HARD}.pdf` are
 * the owner-approved output for each tier. Their rows are transcribed below exactly as those PDFs
 * (and `badabhai_resume.py`, which rendered them) print them, each tagged with the tier that first
 * shows it. The worker's ATTRIBUTES are then derived from those printed labels through the real
 * `trade-resume-map` dictionaries — so a row renders here only if the real map can print it — and
 * the sheet is built at each tier through the real mapper.
 */

const renderer = new ResumeRenderer(null as never);
const AS_OF = new Date("2026-09-18T00:00:00Z");
const GENERATED = new Date("2026-09-18T06:30:00Z");

type Kind = "chips" | "ticks" | "fact";
interface RefRow {
  readonly tier: ProfilingTier;
  readonly label: string;
  readonly kind: Kind;
  readonly items: readonly string[];
}
const E = "easy";
const M = "medium";
const H = "hard";

function tagsOf(packId: string): ItemTierMap {
  const raw = rawCorpusPack(packId) as unknown as {
    items: { question_key: string; min_tier: ProfilingTier }[];
  };
  return new Map(raw.items.map((item) => [item.question_key, item.min_tier]));
}

/** Printed labels → the stored values the map prints them from. Throws on anything unmappable. */
function attributesFor(packId: string, rows: readonly RefRow[]): Record<string, unknown> {
  const map = tradeResumeMapFor(packId)!;
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const spec = map.capability.find((c) => c.label === row.label);
    if (!spec) throw new Error(`${packId}: no map row labelled ${row.label}`);
    const slugs = row.items.map((label) => {
      const hit = Object.entries(spec.values ?? {}).find(([, printed]) => printed === label);
      if (!hit) throw new Error(`${packId}/${spec.from}: no value prints as "${label}"`);
      return hit[0];
    });
    out[spec.from] = spec.kind === "fact" && slugs.length === 1 && !spec.join ? slugs[0] : slugs;
  }
  return out;
}

interface Persona {
  readonly packId: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly titles: Readonly<Record<ProfilingTier, string>>;
  readonly rows: readonly RefRow[];
  readonly employments: readonly WorkerEmploymentRecord[];
  readonly certifications: readonly string[];
  readonly documents: readonly string[];
  readonly languages: readonly string[];
  readonly educationHeadline: string;
  readonly salary: number;
}

const job = (
  employer: string,
  city: string,
  state: string,
  role: string,
  startYm: string,
  endYm: string | null,
  workDone: string,
): WorkerEmploymentRecord => ({
  employer,
  employerCity: city,
  employerState: state,
  startYm,
  endYm,
  durationStated: true,
  roles: [{ roleLabel: role, startYm, endYm, workDone, workDonePolished: null }],
});

const RINKU: Persona = {
  packId: "qp_cnc_turning",
  name: "Rinku Kumar",
  roleLabel: "CNC Turner",
  titles: {
    easy: "MACHINES & CONTROLLERS",
    medium: "MACHINES, CONTROLLERS & CAPABILITY",
    hard: "MACHINES, CONTROLLERS & CAPABILITY",
  },
  rows: [
    {
      tier: E,
      kind: "chips",
      label: "Machines",
      items: ["CNC lathe / turning centre", "Conventional lathe", "VTL", "Sliding head (Swiss)"],
    },
    { tier: E, kind: "chips", label: "Controllers", items: ["Fanuc", "Siemens", "Haas"] },
    {
      tier: M,
      kind: "chips",
      label: "Materials",
      items: ["MS", "EN8 / EN31", "Stainless steel", "Aluminium"],
    },
    {
      tier: H,
      kind: "ticks",
      label: "Workholding",
      items: ["3-jaw chuck", "4-jaw chuck", "Collet", "Soft jaws"],
    },
    {
      tier: H,
      kind: "ticks",
      label: "Setting",
      items: ["Tool offset", "Work offset", "Tool nose radius compensation", "Chuck / jaw change"],
    },
    {
      tier: M,
      kind: "ticks",
      label: "Measuring instruments",
      items: ["Vernier", "Micrometer", "Bore dial gauge", "Height gauge"],
    },
    { tier: M, kind: "fact", label: "Programming", items: ["Edits programs (G-code / M-code)"] },
    { tier: M, kind: "fact", label: "Drawings", items: ["Reads 2D drawings"] },
    { tier: H, kind: "fact", label: "Tolerance held", items: ["±0.05 mm"] },
    {
      tier: H,
      kind: "fact",
      label: "Machine capability",
      items: ["Bar feeder", "Sub-spindle", "C-axis"],
    },
  ],
  employments: [
    job(
      "RVM",
      "Faridabad",
      "Haryana",
      "Cnc",
      "2025-03",
      null,
      "Produced approximately 120 parts, read drawings, and performed CNC turning and lathe operations.",
    ),
    job(
      "Vir Tech",
      "Delhi",
      "Delhi",
      "VMC Operator",
      "2023-01",
      "2025-01",
      "Read blueprints, loaded material, entered programs, set offsets, performed quality checks, and carried out maintenance, safety and cleaning tasks on a VMC.",
    ),
  ],
  certifications: [],
  documents: ["Aadhaar", "PAN", "Bank account", "ESIC", "ITI certificate", "Experience letter"],
  languages: ["Hindi", "English"],
  educationHeadline: "ITI",
  salary: 35000,
};

const FANA: Persona = {
  packId: "qp_cam_programming",
  name: "Fana Kaur",
  roleLabel: "CAM Programmer",
  titles: {
    easy: "SOFTWARE & MACHINES PROGRAMMED",
    medium: "SOFTWARE, MACHINES PROGRAMMED & CAPABILITY",
    hard: "SOFTWARE, MACHINES PROGRAMMED & CAPABILITY",
  },
  rows: [
    {
      tier: E,
      kind: "chips",
      label: "CAM software",
      items: ["Mastercam", "PowerMill", "SolidCAM"],
    },
    {
      tier: E,
      kind: "chips",
      label: "Machines programmed for",
      items: ["VMC · 3-axis", "VMC · 4-axis", "5-axis trunnion"],
    },
    {
      tier: M,
      kind: "chips",
      label: "Controllers posted to",
      items: ["Fanuc", "Heidenhain", "Siemens"],
    },
    {
      tier: M,
      kind: "ticks",
      label: "Programming work",
      items: ["2D & 3D toolpath", "Multi-axis toolpath", "Tool library management"],
    },
    {
      tier: H,
      kind: "ticks",
      label: "CAD model handling",
      items: ["Parasolid import", "Model repair", "Fixture modelling"],
    },
    { tier: M, kind: "fact", label: "Drawings", items: ["Reads 2D drawings"] },
    {
      tier: H,
      kind: "fact",
      label: "Sector worked",
      items: ["Auto components", "General engineering / job shop", "Defence / aerospace"],
    },
  ],
  employments: [
    job(
      "RVM Cad",
      "Faridabad",
      "Haryana",
      "CAM Programmer",
      "2024-08",
      null,
      "Created precise instructions and digital models for CNC machine operation.",
    ),
  ],
  certifications: ["Mastercam Mill — 3-Axis (Govt, 2020)"],
  documents: ["Aadhaar", "PAN", "Bank account", "Experience letter", "Passport photos"],
  languages: ["English", "Hindi"],
  educationHeadline: "Graduate — Mechanical Engineering · SCVT · 2020 · IIT Delhi",
  salary: 50000,
};

function context(p: Persona): TradeSheetContext {
  return {
    packId: p.packId,
    attributes: attributesFor(p.packId, p.rows),
    employments: p.employments,
    asOf: AS_OF,
    qualification: {
      educationHeadline: p.educationHeadline,
      certifications: [...p.certifications],
      documents: [...p.documents],
      languages: [...p.languages],
    },
    footerMeta: buildSheetFooterMeta({ generatedAt: GENERATED, refCode: "GJHXVP" }),
  };
}

function render(
  p: Persona,
  scope: ResumeTierScope | null,
): { input: ResumeRenderInput; html: string } {
  const ctx = context(p);
  const tradeSheet = applyTierScope(
    scope
      ? {
          ...ctx,
          footerMeta: buildSheetFooterMeta({
            generatedAt: GENERATED,
            refCode: "GJHXVP",
            tierLabel: PROFILING_TIER_FOOTER_LABEL[scope.tier],
          }),
        }
      : ctx,
    scope,
  );
  const input = buildResumeRenderInput(
    {
      role_label: p.roleLabel,
      experience: { total_years: null },
      salary_expectation: { amount_min: p.salary, amount_max: null },
      location_preference: { current_city: "Faridabad", preferred_cities: [] },
    },
    p.name,
    "bb_trade",
    null,
    false,
    "worker",
    tradeSheet,
  );
  return { input, html: renderer.buildResumeHtml(input) };
}

const scopeAt = (
  p: Persona,
  tier: ProfilingTier,
  stated: number | null = null,
): ResumeTierScope => ({
  tier,
  itemTiers: tagsOf(p.packId),
  statedExperienceYears: stated,
});

const printedRows = (input: ResumeRenderInput) => [
  ...(input.capChipRows ?? []).map((r) => ({ label: r.label, items: r.values })),
  ...(input.capTickRows ?? []).map((r) => ({ label: r.label, items: r.values })),
  ...(input.capFactRows ?? []).map((r) => ({ label: r.label, items: [r.value] })),
];

describe.each([
  ["Rinku Kumar — CNC Turner", RINKU],
  ["Fana Kaur — CAM Programmer", FANA],
] as const)("%s, against the approved targets", (_name, persona) => {
  describe.each(PROFILING_TIERS)("%s", (tier) => {
    const { input } = render(persona, scopeAt(persona, tier));
    const expected = persona.rows.filter(
      (r) => PROFILING_TIERS.indexOf(r.tier) <= PROFILING_TIERS.indexOf(tier),
    );

    it("prints exactly the rows the approved target prints", () => {
      expect(
        printedRows(input)
          .map((r) => r.label)
          .sort(),
      ).toEqual(expected.map((r) => r.label).sort());
    });

    it("prints each chip and tick row's values as the target does", () => {
      for (const row of expected.filter((r) => r.kind !== "fact")) {
        expect(printedRows(input).find((r) => r.label === row.label)?.items).toEqual(row.items);
      }
    });

    it("titles the capability section as the target does", () => {
      expect(input.capSectionTitle?.toUpperCase()).toBe(persona.titles[tier]);
    });

    it("titles Zone 5 as the target does, and prints documents and certificates only from Medium", () => {
      const qualTitle = QUAL_SECTION_TITLES[input.qualSectionVariant ?? "full"].toUpperCase();
      expect(qualTitle).toBe(
        tier === "easy" ? "QUALIFICATION & LANGUAGES" : "QUALIFICATION, DOCUMENTS & LANGUAGES",
      );
      expect((input.qualTickRows ?? []).length > 0).toBe(tier !== "easy");
      const certificates = (input.qualFactRows ?? []).some((r) => r.label === "Certificates");
      expect(certificates).toBe(tier !== "easy" && persona.certifications.length > 0);
    });

    it("prints the latest job only, with no description, below Medium — and every job with its description from Medium", () => {
      const employers = (input.employments ?? []).map((e) => e.employer);
      const described = (input.employments ?? []).filter((e) => (e.work ?? "").length > 0);
      if (tier === "easy") {
        expect(employers).toEqual([persona.employments[0]!.employer]);
        expect(described).toEqual([]);
      } else {
        expect(employers).toEqual(persona.employments.map((e) => e.employer));
        expect(described).toHaveLength(persona.employments.length);
      }
    });

    it("labels the footer with the tier", () => {
      expect(input.footerMeta).toBe(
        `Generated 18 September 2026  ·  Ref GJHXVP  ·  ${PROFILING_TIER_FOOTER_LABEL[tier]}`,
      );
    });
  });
});

describe("Hard for an existing profile is today's sheet, apart from the footer label", () => {
  it.each([
    ["Rinku", RINKU],
    ["Fana", FANA],
  ] as const)("%s", (_name, persona) => {
    const today = render(persona, null);
    const hard = render(persona, scopeAt(persona, "hard"));
    const { footerMeta: todayFooter, ...todayRest } = today.input;
    const { footerMeta: hardFooter, ...hardRest } = hard.input;
    expect(hardRest).toEqual(todayRest);
    expect(hardFooter).toBe(`${todayFooter}  ·  BadaBhai Recommended profile`);
    expect(hard.html.replace("  ·  BadaBhai Recommended profile", "")).toBe(today.html);
  });
});

describe("D1 — the Easy headline prints the stated total, not the latest job's tenure", () => {
  it("Rinku's Easy headline years match his Hard headline when he stated the same total", () => {
    const hardHeadline = render(RINKU, scopeAt(RINKU, "hard")).input.headlineLine ?? "";
    // 3 yrs 8 mo — the sum of both stints, which is what he told the chat.
    const easy = render(RINKU, scopeAt(RINKU, "easy", 3 + 8 / 12)).input.headlineLine ?? "";
    expect(hardHeadline).toContain("3 yrs 8 mo");
    expect(easy).toContain("3 yrs 8 mo");
  });

  it("without a stated total, falls back to the latest job's tenure rather than inventing one", () => {
    const easy = render(RINKU, scopeAt(RINKU, "easy", null)).input.headlineLine ?? "";
    expect(easy).not.toContain("3 yrs 8 mo");
  });
});

describe("applyTierScope", () => {
  it("returns the context itself when there is no scope — today's sheet, untouched", () => {
    const ctx = context(RINKU);
    expect(applyTierScope(ctx, null)).toBe(ctx);
  });

  it("drops only this pack's out-of-tier keys, never a universal answer", () => {
    const ctx = {
      ...context(RINKU),
      attributes: { ...context(RINKU).attributes, shift_preference: "day" },
    };
    const easy = applyTierScope(ctx, scopeAt(RINKU, "easy"));
    expect(Object.keys(easy.attributes).sort()).toEqual([
      "controller_brand",
      "shift_preference",
      "turning_machine",
    ]);
  });

  it("drops the documents attribute the preferences page writes, below Medium", () => {
    const ctx = { ...context(RINKU), attributes: { documents_ready: ["aadhaar"] } };
    expect(applyTierScope(ctx, scopeAt(RINKU, "easy")).attributes).toEqual({});
    expect(applyTierScope(ctx, scopeAt(RINKU, "medium")).attributes).toEqual({
      documents_ready: ["aadhaar"],
    });
  });

  it("empties 'Also works as' below Medium", () => {
    const ctx = { ...context(RINKU), occupations: ["Welder"] };
    expect(applyTierScope(ctx, scopeAt(RINKU, "easy")).occupations).toEqual([]);
    expect(applyTierScope(ctx, scopeAt(RINKU, "medium")).occupations).toEqual(["Welder"]);
  });
});

/**
 * THE VISUAL CHECK'S INPUT — six sheets (two personas × three tiers) plus each persona's
 * tier-less "today" sheet, as HTML for WeasyPrint. OFF unless `EMIT_TIER_SHEETS=<dir>` is set,
 * exactly like `sheet-shape-emit.test.ts`: this box has no WeasyPrint, so the PDFs are rendered
 * in the API image's recipe (docs/resume-pdf-render-local.md) and compared against the approved
 * targets in `docs/profiling-tiers/profiling-tiers/`.
 */
const EMIT_DIR = process.env.EMIT_TIER_SHEETS;
describe.skipIf(!EMIT_DIR)("emit the tier sheets for a visual comparison", () => {
  it("writes {RINKU_KUMAR,FANA_KAUR}_{EASY,MEDIUM,HARD,TODAY}.html", () => {
    mkdirSync(EMIT_DIR!, { recursive: true });
    for (const [slug, persona] of [
      ["RINKU_KUMAR", RINKU],
      ["FANA_KAUR", FANA],
    ] as const) {
      for (const tier of PROFILING_TIERS) {
        // The total each worker states in the chat (D1): what an Easy headline prints.
        const stated = persona === RINKU ? 3 + 8 / 12 : 2 + 2 / 12;
        const { html } = render(persona, scopeAt(persona, tier, stated));
        writeFileSync(`${EMIT_DIR}/${slug}_${tier.toUpperCase()}.html`, html, "utf8");
      }
      writeFileSync(`${EMIT_DIR}/${slug}_TODAY.html`, render(persona, null).html, "utf8");
    }
  });
});
