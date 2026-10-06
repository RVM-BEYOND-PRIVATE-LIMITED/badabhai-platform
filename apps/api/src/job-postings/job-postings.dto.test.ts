import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { loadQuestionPackCorpus, resolveJobDomainCorpus } from "@badabhai/db";
import { MATCH_SKILLS, ROLES } from "@badabhai/taxonomy";
import CITIES_FILE from "@badabhai/profiling-lexicon/data/cities.json";
import { JOB_ROLE_LABELS } from "@badabhai/types";

import { CreateAgencyJobSchema, UpdateAgencyJobSchema } from "../agency/agency.dto";
import { FAMILY_CHIP_LABELS } from "../occupation/family-chip-labels";
import { CITY_HUBS } from "../profiles/worker-cities.hubs";
import {
  CreateJobPostingSchema,
  PayerCreateJobPostingSchema,
  UpdateJobPostingSchema,
} from "./job-postings.dto";

/**
 * #1823 B3 — POSTING FREE-TEXT SCREEN PARITY (ADR-0024 free-text guard).
 *
 * The worker feed, search and job detail show a posting's `role_title` as the card title and
 * its `description` verbatim. Agency `jobs.title` / `description` have run all three
 * heuristics since the ADR-0024 final addendum. The posting fields did not: `role_title` ran
 * none and `description` ran `looksLikePii` only. Every write into `job_postings` parses one
 * of the three schemas below. That covers the ops register, the payer form and PATCH, and the
 * AI job-posting chat publish, which validates its draft against `PayerCreateJobPostingSchema`
 * before it creates anything. So these matrices cover every runtime write path.
 */
const CREATED_BY = "11111111-1111-4111-8111-111111111111";

const ROUTES: ReadonlyArray<{
  name: string;
  schema: z.ZodTypeAny;
  base: Record<string, unknown>;
}> = [
  {
    name: "CreateJobPostingSchema (ops register)",
    schema: CreateJobPostingSchema,
    base: {
      created_by: CREATED_BY,
      org_label: "Acme Works",
      role_title: "CNC Operator",
      vacancy_band: "1",
    },
  },
  {
    name: "PayerCreateJobPostingSchema (payer form + chat publish)",
    schema: PayerCreateJobPostingSchema,
    base: { org_label: "Acme Works", role_title: "CNC Operator", vacancy_band: "1" },
  },
  {
    name: "UpdateJobPostingSchema (ops + payer PATCH)",
    schema: UpdateJobPostingSchema,
    base: {},
  },
];

/** One sample per heuristic, each tripping ONLY that heuristic. */
const SCREENS = [
  { screen: "looksLikePii (phone)", value: "Call 98765 43210 for this", tail: "contact" },
  { screen: "looksLikePii (email)", value: "Send CV to hr@acme.example", tail: "contact" },
  { screen: "looksLikeOrgName", value: "Operator at Kalyani Pvt Ltd", tail: "company" },
  { screen: "looksLikeUrl", value: "Details at www.acme.in", tail: "link" },
] as const;

/** The agency precedent's messages, verbatim (`agency.dto.ts`). */
const AGENCY_MESSAGES = {
  role_title: {
    contact: "remove contact details from the title",
    company: "title must not contain a company name",
    link: "title must not contain links",
  },
  description: {
    contact: "remove contact details from the description",
    company: "description must not contain a company name",
    link: "description must not contain links",
  },
} as const;

function issuesFor(schema: z.ZodTypeAny, body: Record<string, unknown>, field: string) {
  const r = schema.safeParse(body);
  if (r.success) return [];
  return r.error.issues.filter((i) => i.path.join(".") === field).map((i) => i.message);
}

describe("#1823 B3 — every posting write route screens role_title and description", () => {
  for (const route of ROUTES) {
    for (const field of ["role_title", "description"] as const) {
      for (const s of SCREENS) {
        it(`${route.name}: ${field} × ${s.screen} → 400 naming the field`, () => {
          const body = { ...route.base, [field]: s.value };
          expect(route.schema.safeParse(body).success).toBe(false);
          expect(issuesFor(route.schema, body, field)).toEqual([AGENCY_MESSAGES[field][s.tail]]);
        });
      }
    }

    it(`${route.name}: clean role_title and description pass`, () => {
      const r = route.schema.safeParse({
        ...route.base,
        role_title: "VMC Setter — General Shift",
        description: "Operate and set VMC machines on the day line. Fanuc control, 2 yrs exp.",
      });
      expect(r.success).toBe(true);
    });
  }

  it("org_label and location_label stay UNSCREENED (the company's own name; never on a worker read)", () => {
    const r = PayerCreateJobPostingSchema.safeParse({
      ...ROUTES[1]!.base,
      org_label: "Kalyani Forge Pvt Ltd",
      location_label: "Plot 12, MIDC Bhosari 411026, www.kalyani.in",
    });
    expect(r.success).toBe(true);
  });

  it("a stored value is not re-screened by a PATCH that does not resend the field", () => {
    // Write-side only: no read filter, and no retro-validation of untouched columns.
    expect(UpdateJobPostingSchema.safeParse({ shift: "night" }).success).toBe(true);
  });
});

/**
 * #1942 — every posting write route inherits the screen's fold: a suffix, a phone number or a
 * link in fullwidth forms or split by an invisible character is the same 400 as its plain
 * spelling, on role_title and on description.
 */
describe("#1942 — every posting write route screens fullwidth and invisibly split text", () => {
  const HIDDEN = [
    {
      label: "a fullwidth suffix",
      value: "Tata Steel \u{FF2C}\u{FF54}\u{FF44} mein apply kariye",
      tail: "company",
    },
    { label: "a zero-width-split suffix", value: "Tata Steel L\u{200B}td mein", tail: "company" },
    { label: "a control-split suffix", value: "Tata Steel L\u{1}td mein", tail: "company" },
    { label: "a zero-width-split phone", value: "Call 98765\u{200B}43210", tail: "contact" },
    { label: "a fullwidth host", value: "Details at acme\u{FF0E}in", tail: "link" },
  ] as const;

  for (const route of ROUTES) {
    for (const field of ["role_title", "description"] as const) {
      for (const h of HIDDEN) {
        it(`${route.name}: ${field} × ${h.label} → 400 naming the field`, () => {
          const body = { ...route.base, [field]: h.value };
          expect(issuesFor(route.schema, body, field)).toEqual([AGENCY_MESSAGES[field][h.tail]]);
        });
      }
    }
  }
});

describe("#1823 B3 — the posting messages ARE the agency messages", () => {
  const agencyBase = { trade_key: "cnc_operator", title: "CNC Operator", city: "Pune" } as const;

  for (const s of SCREENS) {
    it(`${s.screen}: role_title ≡ agency title, description ≡ agency description`, () => {
      const agencyTitle = issuesFor(
        CreateAgencyJobSchema,
        { ...agencyBase, title: s.value },
        "title",
      );
      const agencyPatchTitle = issuesFor(UpdateAgencyJobSchema, { title: s.value }, "title");
      const agencyDesc = issuesFor(
        CreateAgencyJobSchema,
        { ...agencyBase, description: s.value },
        "description",
      );
      for (const route of ROUTES) {
        const body = { ...route.base };
        expect(issuesFor(route.schema, { ...body, role_title: s.value }, "role_title")).toEqual(
          agencyTitle,
        );
        expect(issuesFor(route.schema, { ...body, description: s.value }, "description")).toEqual(
          agencyDesc,
        );
      }
      expect(agencyPatchTitle).toEqual(agencyTitle);
    });
  }
});

/**
 * FALSE-REJECTION REGRESSION, measured over the role titles the repository actually carries:
 * the 21 posting role labels, the taxonomy roles and match-skill labels, the worker trade-chip
 * labels, every question-pack family label, and every English label and alias of every
 * SELECTABLE occupation in the NCO-2015 / ISCO-08 / vernacular corpus.
 *
 * The corpus is machine-scraped from PDFs. A handful of its rows are SCRAPE ARTEFACTS rather
 * than titles: a label that starts with NCO codes ("7122.0600"), or one that swallowed its
 * whole occupational definition. No payer types those, and the length cap rejects the second
 * kind anyway. Those are recognised structurally below. Anything ELSE that fails is a real
 * false rejection and turns this red.
 */
describe("#1823 B3 — legitimate trade titles are NOT rejected", () => {
  const NCO_CODE = /\b\d{4}\.\d{4}\b/;
  const LABEL_MAX = 200;
  const isScrapeArtefact = (t: string): boolean => NCO_CODE.test(t) || t.length > LABEL_MAX;

  // Screen refusals only: a 200+ char artefact also fails the length cap, which is not what
  // this suite measures.
  const SCREEN_MESSAGES = new Set<string>(Object.values(AGENCY_MESSAGES.role_title));
  const titleIssues = (title: string): string[] =>
    issuesFor(
      PayerCreateJobPostingSchema,
      { ...ROUTES[1]!.base, role_title: title },
      "role_title",
    ).filter((m) => SCREEN_MESSAGES.has(m));

  it.each([
    "CNC Operator",
    "VMC Setter",
    "Welder (MIG/TIG)",
    "CNC Operator — Night Shift",
    "CNC/VMC Setter — General Shift",
    "Tool Room Technician — Die & Mould",
    "Tool & Die Maker",
    "Fitter - 2 yrs exp",
    "VMC 1060 Operator",
    "Operator for Mazak QT-200",
    "Quality Inspector / QC",
    "co-worker friendly Turner",
  ])("accepts %j", (title) => {
    expect(titleIssues(title)).toEqual([]);
  });

  it("the repository's role lists pass with zero false rejections", () => {
    const titles = new Set<string>([
      ...Object.values(JOB_ROLE_LABELS).map((r) => r.label),
      ...ROLES.map((r) => r.name),
      ...MATCH_SKILLS.map((s) => s.labelEn),
      ...Object.values(FAMILY_CHIP_LABELS),
      ...loadQuestionPackCorpus().families.map((f) => f.label_en),
    ]);
    expect(titles.size).toBeGreaterThan(100); // vacuity guard

    const rejected = [...titles].filter((t) => titleIssues(t).length > 0);
    expect(rejected).toEqual([]);
  });

  it("every selectable occupation label and English alias passes, scrape artefacts aside", () => {
    const titles = new Set<string>();
    for (const d of resolveJobDomainCorpus()) {
      if (!d.selectable) continue;
      titles.add(d.label_en);
      for (const a of d.aliases ?? []) if (a.lang === "en") titles.add(a.text);
    }
    expect(titles.size).toBeGreaterThan(5000); // vacuity guard

    const rejected = [...titles].filter((t) => titleIssues(t).length > 0);
    const real = rejected.filter((t) => !isScrapeArtefact(t));
    expect(real).toEqual([]);
    // The artefact carve-out must stay small, or it is hiding something.
    expect(rejected.length).toBeLessThan(10);
  });
});

/**
 * #1848 — CITY AND AREA ON EVERY WRITE ROUTE, BOTH DEMAND SURFACES.
 *
 * Both render verbatim on the worker job card and detail. Every write of a posting or an
 * agency job parses one of these five schemas (the chat publish goes through
 * `PayerCreateJobPostingSchema`), so this matrix covers every runtime write path for them.
 */
const PLACE_ROUTES: ReadonlyArray<{
  name: string;
  schema: z.ZodTypeAny;
  base: Record<string, unknown>;
}> = [
  ...ROUTES,
  {
    name: "CreateAgencyJobSchema",
    schema: CreateAgencyJobSchema,
    base: { trade_key: "cnc_operator", title: "CNC Operator", city: "Pune" },
  },
  { name: "UpdateAgencyJobSchema", schema: UpdateAgencyJobSchema, base: {} },
];

const PLACE_MESSAGES = {
  city: {
    contact: "remove contact details from the city",
    company: "city must not contain a company name",
    link: "city must not contain links",
  },
  area: {
    contact: "remove contact details from the area",
    company: "area must not contain a company name",
    link: "area must not contain links",
  },
} as const;

/** One sample per heuristic, each a place-shaped value tripping ONLY that heuristic. */
const PLACE_SCREENS = [
  { screen: "looksLikePii (phone)", value: "Pune 98765 43210", tail: "contact" },
  { screen: "looksLikePii (email)", value: "Chakan hr@acme.example", tail: "contact" },
  { screen: "looksLikeOrgName", value: "Bhosari, Kalyani Pvt Ltd", tail: "company" },
  { screen: "looksLikeUrl", value: "Chakan www.acme.in", tail: "link" },
  // An email whose numeric part is pincode-shaped: the waiver must not cut it out (#1848).
  {
    screen: "looksLikePii (email with a pincode-shaped part)",
    value: "hr@411026.xyz",
    tail: "contact",
  },
] as const;

/**
 * Real places, measured (#1848): the seed jobs' cities and areas, then industrial localities
 * across the hubs, then the five sector/phase/plot + pincode forms the plain screen refused.
 * The repository's own city lists are checked in full below.
 */
const REAL_PLACES = [
  "Pune",
  "Chakan",
  "Coimbatore",
  "Peelamedu",
  "Rajkot",
  "Aji GIDC",
  "Pimpri-Chinchwad",
  "Ludhiana",
  "Focal Point",
  "Bengaluru",
  "Peenya",
  "Bhosari",
  "Ahmedabad",
  "Vatva GIDC",
  "Chennai",
  "Ambattur",
  "Faridabad",
  "Sector 24",
  "SIDCO Industrial Estate",
  "Ranjangaon",
  "Shapar-Veraval",
  "MIDC Industrial Estate",
  "Peenya Industrial Area",
  "Sector 63",
  "Sector 63, Noida",
  "Bhosari MIDC",
  "Manesar IMT",
  "GIDC Vatva",
  "Ambattur Industrial Estate",
  "Pvt Colony",
  "Udyog Vihar Phase-V",
  "Okhla Industrial Area Phase 2",
  "Mohali Phase 8",
  "Hosur SIPCOT",
  "SIPCOT Phase 1, Hosur",
  "Electronic City Phase II",
  "Pithampur Sector 3",
  "L&T Colony",
  "Tata Motors Colony",
  "Bhosari & Chakan",
  "Pune (Chakan)",
  "Ahmedabad – Vatva",
  "Co-operative Industrial Estate",
  "G.T. Road",
  "St. Thomas Mount",
  "N.H. 48",
  "Pune 411018",
  "560058",
  "Sector 63, 201301",
  "Sector 63 201301",
  "Sector 63 - 201301",
  "Phase 2 411026",
  "MIDC Phase 2 411026",
  "Plot 7 411026",
] as const;

describe("#1848 — every posting and agency write route screens city and area", () => {
  for (const route of PLACE_ROUTES) {
    for (const field of ["city", "area"] as const) {
      for (const s of PLACE_SCREENS) {
        it(`${route.name}: ${field} × ${s.screen} → 400 naming the field`, () => {
          const body = { ...route.base, [field]: s.value };
          expect(route.schema.safeParse(body).success).toBe(false);
          expect(issuesFor(route.schema, body, field)).toEqual([PLACE_MESSAGES[field][s.tail]]);
        });
      }

      it(`${route.name}: ${field} accepts every measured real place`, () => {
        const rejected = REAL_PLACES.filter(
          (value) => !route.schema.safeParse({ ...route.base, [field]: value }).success,
        );
        expect(rejected).toEqual([]);
      });
    }

    it(`${route.name}: the stored value is the value sent (no shape change)`, () => {
      const r = route.schema.safeParse({ ...route.base, city: "Pune", area: "Phase 2 411026" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.city).toBe("Pune");
        expect(r.data.area).toBe("Phase 2 411026");
      }
    });
  }

  it("the repository's city lists and hub areas pass with zero false rejections", () => {
    const cities = CITIES_FILE as unknown as {
      canonical: string[];
      aliases: Record<string, string>;
    };
    const places = new Set<string>([
      ...cities.canonical,
      ...Object.keys(cities.aliases),
      ...CITY_HUBS.flatMap((h) => [h.display, h.city_value, ...h.areas]),
    ]);
    expect(places.size).toBeGreaterThan(80); // vacuity guard

    const route = PLACE_ROUTES[1]!;
    const rejected = [...places].filter(
      (value) =>
        issuesFor(route.schema, { ...route.base, city: value }, "city").length > 0 ||
        issuesFor(route.schema, { ...route.base, area: value }, "area").length > 0,
    );
    expect(rejected).toEqual([]);
  });

  it("a PATCH that does not resend city or area does not re-screen the stored values", () => {
    // Write-side only: a row stored before #1848 keeps its value until an edit resends it.
    expect(UpdateJobPostingSchema.safeParse({ shift: "night" }).success).toBe(true);
    expect(UpdateAgencyJobSchema.safeParse({ shift: "night" }).success).toBe(true);
  });
});
