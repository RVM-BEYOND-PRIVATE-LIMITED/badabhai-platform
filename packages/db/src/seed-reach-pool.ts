/**
 * SEED-1 — Reach / matching TEST POOL (synthetic, deterministic, prod-guarded).
 *
 * Populates a large, clearly-SYNTHETIC pool whose FIELD DISTRIBUTIONS exercise the
 * deterministic Reach RANK core (@badabhai/reach-engine) end-to-end — not just row
 * count. It is the fixture `db:verify:reach` (SEED-2) ranks against, and the bed for
 * manual Reach / PACE / unlock exploration on a LOCAL Postgres.
 *
 * ── What it seeds (parameterized via env; sane large defaults) ──────────────────
 *   payers          (SEED_PAYERS≈50)    employer + agent mix; each gets payer_credits
 *                                       topped + a payer_capacity + a posting_plans row
 *   workers         (SEED_WORKERS≈500)  encrypted synthetic phone, no name
 *   worker_profiles (1 per worker)      the rankable signal rows (the scorer's input)
 *   worker_consents (1 per worker)      includes `employer_sharing` (unlock gate passes)
 *   job_postings    (SEED_POSTINGS≈100) employer-owned, ADR-0012 banded
 *   jobs            (SEED_JOBS≈100)     ADR-0009 worker-feed / reach demand rows
 *
 * ── How the distribution maps to the scorer (the design intent) ─────────────────
 * The mapper `apps/api/src/reach/reach.mappers.ts` reads these worker_profiles JSONB
 * shapes → WorkerSignals; we write EXACTLY those keys so the seeded values actually
 * move each of the 6 weighted signals (role .35 · distance .20 · experience .15 ·
 * pay .10 · availability .10 · activity .10):
 *   - role          ← canonical_role_id (one of the 7 taxonomy ROLES). Exact match
 *                     against a job's role ids = 1.0; secondary = 0.6; off-trade = 0;
 *                     null = 0.4 neutral. Trade frequency is NON-UNIFORM (VMC / CNC-
 *                     turner common; CAM / grinding rare → a thin-supply trade for PACE).
 *   - distance      ← location_preference.centroid {lat,lng} (a real city CENTROID,
 *                     ADR-0005 — never a worker-precise point) + .city + .travel_radius_km.
 *                     Spread: same-city, nearby (<½ radius), within radius, beyond, unknown.
 *   - experience    ← experience.total_years. Spread: in-range, junior (below), over-
 *                     qualified (above), unknown (null).
 *   - pay           ← salary_expectation.amount_min (period 'monthly'). Spread: within
 *                     offer, above offer, unknown.
 *   - availability  ← availability.status (immediate | notice_period | not_looking |
 *                     unknown). Every value represented.
 *   - activity      ← derived from updated_at. Spread: ≤3d, this-week, this-month, stale.
 * ~10–15% of profiles are deliberately SPARSE (missing experience / salary / location)
 * to prove sort-never-block: a blank field never drops a worker, only lowers evidence.
 *
 * ── Invariants (CLAUDE.md §2) ───────────────────────────────────────────────────
 *  PROD-GUARD : refuses to run when NODE_ENV === "production" (mirrors seed-demand.ts).
 *  SYNTHETIC  : fake names ("Test Worker 0001"), synthetic E.164 phones, encrypted via
 *               the SHARED crypto (encryptPii ciphertext + hashPhone HMAC; needs
 *               PII_ENCRYPTION_KEY / PII_HASH_PEPPER). PII is NEVER written to events,
 *               logs, ai_jobs, or any non-`workers` table.
 *  DETERMINISTIC: a fixed-seed PRNG (mulberry32; NEVER Math.random) → the same SEED_*
 *               inputs produce a byte-identical pool. UUIDs are namespaced + derived
 *               from the index (the "5eed…reac…" prefix flags them as reach-seed rows),
 *               so they are stable across reseeds.
 *  IDEMPOTENT : every insert is ON CONFLICT DO UPDATE / DO NOTHING on a stable key;
 *               payer credits are re-topped on re-run.
 *  DIRECT INSERTS only (like the existing seeds) — NO events are emitted by this seed,
 *               so no PII can leak through an event. (A downstream `db:verify:demand`
 *               run against this pool emits the PII-FREE feed.shown / unlock.* family;
 *               this seed itself emits nothing.)
 *
 * ── Env knobs (defaults are the LARGE profile) ──────────────────────────────────
 *   SEED_WORKERS   (default 500)   worker + profile + consent rows
 *   SEED_PAYERS    (default 50)    payer + credits + capacity + posting_plan rows
 *   SEED_POSTINGS  (default 100)   job_postings rows
 *   SEED_JOBS      (default 100)   jobs rows
 *   SEED_RNG_SEED  (default 1337)  PRNG seed — change it for a different (still
 *                                  deterministic) pool
 *   A small CI profile, e.g.:  SEED_WORKERS=40 SEED_PAYERS=8 SEED_POSTINGS=12 SEED_JOBS=12
 *
 *   pnpm db:seed:reach          # large default pool
 *   pnpm db:seed:reach:large    # explicit large pool (same defaults)
 *   pnpm db:unseed:reach        # delete ONLY the namespaced reach-seed rows
 *   pnpm db:seed:reach -- --reset   # unseed, then reseed clean
 *   (DATABASE_URL / PII_ENCRYPTION_KEY / PII_HASH_PEPPER from the env / repo-root .env.)
 */
import { config } from "dotenv";
import { inArray } from "drizzle-orm";
import { createDbClient } from "./client";
import {
  workers,
  workerProfiles,
  workerConsents,
  jobPostings,
  jobs,
  payers,
  payerCredits,
  payerCapacity,
  postingPlans,
  type TradeKey,
  type JobNeededBy,
  type PayerRole,
} from "./schema";
import { encryptPii, hashPhone } from "./crypto";
import {
  makeRng,
  type Rng,
  REACH_SEED_PREFIX,
  reachSeedUuid,
  REACH_CITIES,
  REACH_TRADES,
  pickWeighted,
  type ReachCity,
  type ReachTrade,
} from "./reach-pool-data";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

// ---------------------------------------------------------------------------
// Env knobs (large defaults). Parse defensively → a positive integer or the default.
// ---------------------------------------------------------------------------
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SEED_WORKERS = intEnv("SEED_WORKERS", 500);
const SEED_PAYERS = intEnv("SEED_PAYERS", 50);
const SEED_POSTINGS = intEnv("SEED_POSTINGS", 100);
const SEED_JOBS = intEnv("SEED_JOBS", 100);
const RNG_SEED = intEnv("SEED_RNG_SEED", 1337);

// Re-topped balance so a verify/unlock run that spends credits never drains the pool.
const STARTING_CREDITS = 100;

// ---------------------------------------------------------------------------
// Pure record builders — these produce the EXACT rows the scorer consumes. They are
// PURE + deterministic (PRNG-driven), so the unit tests exercise them with no DB.
// ---------------------------------------------------------------------------

/** Distance tier — drives location_preference so the engine's Distance factor varies. */
type DistanceTier = "same_city" | "nearby" | "within" | "beyond" | "unknown";
/** Experience tier relative to the typical job window the engine sees. */
type ExperienceTier = "in_range" | "junior" | "overqualified" | "unknown";
/** Pay tier relative to a typical offer. */
type PayTier = "within" | "above" | "unknown";
/** Activity recency tier → controls the row's updated_at. */
type ActivityTier = "fresh" | "this_week" | "this_month" | "stale";

const AVAILABILITIES = ["immediate", "notice_period", "not_looking", "unknown"] as const;
type AvailabilityValue = (typeof AVAILABILITIES)[number];

/** A fully-resolved synthetic worker (PII + the rankable signal payload). */
export interface SeededWorker {
  index: number;
  workerId: string;
  profileId: string;
  consentId: string;
  /** SYNTHETIC display name — written ONLY into workers.full_name, encrypted. */
  fullName: string;
  /** SYNTHETIC E.164 phone — encrypted + hashed, never plaintext at rest. */
  phoneE164: string;
  /** The canonical taxonomy role id, or null (~role unknown). */
  canonicalRoleId: string | null;
  canonicalTradeId: string | null;
  /** True for the deliberately-sparse cohort (missing exp / salary / location). */
  sparse: boolean;
  distanceTier: DistanceTier;
  experienceTier: ExperienceTier;
  payTier: PayTier;
  availability: AvailabilityValue;
  activityTier: ActivityTier;
  /** worker_profiles JSONB payloads — EXACTLY the shapes reach.mappers.ts reads. */
  experience: Record<string, unknown>;
  salaryExpectation: Record<string, unknown>;
  locationPreference: Record<string, unknown>;
  availabilityJson: Record<string, unknown>;
  /** Days ago for updated_at (the activity signal). */
  updatedDaysAgo: number;
}

// Offset a centroid by ~`km` north/east — keeps coordinates a CITY-area band (ADR-0005
// city-centroid only; we never synthesize a worker-precise point — these stay coarse).
function offsetCentroid(c: ReachCity, km: number, rng: Rng): { lat: number; lng: number } {
  const dLat = km / 111; // ~111 km per degree latitude
  const lngScale = Math.cos((c.lat * Math.PI) / 180) * 111;
  const dLng = lngScale > 0 ? km / lngScale : 0;
  // A deterministic bearing from the rng so the offset direction varies but is reproducible.
  const bearing = rng.next() * 2 * Math.PI;
  return {
    lat: Number((c.lat + dLat * Math.sin(bearing)).toFixed(4)),
    lng: Number((c.lng + dLng * Math.cos(bearing)).toFixed(4)),
  };
}

/**
 * Build one synthetic worker deterministically from its index + the PRNG. The tier
 * choices are PRNG-driven, so the SAME seed + index always yields the SAME worker.
 */
export function buildWorker(index: number, rng: Rng): SeededWorker {
  const n = String(index + 1).padStart(4, "0");
  const workerId = reachSeedUuid("worker", index);
  const profileId = reachSeedUuid("profile", index);
  const consentId = reachSeedUuid("consent", index);

  // ── role (.35): non-uniform trade frequency (common vs thin-supply) ──
  // ~8% leave role null (the "trade not stated yet" neutral path).
  const roleNull = rng.next() < 0.08;
  const trade: ReachTrade = pickWeighted(
    REACH_TRADES,
    REACH_TRADES.map((t) => t.weight),
    rng,
  );
  const canonicalRoleId = roleNull ? null : trade.roleId;
  const canonicalTradeId = roleNull ? null : trade.domainId;

  // ── sparse cohort (~12%): missing experience / salary / location ──
  const sparse = rng.next() < 0.12;

  // ── distance (.20) ──
  const distanceTier: DistanceTier = sparse
    ? "unknown"
    : pickWeighted(
        ["same_city", "nearby", "within", "beyond", "unknown"] as DistanceTier[],
        [0.3, 0.25, 0.2, 0.15, 0.1],
        rng,
      );
  const city: ReachCity = REACH_CITIES[Math.floor(rng.next() * REACH_CITIES.length)]!;
  const locationPreference: Record<string, unknown> = (() => {
    if (distanceTier === "unknown") return {}; // location unknown → engine neutral 0.5
    const radius = pickWeighted([30, 40, 50, 60], [0.3, 0.3, 0.25, 0.15], rng);
    const base: Record<string, unknown> = {
      city: city.slug,
      preferred_cities: [city.slug],
      travel_radius_km: radius,
      willing_to_relocate: rng.next() < 0.3,
    };
    // Distance is graded off the centroid. same_city: at the centroid; nearby: <½ radius;
    // within: between ½ and full radius; beyond: just past the radius.
    if (distanceTier === "same_city") {
      base.centroid = { lat: city.lat, lng: city.lng };
    } else if (distanceTier === "nearby") {
      base.centroid = offsetCentroid(city, radius * 0.25, rng);
    } else if (distanceTier === "within") {
      base.centroid = offsetCentroid(city, radius * 0.75, rng);
    } else {
      base.centroid = offsetCentroid(city, radius * 1.4, rng);
    }
    return base;
  })();

  // ── experience (.15) ──
  const experienceTier: ExperienceTier = sparse
    ? "unknown"
    : pickWeighted(
        ["in_range", "junior", "overqualified", "unknown"] as ExperienceTier[],
        [0.45, 0.2, 0.2, 0.15],
        rng,
      );
  const experience: Record<string, unknown> = (() => {
    switch (experienceTier) {
      case "in_range":
        return { total_years: 2 + Math.floor(rng.next() * 4) }; // 2..5 (typical job window)
      case "junior":
        return { total_years: rng.next() < 0.5 ? 0 : 1 };
      case "overqualified":
        return { total_years: 8 + Math.floor(rng.next() * 8) }; // 8..15
      default:
        return {}; // unknown → engine neutral 0.5
    }
  })();

  // ── pay (.10) ──
  const payTier: PayTier = sparse
    ? "unknown"
    : pickWeighted(["within", "above", "unknown"] as PayTier[], [0.5, 0.3, 0.2], rng);
  const salaryExpectation: Record<string, unknown> = (() => {
    switch (payTier) {
      case "within": {
        // At/below a typical offer ceiling (~28k) → pay factor 1.0.
        const amt = 14000 + Math.floor(rng.next() * 12000); // 14k..26k
        return { amount_min: amt, amount_max: amt + 4000, currency: "INR", period: "monthly" };
      }
      case "above": {
        // Above a typical offer → graded penalty (still shown).
        const amt = 32000 + Math.floor(rng.next() * 20000); // 32k..52k
        return { amount_min: amt, amount_max: amt + 6000, currency: "INR", period: "monthly" };
      }
      default:
        return {}; // unknown → engine neutral 0.6
    }
  })();

  // ── availability (.10): every value represented ──
  const availability: AvailabilityValue = pickWeighted(
    [...AVAILABILITIES],
    [0.4, 0.3, 0.15, 0.15],
    rng,
  );
  const availabilityJson: Record<string, unknown> =
    availability === "unknown"
      ? {}
      : availability === "notice_period"
        ? { status: availability, notice_period_days: 15 + Math.floor(rng.next() * 45) }
        : { status: availability };

  // ── activity (.10): controls updated_at ──
  const activityTier: ActivityTier = pickWeighted(
    ["fresh", "this_week", "this_month", "stale"] as ActivityTier[],
    [0.3, 0.3, 0.25, 0.15],
    rng,
  );
  const updatedDaysAgo = (() => {
    switch (activityTier) {
      case "fresh":
        return Math.floor(rng.next() * 4); // 0..3
      case "this_week":
        return 4 + Math.floor(rng.next() * 4); // 4..7
      case "this_month":
        return 8 + Math.floor(rng.next() * 23); // 8..30
      default:
        return 31 + Math.floor(rng.next() * 120); // 31..150
    }
  })();

  return {
    index,
    workerId,
    profileId,
    consentId,
    fullName: `Test Worker ${n}`,
    phoneE164: syntheticPhone(index),
    canonicalRoleId,
    canonicalTradeId,
    sparse,
    distanceTier,
    experienceTier,
    payTier,
    availability,
    activityTier,
    experience,
    salaryExpectation,
    locationPreference,
    availabilityJson,
    updatedDaysAgo,
  };
}

/** A SYNTHETIC, never-real E.164 phone derived from the index. +9155500NNNNN. */
export function syntheticPhone(index: number): string {
  // 5-digit zero-padded suffix keeps every number in a reserved-looking +9155500… block.
  return `+915550${String(index).padStart(5, "0")}`;
}

/** A fully-resolved synthetic payer (employer or agent) + its entitlement rows. */
export interface SeededPayer {
  index: number;
  payerId: string;
  role: PayerRole;
  orgName: string;
  email: string;
  maxActiveVacancies: number;
}

export function buildPayer(index: number, rng: Rng): SeededPayer {
  const n = String(index + 1).padStart(4, "0");
  // ~40% agents, ~60% employers — a realistic supply/demand mix for the unlock spine.
  const role: PayerRole = rng.next() < 0.4 ? "agent" : "employer";
  const orgName =
    role === "agent"
      ? `Test Staffing Agency ${n} (synthetic)`
      : `Test Manufacturing Co ${n} (synthetic)`;
  return {
    index,
    payerId: reachSeedUuid("payer", index),
    role,
    orgName,
    email: `seed-payer-${n}@reach.test.invalid`,
    maxActiveVacancies: pickWeighted([2, 5, 10, 25], [0.35, 0.35, 0.2, 0.1], rng),
  };
}

/** A synthetic job_posting (employer demand record, ADR-0012). */
export interface SeededPosting {
  index: number;
  postingId: string;
  payerIndex: number;
  trade: ReachTrade;
  city: ReachCity;
  vacancyBand: "1" | "2-5" | "6-10" | "11-25" | "25+";
}

const VACANCY_BANDS = ["1", "2-5", "6-10", "11-25", "25+"] as const;

export function buildPosting(index: number, payerCount: number, rng: Rng): SeededPosting {
  const trade = pickWeighted(
    REACH_TRADES,
    REACH_TRADES.map((t) => t.weight),
    rng,
  );
  return {
    index,
    postingId: reachSeedUuid("posting", index),
    payerIndex: Math.floor(rng.next() * payerCount),
    trade,
    city: REACH_CITIES[Math.floor(rng.next() * REACH_CITIES.length)]!,
    vacancyBand: pickWeighted([...VACANCY_BANDS], [0.2, 0.35, 0.25, 0.12, 0.08], rng),
  };
}

/** A synthetic ADR-0009 job (reach demand row). */
export interface SeededJob {
  index: number;
  jobId: string;
  payerIndex: number;
  tradeKey: TradeKey;
  city: ReachCity;
  payMin: number;
  payMax: number;
  minExperienceYears: number;
  maxExperienceYears: number;
  neededBy: JobNeededBy;
}

const NEEDED_BY = ["immediate", "soon", "flexible"] as const;

export function buildJob(index: number, payerCount: number, rng: Rng): SeededJob {
  const trade = pickWeighted(
    REACH_TRADES,
    REACH_TRADES.map((t) => t.weight),
    rng,
  );
  const minExp = Math.floor(rng.next() * 4); // 0..3
  const maxExp = minExp + 2 + Math.floor(rng.next() * 4); // min+2 .. min+5
  const payMin = 14000 + Math.floor(rng.next() * 12000); // 14k..26k
  return {
    index,
    jobId: reachSeedUuid("job", index),
    payerIndex: Math.floor(rng.next() * payerCount),
    tradeKey: trade.tradeKey,
    city: REACH_CITIES[Math.floor(rng.next() * REACH_CITIES.length)]!,
    payMin,
    payMax: payMin + 6000 + Math.floor(rng.next() * 10000),
    minExperienceYears: minExp,
    maxExperienceYears: maxExp,
    neededBy: NEEDED_BY[Math.floor(rng.next() * NEEDED_BY.length)]!,
  };
}

// ---------------------------------------------------------------------------
// Full deterministic plan — builds EVERY record (no DB). The seed writer + the unit
// tests both call this, so the tests assert exactly what the writer persists.
// ---------------------------------------------------------------------------
export interface ReachSeedPlan {
  workers: SeededWorker[];
  payers: SeededPayer[];
  postings: SeededPosting[];
  jobs: SeededJob[];
}

export interface ReachSeedCounts {
  workers: number;
  payers: number;
  postings: number;
  jobs: number;
  rngSeed: number;
}

export function buildReachSeedPlan(counts: ReachSeedCounts): ReachSeedPlan {
  // ONE rng stream, consumed in a FIXED order (payers → workers → postings → jobs), so
  // the whole plan is a pure function of (counts, rngSeed). Same inputs → same plan.
  const rng = makeRng(counts.rngSeed);
  const payers = Array.from({ length: counts.payers }, (_, i) => buildPayer(i, rng));
  const workers = Array.from({ length: counts.workers }, (_, i) => buildWorker(i, rng));
  const postings = Array.from({ length: counts.postings }, (_, i) =>
    buildPosting(i, counts.payers, rng),
  );
  const jobs = Array.from({ length: counts.jobs }, (_, i) => buildJob(i, counts.payers, rng));
  return { payers, workers, postings, jobs };
}

// ---------------------------------------------------------------------------
// Teardown — delete ONLY the namespaced reach-seed rows (so reseeding at a different
// scale is clean). Keyed on the deterministic id sets, never a blanket truncate.
// ---------------------------------------------------------------------------
async function unseed(db: ReturnType<typeof createDbClient>["db"]): Promise<void> {
  // Delete children before parents (FK-safe): posting_plans → job_postings; profiles /
  // consents → workers. We sweep a GENEROUS namespaced range (not the current count) so a
  // prior LARGER reseed is fully removed even when re-running with a SMALLER count — and
  // we only ever touch ids in the reach-seed namespace, never a blanket truncate.
  const wide = (kind: Parameters<typeof reachSeedUuid>[0]): string[] =>
    Array.from({ length: WIDE_TEARDOWN }, (_, i) => reachSeedUuid(kind, i));

  await db.delete(postingPlans).where(inArray(postingPlans.id, wide("plan")));
  await db.delete(jobPostings).where(inArray(jobPostings.id, wide("posting")));
  await db.delete(jobs).where(inArray(jobs.id, wide("job")));
  await db.delete(workerConsents).where(inArray(workerConsents.id, wide("consent")));
  await db.delete(workerProfiles).where(inArray(workerProfiles.id, wide("profile")));
  await db.delete(workers).where(inArray(workers.id, wide("worker")));
  await db.delete(payerCredits).where(inArray(payerCredits.id, wide("credits")));
  await db.delete(payerCapacity).where(inArray(payerCapacity.id, wide("capacity")));
  await db.delete(payers).where(inArray(payers.id, wide("payer")));
}

/** Generous upper bound for teardown — covers any local reseed scale. */
const WIDE_TEARDOWN = 2000;

// ---------------------------------------------------------------------------
// Writer — idempotent inserts (ON CONFLICT). Mirrors seed-demand.ts discipline.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[seed:reach] refusing to seed synthetic fixtures in production.");
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seed:reach] DATABASE_URL is not set");

  const key = process.env.PII_ENCRYPTION_KEY;
  const pepper = process.env.PII_HASH_PEPPER;
  if (!key || !pepper) {
    throw new Error(
      "[seed:reach] PII_ENCRYPTION_KEY and PII_HASH_PEPPER must be set — synthetic phones/names " +
        "are encrypted with the SAME crypto the API uses (a full DB read never reveals plaintext).",
    );
  }

  const counts: ReachSeedCounts = {
    workers: SEED_WORKERS,
    payers: SEED_PAYERS,
    postings: SEED_POSTINGS,
    jobs: SEED_JOBS,
    rngSeed: RNG_SEED,
  };

  const unseedOnly = process.argv.includes("--unseed-only");
  const reset = unseedOnly || process.argv.includes("--reset") || process.env.SEED_RESET === "1";
  const now = new Date();
  const { db, sql } = createDbClient(url, { max: 1 });

  try {
    if (reset) {
      console.log("[seed:reach] removing prior reach-seed rows (teardown)…");
      await unseed(db);
    }

    if (unseedOnly) {
      console.log("[seed:reach] --unseed-only: teardown complete, skipping insert.");
      return;
    }

    const plan = buildReachSeedPlan(counts);

    // 1) Payers + credits + capacity (PII encrypted; org/email synthetic). ---------
    for (const p of plan.payers) {
      await db
        .insert(payers)
        .values({
          id: p.payerId,
          role: p.role,
          emailEnc: encryptPii(p.email, key),
          emailHash: hashPhone(p.email, pepper), // peppered HMAC lookup key (reused helper)
          orgNameEnc: encryptPii(p.orgName, key),
          status: "active",
        })
        .onConflictDoUpdate({
          target: payers.id,
          set: { emailEnc: encryptPii(p.email, key), orgNameEnc: encryptPii(p.orgName, key), updatedAt: now },
        });

      await db
        .insert(payerCredits)
        .values({ id: reachSeedUuid("credits", p.index), payerId: p.payerId, balance: STARTING_CREDITS })
        .onConflictDoUpdate({
          target: payerCredits.payerId,
          set: { balance: STARTING_CREDITS, updatedAt: now },
        });

      await db
        .insert(payerCapacity)
        .values({
          id: reachSeedUuid("capacity", p.index),
          payerId: p.payerId,
          maxActiveVacancies: p.maxActiveVacancies,
          sourceTier: "reach-seed",
        })
        .onConflictDoUpdate({
          target: payerCapacity.payerId,
          set: { maxActiveVacancies: p.maxActiveVacancies, updatedAt: now },
        });
    }

    // 2) Workers (encrypted phone + name) + profiles + consents. -------------------
    for (const w of plan.workers) {
      const updatedAt = new Date(now.getTime() - w.updatedDaysAgo * 86_400_000);

      await db
        .insert(workers)
        .values({
          id: w.workerId,
          phoneE164: encryptPii(w.phoneE164, key), // AES-256-GCM ciphertext token
          phoneHash: hashPhone(w.phoneE164, pepper), // keyed HMAC (lookup/dedup)
          fullName: encryptPii(w.fullName, key), // synthetic name, encrypted (never plaintext)
          status: "active",
        })
        .onConflictDoUpdate({
          target: workers.id,
          set: {
            phoneE164: encryptPii(w.phoneE164, key),
            fullName: encryptPii(w.fullName, key),
            updatedAt,
          },
        });

      await db
        .insert(workerProfiles)
        .values({
          id: w.profileId,
          workerId: w.workerId,
          profileStatus: "confirmed",
          canonicalRoleId: w.canonicalRoleId,
          canonicalTradeId: w.canonicalTradeId,
          experience: w.experience,
          salaryExpectation: w.salaryExpectation,
          locationPreference: w.locationPreference,
          availability: w.availabilityJson,
          confirmedAt: updatedAt,
          updatedAt, // drives the activity (recency) signal
        })
        .onConflictDoUpdate({
          target: workerProfiles.id,
          set: {
            canonicalRoleId: w.canonicalRoleId,
            canonicalTradeId: w.canonicalTradeId,
            experience: w.experience,
            salaryExpectation: w.salaryExpectation,
            locationPreference: w.locationPreference,
            availability: w.availabilityJson,
            updatedAt,
          },
        });

      await db
        .insert(workerConsents)
        .values({
          id: w.consentId,
          workerId: w.workerId,
          consentVersion: "seed-reach-v1",
          purposes: ["employer_sharing"], // so the unlock consent gate passes
          acceptedAt: updatedAt,
        })
        .onConflictDoNothing({ target: workerConsents.id });
    }

    // 3) Job postings (employer demand) + a paid posting_plan each. ----------------
    for (const p of plan.postings) {
      const payer = plan.payers[p.payerIndex]!;
      await db
        .insert(jobPostings)
        .values({
          id: p.postingId,
          createdBy: payer.payerId,
          payerId: payer.payerId,
          orgLabel: `SYNTHETIC — Reach Seed Posting ${p.index + 1}`,
          roleTitle: `${p.trade.title} — Reach Seed`,
          locationLabel: `${p.city.name} (seed)`,
          vacancyBand: p.vacancyBand,
          status: "open",
        })
        .onConflictDoUpdate({
          target: jobPostings.id,
          set: { vacancyBand: p.vacancyBand, status: "open", updatedAt: now },
        });

      await db
        .insert(postingPlans)
        .values({
          id: reachSeedUuid("plan", p.index),
          jobPostingId: p.postingId,
          payerId: payer.payerId,
          tier: "standard",
          applicantVisibilityQuota: 10,
          status: "active",
          paidAt: now,
        })
        .onConflictDoUpdate({
          target: postingPlans.id,
          set: { status: "active", updatedAt: now },
        });
    }

    // 4) Jobs (ADR-0009 reach demand rows). ----------------------------------------
    for (const j of plan.jobs) {
      const payer = plan.payers[j.payerIndex]!;
      await db
        .insert(jobs)
        .values({
          id: j.jobId,
          tradeKey: j.tradeKey,
          title: `${j.tradeKey} — Reach Seed ${j.index + 1}`,
          city: j.city.name,
          area: null,
          status: "open",
          payerId: payer.payerId,
          payMin: j.payMin,
          payMax: j.payMax,
          minExperienceYears: j.minExperienceYears,
          maxExperienceYears: j.maxExperienceYears,
          neededBy: j.neededBy,
        })
        .onConflictDoUpdate({
          target: jobs.id,
          set: {
            payMin: j.payMin,
            payMax: j.payMax,
            minExperienceYears: j.minExperienceYears,
            maxExperienceYears: j.maxExperienceYears,
            neededBy: j.neededBy,
            status: "open",
            updatedAt: now,
          },
        });
    }

    console.log(`[seed:reach] synthetic reach pool ready (prefix ${REACH_SEED_PREFIX}…):`);
    console.log(`  payers   = ${plan.payers.length}  (credits=${STARTING_CREDITS} each)`);
    console.log(`  workers  = ${plan.workers.length}  (+ profiles + consents)`);
    console.log(`  postings = ${plan.postings.length}  (+ posting_plans)`);
    console.log(`  jobs     = ${plan.jobs.length}`);
    console.log(`  rng seed = ${counts.rngSeed} (deterministic — same SEED_* → identical pool)`);
    console.log("Verify the distribution with: pnpm db:verify:reach");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run the writer when invoked directly (so importing this module in tests is side-effect-free).
const invokedDirectly =
  typeof process !== "undefined" && Array.isArray(process.argv) && /seed-reach-pool\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[seed:reach] failed:", err);
    process.exit(1);
  });
}
