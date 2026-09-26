import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";
import { maskInitials } from "./mask-initials";
import { templateIdForPack } from "./resume-document";
import { sheetContentLines } from "./resume-degradation";
import { buildResumeRenderInput, type TradeSheetContext } from "./resume-render-input";
import { ResumeRenderer } from "./resume-renderer.service";

/**
 * THE GENERAL SHEET, RENDERED FROM THE MAPPER — for workers outside the 21 predefined roles.
 *
 * The structural guards (`templates/bb-general-template.test.ts`) read the template; this reads
 * what a real generalized worker's input turns into. It is where a slot that fills on one sheet
 * and not the other, or a qualification row that lands in no section, shows up as text.
 *
 * WHAT THIS CANNOT SEE: visibility. The general sheet routes the qualification rows between three
 * sections with CSS (`data-label` selectors), so every row is in the HTML three times and two of
 * the copies are `display: none`. Only WeasyPrint can say which one prints, so:
 *
 *   EMIT_GENERAL_SHEETS=<dir> pnpm --filter @badabhai/api exec vitest run src/resume/bb-general-sheet
 *
 * writes the personas below and every `SHEET_SHAPES` sheet rendered as `bb_general`, for the
 * Docker recipe in templates/README.md.
 */

const renderer = new ResumeRenderer({} as never);
beforeAll(primeSheetQr);

/** The universal fallback pack — what a worker outside the 21 roles is profiled with. */
const PACK = "qp_universal";

const CHROME = {
  phone: "+91 98765 43210",
  whatsapp: "+91 91234 56789",
  qrCaption: "Scan to open this worker's live profile",
  shortLink: "badabhai.ai",
  footerMeta: "Generated 25 September 2026  ·  Ref 9NRCFH",
  asOf: new Date("2026-09-25T09:00:00Z"),
  currentCity: "Faridabad",
  currentState: "Haryana",
} as const;

/** The chat road: an LLM-led interview, so work history is the flat `experiences` list. */
const STORE_KEEPER_SNAPSHOT = {
  resume_profile: {
    domain_label: "Warehousing",
    role_label: "Store Keeper",
    skills: ["Inventory management", "Tally", "FIFO", "Stock audit"],
    experiences: [
      {
        role_label: "Store Keeper",
        duration_text: "5 saal",
        duration_months: 60,
        work_done: "Maintained the stock register and ran monthly audits",
      },
      {
        role_label: "Store Helper",
        duration_text: "2 years",
        duration_months: 24,
        work_done: "Goods receipt and dispatch",
      },
    ],
    shift: "day",
    current_city: "Faridabad",
    preferred_locations: ["Gurugram", "Noida"],
    availability: "immediate",
    expected_salary: 22000,
  },
};

/**
 * The legacy (answer-map) path: no `resume_profile` container. Two of its list entries are PII
 * shapes a worker could type as a skill — an email and a ten-digit number — and must never print.
 */
const PII_EMAIL = "suresh.pal@example.com";
const PII_NUMBER = "9876512345";
const LEGACY_FORKLIFT_SNAPSHOT = {
  role_label: "Forklift Operator",
  experience_years: 6,
  location_preference: { current_city: "Faridabad", preferred_cities: ["Faridabad", "Palwal"] },
  availability: { status: "immediate" },
  skill_labels: ["Pallet stacking", "Loading and unloading", PII_EMAIL],
  machines: ["Reach truck", "Counterbalance forklift", PII_NUMBER],
  experiences: [],
};

function context(over: Partial<TradeSheetContext> = {}): TradeSheetContext {
  return withSheetQr({
    ...CHROME,
    packId: PACK,
    attributes: {},
    employments: [],
    qualification: {
      educationHeadline: "12th pass",
      education: ["Govt. Senior Secondary School, Ballabgarh"],
      certifications: ["Forklift Safety (TUV, 2019)"],
      trainings: ["Tally ERP (NIIT, 2017)"],
      languages: ["Hindi", "English"],
      documents: ["Aadhaar", "PAN", "Bank account"],
    },
    ...over,
  })!;
}

const EMPLOYMENTS: TradeSheetContext["employments"] = [
  {
    employer: "sandhar technologies pvt ltd",
    employerCity: "Gurugram",
    employerState: "Haryana",
    startYm: "2021-03",
    endYm: null,
    durationStated: true,
    roles: [
      {
        roleLabel: "Senior Store Keeper",
        startYm: "2023-04",
        endYm: null,
        workDone: "Ran the stores team of four",
      },
      {
        roleLabel: "Store Keeper",
        startYm: "2021-03",
        endYm: "2023-03",
        workDone: "Stock register and audits",
      },
    ],
  },
  {
    employer: "JBM Auto",
    employerCity: "Faridabad",
    employerState: "Haryana",
    startYm: "2018-01",
    endYm: "2021-02",
    durationStated: true,
    roles: [
      {
        roleLabel: "Store Helper",
        startYm: null,
        endYm: null,
        workDone: "Goods receipt and dispatch",
      },
    ],
  },
];

type Persona = {
  readonly name: string;
  readonly snapshot: Record<string, unknown>;
  readonly displayName: string | null;
};

const PERSONAS: readonly Persona[] = [
  {
    name: "chat-store-keeper",
    snapshot: STORE_KEEPER_SNAPSHOT,
    displayName: "Ramesh Kumar Yadav",
  },
  {
    name: "records-store-keeper",
    snapshot: STORE_KEEPER_SNAPSHOT,
    displayName: "Ramesh Kumar Yadav",
  },
  {
    name: "sparse",
    snapshot: { resume_profile: { role_label: "Helper", current_city: "Faridabad" } },
    displayName: "Kamla Devi",
  },
  {
    // THE LEGACY (answer-map) PATH, with BOTH a skills and a machines list — the only persona in
    // which two Skills list rows print, i.e. the one that exercises the heading withdrawal
    // between list rows. Its PII-shaped entries are what `cleanList` must drop on this path.
    name: "legacy-forklift",
    snapshot: LEGACY_FORKLIFT_SNAPSHOT,
    displayName: "Suresh Pal",
  },
];

/** Contexts need the primed QR, so they are built lazily inside each test. */
function ctxFor(name: string): TradeSheetContext {
  if (name === "records-store-keeper") return context({ employments: EMPLOYMENTS });
  if (name === "sparse") return context({ qualification: {}, whatsapp: null });
  return context();
}

/**
 * The name each audience's CALLER passes: the employer disclosure masks it before the mapper
 * ever sees it (`resume-disclosure.service.ts`), so this does the same.
 */
function nameFor(p: Persona, audience: "worker" | "employer"): string | null {
  return audience === "employer" && p.displayName ? maskInitials(p.displayName) : p.displayName;
}

function render(p: Persona, audience: "worker" | "employer"): string {
  return renderer.buildResumeHtml(
    buildResumeRenderInput(
      p.snapshot,
      nameFor(p, audience),
      templateIdForPack(PACK),
      null,
      false,
      audience,
      ctxFor(p.name),
    ),
  );
}

/** The inner HTML of the first element carrying `class="<cls>"` up to its closing tag. */
function section(html: string, cls: string): string {
  const start = html.indexOf(`class="sec ${cls}"`);
  expect(start, `no ${cls} section`).toBeGreaterThan(-1);
  const open = html.indexOf(">", start) + 1;
  // Sections are single-line containers; the next section or the footer ends this one.
  const next = html.slice(open).search(/<div class="(?:sec |foot)/);
  return html.slice(open, open + next);
}

describe("a worker outside the 21 roles renders the general sheet", () => {
  it("is routed to bb_general and leaks no template syntax", () => {
    expect(templateIdForPack(PACK)).toBe("bb_general");
    for (const p of PERSONAS) {
      for (const audience of ["worker", "employer"] as const) {
        const html = render(p, audience);
        expect(html, `${p.name}/${audience}`).toContain('class="sec sec-edu"');
        expect(html, `${p.name}/${audience}`).not.toMatch(/\{\{|\}\}/);
      }
    }
  });

  it("prints the masthead, the headline and the owner's five sections from existing slots", () => {
    const html = render(PERSONAS[0]!, "worker");
    expect(html).toContain("Ramesh Kumar Yadav</h1>");
    expect(html).toContain('<div class="loc">Faridabad, Haryana</div>');
    expect(html).toContain('<div class="wa">WhatsApp: +91 91234 56789</div>');
    // The verdict line's first line, as bb_trade prints it — role · tenure · tools.
    expect(html).toMatch(/<div class="headline">Store Keeper · [^<]+<\/div>/);

    // SKILLS — the worker's own list, which bb_trade never printed beyond three headline tools.
    expect(section(html, "sec-skills")).toContain(
      '<ul class="u lrow l-skills"><li>Inventory management</li><li>Tally</li><li>FIFO</li><li>Stock audit</li></ul>',
    );
    // AVAILABILITY & TERMS — the terms rows, then Languages, then documents.
    const avail = section(html, "sec-avail");
    expect(avail).toMatch(/<span class="lab">Salary expected<\/span> ₹22,000 \/ month/);
    expect(avail).toMatch(/<span class="lab">Preferred locations<\/span> Gurugram, Noida/);
    expect(avail).toContain('data-label="Languages spoken"');
    expect(avail).toContain("<li>Aadhaar</li><li>PAN</li><li>Bank account</li>");
    // WORK HISTORY — the chat road's flat jobs: title left, the worker's own duration right.
    const work = section(html, "sec-work");
    expect(work).toContain(
      '<span class="job-title">Store Keeper</span><span class="when dur">5 saal</span>',
    );
    expect(work).toContain(
      '<div class="bullet">Maintained the stock register and ran monthly audits</div>',
    );
    // EDUCATION and CERTIFICATIONS draw from the same rows; CSS keeps each section's own.
    expect(section(html, "sec-edu")).toContain('data-label="Education"');
    expect(section(html, "sec-cert")).toContain('data-label="Certificates"');
    expect(section(html, "sec-cert")).toContain('data-label="Training"');
    // FOOTER
    expect(html).toContain(
      '<div class="foot-lead">Scan to open this worker&#39;s live profile</div>',
    );
    expect(html).toContain(
      '<div class="foot-meta">Generated 25 September 2026  ·  Ref 9NRCFH</div>',
    );
    expect(html).toMatch(/<div class="qr-box"><img class="qr" src="data:image\/svg\+xml,/);
  });

  it("prints employer blocks, promotions included, when the worker has employment records", () => {
    const work = section(render(PERSONAS[1]!, "worker"), "sec-work");
    expect(work).toContain(
      '<span class="job-title">Sandhar Technologies Pvt Ltd<span class="emp-where"> · Gurugram, Haryana</span></span>',
    );
    expect(work).toContain('<span class="stint-role">Senior Store Keeper</span>');
    // A lone undated role rides the employer line.
    expect(work).toContain(
      'JBM Auto<span class="emp-where"> · Faridabad, Haryana</span> — Store Helper</span>',
    );
    // The mapper fills one work-history shape, never both.
    expect(work).not.toContain("5 saal");
  });

  it("keeps the employer copy free of the worker-only facts", () => {
    const html = render(PERSONAS[0]!, "employer");
    expect(html).not.toContain("WhatsApp");
    expect(html).not.toContain("Salary expected");
    expect(html).not.toContain("₹");
    expect(html).not.toContain("Ramesh Kumar Yadav");
    expect(html).toContain(`>${maskInitials("Ramesh Kumar Yadav")}</h1>`);
    // The footer's fixed text survives; the QR and its lines do not travel on this copy.
    expect(html).toContain("Details as stated by the worker.");
  });

  it("prints the legacy path's skills and machines, screened for PII on both audiences", () => {
    // `bb_general` is the first BadaBhai sheet to print these lists in full — `bb_trade` showed at
    // most three tools in the headline — so the legacy path's lists are screened at the source
    // (`cleanList`), exactly as the container path's always were.
    const legacy = PERSONAS.find((p) => p.name === "legacy-forklift")!;
    for (const audience of ["worker", "employer"] as const) {
      const html = render(legacy, audience);
      const skills = section(html, "sec-skills");
      expect(skills, audience).toContain("<li>Pallet stacking</li>");
      expect(skills, audience).toContain("<li>Reach truck</li>");
      expect(html, `${audience}: an email typed as a skill reached the page`).not.toContain(
        PII_EMAIL,
      );
      expect(html, `${audience}: a phone-shaped machine reached the page`).not.toContain(
        PII_NUMBER,
      );
    }
  });

  it("screens the container path's lists for PII too — skills and the draft's machines", () => {
    // The chat road: `resume_profile.skills` was always screened; the draft's top-level
    // `machines`, which this path falls back to, is screened for the same reason as above.
    const chatWithPii: Persona = {
      name: "chat-pii",
      snapshot: {
        ...STORE_KEEPER_SNAPSHOT,
        machines: ["Hand pallet truck", PII_NUMBER],
        resume_profile: {
          ...STORE_KEEPER_SNAPSHOT.resume_profile,
          skills: ["Inventory management", PII_EMAIL],
        },
      },
      displayName: "Ramesh Kumar Yadav",
    };
    for (const audience of ["worker", "employer"] as const) {
      const html = render(chatWithPii, audience);
      const skills = section(html, "sec-skills");
      expect(skills, audience).toContain("<li>Inventory management</li>");
      expect(skills, audience).toContain("<li>Hand pallet truck</li>");
      expect(html, `${audience}: an email typed as a skill reached the page`).not.toContain(
        PII_EMAIL,
      );
      expect(html, `${audience}: a phone-shaped machine reached the page`).not.toContain(
        PII_NUMBER,
      );
    }
  });

  it("collapses every section a sparse profile has nothing for", () => {
    const html = render(PERSONAS[2]!, "worker");
    expect(html).toContain('<div class="sec sec-work"></div>');
    expect(html).toContain('<div class="sec sec-edu"></div>');
    expect(html).toContain('<div class="sec sec-cert"></div>');
    expect(html).toContain('<ul class="u lrow l-skills"></ul>');
    expect(html).toContain('<div class="wa"></div>');
  });
});

const OUT_DIR = process.env.EMIT_GENERAL_SHEETS;

describe.skipIf(!OUT_DIR)("emit general sheets for a real PDF render", () => {
  it("writes the personas and every content shape as bb_general", () => {
    mkdirSync(OUT_DIR!, { recursive: true });
    const manifest: Record<string, unknown>[] = [];
    const write = (
      file: string,
      snapshot: unknown,
      name: string | null,
      audience: "worker" | "employer",
      ctx: TradeSheetContext | null,
    ) => {
      const input = buildResumeRenderInput(
        snapshot,
        name,
        "bb_general",
        null,
        false,
        audience,
        ctx,
      );
      writeFileSync(`${OUT_DIR}/${file}`, renderer.buildResumeHtml(input), "utf8");
      manifest.push({
        file,
        audience,
        // The bb_trade line model's view of the page — NOT calibrated to this layout; recorded so
        // the measured page count can be read against it.
        lines: Number(sheetContentLines(input).toFixed(2)),
        overflows: input.degradationOverflows ?? false,
      });
    };
    for (const p of PERSONAS) {
      for (const audience of ["worker", "employer"] as const) {
        write(
          `persona-${p.name}-${audience}.html`,
          p.snapshot,
          nameFor(p, audience),
          audience,
          ctxFor(p.name),
        );
      }
    }
    for (const shape of SHEET_SHAPES) {
      for (const audience of ["worker", "employer"] as const) {
        const tag = `${String(shape.n).padStart(2, "0")}-${audience}`;
        write(
          `shape-${tag}.html`,
          shape.snapshot,
          shape.displayName,
          audience,
          withSheetQr(shape.tradeSheet),
        );
      }
    }
    writeFileSync(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expect(manifest).toHaveLength((PERSONAS.length + SHEET_SHAPES.length) * 2);
  });
});
