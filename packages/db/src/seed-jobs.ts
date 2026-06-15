/**
 * Alpha jobs seed (ADR-0009, Stream A).
 *
 * Populates the `jobs` table with a small, coarse, PII-FREE set of seeded jobs for
 * the alpha swipe-to-apply surface. The seed IS the alpha's "job source" — there is
 * no employer write path (ADR-0009 §6).
 *
 * This is REFERENCE/CATALOG data (no PII), so — like `seed-questionnaire.ts` and
 * unlike `seed.ts` — it is safe to run in any environment and is idempotent
 * (`ON CONFLICT (id) DO NOTHING`), so re-runs are no-ops.
 *
 *   pnpm --filter @badabhai/db db:seed:jobs
 *   (DATABASE_URL is read from the environment / repo-root .env.)
 *
 * PRIVACY (ADR-0009 §2): every job is coarse and PII-free.
 *  - `title` is a GENERIC role string — NEVER an employer name.
 *  - `city`/`area` are coarse location buckets — NEVER an address or geo.
 *  - NO employer name/id, NO contact/phone, NO pay/salary (Phase-2 economics).
 *
 * STABLE IDs: each job's `id` is a hardcoded UUID so the same `job_id` exists across
 * environments and reseeds (the events spine carries this id; it must be stable).
 * Do NOT regenerate these UUIDs — that would orphan already-emitted events.
 *
 * Does NOT seed `applications` — those are produced only by real worker apply/skip.
 */
import { config } from "dotenv";
import { createDbClient } from "./client";
import { jobs, type TradeKey } from "./schema";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

type SeedJob = {
  id: string; // STABLE hardcoded UUID — see file header. Never regenerate.
  tradeKey: TradeKey;
  title: string; // generic role title, never an employer name
  city: string; // coarse city only
  area: string | null; // coarse locality bucket, not an address
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
  },
  {
    id: "a1f0c0de-0002-4a00-8000-000000000002",
    tradeKey: "cnc_operator",
    title: "CNC Lathe Operator — Day Shift",
    city: "Coimbatore",
    area: "Peelamedu",
  },
  {
    id: "a1f0c0de-0003-4a00-8000-000000000003",
    tradeKey: "vmc_operator",
    title: "VMC Operator — Rotational Shift",
    city: "Rajkot",
    area: "Aji GIDC",
  },
  {
    id: "a1f0c0de-0004-4a00-8000-000000000004",
    tradeKey: "vmc_operator",
    title: "VMC Operator — General Shift",
    city: "Pune",
    area: "Pimpri-Chinchwad",
  },
  {
    id: "a1f0c0de-0005-4a00-8000-000000000005",
    tradeKey: "cnc_vmc_setter",
    title: "CNC/VMC Setter — General Shift",
    city: "Ludhiana",
    area: "Focal Point",
  },
  {
    id: "a1f0c0de-0006-4a00-8000-000000000006",
    tradeKey: "cnc_programmer",
    title: "CNC Programmer (Fanuc)",
    city: "Bengaluru",
    area: "Peenya",
  },
  {
    id: "a1f0c0de-0007-4a00-8000-000000000007",
    tradeKey: "vmc_programmer",
    title: "VMC Programmer — Production",
    city: "Pune",
    area: "Bhosari",
  },
  {
    id: "a1f0c0de-0008-4a00-8000-000000000008",
    tradeKey: "cad_designer",
    title: "CAD Designer — Tooling",
    city: "Ahmedabad",
    area: "Vatva GIDC",
  },
  {
    id: "a1f0c0de-0009-4a00-8000-000000000009",
    tradeKey: "solidworks_designer",
    title: "SolidWorks Designer — Sheet Metal",
    city: "Chennai",
    area: "Ambattur",
  },
  {
    id: "a1f0c0de-000a-4a00-8000-00000000000a",
    tradeKey: "autocad_draftsman",
    title: "AutoCAD Draftsman — Mechanical",
    city: "Faridabad",
    area: "Sector 24",
  },
  {
    id: "a1f0c0de-000b-4a00-8000-00000000000b",
    tradeKey: "quality_inspector",
    title: "Quality Inspector — CMM",
    city: "Coimbatore",
    area: "SIDCO Industrial Estate",
  },
  {
    id: "a1f0c0de-000c-4a00-8000-00000000000c",
    tradeKey: "production_engineer",
    title: "Production Engineer — Machine Shop",
    city: "Pune",
    area: "Ranjangaon",
  },
  {
    id: "a1f0c0de-000d-4a00-8000-00000000000d",
    tradeKey: "maintenance_technician",
    title: "Maintenance Technician — CNC Machines",
    city: "Rajkot",
    area: "Shapar-Veraval",
  },
  {
    id: "a1f0c0de-000e-4a00-8000-00000000000e",
    tradeKey: "tool_room_technician",
    title: "Tool Room Technician — Die & Mould",
    city: "Ludhiana",
    area: "Industrial Area A",
  },
  {
    id: "a1f0c0de-000f-4a00-8000-00000000000f",
    tradeKey: "machine_operator",
    title: "Machine Operator — General Shift",
    city: "Nashik",
    area: "Satpur MIDC",
  },
  {
    id: "a1f0c0de-0010-4a00-8000-000000000010",
    tradeKey: "assembly_technician",
    title: "Assembly Technician — Sub-Assembly Line",
    city: "Aurangabad",
    area: "Waluj MIDC",
  },
  {
    id: "a1f0c0de-0011-4a00-8000-000000000011",
    tradeKey: "fitter",
    title: "Fitter — Mechanical",
    city: "Surat",
    area: "Sachin GIDC",
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seed:jobs] DATABASE_URL is not set");

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // Idempotent on the stable PK: re-runs insert nothing for existing job_ids.
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
        })
        .onConflictDoNothing({ target: jobs.id });
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
