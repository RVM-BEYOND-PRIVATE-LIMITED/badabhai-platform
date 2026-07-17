/**
 * Alpha jobs seed (ADR-0009, Stream A; content fields per ADR-0024 addendum 2026-07-16).
 *
 * Populates the `jobs` table with a small, coarse, PII-FREE set of seeded jobs for
 * the alpha swipe-to-apply surface. The seed IS the alpha's "job source" — there is
 * no employer write path (ADR-0009 §6).
 *
 * This is REFERENCE/CATALOG data (no PII), so — like `seed-questionnaire.ts` and
 * unlike `seed.ts` — it is safe to run in any environment and is idempotent:
 * re-runs never re-insert a job. IDENTITY/LIVE fields (title, city/area, pay,
 * experience, status, applicants_received) of an already-seeded row are NEVER
 * touched on re-run. The worker-visible CONTENT fields (`description`, `shift`,
 * `benefits`, `requirements`) are SEEDER-OWNED: re-runs BACKFILL/refresh them on
 * existing rows via `ON CONFLICT (id) DO UPDATE` (so a live DB seeded before the
 * ADR-0024 addendum picks up the new content without a manual migration).
 *
 *   pnpm --filter @badabhai/db db:seed:jobs
 *   (DATABASE_URL is read from the environment / repo-root .env.)
 *
 * PRIVACY (ADR-0009 §2 + ADR-0024 addendum 2026-07-16): every job is coarse and
 * PII-free. The content fields go to workers VERBATIM.
 *  - `title` is a GENERIC role string — NEVER an employer name.
 *  - `city`/`area` are coarse location buckets — NEVER an address or geo.
 *  - `description`/`benefits`/`requirements` are short, generic strings — NEVER an
 *    employer/company name, phone, email, address, or URL.
 *  - NO employer name/id, NO contact/phone.
 *  - FAIL-CLOSED: every free-text value is checked with `looksLikePii`
 *    (@badabhai/validators) before insert; a trip aborts the whole run.
 *  - Coarse demand-side ranking signals (pay band / experience window / timing)
 *    are present for Reach-on-real-jobs (ADR-0011): non-PII job attributes, never
 *    an identity. They feed the RANK core's Pay/Experience/Availability factors.
 *
 * STABLE IDs: each job's `id` is a hardcoded UUID so the same `job_id` exists across
 * environments and reseeds (the events spine carries this id; it must be stable).
 * Do NOT regenerate these UUIDs — that would orphan already-emitted events.
 *
 * Does NOT seed `applications` — those are produced only by real worker apply/skip.
 */
import { config } from "dotenv";
import { looksLikePii, looksLikeOrgName, looksLikeUrl } from "@badabhai/validators";
import { createDbClient } from "./client";
import { jobs, type TradeKey, type JobNeededBy, type JobShift } from "./schema";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

type SeedJob = {
  id: string; // STABLE hardcoded UUID — see file header. Never regenerate.
  tradeKey: TradeKey;
  title: string; // generic role title, never an employer name
  city: string; // coarse city only
  area: string | null; // coarse locality bucket, not an address
  // Coarse demand-side ranking signals (ADR-0011). Non-PII; feed Reach RANK.
  payMin: number; // monthly INR (whole rupees)
  payMax: number;
  minExperienceYears: number;
  maxExperienceYears: number;
  neededBy: JobNeededBy;
  // Worker-visible content (ADR-0024 addendum 2026-07-16). PII-FREE, verbatim to
  // workers — never an employer/company name, phone, email, address, or URL.
  description: string; // 2–4 short sentences, Hinglish tone
  shift: JobShift; // must be consistent with any shift hint in `title`
  benefits: string[]; // 3–5 short PII-free strings
  requirements: string[]; // 2–4 short requirement tags
};

// ~17 jobs spread across all 15 alpha trades (every trade_key appears at least
// once; the two highest-volume operator trades get a second listing). Coarse
// Indian manufacturing-hub cities. No employer, no pay.
const JOBS: SeedJob[] = [
  {
    id: "a1f0c0de-0001-4a00-8000-000000000001",
    tradeKey: "cnc_operator",
    title: "CNC Operator — Night Shift",
    city: "Pune",
    area: "Chakan",
    payMin: 16000,
    payMax: 26000,
    minExperienceYears: 1,
    maxExperienceYears: 4,
    neededBy: "immediate",
    description:
      "Fanuc CNC machine operate karna. Program load aur quality check. Night shift mein output target maintain karna.",
    shift: "night",
    benefits: ["PF + ESI", "Overtime pay", "Night shift allowance", "Canteen"],
    requirements: ["Fanuc control", "ITI / Diploma", "1+ yrs"],
  },
  {
    id: "a1f0c0de-0002-4a00-8000-000000000002",
    tradeKey: "cnc_operator",
    title: "CNC Lathe Operator — Day Shift",
    city: "Coimbatore",
    area: "Peelamedu",
    payMin: 17000,
    payMax: 28000,
    minExperienceYears: 2,
    maxExperienceYears: 5,
    neededBy: "soon",
    description:
      "CNC lathe pe turning jobs chalana. Offset set karna aur first-piece inspection. Daily production report dena.",
    shift: "day",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Bonus"],
    requirements: ["CNC lathe", "Fanuc / Siemens control", "2+ yrs"],
  },
  {
    id: "a1f0c0de-0003-4a00-8000-000000000003",
    tradeKey: "vmc_operator",
    title: "VMC Operator — Rotational Shift",
    city: "Rajkot",
    area: "Aji GIDC",
    payMin: 18000,
    payMax: 28000,
    minExperienceYears: 2,
    maxExperienceYears: 5,
    neededBy: "immediate",
    description:
      "VMC machine pe milling operations. Tool change aur job setting mein help karna. Rotational shift — har hafte shift change hota hai.",
    shift: "rotational",
    benefits: ["PF + ESI", "Overtime pay", "Transport", "Canteen"],
    requirements: ["VMC operation", "Measuring instruments", "2+ yrs"],
  },
  {
    id: "a1f0c0de-0004-4a00-8000-000000000004",
    tradeKey: "vmc_operator",
    title: "VMC Operator — General Shift",
    city: "Pune",
    area: "Pimpri-Chinchwad",
    payMin: 17000,
    payMax: 27000,
    minExperienceYears: 1,
    maxExperienceYears: 4,
    neededBy: "flexible",
    description:
      "VMC pe production parts banana. Program run karna aur dimension check karna. Quality reject kam rakhna.",
    shift: "day",
    benefits: ["PF + ESI", "Canteen", "Uniform", "Bonus"],
    requirements: ["Fanuc control", "ITI / Diploma", "1+ yrs"],
  },
  {
    id: "a1f0c0de-0005-4a00-8000-000000000005",
    tradeKey: "cnc_vmc_setter",
    title: "CNC/VMC Setter — General Shift",
    city: "Ludhiana",
    area: "Focal Point",
    payMin: 22000,
    payMax: 34000,
    minExperienceYears: 3,
    maxExperienceYears: 7,
    neededBy: "soon",
    description:
      "Naye jobs ki setting karna — tooling, offset aur first piece approval. Operators ko setting mein guide karna. Setup time kam karna.",
    shift: "day",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Bonus"],
    requirements: ["Job setting", "Offset & tooling", "3+ yrs"],
  },
  {
    id: "a1f0c0de-0006-4a00-8000-000000000006",
    tradeKey: "cnc_programmer",
    title: "CNC Programmer (Fanuc)",
    city: "Bengaluru",
    area: "Peenya",
    payMin: 30000,
    payMax: 48000,
    minExperienceYears: 3,
    maxExperienceYears: 8,
    neededBy: "immediate",
    description:
      "Fanuc control ke liye CNC programs banana. Drawing se cycle plan karna. Prove-out aur cycle time improvement bhi karna.",
    shift: "day",
    benefits: ["PF + ESI", "Bonus", "Canteen", "Transport"],
    requirements: ["Fanuc programming", "G & M codes", "Blueprint reading", "3+ yrs"],
  },
  {
    id: "a1f0c0de-0007-4a00-8000-000000000007",
    tradeKey: "vmc_programmer",
    title: "VMC Programmer — Production",
    city: "Pune",
    area: "Bhosari",
    payMin: 28000,
    payMax: 45000,
    minExperienceYears: 3,
    maxExperienceYears: 7,
    neededBy: "soon",
    description:
      "VMC ke liye CAM software se programs banana. Production floor pe prove-out karna. Shift ke hisaab se program support dena.",
    shift: "rotational",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Bonus"],
    requirements: ["CAM software", "G & M codes", "3+ yrs"],
  },
  {
    id: "a1f0c0de-0008-4a00-8000-000000000008",
    tradeKey: "cad_designer",
    title: "CAD Designer — Tooling",
    city: "Ahmedabad",
    area: "Vatva GIDC",
    payMin: 24000,
    payMax: 40000,
    minExperienceYears: 2,
    maxExperienceYears: 6,
    neededBy: "flexible",
    description:
      "Tooling aur fixture ke CAD drawings banana. Design changes jaldi update karna. Shop floor ke saath drawing clarify karna.",
    shift: "day",
    benefits: ["PF + ESI", "Canteen", "Bonus"],
    requirements: ["CAD software", "Tool / fixture design", "2+ yrs"],
  },
  {
    id: "a1f0c0de-0009-4a00-8000-000000000009",
    tradeKey: "solidworks_designer",
    title: "SolidWorks Designer — Sheet Metal",
    city: "Chennai",
    area: "Ambattur",
    payMin: 26000,
    payMax: 42000,
    minExperienceYears: 2,
    maxExperienceYears: 6,
    neededBy: "soon",
    description:
      "SolidWorks mein sheet metal parts design karna. Flat pattern aur production drawings nikaalna. Design review mein participate karna.",
    shift: "day",
    benefits: ["PF + ESI", "Canteen", "Transport", "Bonus"],
    requirements: ["SolidWorks", "Sheet metal design", "2+ yrs"],
  },
  {
    id: "a1f0c0de-000a-4a00-8000-00000000000a",
    tradeKey: "autocad_draftsman",
    title: "AutoCAD Draftsman — Mechanical",
    city: "Faridabad",
    area: "Sector 24",
    payMin: 20000,
    payMax: 34000,
    minExperienceYears: 1,
    maxExperienceYears: 5,
    neededBy: "flexible",
    description:
      "AutoCAD mein 2D mechanical drawings banana. Purani drawings update karna. BOM aur drawing register maintain karna.",
    shift: "day",
    benefits: ["PF + ESI", "Canteen", "Bonus"],
    requirements: ["AutoCAD 2D", "Mechanical drawing", "ITI / Diploma"],
  },
  {
    id: "a1f0c0de-000b-4a00-8000-00000000000b",
    tradeKey: "quality_inspector",
    title: "Quality Inspector — CMM",
    city: "Coimbatore",
    area: "SIDCO Industrial Estate",
    payMin: 22000,
    payMax: 36000,
    minExperienceYears: 2,
    maxExperienceYears: 6,
    neededBy: "immediate",
    description:
      "CMM pe parts inspection karna. Inspection report banana aur reject analysis mein help karna. Shift ke hisaab se line inspection bhi karna.",
    shift: "rotational",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Uniform"],
    requirements: ["CMM operation", "Measuring instruments", "Blueprint reading"],
  },
  {
    id: "a1f0c0de-000c-4a00-8000-00000000000c",
    tradeKey: "production_engineer",
    title: "Production Engineer — Machine Shop",
    city: "Pune",
    area: "Ranjangaon",
    payMin: 30000,
    payMax: 50000,
    minExperienceYears: 3,
    maxExperienceYears: 8,
    neededBy: "soon",
    description:
      "Machine shop ka daily production plan chalana. Manpower aur machine loading manage karna. Rejection aur downtime kam karna.",
    shift: "day",
    benefits: ["PF + ESI", "Bonus", "Canteen", "Transport"],
    requirements: ["Machine shop experience", "Production planning", "Diploma / BE", "3+ yrs"],
  },
  {
    id: "a1f0c0de-000d-4a00-8000-00000000000d",
    tradeKey: "maintenance_technician",
    title: "Maintenance Technician — CNC Machines",
    city: "Rajkot",
    area: "Shapar-Veraval",
    payMin: 22000,
    payMax: 36000,
    minExperienceYears: 2,
    maxExperienceYears: 6,
    neededBy: "immediate",
    description:
      "CNC machines ka breakdown aur preventive maintenance karna. Electrical aur mechanical dono side dekhna. Machine downtime kam rakhna.",
    shift: "rotational",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Uniform"],
    requirements: ["CNC maintenance", "Electrical + mechanical", "2+ yrs"],
  },
  {
    id: "a1f0c0de-000e-4a00-8000-00000000000e",
    tradeKey: "tool_room_technician",
    title: "Tool Room Technician — Die & Mould",
    city: "Ludhiana",
    area: "Industrial Area A",
    payMin: 24000,
    payMax: 40000,
    minExperienceYears: 3,
    maxExperienceYears: 7,
    neededBy: "soon",
    description:
      "Die aur mould ka repair aur maintenance karna. Surface grinding aur fitting ka kaam. Tool room ke machines pe precision work.",
    shift: "day",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Bonus"],
    requirements: ["Die & mould work", "Surface grinding", "3+ yrs"],
  },
  {
    id: "a1f0c0de-000f-4a00-8000-00000000000f",
    tradeKey: "machine_operator",
    title: "Machine Operator — General Shift",
    city: "Nashik",
    area: "Satpur MIDC",
    payMin: 15000,
    payMax: 24000,
    minExperienceYears: 0,
    maxExperienceYears: 3,
    neededBy: "immediate",
    description:
      "Production machine operate karna. Material load-unload aur basic quality check. Training milegi — fresher bhi apply kar sakte hain.",
    shift: "day",
    benefits: ["PF + ESI", "Canteen", "Uniform", "Transport"],
    requirements: ["Fresher welcome", "Basic measuring", "ITI preferred"],
  },
  {
    id: "a1f0c0de-0010-4a00-8000-000000000010",
    tradeKey: "assembly_technician",
    title: "Assembly Technician — Sub-Assembly Line",
    city: "Aurangabad",
    area: "Waluj MIDC",
    payMin: 16000,
    payMax: 26000,
    minExperienceYears: 1,
    maxExperienceYears: 4,
    neededBy: "flexible",
    description:
      "Sub-assembly line pe parts assemble karna. Hand tools aur torque tools ka use. Line target ke hisaab se kaam karna.",
    shift: "rotational",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Transport", "Uniform"],
    requirements: ["Hand tools", "Assembly line experience", "1+ yrs"],
  },
  {
    id: "a1f0c0de-0011-4a00-8000-000000000011",
    tradeKey: "fitter",
    title: "Fitter — Mechanical",
    city: "Surat",
    area: "Sachin GIDC",
    payMin: 18000,
    payMax: 30000,
    minExperienceYears: 2,
    maxExperienceYears: 5,
    neededBy: "soon",
    description:
      "Mechanical fitting aur alignment ka kaam. Drawing padh ke assembly karna. Maintenance team ke saath machine fitting mein help karna.",
    shift: "day",
    benefits: ["PF + ESI", "Overtime pay", "Canteen", "Bonus"],
    requirements: ["Fitting & alignment", "Blueprint reading", "ITI Fitter"],
  },
];

/**
 * FAIL-CLOSED PII guard (ADR-0024 final addendum 2026-07-16): every free-text
 * value that workers see verbatim is checked with ALL THREE write-path
 * heuristics — `looksLikePii` (phone/email), `looksLikeOrgName` (legal-entity
 * suffixes), `looksLikeUrl` (link shapes) — before ANY row is written, the same
 * screen the agency write path applies. A trip aborts the whole run. The error
 * names the job id + field but NEVER echoes the offending content.
 */
function assertSeedContentPiiFree(all: SeedJob[]): void {
  const flagged = (s: string): boolean => looksLikePii(s) || looksLikeOrgName(s) || looksLikeUrl(s);
  const fail = (id: string, field: string): never => {
    throw new Error(
      `[seed:jobs] PII guard tripped — job ${id}, field "${field}" looks like PII / an employer name / a link; aborting (content not echoed)`,
    );
  };
  for (const j of all) {
    if (flagged(j.title)) fail(j.id, "title");
    if (flagged(j.description)) fail(j.id, "description");
    for (const b of j.benefits) if (flagged(b)) fail(j.id, "benefits");
    for (const r of j.requirements) if (flagged(r)) fail(j.id, "requirements");
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seed:jobs] DATABASE_URL is not set");

  // Fail closed BEFORE any insert: no row is written if any value looks like PII.
  assertSeedContentPiiFree(JOBS);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // Idempotent on the stable PK. Existing rows keep their identity/live fields
    // (title/pay/status/counters untouched); only the seeder-owned CONTENT fields
    // are backfilled/refreshed on conflict (see file header).
    for (const j of JOBS) {
      await db
        .insert(jobs)
        .values({
          id: j.id,
          tradeKey: j.tradeKey,
          title: j.title,
          city: j.city,
          area: j.area,
          status: "open",
          payMin: j.payMin,
          payMax: j.payMax,
          minExperienceYears: j.minExperienceYears,
          maxExperienceYears: j.maxExperienceYears,
          neededBy: j.neededBy,
          description: j.description,
          shift: j.shift,
          benefits: j.benefits,
          requirements: j.requirements,
        })
        .onConflictDoUpdate({
          target: jobs.id,
          set: {
            description: j.description,
            shift: j.shift,
            benefits: j.benefits,
            requirements: j.requirements,
            updatedAt: new Date(),
          },
        });
    }

    const jobRows = await db.select().from(jobs);
    console.log(`[seed:jobs] done — jobs in table=${jobRows.length} (seed defines ${JOBS.length})`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[seed:jobs] failed:", err);
  process.exit(1);
});
