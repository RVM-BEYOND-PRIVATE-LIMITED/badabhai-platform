import { getMachine, getRole } from "@badabhai/taxonomy";
import { canonicalCity } from "@badabhai/profiling-lexicon";
import { RVM_INSTITUTE_CODE } from "@badabhai/db";
import { resolveTradeContent } from "../resume/trade-content";
import {
  isOpenTopSalaryChip,
  resolveSalaryBand,
  resolveSalaryPeriod,
  type SalaryPeriod,
} from "../profiles/worker-field-precedence";
import { formatOpenTopSalary, formatSalaryBand } from "../resume/resume-sheet-rows";
import { hasForbiddenLabelCharacter } from "../campus-link/campus-characters";

/**
 * Who an applicant or search row is (#2747 item 1, brief 4B.3): an RVM student reached through
 * BadaBhai Campus, or a BadaBhai worker. Read from the ACTIVE institute link (#2752) — the same
 * fact that keeps him out of company search and labels him in the admin console — never from a
 * second column.
 */
export const APPLICANT_SOURCES = ["rvm_student", "badabhai_worker"] as const;
export type ApplicantSource = (typeof APPLICANT_SOURCES)[number];

/** The label for a row whose live link (or none) is `instituteCode`. */
export function applicantSourceOf(instituteCode: string | null | undefined): ApplicantSource {
  return instituteCode === RVM_INSTITUTE_CODE ? "rvm_student" : "badabhai_worker";
}

/**
 * The facts a company sees BEFORE it pays (#2747 item 4, brief 4B.5), on top of the level,
 * experience and availability the card already carries (#2736).
 *
 * EVERY KEY IS ALWAYS PRESENT once the `applicant_facts` switch is on for the company; `null`
 * means "not given" and the card prints it so. While the switch is off none of these keys is
 * sent, so a shipped client sees exactly the shape it parses today.
 *
 * WHAT IT IS NOT. No surname, phone number, address, employer name, photo or free text the worker
 * typed. The first name is the brief's one personal fact before paying; it is derived here on the
 * server from the encrypted `workers.full_name`, per page, and never logged, cached or put in an
 * event (ADR-0047 lets raw personal data into logs; this read does not take that allowance).
 */
export interface PrePayFacts {
  /** The first word of his name, or null. Never the surname. */
  firstName: string | null;
  /**
   * His trade, from the closed taxonomy (never the model's free-text label); for an RVM student,
   * the course RVM reports, when it reports one.
   */
  tradeLine: string | null;
  /** The expected salary as the résumé prints it ("₹24,000 – ₹28,000 / month"), or null. */
  expectedSalary: string | null;
  /** Machine labels from the closed vocabulary, capped at {@link PRE_PAY_MACHINES_MAX}. */
  machines: string[] | null;
  /**
   * The city — profiles hold city and state and nothing finer. For an RVM student, his branch's
   * city when the gazetteer knows the branch name, else his own.
   */
  area: string | null;
  /**
   * The IST calendar day he was last active (`yyyy-mm-dd`), or null when never seen. His newest
   * device sighting; while `WORKER_ACTIVITY_ENABLED` is on, the later of that and his newest
   * `worker_activity` day (#2753, `WorkerActivityRepository.lastActiveDays`).
   */
  lastActiveOn: string | null;
}

/** The keys above, for the "every key on every card" checks. */
export const PRE_PAY_FACT_KEYS = [
  "firstName",
  "tradeLine",
  "expectedSalary",
  "machines",
  "area",
  "lastActiveOn",
] as const satisfies readonly (keyof PrePayFacts)[];

export const PRE_PAY_MACHINES_MAX = 8;
/** A first name longer than this is cut; a real first name never is. */
export const FIRST_NAME_MAX_CHARS = 40;
/** RVM's course names are short; this only bounds what a contract break could put on a card. */
export const TRADE_LINE_MAX_CHARS = 80;

export const EMPTY_PRE_PAY_FACTS: PrePayFacts = {
  firstName: null,
  tradeLine: null,
  expectedSalary: null,
  machines: null,
  area: null,
  lastActiveOn: null,
};

/** The worker's active institute link, when he has one. */
export interface PrePayInstituteLink {
  instituteCode: string;
  course: string | null;
  branch: string | null;
}

/** One worker's raw inputs, as the batched read returns them (the name already decrypted). */
export interface PrePayFactsSourceRow {
  workerId: string;
  /** Decrypted `workers.full_name`. PLAINTEXT: never logged, never kept past the page. */
  fullName: string | null;
  /** `workers.current_city`. */
  workersCity: string | null;
  /** The current profile's taxonomy ids (`CURRENT_PROFILE_ORDER`). */
  canonicalTradeId: string | null;
  canonicalRoleId: string | null;
  /** `worker_profiles.machines`. */
  machineIds: unknown;
  /** `worker_profiles.salary_expectation` (the extraction container). */
  salaryContainer: unknown;
  /** `worker_attributes` `salary_expected_min` / `_max` / `salary_period`. */
  salaryExpectedMin: number | null;
  salaryExpectedMax: number | null;
  salaryPeriod: string | null;
  /** Max `worker_devices.last_seen_at`. */
  lastSeenAt: Date | string | null;
  institute: PrePayInstituteLink | null;
  /** Live admin corrections (ADR-0062 §3.2), keyed by fact key. Empty when none. */
  overrides: ReadonlyMap<string, unknown>;
}

/**
 * Raw inputs → the card's facts. Pure. Unknown stays unknown (`null`): nothing is guessed, and no
 * value is derived from another (a salary band is never widened, a city never inferred).
 */
export function toPrePayFacts(row: PrePayFactsSourceRow, now: Date = new Date()): PrePayFacts {
  const city = correctedString(row.overrides, "current_city") ?? row.workersCity;
  const ownArea = cityOf(city);
  const rvm = row.institute?.instituteCode === RVM_INSTITUTE_CODE ? row.institute : null;
  return {
    firstName: firstNameOf(row.fullName),
    tradeLine:
      courseLine(rvm?.course ?? null) ??
      tradeLineOf(
        correctedId(row.overrides, "role", row.canonicalRoleId),
        correctedId(row.overrides, "trade", row.canonicalTradeId),
      ),
    expectedSalary: expectedSalaryOf(row),
    machines: machineLabels(row.machineIds),
    area: (rvm?.branch ? cityOf(rvm.branch) : null) ?? ownArea,
    lastActiveOn: lastActiveOnOf(row.lastSeenAt, now),
  };
}

/**
 * The first word of the name he gave, skipping a leading honorific ("Mr", "Md.", "Shri") and bare
 * initials ("R."), so "R. Ramesh Kumar" reads "Ramesh". A "word" carrying a digit or an `@` is not a
 * name (a phone number or an e-mail typed into the name field), and a name with a control, bidi or
 * stray format character is not printed: both read as not given. A surname-first name gives its
 * first word — the brief's "first name" is the name as written, never a guess at which word it is.
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
  if (typeof fullName !== "string" || hasForbiddenLabelCharacter(fullName)) return null;
  const words = fullName
    .trim()
    .split(/\s+/u)
    .filter((w) => w !== "");
  const first = words.find((w) => !isHonorificOrInitial(w));
  if (first === undefined || /[\p{Nd}@]/u.test(first)) return null;
  return [...first].slice(0, FIRST_NAME_MAX_CHARS).join("");
}

/** Titles written before a name in India, compared without dots and case. */
const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "md",
  "mohd",
  "shri",
  "smt",
  "kumari",
  "sh",
  "late",
]);

function isHonorificOrInitial(word: string): boolean {
  const bare = word.replace(/\./gu, "").toLowerCase();
  if (bare === "" || HONORIFICS.has(bare)) return true;
  // "R." or "R" alone is an initial, not a name.
  return [...bare].length === 1;
}

/**
 * The trade from the taxonomy: the role's name, else the authored trade content's display name.
 * The model's own `role_label` is deliberately NOT a fallback here (unlike the worker's own
 * profile tab): it is free text, and before paying the card shows closed values only.
 */
export function tradeLineOf(roleId: string | null, tradeId: string | null): string | null {
  if (roleId) {
    const role = getRole(roleId);
    if (role) return role.name;
  }
  if (roleId || tradeId) return resolveTradeContent(roleId, tradeId)?.display_name ?? null;
  return null;
}

/**
 * The expected salary on the résumé's own precedence (`resolveSalaryBandWithSource`, the SALARY ×3
 * rule): a live correction, else the extraction container, else the worker's own band — printed by
 * the résumé's formatters, as his own résumé prints it. (The EMPLOYER copy of the résumé prints no
 * salary; ADR-0064 records that the card now shows it before paying.) The form's open top chip
 * prints "₹50,000+", never the chip's stored key (#2400). The unit is the worker's `salary_period`
 * answer, except that a figure from the extraction container says its own period.
 */
export function expectedSalaryOf(row: PrePayFactsSourceRow): string | null {
  const period = resolveSalaryPeriod(row.salaryPeriod);
  const corrected = salaryCorrection(row.overrides);
  if (corrected !== null) {
    const band = resolveSalaryBand({ expected: corrected.min, expectedMax: corrected.max });
    if (band !== null) return perPeriod(formatSalaryBand(band.low, band.high), period);
  }
  const container = asRecord(row.salaryContainer);
  const fromContainer = resolveSalaryBand({
    expected: finiteNumber(container?.amount_min),
    expectedMax: finiteNumber(container?.amount_max),
  });
  if (fromContainer !== null) {
    return perPeriod(
      formatSalaryBand(fromContainer.low, fromContainer.high),
      containerPeriod(container?.period) ?? period,
    );
  }
  const attributes = { expected: row.salaryExpectedMin, expectedMax: row.salaryExpectedMax };
  if (isOpenTopSalaryChip(attributes)) return perPeriod(formatOpenTopSalary(null), period);
  const band = resolveSalaryBand(attributes);
  return band === null ? null : perPeriod(formatSalaryBand(band.low, band.high), period);
}

/**
 * The extraction container's own unit when it is NOT the schema default: `period` defaults to
 * "monthly" (`SalaryExpectationSchema`), so "monthly" says nothing and the worker's answer decides.
 */
function containerPeriod(value: unknown): SalaryPeriod | null {
  if (value === "daily") return "day";
  if (value === "yearly") return "year";
  return null;
}

/** The formatters print "/ month"; a day or year rate says its own unit instead. */
function perPeriod(label: string | null, period: SalaryPeriod): string | null {
  if (label === null || period === "month") return label;
  return label.replace(/ \/ month$/u, ` / ${period}`);
}

/**
 * Machine ids the taxonomy KNOWS → their labels, deduplicated and capped; none is null. Anything
 * else in the column (a phrase the model extracted, an old unscreened row) is dropped, never shown:
 * `labelForTaxonomyId` passes a non-id string through unchanged, so it is not used here.
 */
function machineLabels(machineIds: unknown): string[] | null {
  if (!Array.isArray(machineIds)) return null;
  const labels = machineIds
    .map((id) => (typeof id === "string" ? getMachine(id)?.name.trim() : undefined))
    .filter((label): label is string => typeof label === "string" && label !== "");
  const deduped = [...new Set(labels)].slice(0, PRE_PAY_MACHINES_MAX);
  return deduped.length > 0 ? deduped : null;
}

/**
 * `last_seen_at` → the IST day (18:30 UTC is IST midnight). A future timestamp (clock skew) reads
 * as today rather than a day that has not happened; an unparseable value is unknown.
 */
export function lastActiveOnOf(
  lastSeenAt: Date | string | null,
  now: Date = new Date(),
): string | null {
  if (lastSeenAt === null) return null;
  const t = new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(Math.min(t, now.getTime()) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const IST_OFFSET_MS = 330 * 60 * 1000;

/** A gazetteer city, or null: a spelling the gazetteer does not know is not shown. */
function cityOf(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return canonicalCity(value)?.value ?? null;
}

/**
 * RVM's course name, as a label companies read: one line, bounded, and refused outright (not
 * shown) when it carries a control, bidi or stray format character (the Campus label rule).
 */
function courseLine(value: string | null): string | null {
  if (typeof value !== "string" || hasForbiddenLabelCharacter(value)) return null;
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed === "" ? null : [...trimmed].slice(0, TRADE_LINE_MAX_CHARS).join("");
}

function correctedString(overrides: ReadonlyMap<string, unknown>, key: string): string | null {
  const value = overrides.get(key);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A trade/role correction may clear the id (`null`); absent means "no correction". */
function correctedId(
  overrides: ReadonlyMap<string, unknown>,
  key: "role" | "trade",
  base: string | null,
): string | null {
  if (!overrides.has(key)) return base;
  const value = overrides.get(key);
  return typeof value === "string" && value !== "" ? value : null;
}

/** The `salary_expected` correction (`{min, max}`), or null. */
function salaryCorrection(
  overrides: ReadonlyMap<string, unknown>,
): { min: number | null; max: number | null } | null {
  const value = asRecord(overrides.get("salary_expected"));
  if (value === null) return null;
  return { min: finiteNumber(value.min), max: finiteNumber(value.max) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A company-facing row as it goes on the wire: its base shape, the `source` label and, while the
 * `applicant_facts` switch is on for the company, every {@link PrePayFacts} key. `source` is
 * optional only in the TYPE, for hand-built unit instances without `PrePayFactsService`; the
 * @Global MatchModule provides it, so every served row carries it. `notRecentlyActive` (#2753
 * item 7) is on every row while `WORKER_ACTIVITY_ENABLED` is on, and absent while it is off.
 */
export type PrePayWire<R> = R & { source?: ApplicantSource } & Partial<PrePayFacts> & {
    notRecentlyActive?: boolean;
  };
