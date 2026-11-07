import {
  labelForTaxonomyId,
  matchSkillLabel,
  TRADE_LEVEL_LABELS,
  type TradeLevel,
} from "@badabhai/taxonomy";
import {
  AVAILABILITY_STATUSES,
  EDUCATION_QUALIFICATIONS,
  labelFor,
} from "../profiles/worker-preferences.vocabulary";
import { experienceBandFromYears } from "../reach/reach.mappers";

/**
 * Non-contact profile facts for a payer applicant card (issue #2736).
 *
 * WHAT THIS IS. The payer-app Applicants card can only render what
 * `GET /payer/reach/jobs/:jobId/applicants` returns, and today that is rank, score and
 * ranking reasons — the card literally says "experience unknown". This block adds the
 * coarse, non-identifying facts a card needs to be useful BEFORE the paid unlock:
 * skills, experience bands, education, availability and recency. Every field is a label,
 * a band, a count or an id from a closed vocabulary — nothing that names, contacts or
 * locates a person.
 *
 * PRIVACY (hard constraints from the issue, kept here by construction):
 *   - NO name, phone, email, address, employer name or contact/unique identifier — the
 *     repository projects none of those columns, and the mapper has no code path that
 *     reads them.
 *   - Employer-side masking stays until the paid unlock (ADR-0047 G2): free-text fields
 *     (certificate names/issuers, training names, institutes, work descriptions) are
 *     NEVER projected — only the closed credential slug and row COUNTS cross.
 *   - Additive and versioned: every field is nullable, so a sparse profile renders and
 *     older clients (which strip unknown keys) keep parsing.
 *
 * WHERE IT IS READ. One batched read per list (`ApplicantProfileFactsRepository`), keyed
 * by the worker ids already on that list — membership is decided upstream (applied,
 * not pending deletion, owned posting), so this read never filters and never gates:
 * a worker with no row in some table gets `null` (or `[]`), never disappears.
 */

export const APPLICANT_SKILLS_MAX = 8;

/** Coarse recency of the worker's last activity — a bucket, never a timestamp. */
export type LastActiveBand = "today" | "this week" | "this month" | "earlier";

/** One rung for the card's level badge — the same shape as the V1 `tradeLevels` badge. */
export interface ApplicantTradeLevelBadge {
  /** The trade skill the rung sits on (an `mskill_*` id). */
  skillId: string;
  /** The trade's display label, when the taxonomy knows it. */
  skillLabel: string | null;
  /** The stored rung key. */
  tradeLevel: string;
  /** The printed rung, or the raw key when the taxonomy does not know it. */
  tradeLevelLabel: string;
  /** True once the separating question was answered. */
  levelConfirmed: boolean;
}

/** The coarse, non-contact facts grafted onto each applicant row. */
export interface ApplicantProfileFacts {
  /** Skill labels (taxonomy-resolved, capped) — never ids the card would have to map. */
  skills: string[] | null;
  /** Total-experience band ("1-2 yrs" …), or null when unknown. */
  totalExperienceBand: string | null;
  /** Industry-experience band, or null when unknown. */
  industryExperienceBand: string | null;
  /** Highest closed credential ("ITI", "Graduate", …), or null. */
  educationLabel: string | null;
  /** How many certificates are on record (a count, never names/issuers). */
  certificationCount: number | null;
  /** Availability in words ("Within a week"), or null when unstated. */
  availabilityLabel: string | null;
  /** Coarse recency bucket, or null when never seen. */
  lastActiveBand: LastActiveBand | null;
  /**
   * Stated rungs for the level badge. V1 rows carry their own (frozen-subquery) badges
   * and ignore these; legacy rows take them — either way the card never maps an id.
   */
  tradeLevels: ApplicantTradeLevelBadge[];
}

/** The all-empty facts: what a worker with no stored signal gets (renders, never drops). */
export const EMPTY_APPLICANT_PROFILE_FACTS: ApplicantProfileFacts = {
  skills: null,
  totalExperienceBand: null,
  industryExperienceBand: null,
  educationLabel: null,
  certificationCount: null,
  availabilityLabel: null,
  lastActiveBand: null,
  tradeLevels: [],
};

/** One worker's raw facts, as the batched repository returns them. */
export interface ApplicantProfileFactsSourceRow {
  workerId: string;
  /** `worker_profiles.skills` — closed ids and, possibly, worker-typed phrases. */
  skillIds: unknown;
  /** `worker_profiles.experience.total_years`. */
  totalYears: number | null;
  /** `worker_profiles.availability.status`. */
  availabilityStatus: string | null;
  /** Highest `worker_education.credential` slug, or null. */
  educationCredential: string | null;
  /** `worker_certificate` row count. */
  certificateCount: number;
  /** Max `worker_industry_tenure.calendar_months`, or null. */
  industryMonths: number | null;
  /** Stated rungs (latest profile per skill) for the level badge. */
  tradeLevels: {
    skillId: string;
    tradeLevel: string;
    levelConfirmed: boolean;
  }[];
  /** `workers.last_seen_at`. */
  lastSeenAt: Date | string | null;
}

/**
 * Raw facts → the card's facts. Pure: every rule here is unit-testable without a database.
 * Unknown stays unknown (`null`); nothing is derived, averaged or guessed.
 */
export function toApplicantProfileFacts(
  row: ApplicantProfileFactsSourceRow,
  now: Date = new Date(),
): ApplicantProfileFacts {
  return {
    skills: applicantSkillLabels(row.skillIds),
    totalExperienceBand: experienceBandFromYears(row.totalYears),
    industryExperienceBand:
      row.industryMonths === null ? null : experienceBandFromYears(row.industryMonths / 12),
    educationLabel:
      typeof row.educationCredential === "string" && row.educationCredential in EDUCATION_QUALIFICATIONS
        ? EDUCATION_QUALIFICATIONS[row.educationCredential as keyof typeof EDUCATION_QUALIFICATIONS]!
        : null,
    certificationCount: row.certificateCount,
    availabilityLabel:
      typeof row.availabilityStatus === "string"
        ? (labelFor(AVAILABILITY_STATUSES, row.availabilityStatus) ?? null)
        : null,
    lastActiveBand: lastActiveBandFrom(row.lastSeenAt, now),
    tradeLevels: row.tradeLevels.map(toApplicantTradeLevelBadge),
  };
}

/** Closed skill ids → display labels, capped; phrases resolve to themselves, blanks drop. */
function applicantSkillLabels(skillIds: unknown): string[] | null {
  if (!Array.isArray(skillIds)) return null;
  const labels = skillIds
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((id) => labelForTaxonomyId(id).trim())
    .filter((label) => label !== "");
  const deduped = [...new Set(labels)].slice(0, APPLICANT_SKILLS_MAX);
  return deduped.length > 0 ? deduped : null;
}

/**
 * `last_seen_at` → a coarse bucket. A future timestamp (clock skew) reads as the most
 * recent bucket rather than vanishing the worker; an unparseable value is unknown.
 */
export function lastActiveBandFrom(
  lastSeenAt: Date | string | null,
  now: Date = new Date(),
): LastActiveBand | null {
  if (lastSeenAt === null) return null;
  const t = new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return null;
  const days = (now.getTime() - t) / 86_400_000;
  if (days < 1) return "today";
  if (days < 7) return "this week";
  if (days < 30) return "this month";
  return "earlier";
}

/** One stated rung → the card's badge facts. Both labels resolve here, never on the card. */
export function toApplicantTradeLevelBadge(row: {
  skillId: string;
  tradeLevel: string;
  levelConfirmed: boolean;
}): ApplicantTradeLevelBadge {
  return {
    skillId: row.skillId,
    skillLabel: matchSkillLabel(row.skillId) ?? null,
    tradeLevel: row.tradeLevel,
    tradeLevelLabel:
      TRADE_LEVEL_LABELS[row.tradeLevel as TradeLevel] ?? row.tradeLevel,
    levelConfirmed: row.levelConfirmed,
  };
}

/**
 * Graft facts onto legacy (`ApplicantRowDto`) rows, keyed by worker id. The legacy row
 * already carries its total-experience band (`experienceBand`, from its own signal row),
 * so the lookup's duplicate is NOT grafted — one name per fact on the wire. A worker
 * with no stored signal keeps the all-empty facts instead of dropping
 * (count in == count out — sort-never-block).
 */
export function graftLegacyApplicantFacts<Row extends { workerId: string }>(
  rows: readonly Row[],
  byWorker: ReadonlyMap<string, ApplicantProfileFacts>,
): (Row & Omit<ApplicantProfileFacts, "totalExperienceBand">)[] {
  return rows.map((row) => {
    const facts = byWorker.get(row.workerId) ?? EMPTY_APPLICANT_PROFILE_FACTS;
    return {
      ...row,
      skills: facts.skills,
      industryExperienceBand: facts.industryExperienceBand,
      educationLabel: facts.educationLabel,
      certificationCount: facts.certificationCount,
      availabilityLabel: facts.availabilityLabel,
      lastActiveBand: facts.lastActiveBand,
      tradeLevels: facts.tradeLevels,
    };
  });
}

/**
 * Rows whose months are unknown sort below a real zero rather than tying with it
 * (mirrors the rank SQL's `COALESCE(x, -1)`), and an unknown band is `null`, never a
 * guessed "0".
 */
export function industryBandFromMonths(months: number | null): string | null {
  if (months === null || !Number.isFinite(months) || months < 0) return null;
  return experienceBandFromYears(months / 12);
}
