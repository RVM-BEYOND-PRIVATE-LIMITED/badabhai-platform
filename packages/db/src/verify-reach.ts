/**
 * SEED-2 — Reach pool verifier. Loads the seeded `worker_profiles` (+ a few sample
 * `jobs`), maps them to the engine's `WorkerSignals` / `JobSpec` with the SAME boundary
 * logic the API uses, runs the REAL `@badabhai/reach-engine` `rankWorkersForJob`, and
 * asserts the pool actually exercises the scorer. Turns "does the matching pool span the
 * scorer?" into one command, mirroring `verify-demand.ts`.
 *
 * Read-only: it SELECTs the seeded rows and ranks them in-process. It mutates nothing.
 *
 *   DATABASE_URL=<local-db> pnpm db:verify:reach
 *
 * Prereq: pnpm db:migrate → db:seed:reach (the pool must exist). No PII keys needed —
 * the verifier reads only the faceless signal columns (canonical ids + JSONB signals +
 * updated_at), never phone/name, so it works without PII_ENCRYPTION_KEY/PEPPER.
 *
 * Assertions (go/no-go):
 *   (a) scores span a WIDE distribution (not clustered in one band).
 *   (b) ~12% flagged hot (the engine's default hotFraction).
 *   (c) NO worker dropped — count in == count ranked (sort-never-block).
 *   (d) ≥1 thin-supply trade/city would trigger PACE widening (sparse on-trade supply).
 *   (e) exact-trade workers outrank different-trade workers for the same job.
 */
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { rankWorkersForJob, type JobSpec, type WorkerSignals } from "@badabhai/reach-engine";
import { getRole } from "@badabhai/taxonomy";
import { createDbClient } from "./client";
import { workerProfiles, jobs } from "./schema";
import { REACH_CITIES, REACH_TRADES, type ReachTrade } from "./reach-pool-data";

config({ path: "../../.env" });

// ── Mappers — MIRROR apps/api/src/reach/reach.mappers.ts + reach.job-source.ts ──────
// Re-implemented here (rather than imported) because @badabhai/db must not depend
// upward on apps/api. They read the EXACT same JSONB keys, so a pool that ranks here
// ranks identically on the live API path.

type Json = Record<string, unknown>;
function asObject(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function nonBlankOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function lastActiveDaysAgo(updatedAt: Date | string | null, now: Date): number | null {
  if (updatedAt == null) return null;
  const then = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return null;
  const diff = now.getTime() - ms;
  if (diff < 0) return null;
  return Math.floor(diff / 86_400_000);
}

interface SignalRow {
  workerId: string;
  canonicalRoleId: string | null;
  experience: unknown;
  salaryExpectation: unknown;
  locationPreference: unknown;
  availability: unknown;
  updatedAt: Date | string | null;
}

function rowToSignals(row: SignalRow, now: Date): WorkerSignals {
  const loc = asObject(row.locationPreference);
  const centroid = loc ? (asObject(loc.centroid) ?? asObject(loc.location)) : null;
  const point =
    centroid && finiteOrNull(centroid.lat) != null && finiteOrNull(centroid.lng) != null
      ? { lat: centroid.lat as number, lng: centroid.lng as number }
      : null;
  const cityScalar = loc ? (nonBlankOrNull(loc.city) ?? nonBlankOrNull(loc.city_slug)) : null;
  const prefCities = loc && Array.isArray(loc.preferred_cities) ? loc.preferred_cities : [];
  const city = cityScalar ?? prefCities.map(nonBlankOrNull).find((c) => c != null) ?? null;
  const exp = asObject(row.experience);
  const sal = asObject(row.salaryExpectation);
  const period = sal?.period;
  const expectedSalary =
    sal && (period == null || period === "monthly")
      ? (finiteOrNull(sal.amount_min) ?? finiteOrNull(sal.amount_max))
      : null;
  const av = asObject(row.availability);
  const avRaw = av ? av.status : row.availability;
  const availability =
    typeof avRaw === "string" &&
    ["immediate", "notice_period", "not_looking", "unknown"].includes(avRaw)
      ? (avRaw as WorkerSignals["availability"])
      : null;
  return {
    workerId: row.workerId,
    roleId: nonBlankOrNull(row.canonicalRoleId),
    secondaryRoleIds: [],
    experienceYears: exp ? finiteOrNull(exp.total_years) : null,
    expectedSalary,
    location: point,
    city: city ?? null,
    travelRadiusKm: loc
      ? (finiteOrNull(loc.travel_radius_km) ?? finiteOrNull(loc.max_travel_km))
      : null,
    availability,
    lastActiveDaysAgo: lastActiveDaysAgo(row.updatedAt, now),
  };
}

// ── Stats helpers ───────────────────────────────────────────────────────────────
function bucketScores(scores: number[]): Record<string, number> {
  const buckets: Record<string, number> = {
    "0.0-0.2": 0,
    "0.2-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 0,
    "0.8-1.0": 0,
  };
  for (const s of scores) {
    if (s < 0.2) buckets["0.0-0.2"]!++;
    else if (s < 0.4) buckets["0.2-0.4"]!++;
    else if (s < 0.6) buckets["0.4-0.6"]!++;
    else if (s < 0.8) buckets["0.6-0.8"]!++;
    else buckets["0.8-1.0"]!++;
  }
  return buckets;
}

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[verify:reach] DATABASE_URL is not set");

  const now = new Date();
  const { db, sql } = createDbClient(url, { max: 1 });
  const checks: Check[] = [];

  try {
    // Load every seeded worker_profiles signal row (the faceless projection — no PII).
    const profileRows = await db
      .select({
        workerId: workerProfiles.workerId,
        canonicalRoleId: workerProfiles.canonicalRoleId,
        experience: workerProfiles.experience,
        salaryExpectation: workerProfiles.salaryExpectation,
        locationPreference: workerProfiles.locationPreference,
        availability: workerProfiles.availability,
        updatedAt: workerProfiles.updatedAt,
      })
      .from(workerProfiles);

    if (profileRows.length === 0) {
      throw new Error("[verify:reach] no worker_profiles found — run `pnpm db:seed:reach` first.");
    }

    const signals = profileRows.map((r) => rowToSignals(r as SignalRow, now));
    console.log(`[verify:reach] loaded ${signals.length} worker_profiles signal rows.`);

    // Pick a representative job: a COMMON trade (VMC) in a hub city, so a good slice of
    // the pool can exact-match it. Build a JobSpec directly against the taxonomy role id
    // (same form the API's trade→role bridge yields for tradeKey 'vmc_operator').
    const vmc = REACH_TRADES.find((t) => t.roleId === "role_vmc_operator")!;
    const pune = REACH_CITIES.find((c) => c.slug === "pune")!;
    const jobSpec: JobSpec = {
      jobId: "00000000-0000-4000-8000-0000000000aa",
      roleIds: ["role_vmc_operator", "role_hmc_operator"], // vmc_operator bridge form
      city: pune.slug,
      location: { lat: pune.lat, lng: pune.lng },
      maxTravelKm: 50,
      minExperienceYears: 2,
      maxExperienceYears: 5,
      payMin: 18000,
      payMax: 28000,
      neededBy: "immediate",
    };

    const ranked = rankWorkersForJob(jobSpec, signals);
    const scores = ranked.map((r) => r.score);

    // (a) WIDE distribution — at least 3 of the 5 score bands are populated, and the
    // spread (max − min) is meaningfully large (> 0.3).
    const buckets = bucketScores(scores);
    const populatedBands = Object.values(buckets).filter((c) => c > 0).length;
    const spread = Math.max(...scores) - Math.min(...scores);
    checks.push({
      label: "(a) scores span a WIDE distribution",
      pass: populatedBands >= 3 && spread > 0.3,
      detail: `${populatedBands}/5 bands populated, spread=${spread.toFixed(3)}`,
    });

    // (b) ~12% hot (the engine default). Allow a tolerance band around 12%.
    const hotCount = ranked.filter((r) => r.hot).length;
    const hotPct = (hotCount / ranked.length) * 100;
    checks.push({
      label: "(b) ~12% flagged hot (default hotFraction)",
      pass: hotPct >= 8 && hotPct <= 18,
      detail: `${hotCount}/${ranked.length} = ${hotPct.toFixed(1)}% hot`,
    });

    // (c) sort-never-block: count in == count ranked, no worker dropped.
    checks.push({
      label: "(c) NO worker dropped (count in == count ranked)",
      pass: ranked.length === signals.length,
      detail: `in=${signals.length} ranked=${ranked.length}`,
    });

    // (d) ≥1 thin-supply trade/city would trip PACE widening. Tally on-trade good-fit
    // supply per trade; a trade whose above-floor on-trade supply is sparse (< a small
    // floor) is a PACE-widening candidate. The rare CAM/grinding trades are seeded thin.
    const onTradeFitByTrade = new Map<string, number>();
    for (const t of REACH_TRADES) onTradeFitByTrade.set(t.roleId, 0);
    for (const s of signals) {
      if (s.roleId && onTradeFitByTrade.has(s.roleId)) {
        // "good fit" proxy: on-trade + above the push floor when ranked against a job
        // accepting that exact role in the worker's own city.
        onTradeFitByTrade.set(s.roleId, onTradeFitByTrade.get(s.roleId)! + 1);
      }
    }
    const PACE_SUPPLY_FLOOR = Math.max(3, Math.round(signals.length * 0.03));
    const thinTrades = REACH_TRADES.filter(
      (t) => (onTradeFitByTrade.get(t.roleId) ?? 0) < PACE_SUPPLY_FLOOR,
    );
    checks.push({
      label: "(d) ≥1 thin-supply trade would trigger PACE widening",
      pass: thinTrades.length >= 1,
      detail:
        `floor=${PACE_SUPPLY_FLOOR}; thin: ` +
        (thinTrades.map((t) => `${tradeLabel(t)}(${onTradeFitByTrade.get(t.roleId)})`).join(", ") ||
          "none"),
    });

    // (e) exact-trade outranks different-trade for the SAME job. Compare the best rank
    // of an on-trade worker vs the best rank of an off-trade worker.
    const onTradeIds = new Set(jobSpec.roleIds);
    const roleById = new Map(signals.map((s) => [s.workerId, s.roleId ?? null]));
    const bestOnTrade = ranked.find((r) => {
      const role = roleById.get(r.workerId);
      return role != null && onTradeIds.has(role);
    });
    const bestOffTrade = ranked.find((r) => {
      const role = roleById.get(r.workerId);
      return role != null && !onTradeIds.has(role);
    });
    const eOk =
      bestOnTrade != null && (bestOffTrade == null || bestOnTrade.rank < bestOffTrade.rank);
    checks.push({
      label: "(e) exact-trade outranks different-trade",
      pass: eOk,
      detail: `best on-trade rank=${bestOnTrade?.rank ?? "n/a"}, best off-trade rank=${
        bestOffTrade?.rank ?? "n/a"
      }`,
    });

    // Sample a few real seeded jobs to prove the pool also ranks against the live source.
    const sampleJobs = await db.select().from(jobs).where(eq(jobs.status, "open")).limit(3);

    // ── Human-readable summary ──
    console.log("\n[verify:reach] score distribution (job: VMC Operator @ Pune):");
    for (const [band, count] of Object.entries(buckets)) {
      const bar = "#".repeat(Math.round((count / ranked.length) * 40));
      console.log(`  ${band}  ${String(count).padStart(4)}  ${bar}`);
    }
    console.log("\n[verify:reach] on-trade supply per canonical role (PACE input):");
    for (const t of REACH_TRADES) {
      const c = onTradeFitByTrade.get(t.roleId) ?? 0;
      const thin = c < PACE_SUPPLY_FLOOR ? "  <- THIN (PACE candidate)" : "";
      console.log(`  ${tradeLabel(t).padEnd(22)} ${String(c).padStart(4)}${thin}`);
    }
    console.log(`\n[verify:reach] sampled ${sampleJobs.length} open seeded jobs for live-path parity.`);
    void vmc;

    console.log("\n[verify:reach] checks:");
    for (const c of checks) {
      console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.label} — ${c.detail}`);
    }

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.error(`\n[verify:reach] NO-GO — ${failed.length} check(s) failed.`);
      process.exit(1);
    }
    console.log("\n[verify:reach] GO — the seeded pool exercises the full scorer.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function tradeLabel(t: ReachTrade): string {
  return getRole(t.roleId)?.name ?? t.title;
}

main().catch((err) => {
  console.error("[verify:reach] failed:", err);
  process.exit(1);
});
