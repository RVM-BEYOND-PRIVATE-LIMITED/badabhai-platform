/**
 * Synthetic workforce seed — repopulates production's Matching V1 engine after
 * `workers`/`worker_profiles`/`worker_skill`/`auth.users`/`applications` were found wiped to 0
 * rows (a separate incident; this script is the recovery data, not the fix). Owner (Prakash)
 * sign-off: 2026-10-07. `job_postings` (13 rows) and `payers` (13 rows) were untouched and are
 * real — this seed adds SYNTHETIC rows alongside them, never touches them.
 *
 * WHAT IT WRITES (DIRECT inserts; NO events — seeded synthetic data, not business activity;
 * every id is namespaced `face…`, see {@link workforceUuid}):
 *   payers          ~35 synthetic employers (org name + `.invalid` email, encrypted + hashed)
 *   workers         250 synthetic workers, RESERVED phones (`+910000050xxx`, a NEW carve-out
 *                   of the reserved test-phone range — see `demo-phones.ts`), names encrypted
 *   worker_profiles one profile per worker (`canonical_role_id` / `skills` / `experience`),
 *                   populated through the SAME bridge the live chat/form extraction uses
 *                   (see "DERIVATION ROUTES" below) — never a hand-picked match skill
 *   worker_consents one live consent per worker (`employer_sharing` INCLUDED — see "CONSENT")
 *   worker_attributes one pack-answer row per PACK-ROUTE worker (see below) — closed-set
 *                   option keys from the checked-in pack JSON, nothing invented
 *   job_postings    ~140 OPEN postings, `role_kind` set, realistic card fields, `published_at`
 *                   staggered over 30 days; `match_skill_ids` the trade's own skill(s) and
 *                   `reach_skill_ids` resolved by the publish rule (`resolveReachSet` + the
 *                   live `match_config`), cross-checked against the seeded `skill_related`
 *
 * WHAT IT DELIBERATELY DOES NOT WRITE: `worker_skill`, `worker_industry_tenure`, `job_reach`.
 * Those are DERIVED columns, and deriving them here would fake the output of the pipeline this
 * seed exists to exercise. Run, in order, after `--apply`:
 *   pnpm --filter @badabhai/db db:backfill:worker-skills --apply
 *   pnpm --filter @badabhai/db db:materialize:reach --apply
 * This also gives REAL regression coverage for the `computeIndustryTenure` fix in
 * `backfill-worker-skills.ts` (TD — the hand-rolled max-by-industry loop that silently dropped
 * a worker's tenure row when his first skill bucketed to 0 months): a slice of this cohort is
 * seeded as FRESHERS (`experience.total_years = 0`), which buckets to exactly 0 months.
 *
 * DERIVATION ROUTES — the 20 trades are INDUSTRIAL/MECHANICAL ONLY, drawn from the live
 * `mskill_*` vocabulary (26 total; plumber/carpenter/designer/interior_designer/delivery_rider/
 * painter_coater excluded, same discipline `demo-matching-plan.ts` uses). Each trade's match
 * skill is reached through the SAME bridge `deriveWorkerSkills`/`workerSkillDeriveInput`
 * (`@badabhai/match-engine`) reads on the live path — never invented here:
 *   ROLE bridge (`ROLE_TO_MATCH_SKILL`, 9 trades)        → `worker_profiles.canonical_role_id`
 *   ATTRIBUTE bridge (`ATTRIBUTE_TO_MATCH_SKILLS`, 4)     → a `skill_*` id in `worker_profiles.skills`
 *   PACK-ANSWER bridge (`PACK_ANSWER_SKILLS`, 7 — the      → one `worker_attributes` row naming a
 *     #2022 trades with no role and no corpus id)            closed pack option key
 * See {@link SKILL_DERIVE_ROUTE}. A pack-route worker's profile carries `source: "form"`,
 * `canonical_role_id: null`, `skills: []` — exactly what `toExtractionOutput` hardcodes for a
 * real trade-form worker (see `pack-answer-skills.ts`'s own docstring).
 *
 * CONSENT — unlike `seed-demo-matching.ts`, `employer_sharing` is granted HERE EVEN ON
 * PRODUCTION. The demo seed withholds it there on purpose (a real employer must not spend a
 * credit unlocking a persona who does not exist for a SHOWCASE). This seed's whole purpose is
 * the opposite: production's 13 real payers/postings need REAL, unlockable candidates to
 * exercise the engine against, because there are currently zero real workers at all. Flag this
 * to the owner before `--apply` if that reasoning does not hold.
 *
 * NAMES — a small set of real-sounding Indian first names + the marker suffix "Seed"
 * (`"Ravi Seed"`), deliberately DISTINCT from `seed-demo-matching.ts`'s "Demo" marker so the
 * two synthetic cohorts stay independently greppable and independently cleanable.
 *
 * MODES
 *   (default)   dry run: the plan's counts, per-trade/per-city/per-experience-band breakdown
 *   --apply     write (upserts; re-running SYNCS — cohort rows outside the current plan are
 *               removed, never append-only)
 *   --unseed | --cleanup   (with --apply) delete every `face…` row, cascading reach/
 *               applications. REFUSES while non-cohort workers hold applications to cohort
 *               postings, unless --delete-real-applications; `--close-only` instead closes the
 *               cohort's postings (off every feed, nothing deleted)
 *
 * GUARDS
 *   - `parseCommonCli` → `enforceOpsGuard`: a WRITE to a production-like target needs
 *     `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=seed:synthetic-workforce`.
 *   - ANY run against a production-like target (even read-only) needs `--target=production`;
 *     `--target=production` against a local database is refused as a mismatch.
 *   - Every worker-visible string (names, city labels, posting titles/descriptions/benefits/
 *     requirements) is screened (ADR-0024, `workerVisibleTextScreens`) before anything is written.
 *   - Logs carry ids, counts, titles and the reserved synthetic phones only.
 *
 *   pnpm --filter @badabhai/db db:seed:synthetic-workforce                     # dry run
 *   pnpm --filter @badabhai/db db:seed:synthetic-workforce --apply --target=production \
 *     --i-am-authorised-to-write-to-production
 *     (with OPS_ALLOW_PRODUCTION=seed:synthetic-workforce and PII_ENCRYPTION_KEY/PII_HASH_PEPPER set)
 *   pnpm --filter @badabhai/db db:unseed:synthetic-workforce --apply
 *
 * Options: --workers=N (>=20) --postings=N (>=20) --payers=N (>=1) --rng-seed=N --anchor=<ISO>
 */
import { eq, inArray, sql as dsql } from "drizzle-orm";

import { resolveReachSet, parseMatchConfig, type MatchConfig } from "@badabhai/match-engine";
import { matchSkillIndustry, relatedMatchSkills } from "@badabhai/taxonomy";
import { CURRENT_CONSENT_VERSION, type ConsentPurpose } from "@badabhai/types";
import { workerVisibleTextScreens } from "@badabhai/validators";

import { createDbClient, type Database } from "./client";
import { encryptPii, hashPhone } from "./crypto";
import { DEMO_BENEFITS, DEMO_TRADES, type DemoTrade } from "./demo-matching-plan";
import { WORKFORCE_SEED_PHONE_PATTERN, WORKFORCE_SEED_PHONE_PREFIX } from "./demo-phones";
import { expandReachSkillIds } from "./match-v1-derive";
import { argFlag, argValue, parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";
import { hostClass, isProductionLike } from "./ops-guard";
import { makeRng, pickWeighted, REACH_CITIES, type ReachCity, type Rng } from "./reach-pool-data";
import { jobPostings, matchConfig, payers, skills, workerAttributes, workerConsents, workerProfiles, workers } from "./schema";

const NAME = "seed:synthetic-workforce";

// ---------------------------------------------------------------------------
// Id namespace — "face" (valid hex only — UUIDs can't carry a literal "wfsd", "w"/"s" aren't
// hex digits; this replaced an earlier prefix that silently produced invalid UUIDs), disjoint
// from the demo seed's "de30…" and the reach seed's "5eed…". Layout mirrors `demoUuid` exactly.
// ---------------------------------------------------------------------------

export const WORKFORCE_ID_PREFIX = "face";

const WORKFORCE_KIND_TAG = {
  payer: "10",
  worker: "20",
  profile: "21",
  consent: "22",
  posting: "30",
} as const;

export type WorkforceIdKind = keyof typeof WORKFORCE_KIND_TAG;

export function workforceUuid(kind: WorkforceIdKind, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`workforceUuid: bad index ${index}`);
  return `${WORKFORCE_ID_PREFIX}${WORKFORCE_KIND_TAG[kind]}00-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** SQL `LIKE` pattern matching every workforce-seed id of one kind (and nothing else). */
export function workforceIdLikePattern(kind: WorkforceIdKind): string {
  return `${WORKFORCE_ID_PREFIX}${WORKFORCE_KIND_TAG[kind]}00-0000-4000-8000-%`;
}

/** Workforce-seed phones: `+910000050001` … (the first 250 of the 1000-slot block). */
export function workforcePhone(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 998) {
    throw new Error(`workforcePhone: index ${index} outside 0..998`);
  }
  const phone = `${WORKFORCE_SEED_PHONE_PREFIX}${String(index + 1).padStart(3, "0")}`;
  if (!WORKFORCE_SEED_PHONE_PATTERN.test(phone)) {
    throw new Error(`workforcePhone: ${index} is outside the workforce-seed block`);
  }
  return phone;
}

// ---------------------------------------------------------------------------
// Trade catalogue — the 20 industrial/mechanical trades, each wired to the REAL derivation
// route `deriveWorkerSkills`/`workerSkillDeriveInput` (@badabhai/match-engine) reads.
// ---------------------------------------------------------------------------

export type SkillDeriveRoute =
  | { kind: "role"; roleId: string; flavorAttributeId?: string }
  | { kind: "attribute"; attributeSkillId: string }
  | { kind: "pack"; packId: string; packVersion: number; attributeKey: string; optionKey: string };

/**
 * `mskill_*` → how a worker's profile makes `deriveWorkerSkills` produce it.
 *
 * ROLE entries name the EXACT `role_*` id `ROLE_TO_MATCH_SKILL` maps to this skill
 * (`@badabhai/taxonomy`, match-skills.ts). `flavorAttributeId` is an OPTIONAL corpus id added to
 * `worker_profiles.skills` for realism; every one named here is checked to be either a NEUTRAL
 * attribute (maps to `[]`) or one that reinforces the SAME match skill — never a different trade.
 *
 * ATTRIBUTE entries (tig/arc welder, fitter, quality inspector) have no `role_*` of their own;
 * the corpus id is the only bridge (`ATTRIBUTE_TO_MATCH_SKILLS`).
 *
 * PACK entries are the seven trades minted in #2022 with no role and no corpus id at all — the
 * worker's own pack answer (`PACK_ANSWER_SKILLS`) is the ONLY evidence that derives them. Every
 * (packId, attributeKey, optionKey) triple here is a real, checked-in pack option
 * (`packages/db/data/question-packs/packs/*.json`), pinned at version 1
 * (`_published-versions.jsonl`).
 */
const SKILL_DERIVE_ROUTE: Readonly<Record<string, SkillDeriveRoute>> = {
  mskill_cnc_turner: {
    kind: "role",
    roleId: "role_cnc_turner_operator",
    flavorAttributeId: "skill_turning",
  },
  mskill_cnc_setter_operator: {
    kind: "role",
    roleId: "role_cnc_setter_operator",
    flavorAttributeId: "skill_tool_offset_setting",
  },
  mskill_vmc_operator: { kind: "role", roleId: "role_vmc_operator", flavorAttributeId: "skill_milling" },
  mskill_hmc_operator: { kind: "role", roleId: "role_hmc_operator", flavorAttributeId: "skill_fixture_setup" },
  mskill_cnc_grinding_operator: {
    kind: "role",
    roleId: "role_cnc_grinding_operator",
    flavorAttributeId: "skill_grinding_ops",
  },
  mskill_cnc_operator_general: {
    kind: "role",
    roleId: "role_cnc_operator",
    flavorAttributeId: "skill_measuring_instruments",
  },
  mskill_cam_programmer: {
    kind: "role",
    roleId: "role_cam_programmer",
    flavorAttributeId: "skill_cam_software",
  },
  mskill_cnc_programmer: {
    kind: "role",
    roleId: "role_cnc_programmer",
    flavorAttributeId: "skill_cnc_programming",
  },
  mskill_mig_welder: { kind: "role", roleId: "role_welder", flavorAttributeId: "skill_mig_welding" },
  mskill_tig_welder: { kind: "attribute", attributeSkillId: "skill_tig_welding" },
  mskill_arc_welder: { kind: "attribute", attributeSkillId: "skill_arc_welding" },
  mskill_fitter: { kind: "attribute", attributeSkillId: "skill_bench_fitting" },
  mskill_quality_inspector: { kind: "attribute", attributeSkillId: "skill_quality_control" },
  mskill_conventional_machinist: {
    kind: "pack",
    packId: "qp_conventional_machining",
    packVersion: 1,
    attributeKey: "machining_machine",
    optionKey: "radial_drill",
  },
  mskill_tool_die_maker: {
    kind: "pack",
    packId: "qp_tool_die_making",
    packVersion: 1,
    attributeKey: "tooling_made",
    optionKey: "press_tool",
  },
  mskill_sheet_metal_worker: {
    kind: "pack",
    packId: "qp_sheet_metal_fab",
    packVersion: 1,
    attributeKey: "sheet_metal_machine",
    optionKey: "cnc_press_brake",
  },
  mskill_press_operator: {
    kind: "pack",
    packId: "qp_press_operation",
    packVersion: 1,
    attributeKey: "press_machine",
    optionKey: "mechanical_power_press",
  },
  mskill_maintenance_technician: {
    kind: "pack",
    packId: "qp_maintenance_tech",
    packVersion: 1,
    attributeKey: "maintenance_discipline",
    optionKey: "mechanical",
  },
  mskill_industrial_electrician: {
    kind: "pack",
    packId: "qp_industrial_electrician",
    packVersion: 1,
    attributeKey: "electrical_work_type",
    optionKey: "panel_wiring",
  },
  mskill_assembly_line_worker: {
    kind: "pack",
    packId: "qp_assembly_line",
    packVersion: 1,
    attributeKey: "assembly_stage",
    optionKey: "sub_assembly",
  },
};

/** Match skills `demo-matching-plan.ts` carries that are NOT industrial/mechanical — excluded. */
const EXCLUDED_FROM_WORKFORCE = new Set([
  "mskill_designer",
  "mskill_interior_designer",
  "mskill_plumber",
  "mskill_painter_coater",
]);

export interface WorkforceTrade extends DemoTrade {
  route: SkillDeriveRoute;
}

/** The 20 industrial/mechanical trades, each trade content REUSED from `demo-matching-plan.ts`
 * (titles/pay/unit/requirements/shiftWeights) so a worker's card and a posting's card describe
 * the same trade the same way — only the derivation route is new here. */
export const WORKFORCE_TRADES: readonly WorkforceTrade[] = DEMO_TRADES.filter(
  (t) => !EXCLUDED_FROM_WORKFORCE.has(t.skillId),
).map((t) => {
  const route = SKILL_DERIVE_ROUTE[t.skillId];
  if (!route) {
    throw new Error(`seed-synthetic-workforce: no derivation route declared for ${t.skillId}`);
  }
  return { ...t, route };
});

if (WORKFORCE_TRADES.length !== 20) {
  throw new Error(
    `seed-synthetic-workforce: expected exactly 20 industrial/mechanical trades, got ${WORKFORCE_TRADES.length}`,
  );
}

function profileSkillsForRoute(route: SkillDeriveRoute): string[] {
  switch (route.kind) {
    case "role":
      return route.flavorAttributeId ? [route.flavorAttributeId] : [];
    case "attribute":
      return [route.attributeSkillId];
    case "pack":
      return [];
  }
}

function canonicalRoleIdForRoute(route: SkillDeriveRoute): string | null {
  return route.kind === "role" ? route.roleId : null;
}

/** `chat` for the role/attribute bridges (what free-text extraction produces); `form` for the
 * pack bridge (what a trade form produces) — mirrors `worker_profiles.source`'s real meaning. */
function profileSourceForRoute(route: SkillDeriveRoute): "chat" | "form" {
  return route.kind === "pack" ? "form" : "chat";
}

// ---------------------------------------------------------------------------
// Cities — REUSED from `reach-pool-data.ts` (`REACH_CITIES`, the real manufacturing-hub
// centroid list this package already seeds reach-pool fixtures from), not invented here.
// Areas are flavor text only (never an address) — same discipline as `demo-matching-plan.ts`.
// ---------------------------------------------------------------------------

const WORKFORCE_CITY_AREAS: Readonly<Record<string, readonly string[]>> = {
  pune: ["Chakan", "Bhosari", "Pimpri", "Ranjangaon", "Talegaon"],
  bengaluru: ["Peenya", "Bommasandra", "Jigani", "Whitefield", "Electronic City"],
  chennai: ["Sriperumbudur", "Ambattur", "Oragadam", "Guindy", "Maraimalai Nagar"],
  coimbatore: ["Peelamedu", "Kurichi", "Saravanampatti", "Thudiyalur"],
  ahmedabad: ["Sanand", "Changodar", "Naroda", "Vatva", "Odhav"],
  rajkot: ["Aji Industrial Area", "Metoda GIDC", "Shapar Veraval", "Gondal Road"],
  faridabad: ["Sector 24", "Sector 58", "NIT Faridabad", "Ballabhgarh"],
  ludhiana: ["Focal Point", "Dhandari Kalan", "Industrial Area A", "Tajpur Road"],
  aurangabad: ["Chikalthana MIDC", "Waluj MIDC", "Shendra MIDC", "Rail Nagar"],
  ncr: ["Manesar", "Udyog Vihar Gurgaon", "Bhiwadi", "Noida Phase 2"],
};

for (const city of REACH_CITIES) {
  if (!WORKFORCE_CITY_AREAS[city.slug]) {
    throw new Error(`seed-synthetic-workforce: no area list declared for city "${city.slug}"`);
  }
}

// ---------------------------------------------------------------------------
// Names — small, real-sounding first names + the "Seed" marker. Distinct from the demo seed's
// "Demo" marker so the two synthetic cohorts stay independently greppable.
// ---------------------------------------------------------------------------

const WORKFORCE_FIRST_NAMES: readonly string[] = [
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
  "Jagdish",
  "Shyam",
  "Chandan",
  "Lokesh",
  "Narendra",
  "Omkar",
  "Birbal",
  "Kishore",
];

function pickOne<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng.next() * items.length)]!;
}

function pickDistinct<T>(items: readonly T[], k: number, rng: Rng): T[] {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(k, items.length)) chosen.add(Math.floor(rng.next() * items.length));
  return [...chosen].sort((a, b) => a - b).map((i) => items[i]!);
}

// ---------------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------------

export const WORKFORCE_PAYER_COUNT = 35;

export interface WorkforcePayer {
  index: number;
  payerId: string;
  /** SYNTHETIC — encrypted into `payers.org_name_enc`; never worker-visible. */
  orgName: string;
  /** SYNTHETIC — `.invalid` TLD (RFC 2606), encrypted + hashed. */
  email: string;
  weight: number;
}

export function buildWorkforcePayers(count: number = WORKFORCE_PAYER_COUNT): WorkforcePayer[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      index: i,
      payerId: workforceUuid("payer", i),
      orgName: `Workforce Seed Employer ${n} (synthetic)`,
      email: `workforce-seed-employer-${n}@workforce-seed.test.invalid`,
      // Employers 01-04 are large (weight 5), 05-12 medium (2), the rest small (1).
      weight: i < 4 ? 5 : i < 12 ? 2 : 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export const DEFAULT_WORKFORCE_WORKER_COUNT = 250;

interface ExperienceBand {
  label: "fresher" | "junior" | "mid" | "senior" | "veteran";
  min: number;
  max: number;
}

/** "fresher" MUST bucket to exactly 0 months (`min === max === 0`) — the regression case for the
 * `computeIndustryTenure` backfill fix. */
const EXPERIENCE_BANDS: readonly ExperienceBand[] = [
  { label: "fresher", min: 0, max: 0 },
  { label: "junior", min: 1, max: 3 },
  { label: "mid", min: 3, max: 7 },
  { label: "senior", min: 7, max: 15 },
  { label: "veteran", min: 15, max: 25 },
];

export interface WorkforceWorker {
  index: number;
  workerId: string;
  profileId: string;
  consentId: string;
  /** RESERVED synthetic phone — never real. */
  phoneE164: string;
  /** SYNTHETIC display name — written ONLY into `workers.full_name`, encrypted. */
  name: string;
  trade: WorkforceTrade;
  city: ReachCity;
  totalYears: number;
  experienceBand: ExperienceBand["label"];
}

export function buildWorkforceWorkers(count: number, rng: Rng): WorkforceWorker[] {
  if (!Number.isInteger(count) || count < WORKFORCE_TRADES.length) {
    throw new Error(
      `workers must be an integer >= ${WORKFORCE_TRADES.length} (one per trade for coverage); got ${count}`,
    );
  }
  const tradeWeights = WORKFORCE_TRADES.map((t) => t.weight);
  const bandWeights = EXPERIENCE_BANDS.map(() => 1);
  const out: WorkforceWorker[] = [];
  for (let i = 0; i < count; i++) {
    // COVERAGE PASS: the first |trades| workers name each trade once, so every trade has at
    // least one worker regardless of how the remainder's weighted draws land.
    const coverage = i < WORKFORCE_TRADES.length;
    const trade = coverage ? WORKFORCE_TRADES[i]! : pickWeighted(WORKFORCE_TRADES, tradeWeights, rng);
    const city = pickOne(REACH_CITIES, rng);
    const band = pickWeighted(EXPERIENCE_BANDS, bandWeights, rng);
    const totalYears =
      band.min === band.max ? band.min : band.min + Math.floor(rng.next() * (band.max - band.min + 1));
    const name = `${pickOne(WORKFORCE_FIRST_NAMES, rng)} Seed`;
    out.push({
      index: i,
      workerId: workforceUuid("worker", i),
      profileId: workforceUuid("profile", i),
      consentId: workforceUuid("consent", i),
      phoneE164: workforcePhone(i),
      name,
      trade,
      city,
      totalYears,
      experienceBand: band.label,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export const DEFAULT_WORKFORCE_POSTING_COUNT = 140;

const PUBLISH_WINDOW_MINUTES = 30 * 24 * 60;
const MAX_BATCH = 4;
const BATCH_SPACING_MINUTES = 3;
const TWO_SKILL_RATE = 0.12;
const BOOST_RATE = 0.03;
/** How long a seeded boost lasts past the anchor. Re-run the seed to refresh it. */
const BOOST_DAYS = 14;

type WorkforcePayType = "in_hand" | "gross" | "ctc";
type WorkforceShift = "day" | "rotational" | "night";
type WorkforceNeededBy = "immediate" | "soon" | "flexible";
type WorkforceVacancyBand = "1" | "2-5" | "6-10" | "11-25" | "25+";

export interface WorkforcePosting {
  index: number;
  postingId: string;
  payerIndex: number;
  matchSkillIds: string[];
  roleKind: WorkforceTrade["roleKind"];
  industryId: string;
  roleTitle: string;
  city: string;
  area: string;
  description: string;
  benefits: string[];
  requirements: string[];
  payMin: number;
  payMax: number;
  payType: WorkforcePayType | null;
  shift: WorkforceShift | null;
  neededBy: WorkforceNeededBy;
  vacancyBand: WorkforceVacancyBand;
  minExperienceYears: number;
  maxExperienceYears: number;
  /** Minutes BEFORE the anchor this posting was published (0 .. 30 days). */
  publishedMinutesAgo: number;
  boosted: boolean;
}

interface WorkforcePostingBatch {
  payerIndex: number;
  publishedMinutesAgo: number;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function shiftLine(shift: WorkforceShift | null): string {
  switch (shift) {
    case "day":
      return "Day shift.";
    case "rotational":
      return "Rotational shifts.";
    case "night":
      return "Night shift, with night allowance.";
    default:
      return "Shift timing discussed at interview.";
  }
}

function buildWorkforcePosting(index: number, batch: WorkforcePostingBatch, rng: Rng): WorkforcePosting {
  const coverage = index < WORKFORCE_TRADES.length;
  const trade = coverage
    ? WORKFORCE_TRADES[index]!
    : pickWeighted(
        WORKFORCE_TRADES,
        WORKFORCE_TRADES.map((t) => t.weight),
        rng,
      );
  const matchSkillIds = [trade.skillId];
  const neighbours = relatedMatchSkills(trade.skillId);
  if (!coverage && neighbours.length > 0 && rng.next() < TWO_SKILL_RATE) {
    matchSkillIds.push(pickOne(neighbours, rng));
  }
  const industryId = matchSkillIndustry(trade.skillId);
  if (!industryId) throw new Error(`${trade.skillId} has no industry in the taxonomy`);

  const { payerIndex, publishedMinutesAgo } = batch;
  const city = pickOne(REACH_CITIES, rng);
  const area = pickOne(WORKFORCE_CITY_AREAS[city.slug] ?? [city.name], rng);
  const roleTitle = pickOne(trade.titles, rng);

  const [lo, hi] = trade.pay;
  const payMin = roundTo(lo + rng.next() * (hi - lo), 500);
  const payMax = payMin + roundTo(2000 + rng.next() * 8000, 500);
  const payType = pickWeighted<WorkforcePayType | null>(
    ["in_hand", "gross", "ctc", null],
    [0.5, 0.2, 0.15, 0.15],
    rng,
  );
  const shift = pickWeighted<WorkforceShift | null>(
    ["day", "rotational", "night", null],
    [...trade.shiftWeights, 1],
    rng,
  );
  const neededBy = pickWeighted<WorkforceNeededBy>(["immediate", "soon", "flexible"], [0.4, 0.4, 0.2], rng);
  const vacancyBand = pickWeighted<WorkforceVacancyBand>(
    ["1", "2-5", "6-10", "11-25", "25+"],
    [0.2, 0.4, 0.25, 0.1, 0.05],
    rng,
  );
  const [eLo, eHi] = trade.minExp;
  const minExperienceYears = eLo + Math.floor(rng.next() * (eHi - eLo + 1));
  const maxExperienceYears = minExperienceYears + 2 + Math.floor(rng.next() * 4);
  const benefits = pickDistinct(DEMO_BENEFITS, 2 + Math.floor(rng.next() * 3), rng);
  const requirements = pickDistinct(trade.requirements, 2 + Math.floor(rng.next() * 2), rng);
  const boosted = rng.next() < BOOST_RATE;

  const description =
    `${roleTitle} needed at a ${trade.unit} in ${area}, ${city.name}. ` +
    `${minExperienceYears === 0 ? "Freshers welcome." : `${minExperienceYears}+ years of experience.`} ` +
    shiftLine(shift);

  return {
    index,
    postingId: workforceUuid("posting", index),
    payerIndex,
    matchSkillIds,
    roleKind: trade.roleKind,
    industryId,
    roleTitle,
    city: city.name,
    area,
    description,
    benefits,
    requirements,
    payMin,
    payMax,
    payType,
    shift,
    neededBy,
    vacancyBand,
    minExperienceYears,
    maxExperienceYears,
    publishedMinutesAgo,
    boosted,
  };
}

export function buildWorkforcePostings(
  count: number,
  payerList: readonly WorkforcePayer[],
  rng: Rng,
): WorkforcePosting[] {
  if (!Number.isInteger(count) || count < WORKFORCE_TRADES.length) {
    throw new Error(`postings must be an integer >= ${WORKFORCE_TRADES.length} (one per trade); got ${count}`);
  }
  const postings: WorkforcePosting[] = [];
  let batch: WorkforcePostingBatch | null = null;
  let leftInBatch = 0;
  for (let i = 0; i < count; i++) {
    if (leftInBatch === 0 || batch === null) {
      batch = {
        payerIndex: pickWeighted(
          payerList.map((p) => p.index),
          payerList.map((p) => p.weight),
          rng,
        ),
        publishedMinutesAgo: Math.floor(rng.next() * PUBLISH_WINDOW_MINUTES),
      };
      leftInBatch = 1 + Math.floor(rng.next() * MAX_BATCH);
    }
    postings.push(buildWorkforcePosting(i, batch, rng));
    leftInBatch -= 1;
    batch = { ...batch, publishedMinutesAgo: Math.max(0, batch.publishedMinutesAgo - BATCH_SPACING_MINUTES) };
  }
  return postings;
}

// ---------------------------------------------------------------------------
// The plan — ONE mulberry32 stream, consumed in a fixed order (workers, then postings), so a
// given `--rng-seed` always reproduces the same plan byte-for-byte.
// ---------------------------------------------------------------------------

export interface WorkforcePlanOptions {
  workers: number;
  postings: number;
  payers: number;
  rngSeed: number;
}

export const DEFAULT_WORKFORCE_PLAN: WorkforcePlanOptions = Object.freeze({
  workers: DEFAULT_WORKFORCE_WORKER_COUNT,
  postings: DEFAULT_WORKFORCE_POSTING_COUNT,
  payers: WORKFORCE_PAYER_COUNT,
  rngSeed: 20261007,
});

export interface WorkforcePlan {
  options: WorkforcePlanOptions;
  payers: WorkforcePayer[];
  workers: WorkforceWorker[];
  postings: WorkforcePosting[];
}

export function buildWorkforcePlan(options: WorkforcePlanOptions = DEFAULT_WORKFORCE_PLAN): WorkforcePlan {
  const rng = makeRng(options.rngSeed);
  const payerList = buildWorkforcePayers(options.payers);
  const workerList = buildWorkforceWorkers(options.workers, rng);
  const postingList = buildWorkforcePostings(options.postings, payerList, rng);
  return { options, payers: payerList, workers: workerList, postings: postingList };
}

// ---------------------------------------------------------------------------
// Worker-visible text screen (ADR-0024) — names, city, posting card fields.
// ---------------------------------------------------------------------------

function workerVisibleWorkerFields(w: WorkforceWorker): Array<[string, string]> {
  return [
    ["name", w.name],
    ["city", w.city.name],
  ];
}

function workerVisiblePostingFields(p: WorkforcePosting): Array<[string, string]> {
  return [
    ["role_title", p.roleTitle],
    ["city", p.city],
    ["area", p.area],
    ["description", p.description],
    ...p.benefits.map((b, i): [string, string] => [`benefits[${i}]`, b]),
    ...p.requirements.map((r, i): [string, string] => [`requirements[${i}]`, r]),
  ];
}

export function assertWorkerVisibleTextClean(plan: WorkforcePlan): void {
  for (const w of plan.workers) {
    for (const [field, text] of workerVisibleWorkerFields(w)) {
      const screens = workerVisibleTextScreens(text);
      if (screens.length > 0) {
        throw new Error(
          `[${NAME}] worker-visible text screen tripped — worker ${w.workerId} field ${field} ` +
            `(${screens.join(",")}); aborting before any write.`,
        );
      }
    }
  }
  for (const p of plan.postings) {
    for (const [field, text] of workerVisiblePostingFields(p)) {
      const screens = workerVisibleTextScreens(text);
      if (screens.length > 0) {
        throw new Error(
          `[${NAME}] worker-visible text screen tripped — posting ${p.postingId} field ${field} ` +
            `(${screens.join(",")}); aborting before any write.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reach resolution — the publish rule, cross-checked against the seeded vocabulary (same
// discipline as `seed-demo-matching.ts`'s `resolveDemoReachSets`).
// ---------------------------------------------------------------------------

async function loadMatchConfig(db: Database): Promise<MatchConfig> {
  const rows = await db
    .select({ config: matchConfig.config })
    .from(matchConfig)
    .where(eq(matchConfig.isActive, true))
    .limit(1);
  return parseMatchConfig(rows[0]?.config);
}

export async function resolveWorkforceReachSets(
  db: Database,
  plan: WorkforcePlan,
  config: MatchConfig,
): Promise<Map<string, string[]>> {
  const allSkills = [...new Set(plan.postings.flatMap((p) => p.matchSkillIds))].sort();
  const present = await db.select({ skillId: skills.skillId }).from(skills).where(inArray(skills.skillId, allSkills));
  const missing = allSkills.filter((id) => !present.some((r) => r.skillId === id));
  if (missing.length > 0) {
    throw new Error(
      `[${NAME}] match skills missing from the "skill" table: ${missing.join(", ")}. ` +
        `Run: pnpm --filter @badabhai/db db:seed:match:vocabulary --apply`,
    );
  }

  const bySet = new Map<string, string[]>();
  const out = new Map<string, string[]>();
  for (const p of plan.postings) {
    const key = [...p.matchSkillIds].sort().join(",");
    let reach = bySet.get(key);
    if (reach === undefined) {
      const resolved = resolveReachSet({
        postedSkillIds: p.matchSkillIds,
        relatedDefault: config.relatedSkillsDefault,
        untickedIds: [],
      });
      if (resolved.postedSkillIds.length !== p.matchSkillIds.length) {
        throw new Error(`[${NAME}] posting ${p.postingId} names a non-match skill id.`);
      }
      reach = [...resolved.reachSkillIds];
      if (config.relatedSkillsDefault === "on") {
        const fromDb = await expandReachSkillIds(db, [...p.matchSkillIds]);
        if (fromDb.join(",") !== [...reach].sort().join(",")) {
          throw new Error(
            `[${NAME}] skill_related in the database disagrees with the taxonomy for {${key}} ` +
              `(db=${fromDb.join(",")} taxonomy=${reach.join(",")}). Re-run db:seed:match:vocabulary.`,
          );
        }
      }
      bySet.set(key, reach);
    }
    out.set(p.postingId, reach);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface WorkforceCrypto {
  key: string;
  pepper: string;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const excluded = (col: string) => dsql.raw(`excluded.${col}`);
const INSERT_CHUNK = 200;

/** A reserved workforce phone must belong to its cohort worker or to nobody — mirrors
 * `seed-demo-matching.ts`'s `assertPhonesUnclaimed`. */
async function assertPhonesUnclaimed(db: Database, plan: WorkforcePlan, pepper: string): Promise<void> {
  const hashes = plan.workers.map((w) => hashPhone(w.phoneE164, pepper));
  const owners = await db.select({ id: workers.id, phoneHash: workers.phoneHash }).from(workers).where(
    inArray(workers.phoneHash, hashes),
  );
  const foreign = owners.filter((o) => !plan.workers.some((w) => w.workerId === o.id));
  if (foreign.length > 0) {
    throw new Error(
      `[${NAME}] ${foreign.length} reserved workforce-seed phone(s) already belong to non-cohort ` +
        `worker(s) ${foreign.map((f) => f.id).join(", ")}. Remove those workers, then re-run. ` +
        `Nothing was written.`,
    );
  }
}

export interface ApplyWorkforceSeedResult {
  payers: number;
  workers: number;
  packAttributes: number;
  postings: number;
  boosted: number;
  staleRemoved: number;
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

async function removeWorkforceRowsOutside(db: Database, plan: WorkforcePlan): Promise<number> {
  const keepPostings = dsql.param(plan.postings.map((p) => p.postingId));
  const keepWorkers = dsql.param(plan.workers.map((w) => w.workerId));
  const keepPayers = dsql.param(plan.payers.map((p) => p.payerId));
  const a = rowsOf(
    await db.execute(dsql`
      DELETE FROM job_postings
      WHERE id::text LIKE ${workforceIdLikePattern("posting")} AND NOT (id = ANY(${keepPostings}::uuid[]))
      RETURNING 1`),
  ).length;
  const b = rowsOf(
    await db.execute(dsql`
      DELETE FROM workers
      WHERE id::text LIKE ${workforceIdLikePattern("worker")} AND NOT (id = ANY(${keepWorkers}::uuid[]))
      RETURNING 1`),
  ).length;
  const c = rowsOf(
    await db.execute(dsql`
      DELETE FROM payers
      WHERE id::text LIKE ${workforceIdLikePattern("payer")} AND NOT (id = ANY(${keepPayers}::uuid[]))
      RETURNING 1`),
  ).length;
  return a + b + c;
}

export async function applyWorkforceSeed(
  db: Database,
  plan: WorkforcePlan,
  reach: ReadonlyMap<string, string[]>,
  crypto: WorkforceCrypto,
  anchor: Date,
): Promise<ApplyWorkforceSeedResult> {
  assertWorkerVisibleTextClean(plan);
  await assertPhonesUnclaimed(db, plan, crypto.pepper);
  const boostedUntil = new Date(anchor.getTime() + BOOST_DAYS * 86_400_000);
  // See the header's CONSENT note: `employer_sharing` is granted on EVERY target, including
  // production — this cohort exists to BE unlockable by the 13 real payers/postings.
  const consentPurposes: ConsentPurpose[] = ["profiling", "resume_generation", "communication", "employer_sharing"];

  return db.transaction(async (tx) => {
    // 1. Payers.
    for (const p of plan.payers) {
      await tx
        .insert(payers)
        .values({
          id: p.payerId,
          role: "employer",
          emailEnc: encryptPii(p.email, crypto.key),
          emailHash: hashPhone(p.email, crypto.pepper),
          orgNameEnc: encryptPii(p.orgName, crypto.key),
          status: "active",
        })
        .onConflictDoUpdate({
          target: payers.id,
          set: {
            emailEnc: encryptPii(p.email, crypto.key),
            emailHash: hashPhone(p.email, crypto.pepper),
            orgNameEnc: encryptPii(p.orgName, crypto.key),
            status: "active",
            updatedAt: anchor,
          },
        });
    }

    // 2. Workers: worker + profile + consent + (pack-route) worker_attributes.
    let packAttributeRows = 0;
    for (const w of plan.workers) {
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
      const profile = {
        source: profileSourceForRoute(route),
        canonicalRoleId: canonicalRoleIdForRoute(route),
        skills: profileSkillsForRoute(route),
        experience: { total_years: w.totalYears },
        locationPreference: { city: w.city.slug, preferred_cities: [w.city.slug] },
        availability: { status: "immediate" },
        confirmedAt: anchor,
        updatedAt: anchor,
      } as const;
      await tx
        .insert(workerProfiles)
        .values({ id: w.profileId, workerId: w.workerId, ...profile, skills: [...profile.skills] })
        .onConflictDoUpdate({
          target: workerProfiles.id,
          set: { ...profile, skills: [...profile.skills] },
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

      // This worker id is wholly owned by this seed, so the only prior writer of its
      // worker_attributes rows (if any, from an earlier run with a different --rng-seed that
      // assigned a different trade) is this script itself. Delete-then-reinsert keeps the sync
      // simple and correct without a second query to diff against.
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
    }

    // 3. Postings, in chunks.
    for (const batch of chunks(plan.postings, INSERT_CHUNK)) {
      await tx
        .insert(jobPostings)
        .values(
          batch.map((p) => {
            const payer = plan.payers[p.payerIndex]!;
            return {
              id: p.postingId,
              createdBy: payer.payerId,
              payerId: payer.payerId,
              orgLabel: `SYNTHETIC — Workforce Seed Employer ${String(p.payerIndex + 1).padStart(2, "0")}`,
              roleTitle: p.roleTitle,
              locationLabel: `${p.area}, ${p.city}`,
              description: p.description,
              vacancyBand: p.vacancyBand,
              status: "open" as const,
              industryId: p.industryId,
              roleKind: p.roleKind,
              matchSkillIds: p.matchSkillIds,
              reachSkillIds: reach.get(p.postingId)!,
              city: p.city,
              area: p.area,
              payMin: p.payMin,
              payMax: p.payMax,
              payType: p.payType,
              shift: p.shift,
              neededBy: p.neededBy,
              minExperienceYears: p.minExperienceYears,
              maxExperienceYears: p.maxExperienceYears,
              benefits: p.benefits,
              requirements: p.requirements,
              publishedAt: new Date(anchor.getTime() - p.publishedMinutesAgo * 60_000),
              boostedUntil: p.boosted ? boostedUntil : null,
              updatedAt: anchor,
            };
          }),
        )
        .onConflictDoUpdate({
          target: jobPostings.id,
          set: Object.fromEntries(
            [
              ["createdBy", "created_by"],
              ["payerId", "payer_id"],
              ["orgLabel", "org_label"],
              ["roleTitle", "role_title"],
              ["locationLabel", "location_label"],
              ["description", "description"],
              ["vacancyBand", "vacancy_band"],
              ["status", "status"],
              ["industryId", "industry_id"],
              ["roleKind", "role_kind"],
              ["matchSkillIds", "match_skill_ids"],
              ["reachSkillIds", "reach_skill_ids"],
              ["city", "city"],
              ["area", "area"],
              ["payMin", "pay_min"],
              ["payMax", "pay_max"],
              ["payType", "pay_type"],
              ["shift", "shift"],
              ["neededBy", "needed_by"],
              ["minExperienceYears", "min_experience_years"],
              ["maxExperienceYears", "max_experience_years"],
              ["benefits", "benefits"],
              ["requirements", "requirements"],
              ["publishedAt", "published_at"],
              ["boostedUntil", "boosted_until"],
              ["updatedAt", "updated_at"],
            ].map(([k, col]) => [k, excluded(col!)]),
          ),
        });
    }

    // 4. Sync: drop cohort rows a previous, larger plan left behind.
    const staleRemoved = await removeWorkforceRowsOutside(tx as unknown as Database, plan);

    return {
      payers: plan.payers.length,
      workers: plan.workers.length,
      packAttributes: packAttributeRows,
      postings: plan.postings.length,
      boosted: plan.postings.filter((p) => p.boosted).length,
      staleRemoved,
    };
  });
}

/** Applications REAL (non-cohort) workers made to cohort postings — what a hard cleanup would delete. */
export async function countRealApplicationsToWorkforce(db: Database): Promise<number> {
  return (
    rowsOf<{ n: number }>(
      await db.execute(dsql`
        SELECT count(*)::int AS n FROM applications a
        WHERE a.job_posting_id::text LIKE ${workforceIdLikePattern("posting")}
          AND a.worker_id::text NOT LIKE ${workforceIdLikePattern("worker")}`),
    )[0]?.n ?? 0
  );
}

/** SOFT cleanup: close every open cohort posting (off every feed; nothing deleted). */
export async function closeWorkforcePostings(db: Database, now: Date): Promise<number> {
  return rowsOf(
    await db.execute(dsql`
      UPDATE job_postings
      SET status = 'closed', closed_at = ${now.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      WHERE id::text LIKE ${workforceIdLikePattern("posting")} AND status <> 'closed'
      RETURNING 1`),
  ).length;
}

/** HARD cleanup: remove every cohort row. Postings first (cascades job_reach/applications), then
 * workers (cascades profile/consent/worker_attributes/worker_skill/worker_industry_tenure), then
 * payers. */
export async function unseedWorkforce(db: Database): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const del = async (table: "job_postings" | "workers" | "payers", kind: WorkforceIdKind) =>
      rowsOf(
        await tx.execute(
          dsql`DELETE FROM ${dsql.identifier(table)} WHERE id::text LIKE ${workforceIdLikePattern(kind)} RETURNING 1`,
        ),
      ).length;
    return {
      "job_postings deleted": await del("job_postings", "posting"),
      "workers deleted (cascades profile/consent/attributes/skill/tenure/reach)": await del("workers", "worker"),
      "payers deleted": await del("payers", "payer"),
    };
  });
}

// ---------------------------------------------------------------------------
// Target declaration — mirrors `seed-demo-matching.ts`'s guard exactly.
// ---------------------------------------------------------------------------

export function targetDeclarationProblem(databaseUrl: string, declared: string | undefined): string | null {
  const target = declared ?? "local";
  if (target !== "local" && target !== "production") {
    return `--target must be "local" or "production" (got "${target}").`;
  }
  const prodLike = isProductionLike(databaseUrl);
  if (prodLike && target !== "production") {
    return (
      `DATABASE_URL is ${hostClass(databaseUrl)} — a production-like target. This seed writes ` +
      `synthetic workers and postings REAL EMPLOYERS WILL SEE. Re-run with --target=production ` +
      `(plus, for a write, the ops-guard flag + OPS_ALLOW_PRODUCTION=${NAME}) only if the owner asked.`
    );
  }
  if (!prodLike && target === "production") {
    return `--target=production was declared but DATABASE_URL is ${hostClass(databaseUrl)}; refusing the mismatch.`;
  }
  return null;
}

function assertTargetDeclared(databaseUrl: string, declared: string | undefined): void {
  const problem = targetDeclarationProblem(databaseUrl, declared);
  if (problem !== null) throw new Error(`[${NAME}] ${problem}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function intArg(flag: string, fallback: number, min: number, max: number): number {
  const raw = argValue(flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[${NAME}] --${flag} must be an integer in ${min}..${max}`);
  }
  return n;
}

function readCrypto(): WorkforceCrypto {
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

function printPlanSummary(plan: WorkforcePlan, config: MatchConfig): void {
  printCounts(NAME, {
    workers: plan.workers.length,
    payers: plan.payers.length,
    postings: plan.postings.length,
    "two-skill postings": plan.postings.filter((p) => p.matchSkillIds.length > 1).length,
    boosted: plan.postings.filter((p) => p.boosted).length,
    "related skills default": config.relatedSkillsDefault,
  });
  console.log(`[${NAME}] workers per trade:`);
  for (const trade of WORKFORCE_TRADES) {
    const n = plan.workers.filter((w) => w.trade.skillId === trade.skillId).length;
    console.log(`  ${trade.skillId.padEnd(32)} ${n} (route: ${trade.route.kind})`);
  }
  console.log(`[${NAME}] workers per experience band:`);
  for (const band of EXPERIENCE_BANDS) {
    const n = plan.workers.filter((w) => w.experienceBand === band.label).length;
    console.log(`  ${band.label.padEnd(10)} ${n}`);
  }
  console.log(`[${NAME}] workers per city:`);
  for (const city of REACH_CITIES) {
    const n = plan.workers.filter((w) => w.city.slug === city.slug).length;
    console.log(`  ${city.name.padEnd(14)} ${n}`);
  }
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  assertTargetDeclared(opts.databaseUrl, argValue("target"));
  const unseedMode = argFlag("unseed") || argFlag("cleanup");
  const anchorRaw = argValue("anchor");
  const anchor = anchorRaw === undefined ? new Date() : new Date(anchorRaw);
  if (Number.isNaN(anchor.getTime())) throw new Error(`[${NAME}] --anchor must be an ISO timestamp`);

  const plan = buildWorkforcePlan({
    workers: intArg("workers", DEFAULT_WORKFORCE_PLAN.workers, WORKFORCE_TRADES.length, 999),
    postings: intArg("postings", DEFAULT_WORKFORCE_PLAN.postings, WORKFORCE_TRADES.length, 5000),
    payers: intArg("payers", DEFAULT_WORKFORCE_PLAN.payers, 1, 999),
    rngSeed: intArg("rng-seed", DEFAULT_WORKFORCE_PLAN.rngSeed, 0, 2 ** 31 - 1),
  });
  assertWorkerVisibleTextClean(plan);

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    if (unseedMode) {
      if (!opts.apply) {
        console.log(`[${NAME}] --unseed dry run: re-run with --apply to remove every face… cohort row.`);
        printFooter(NAME, opts, 0);
        return;
      }
      if (argFlag("close-only")) {
        const closed = await closeWorkforcePostings(db, new Date());
        printCounts(NAME, { "cohort postings closed (rows kept)": closed });
        printFooter(NAME, opts, closed);
        return;
      }
      const realApplications = await countRealApplicationsToWorkforce(db);
      if (realApplications > 0 && !argFlag("delete-real-applications")) {
        throw new Error(
          `[${NAME}] ${realApplications} application(s) by NON-cohort workers point at cohort ` +
            `postings; a hard cleanup would delete them. Run with --close-only to take the cohort ` +
            `off every feed without deleting anything, or pass --delete-real-applications if the ` +
            `owner has decided they go. Nothing was written.`,
        );
      }
      const counts = await unseedWorkforce(db);
      printCounts(NAME, { ...counts, "real applications deleted (cascade)": realApplications });
      printFooter(
        NAME,
        opts,
        Object.values(counts).reduce((a, b) => a + b, 0),
      );
      return;
    }

    const config = await loadMatchConfig(db);
    const reach = await resolveWorkforceReachSets(db, plan, config);

    if (!opts.apply) {
      printPlanSummary(plan, config);
      printFooter(NAME, opts, plan.payers.length + plan.workers.length * 3 + plan.postings.length);
      return;
    }

    const crypto = readCrypto();
    const seeded = await applyWorkforceSeed(db, plan, reach, crypto, anchor);
    printCounts(NAME, {
      "payers upserted": seeded.payers,
      "workers upserted": seeded.workers,
      "worker_attributes (pack answers) written": seeded.packAttributes,
      "job_postings upserted (open)": seeded.postings,
      "job_postings boosted": seeded.boosted,
      "stale cohort rows removed": seeded.staleRemoved,
    });
    console.log(
      `[${NAME}] NEXT — run the real derivation pipeline against this cohort (not run by this script):`,
    );
    console.log(`  pnpm --filter @badabhai/db db:backfill:worker-skills --apply`);
    console.log(`  pnpm --filter @badabhai/db db:materialize:reach --apply`);
    printFooter(NAME, opts, seeded.payers + seeded.workers + seeded.postings);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input.
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
