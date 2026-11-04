/**
 * Payer-demo candidate seed — 30 candidates × 16 live profiles (480 workers) (#2651).
 *
 * Owner ask (2026-11-03): the payer web/app shows no candidates because no worker
 * profiles exist yet. Seed DEMO data: 30 candidates per live profile, spread across
 * locations + experience bands, honouring the CEO new-taxonomy ladders. Applied to
 * production 2026-11-03; committed with #2651.
 *
 * THEY ARE SAMPLES. Every worker id is in the `be16…` namespace owned by
 * `sample-workers.ts`, so the API badges the card "Sample candidate" and refuses its unlock
 * before any credit moves (R74) — the same treatment as the `face…` synthetic workforce.
 *
 * WHAT IT WRITES (DIRECT inserts; NO events; every id namespaced `be16…`):
 *   workers            480 synthetic workers, RESERVED phones (`+910000061xxx`,
 *                      a NEW carve-out of the reserved test-phone range — disjoint
 *                      from demo `026xxx` and workforce `050xxx`)
 *   worker_profiles    one confirmed profile per worker (`canonical_role_id` /
 *                      `skills` / `experience`), populated through the SAME bridge
 *                      the live chat/form extraction uses — never a hand-picked
 *                      match skill
 *   worker_consents    one live consent per worker (`employer_sharing` INCLUDED so
 *                      payers can find the demo candidates)
 *   worker_attributes  one pack-answer row per PACK-route worker (closed-set
 *                      option keys from the checked-in pack JSON, nothing invented)
 *   worker_profile_skill one authored row per worker (trade `mskill_*` +
 *                      CEO-ladder `trade_level` + `levelConfirmed` + months)
 *
 * WHAT IT DELIBERATELY DOES NOT WRITE: `worker_skill`, `worker_industry_tenure`,
 * `job_reach`. Those are DERIVED. After `--apply`, run in order:
 *   pnpm --filter @badabhai/db db:backfill:worker-skills --apply
 *   pnpm --filter @badabhai/db db:materialize:reach --apply
 *
 * THE 16 = the 16 postable trades (`POSTING_TRADE_KINDS`, packages/taxonomy/src/posting-trades.ts).
 *
 * LADDERS. Each trade's rungs are its CEO posting ladder (`POSTING_TRADES[].ladder` — the
 * Launch Plan Pack v1 sheet ladder the worker answers too, #2550), and `levelConfirmed` is the
 * taxonomy's own `isLevelConfirmed`. Neither is a hand-kept copy here, so a ladder change reaches
 * the seed on its next re-sync. A rung never changes reach; since ADR-0061 the rung frozen onto an
 * APPLICATION sorts the 4 CNC trades' applicant lists. These workers never apply.
 *
 * MODES
 *   (default)   dry run: per-trade / per-city / per-band / per-rung breakdown
 *   --apply     write (upserts; re-running SYNCS — cohort rows outside the plan
 *               are removed, never append-only)
 *   --unseed | --cleanup (with --apply) delete every `be16…` row.
 *
 * GUARDS — same as the other V1 seeds: dry-run default, ops-guard on the
 * connection string, `--target=production` required against a prod-like DB.
 */
import { eq, inArray, sql as dsql } from "drizzle-orm";

import { isLevelConfirmed, postingTradeFor, type TradeLevel } from "@badabhai/taxonomy";
import type { ConsentPurpose } from "@badabhai/types";
import { CURRENT_CONSENT_VERSION } from "@badabhai/types";
import { workerVisibleTextScreens } from "@badabhai/validators";

import { createDbClient, type Database } from "./client";
import { encryptPii, hashPhone } from "./crypto";
import {
  argFlag,
  argValue,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";
import { hostClass, isProductionLike } from "./ops-guard";
import { REACH_CITIES, type ReachCity } from "./reach-pool-data";
import { payerDemoIdLikePattern, payerDemoUuid } from "./sample-workers";
import {
  workerAttributes,
  workerConsents,
  workerProfiles,
  workerProfileSkills,
  workers,
} from "./schema";

const NAME = "seed:payer-demo-candidates";

// ---------------------------------------------------------------------------
// Phone namespace — the `061xxx` block of the reserved synthetic range. Disjoint
// from demo `026xxx` and workforce `050xxx`. Ids live in `sample-workers.ts`.
// ---------------------------------------------------------------------------

export const PAYER_DEMO_PHONE_PREFIX = "+910000061";
export const PAYER_DEMO_PHONE_PATTERN = /^\+910000061\d{3}$/;

export function payerDemoPhone(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 998) {
    throw new Error(`payerDemoPhone: index ${index} outside 0..998`);
  }
  const phone = `${PAYER_DEMO_PHONE_PREFIX}${String(index + 1).padStart(3, "0")}`;
  if (!PAYER_DEMO_PHONE_PATTERN.test(phone)) {
    throw new Error(`payerDemoPhone: ${index} is outside the payer-demo block`);
  }
  return phone;
}

// ---------------------------------------------------------------------------
// The 16 live profiles: derivation route per trade. Rungs come from the CEO
// posting ladder (see the header), not from this table.
// ---------------------------------------------------------------------------

export type CandidateDeriveRoute =
  | { kind: "role"; roleId: string; flavorAttributeId?: string }
  | { kind: "attribute"; attributeSkillId: string }
  | { kind: "pack"; packId: string; packVersion: number; attributeKey: string; optionKey: string };

export interface PayerDemoTrade {
  roleKind: string;
  label: string;
  packId: string;
  /** Primary trade match skill (the `worker_profile_skill.skillId`). */
  skillId: string;
  route: CandidateDeriveRoute;
  /** Extra attribute skills sprinkled for realism (neutral or same-trade only). */
  flavorSkills: readonly string[];
}

export const PAYER_DEMO_TRADES: readonly PayerDemoTrade[] = [
  {
    roleKind: "cnc_turner",
    label: "CNC Turner",
    packId: "qp_cnc_turning",
    skillId: "mskill_cnc_turner",
    route: { kind: "role", roleId: "role_cnc_turner_operator", flavorAttributeId: "skill_turning" },
    flavorSkills: ["skill_measuring_instruments", "skill_drawing_reading"],
  },
  {
    roleKind: "vmc_milling",
    label: "CNC Machining Centre Operator (VMC)",
    packId: "qp_vmc_milling",
    skillId: "mskill_vmc_operator",
    route: { kind: "role", roleId: "role_vmc_operator", flavorAttributeId: "skill_milling" },
    flavorSkills: ["skill_measuring_instruments", "skill_fixture_setup"],
  },
  {
    roleKind: "cnc_grinding",
    label: "CNC Grinding Operator",
    packId: "qp_cnc_grinding",
    skillId: "mskill_cnc_grinding_operator",
    route: { kind: "role", roleId: "role_cnc_grinding_operator", flavorAttributeId: "skill_grinding_ops" },
    flavorSkills: ["skill_measuring_instruments"],
  },
  {
    roleKind: "cam_programmer",
    label: "CAM Programmer",
    packId: "qp_cam_programming",
    skillId: "mskill_cam_programmer",
    route: { kind: "role", roleId: "role_cam_programmer", flavorAttributeId: "skill_cam_software" },
    flavorSkills: ["skill_cnc_programming"],
  },
  {
    roleKind: "cad_draughtsman",
    label: "CAD Designer / Draughtsman",
    packId: "qp_cad_drafting",
    skillId: "mskill_designer",
    route: { kind: "attribute", attributeSkillId: "skill_cad_2d_drafting" },
    flavorSkills: ["skill_drawing_reading"],
  },
  {
    roleKind: "conventional_machinist",
    label: "Conventional Machinist",
    packId: "qp_conventional_machining",
    skillId: "mskill_conventional_machinist",
    route: {
      kind: "pack",
      packId: "qp_conventional_machining",
      packVersion: 1,
      attributeKey: "machining_machine",
      optionKey: "centre_lathe",
    },
    flavorSkills: [],
  },
  {
    roleKind: "tool_die_maker",
    label: "Tool & Die Maker",
    packId: "qp_tool_die_making",
    skillId: "mskill_tool_die_maker",
    route: {
      kind: "pack",
      packId: "qp_tool_die_making",
      packVersion: 1,
      attributeKey: "tooling_made",
      optionKey: "press_tool",
    },
    flavorSkills: [],
  },
  {
    roleKind: "welder",
    label: "Welder",
    packId: "qp_welding_trade",
    skillId: "mskill_welder",
    route: { kind: "role", roleId: "role_welder", flavorAttributeId: "skill_mig_welding" },
    flavorSkills: ["skill_arc_welding", "skill_tig_welding"],
  },
  {
    roleKind: "sheet_metal_worker",
    label: "Sheet Metal Worker",
    packId: "qp_sheet_metal_fab",
    skillId: "mskill_sheet_metal_worker",
    route: {
      kind: "pack",
      packId: "qp_sheet_metal_fab",
      packVersion: 1,
      attributeKey: "sheet_metal_machine",
      optionKey: "cnc_press_brake",
    },
    flavorSkills: [],
  },
  {
    roleKind: "press_operator",
    label: "Press / Machine Operator",
    packId: "qp_press_operation",
    skillId: "mskill_press_operator",
    route: {
      kind: "pack",
      packId: "qp_press_operation",
      packVersion: 1,
      attributeKey: "press_machine",
      optionKey: "mechanical_power_press",
    },
    flavorSkills: [],
  },
  {
    roleKind: "painter_coating",
    label: "Painter / Powder Coating",
    packId: "qp_powder_coating",
    skillId: "mskill_painter_coater",
    route: {
      kind: "pack",
      packId: "qp_powder_coating",
      packVersion: 1,
      attributeKey: "coating_process",
      optionKey: "powder_coating",
    },
    flavorSkills: [],
  },
  {
    roleKind: "fitter",
    label: "Fitter",
    packId: "qp_fitter",
    skillId: "mskill_fitter",
    route: { kind: "attribute", attributeSkillId: "skill_bench_fitting" },
    flavorSkills: ["skill_mechanical_assembly"],
  },
  {
    roleKind: "maintenance_technician",
    label: "Maintenance Technician",
    packId: "qp_maintenance_tech",
    skillId: "mskill_maintenance_technician",
    route: {
      kind: "pack",
      packId: "qp_maintenance_tech",
      packVersion: 1,
      attributeKey: "maintenance_discipline",
      optionKey: "mechanical",
    },
    flavorSkills: [],
  },
  {
    roleKind: "industrial_electrician",
    label: "Industrial Electrician",
    packId: "qp_industrial_electrician",
    skillId: "mskill_industrial_electrician",
    route: {
      kind: "pack",
      packId: "qp_industrial_electrician",
      packVersion: 1,
      attributeKey: "electrical_work_type",
      optionKey: "panel_wiring",
    },
    flavorSkills: [],
  },
  {
    roleKind: "assembly_line_worker",
    label: "Assembly Line Worker",
    packId: "qp_assembly_line",
    skillId: "mskill_assembly_line_worker",
    route: {
      kind: "pack",
      packId: "qp_assembly_line",
      packVersion: 1,
      attributeKey: "assembly_stage",
      optionKey: "sub_assembly",
    },
    flavorSkills: [],
  },
  {
    roleKind: "quality_inspector",
    label: "Quality Inspector / QC",
    packId: "qp_quality_inspection",
    skillId: "mskill_quality_inspector",
    route: { kind: "attribute", attributeSkillId: "skill_quality_control" },
    flavorSkills: ["skill_dimensional_inspection"],
  },
];

export const PER_TRADE_COUNT = 30;
export const PAYER_DEMO_WORKER_COUNT = PAYER_DEMO_TRADES.length * PER_TRADE_COUNT; // 480

/**
 * A trade's CEO ladder, lowest rung first — straight from the posting catalogue. Throws for a
 * role that is not postable, so a typo in the table above fails at import, not at apply.
 */
export function payerDemoLadder(roleKind: string): readonly TradeLevel[] {
  const trade = postingTradeFor(roleKind);
  if (!trade) throw new Error(`[${NAME}] ${roleKind} is not one of the 16 postable trades`);
  return trade.ladder.map((rung) => rung.rung);
}

const CITY_AREAS: Readonly<Record<string, readonly string[]>> = {
  pune: ["Chakan", "Bhosari", "Pimpri", "Ranjangaon", "Talegaon"],
  bengaluru: ["Peenya", "Bommasandra", "Jigani", "Whitefield", "Electronic City"],
  chennai: ["Sriperumbudur", "Ambattur", "Oragadam", "Guindy", "Maraimalai Nagar"],
  coimbatore: ["Peelamedu", "Kurichi", "Saravanampatti", "Thudiyalur"],
  ahmedabad: ["Sanand", "Changodar", "Naroda", "Vatva", "Odhav"],
  rajkot: ["Aji Industrial Area", "Metoda GIDC", "Shapar Veraval", "Gondal Road"],
  faridabad: ["Sector 24", "Sector 58", "NIT Faridabad", "Ballabhgarh"],
  ludhiana: ["Focal Point", "Dhandari Kalan", "Industrial Area A", "Tajpur Road"],
  aurangabad: ["Chikalthana MIDC", "Waluj MIDC", "Shendra MIDC"],
  ncr: ["Manesar", "Udyog Vihar Gurgaon", "Bhiwadi", "Noida Phase 2"],
};

const FIRST_NAMES: readonly string[] = [
  "Ravi",
  "Suresh",
  "Vijay",
  "Manoj",
  "Deepak",
  "Santosh",
  "Rakesh",
  "Pradeep",
  "Anil",
  "Mahesh",
  "Sunil",
  "Ramesh",
  "Ashok",
  "Dinesh",
  "Naveen",
  "Rajesh",
  "Sanjay",
  "Vikram",
  "Yogesh",
  "Harish",
  "Ganesh",
  "Mukesh",
  "Arun",
  "Kishore",
  "Prakash",
  "Naresh",
  "Amit",
  "Sachin",
  "Rahul",
  "Imran",
];

interface ExperienceBand {
  label: string;
  min: number;
  max: number;
}

const EXPERIENCE_BANDS: readonly ExperienceBand[] = [
  { label: "fresher", min: 0, max: 0 },
  { label: "junior", min: 1, max: 3 },
  { label: "mid", min: 3, max: 7 },
  { label: "senior", min: 7, max: 15 },
  { label: "veteran", min: 15, max: 25 },
];

export interface PayerDemoWorker {
  index: number;
  workerId: string;
  profileId: string;
  consentId: string;
  phoneE164: string;
  name: string;
  trade: PayerDemoTrade;
  city: ReachCity;
  area: string;
  totalYears: number;
  experienceBand: string;
  tradeLevel: TradeLevel;
  levelConfirmed: boolean;
}

function cityBySlug(slug: string): ReachCity {
  const c = REACH_CITIES.find((x) => x.slug === slug);
  if (!c) throw new Error(`unknown city ${slug}`);
  return c;
}

const CITY_SLUGS = Object.keys(CITY_AREAS);

export function buildPayerDemoWorkers(): PayerDemoWorker[] {
  const out: PayerDemoWorker[] = [];
  let index = 0;
  for (let t = 0; t < PAYER_DEMO_TRADES.length; t++) {
    const trade = PAYER_DEMO_TRADES[t]!;
    const ladder = payerDemoLadder(trade.roleKind);
    for (let j = 0; j < PER_TRADE_COUNT; j++) {
      const citySlug = CITY_SLUGS[(j + t) % CITY_SLUGS.length]!;
      const city = cityBySlug(citySlug);
      const areas = CITY_AREAS[citySlug]!;
      const area = areas[(j * 3 + t) % areas.length]!;
      const band = EXPERIENCE_BANDS[j % EXPERIENCE_BANDS.length]!;
      const span = band.max - band.min;
      const totalYears = span === 0 ? 0 : band.min + ((j * 7 + t * 3) % (span + 1));
      const tradeLevel = ladder[(j + t) % ladder.length]!;
      out.push({
        index,
        workerId: payerDemoUuid("worker", index),
        profileId: payerDemoUuid("profile", index),
        consentId: payerDemoUuid("consent", index),
        phoneE164: payerDemoPhone(index),
        name: `${FIRST_NAMES[(index * 5 + t) % FIRST_NAMES.length]} Demo`,
        trade,
        city,
        area,
        totalYears,
        experienceBand: band.label,
        tradeLevel,
        levelConfirmed: isLevelConfirmed(tradeLevel),
      });
      index++;
    }
  }
  return out;
}

/** The `worker_profiles.skills` a route stores — the attribute ids the live bridges read. */
export function profileSkillsForRoute(
  route: CandidateDeriveRoute,
  flavor: readonly string[],
): string[] {
  switch (route.kind) {
    case "role":
      return [...(route.flavorAttributeId ? [route.flavorAttributeId] : []), ...flavor].slice(0, 3);
    case "attribute":
      return [route.attributeSkillId, ...flavor].slice(0, 3);
    case "pack":
      return [...flavor].slice(0, 2);
  }
}

function canonicalRoleIdForRoute(route: CandidateDeriveRoute): string | null {
  return route.kind === "role" ? route.roleId : null;
}

function profileSourceForRoute(route: CandidateDeriveRoute): "chat" | "form" {
  return route.kind === "pack" ? "form" : "chat";
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface PayerDemoCrypto {
  key: string;
  pepper: string;
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

async function assertPhonesUnclaimed(
  db: Database,
  workers_: PayerDemoWorker[],
  pepper: string,
): Promise<void> {
  const hashes = workers_.map((w) => hashPhone(w.phoneE164, pepper));
  const owners = await db
    .select({ id: workers.id, phoneHash: workers.phoneHash })
    .from(workers)
    .where(inArray(workers.phoneHash, hashes));
  const foreign = owners.filter((o) => !workers_.some((w) => w.workerId === o.id));
  if (foreign.length > 0) {
    throw new Error(
      `[${NAME}] ${foreign.length} reserved phone(s) already belong to non-cohort worker(s) ` +
        `${foreign.map((f) => f.id).join(", ")}. Remove those workers, then re-run. Nothing was written.`,
    );
  }
}

export interface ApplyPayerDemoResult {
  workers: number;
  profiles: number;
  profileSkills: number;
  packAttributes: number;
  /** Cohort workers a previous plan left behind and this sync removed (normally 0). */
  staleRemoved: number;
}

export async function applyPayerDemoSeed(
  db: Database,
  plan: PayerDemoWorker[],
  crypto: PayerDemoCrypto,
  anchor: Date,
): Promise<ApplyPayerDemoResult> {
  for (const w of plan) {
    for (const [field, text] of [
      ["name", w.name],
      ["city", w.city.name],
      ["area", w.area],
    ] as const) {
      const screens = workerVisibleTextScreens(text);
      if (screens.length > 0) {
        throw new Error(
          `[${NAME}] worker-visible text screen tripped — worker ${w.workerId} field ${field} (${screens.join(",")}); aborting.`,
        );
      }
    }
  }
  await assertPhonesUnclaimed(db, plan, crypto.pepper);
  const consentPurposes: ConsentPurpose[] = [
    "profiling",
    "resume_generation",
    "communication",
    "employer_sharing",
  ];

  return db.transaction(async (tx) => {
    let profileSkillRows = 0;
    let packAttributeRows = 0;
    for (const w of plan) {
      const phoneEnc = encryptPii(w.phoneE164, crypto.key);
      const nameEnc = encryptPii(w.name, crypto.key);
      await tx
        .insert(workers)
        .values({
          id: w.workerId,
          phoneE164: phoneEnc,
          phoneHash: hashPhone(w.phoneE164, crypto.pepper),
          fullName: nameEnc,
          status: "active",
          currentCity: w.city.name,
        })
        .onConflictDoUpdate({
          target: workers.id,
          set: {
            phoneHash: hashPhone(w.phoneE164, crypto.pepper),
            phoneE164: phoneEnc,
            fullName: nameEnc,
            status: "active",
            currentCity: w.city.name,
            updatedAt: anchor,
          },
        });

      const route = w.trade.route;
      const skills = profileSkillsForRoute(route, w.trade.flavorSkills);
      await tx
        .insert(workerProfiles)
        .values({
          id: w.profileId,
          workerId: w.workerId,
          profileStatus: "confirmed",
          source: profileSourceForRoute(route),
          canonicalRoleId: canonicalRoleIdForRoute(route),
          skills,
          experience: { total_years: w.totalYears },
          locationPreference: { city: w.city.slug, preferred_cities: [w.city.slug] },
          availability: { status: "immediate" },
          confirmedAt: anchor,
          updatedAt: anchor,
        })
        .onConflictDoUpdate({
          target: workerProfiles.id,
          set: {
            profileStatus: "confirmed",
            source: profileSourceForRoute(route),
            canonicalRoleId: canonicalRoleIdForRoute(route),
            skills,
            experience: { total_years: w.totalYears },
            locationPreference: { city: w.city.slug, preferred_cities: [w.city.slug] },
            availability: { status: "immediate" },
            confirmedAt: anchor,
            updatedAt: anchor,
          },
        });

      await tx
        .insert(workerConsents)
        .values({
          id: w.consentId,
          workerId: w.workerId,
          consentVersion: CURRENT_CONSENT_VERSION,
          purposes: consentPurposes,
          acceptedAt: anchor,
        })
        .onConflictDoUpdate({
          target: workerConsents.id,
          set: {
            consentVersion: CURRENT_CONSENT_VERSION,
            purposes: consentPurposes,
            revokedAt: null,
          },
        });

      await tx.delete(workerAttributes).where(eq(workerAttributes.workerId, w.workerId));
      if (route.kind === "pack") {
        await tx.insert(workerAttributes).values({
          workerId: w.workerId,
          attributeKey: route.attributeKey,
          valueKind: "text_list",
          valueTextList: [route.optionKey],
          source: "answer_map",
          questionKey: route.attributeKey,
          packId: route.packId,
          packVersion: route.packVersion,
          updatedAt: anchor,
        });
        packAttributeRows += 1;
      }

      await tx
        .insert(workerProfileSkills)
        .values({
          workerProfileId: w.profileId,
          skillId: w.trade.skillId,
          source: "ops",
          tradeLevel: w.tradeLevel,
          levelConfirmed: w.levelConfirmed,
          monthsExperience: w.totalYears * 12,
        })
        .onConflictDoUpdate({
          target: [workerProfileSkills.workerProfileId, workerProfileSkills.skillId],
          set: {
            source: "ops",
            tradeLevel: w.tradeLevel,
            levelConfirmed: w.levelConfirmed,
            monthsExperience: w.totalYears * 12,
            updatedAt: anchor,
          },
        });
      profileSkillRows += 1;
    }

    // Sync: drop cohort rows a previous plan left behind (same fixed 480, so normally 0).
    const keepWorkers = dsql.param(plan.map((w) => w.workerId));
    const staleRemoved = rowsOf(
      await tx.execute(dsql`
        DELETE FROM workers
        WHERE id::text LIKE ${payerDemoIdLikePattern("worker")} AND NOT (id = ANY(${keepWorkers}::uuid[]))
        RETURNING 1`),
    ).length;

    return {
      workers: plan.length,
      profiles: plan.length,
      profileSkills: profileSkillRows,
      packAttributes: packAttributeRows,
      staleRemoved,
    };
  });
}

export async function unseedPayerDemo(db: Database): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const n = rowsOf(
      await tx.execute(
        dsql`DELETE FROM workers WHERE id::text LIKE ${payerDemoIdLikePattern("worker")} RETURNING 1`,
      ),
    ).length;
    return { "workers deleted (cascades profile/consent/attributes/profile_skill/skill/reach)": n };
  });
}

function targetDeclarationProblem(databaseUrl: string, declared: string | undefined): string | null {
  const target = declared ?? "local";
  if (target !== "local" && target !== "production") {
    return `--target must be "local" or "production" (got "${target}").`;
  }
  const prodLike = isProductionLike(databaseUrl);
  if (prodLike && target !== "production") {
    return (
      `DATABASE_URL is ${hostClass(databaseUrl)} — a production-like target. This seed writes ` +
      `480 synthetic workers REAL EMPLOYERS WILL SEE. Re-run with --target=production ` +
      `(plus, for a write, the ops-guard flag + OPS_ALLOW_PRODUCTION=${NAME}) only if the owner asked.`
    );
  }
  if (!prodLike && target === "production") {
    return `--target=production was declared but DATABASE_URL is ${hostClass(databaseUrl)}; refusing the mismatch.`;
  }
  return null;
}

function readCrypto(): PayerDemoCrypto {
  const key = process.env.PII_ENCRYPTION_KEY;
  const pepper = process.env.PII_HASH_PEPPER;
  if (!key || !pepper) {
    throw new Error(
      `[${NAME}] PII_ENCRYPTION_KEY and PII_HASH_PEPPER must be set — synthetic phones/names are ` +
        `encrypted + hashed with the SAME crypto the API uses.`,
    );
  }
  return { key, pepper };
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  const problem = targetDeclarationProblem(opts.databaseUrl, argValue("target"));
  if (problem !== null) throw new Error(`[${NAME}] ${problem}`);
  const unseedMode = argFlag("unseed") || argFlag("cleanup");

  const plan = buildPayerDemoWorkers();

  const { db } = createDbClient(opts.databaseUrl, { max: 1 });
  if (unseedMode) {
    if (!opts.apply) {
      console.log(`[${NAME}] --unseed dry run: re-run with --apply to remove every be16… cohort row.`);
      printFooter(NAME, opts, 0);
      return;
    }
    const counts = await unseedPayerDemo(db);
    printCounts(NAME, counts);
    printFooter(NAME, opts, Object.values(counts).reduce((a, b) => a + b, 0));
    return;
  }

  if (!opts.apply) {
    printCounts(NAME, {
      workers: plan.length,
      trades: PAYER_DEMO_TRADES.length,
      "per trade": PER_TRADE_COUNT,
      cities: new Set(plan.map((w) => w.city.slug)).size,
      "employer_sharing consents": plan.length,
      "level confirmed": plan.filter((w) => w.levelConfirmed).length,
    });
    for (const t of PAYER_DEMO_TRADES) {
      const rungs = new Map<string, number>();
      for (const w of plan.filter((x) => x.trade.roleKind === t.roleKind)) {
        rungs.set(w.tradeLevel, (rungs.get(w.tradeLevel) ?? 0) + 1);
      }
      console.log(
        `  ${t.roleKind.padEnd(24)} ${[...rungs.entries()].map(([r, n]) => `${r}×${n}`).join(" ")}`,
      );
    }
    console.log(`[${NAME}] experience bands:`);
    for (const b of EXPERIENCE_BANDS) {
      console.log(`  ${b.label.padEnd(10)} ${plan.filter((w) => w.experienceBand === b.label).length}`);
    }
    printFooter(NAME, opts, plan.length * 4);
    return;
  }

  const crypto = readCrypto();
  const anchor = new Date();
  const seeded = await applyPayerDemoSeed(db, plan, crypto, anchor);
  printCounts(NAME, {
    "workers upserted": seeded.workers,
    "worker_profiles upserted": seeded.profiles,
    "worker_profile_skill upserted": seeded.profileSkills,
    "worker_attributes upserted (pack route)": seeded.packAttributes,
    "stale cohort workers removed": seeded.staleRemoved,
  });
  console.log(
    `[${NAME}] NEXT: pnpm --filter @badabhai/db db:backfill:worker-skills --apply && ` +
      `pnpm --filter @badabhai/db db:materialize:reach --apply`,
  );
  printFooter(NAME, opts, seeded.workers * 4);
}

if (require.main === module) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input.
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
