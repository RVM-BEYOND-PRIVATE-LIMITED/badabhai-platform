/**
 * B5 (#2559) — synthetic 50k-row Candidates fixture for the p95 acceptance.
 *
 * Seeds `workers` + `admin_candidate_index` rows with varied, representative
 * data (20 cities, 10 trades, skill/label distributions, mixed statuses) so a
 * search + filter + sort + facets round-trip can be timed at production scale.
 * The READ path is what is measured: rows are inserted directly (not projected),
 * which is legitimate because projection cost is covered by unit tests and the
 * acceptance is about query latency.
 *
 * LOCAL HOSTS ONLY (same guard as the .db.test.ts files — the repo-root env
 * points at production). Refuses any non-local host. Idempotent per run-tag:
 * every synthetic value carries the run tag, and `--clean` deletes exactly
 * this run's rows (workers cascade owns the index rows).
 *
 *   pnpm db:seed:candidates-perf [--workers=50000] [--clean] [--tag=<tag>]
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { sql as dsql } from "drizzle-orm";
import { createDbClient, type Database } from "./client";
import { adminCandidateIndex, workers } from "./schema";

const CITIES = [
  "Pune", "Mumbai", "Nashik", "Nagpur", "Thane", "Pimpri", "Solapur", "Kolhapur",
  "Aurangabad", "Amravati", "Indore", "Bhopal", "Surat", "Ahmedabad", "Jaipur",
  "Lucknow", "Kanpur", "Delhi", "Bangalore", "Chennai",
];
const TRADES: { id: string; label: string; role: string; roleId: string; skills: string[] }[] = [
  { id: "trade_cnc", label: "CNC Machining", role: "CNC Operator", roleId: "role_cnc_operator", skills: ["CNC operating", "VMC", "GD&T"] },
  { id: "trade_weld", label: "Welding", role: "TIG Welder", roleId: "role_tig_welder", skills: ["TIG welding", "MIG welding"] },
  { id: "trade_fit", label: "Fitting", role: "Fitter", roleId: "role_fitter", skills: ["Bench fitting", "Assembly"] },
  { id: "trade_elec", label: "Electrical", role: "Electrician", roleId: "role_electrician", skills: ["Wiring", "Motor repair"] },
  { id: "trade_plumb", label: "Plumbing", role: "Plumber", roleId: "role_plumber", skills: ["Pipe fitting"] },
  { id: "trade_carp", label: "Carpentry", role: "Carpenter", roleId: "role_carpenter", skills: ["Woodwork", "Furniture"] },
  { id: "trade_paint", label: "Painting", role: "Painter", roleId: "role_painter", skills: ["Spray painting"] },
  { id: "trade_mason", label: "Masonry", role: "Mason", roleId: "role_mason", skills: ["Brickwork", "Plastering"] },
  { id: "trade_tailor", label: "Tailoring", role: "Tailor", roleId: "role_tailor", skills: ["Stitching", "Cutting"] },
  { id: "trade_driver", label: "Driving", role: "Driver", roleId: "role_driver", skills: ["LMV driving", "Navigation"] },
];
const STATUSES = ["active", "active", "active", "pending", "suspended"] as const;

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`seed-candidates-perf refuses non-local host (${host})`);
  }
}

async function seed(db: Database, total: number, tag: string): Promise<void> {
  const BATCH = 1000;
  for (let start = 0; start < total; start += BATCH) {
    const end = Math.min(start + BATCH, total);
    const workerRows = [];
    const indexRows = [];
    for (let i = start; i < end; i++) {
      const id = randomUUID();
      const trade = TRADES[i % TRADES.length]!;
      const city = CITIES[i % CITIES.length]!;
      const status = STATUSES[i % STATUSES.length]!;
      const exp = (i * 7) % 25;
      workerRows.push({
        id,
        phoneE164: `perfenc:${tag}:${i}`,
        phoneHash: `perfhash:${tag}:${i}`,
        status,
        currentCity: city,
      });
      const searchDoc = `${trade.label} ${trade.role} manufacturing ${city} ${trade.skills.join(" ")} hindi`.toLowerCase();
      indexRows.push({
        workerId: id,
        status,
        flagged: i % 17 === 0,
        isTestAccount: i % 11 === 0,
        currentCity: city,
        currentState: "Maharashtra",
        canonicalTradeId: trade.id,
        canonicalRoleId: trade.roleId,
        tradeLabel: trade.label,
        roleLabel: trade.role,
        domainLabel: "Manufacturing",
        totalExperienceYears: String(exp),
        profileStatus: exp % 2 === 0 ? "confirmed" : "incomplete",
        searchDoc,
        nameTokenHashes: [`perftok:${i % 200}`],
        phoneHash: `perfphone:${tag}:${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await db.insert(workers).values(workerRows);
    await db.insert(adminCandidateIndex).values(indexRows);
  }
}

async function clean(db: Database, tag: string): Promise<number> {
  // `_` is a LIKE wildcard: escape it so one run can never catch another's rows.
  const safeTag = tag.replace(/_/g, "\\_");
  const rows = await db.execute<{ n: number }>(
    dsql`WITH gone AS (DELETE FROM workers WHERE phone_hash LIKE ${`perfhash:${safeTag}:%`} ESCAPE '\\' RETURNING id) SELECT count(*)::int AS n FROM gone`,
  );
  return (rows as unknown as { n: number }[])[0]?.n ?? 0;
}

async function run(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      workers: { type: "string" },
      clean: { type: "boolean", default: false },
      tag: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const total = values.workers === undefined ? 50000 : Number(values.workers);
  if (!Number.isInteger(total) || total < 1 || total > 200000) {
    throw new Error("--workers must be an integer in 1..200000");
  }
  const tag = values.tag ?? randomUUID().slice(0, 8);
  // The tag interpolates into a LIKE pattern in --clean: keep it to a safe
  // alphabet rather than trusting argv anywhere near SQL.
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(tag)) {
    throw new Error("--tag must be 1..16 chars of A-Za-z0-9_-");
  }
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL is required");
  assertLocalDatabase(cs);
  const client = createDbClient(cs, { max: 1 });
  try {
    if (values.clean) {
      const n = await clean(client.db, tag);
      console.log(`[seed-candidates-perf] cleaned workers=${n} tag=${tag}`);
      return 0;
    }
    const started = Date.now();
    await seed(client.db, total, tag);
    console.log(
      `[seed-candidates-perf] seeded workers=${total} tag=${tag} ms=${Date.now() - started}`,
    );
    return 0;
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(
        `[seed-candidates-perf] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    },
  );
}
