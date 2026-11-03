import { z } from "zod";
import { INDUSTRIES, isMatchSkillId } from "@badabhai/taxonomy";
import type { TradeLevelBadge } from "../match/match-candidates.service";
import { matchSkillIdSchema } from "../match/match.dto";
import { decodeCandidateCursor, CANDIDATE_CURSOR_MAX_LENGTH } from "./candidate-search.cursor";

/**
 * `POST /payer/candidates/search` — the payer's ALL-CANDIDATES search (ADR-0040; phase E2;
 * owner rulings 2026-11-03: the payer-web "Candidates" tab opens on it, full filter set).
 *
 * WIRE CONVENTION, matching the routes beside it: a POST BODY is snake_case (`/payer/unlocks`
 * `worker_id`, `/payer/match/reach-preview` `match_skill_ids`), a RESPONSE is camelCase (the
 * applicant rows' `workerId`, `skillMonths`, `nextCursor`). The cross-language fixture
 * `packages/types/fixtures/candidate-search-contract.json` pins both halves for the API,
 * payer-web and the payer app.
 */

/** Page size when the caller names none — the payer list convention (1..50, default 20). */
export const CANDIDATE_SEARCH_DEFAULT_LIMIT = 20;
/** The largest page one request can read. */
export const CANDIDATE_SEARCH_MAX_LIMIT = 50;
/** The most roles one search may name. */
export const CANDIDATE_SEARCH_MAX_ROLES = 5;

/**
 * Years-of-experience buckets — ONE closed list for both experience filters (on the role, and
 * in the industry), served to the clients by `GET /payer/candidates/filters` so neither client
 * keeps a copy. Offered as BUCKETS, never a free integer: `worker_skill.months_bucketed` is
 * bucketed to 6 months by config, so a "4 years exactly" control would promise a precision the
 * data does not have (E_CHAIN_DESIGN §3.1). Every edge is a multiple of 6 months. `maxMonths`
 * is EXCLUSIVE; null = no upper edge.
 */
export const EXPERIENCE_BUCKETS = [
  { id: "under_1", label: "Under 1 year", minMonths: 0, maxMonths: 12 },
  { id: "1_3", label: "1–3 years", minMonths: 12, maxMonths: 36 },
  { id: "3_5", label: "3–5 years", minMonths: 36, maxMonths: 60 },
  { id: "5_10", label: "5–10 years", minMonths: 60, maxMonths: 120 },
  { id: "10_plus", label: "10+ years", minMonths: 120, maxMonths: null },
] as const;

export type ExperienceBucketId = (typeof EXPERIENCE_BUCKETS)[number]["id"];
const EXPERIENCE_BUCKET_IDS = EXPERIENCE_BUCKETS.map((b) => b.id) as [
  ExperienceBucketId,
  ...ExperienceBucketId[],
];
const INDUSTRY_IDS = INDUSTRIES.map((i) => i.id) as [string, ...string[]];

/** The `[min, max)` month range of a bucket. */
export function experienceRange(id: ExperienceBucketId): { min: number; max: number | null } {
  const bucket = EXPERIENCE_BUCKETS.find((b) => b.id === id);
  // Unreachable through the schema (the enum admits only listed ids); fail closed anyway.
  if (!bucket) throw new Error(`unknown experience bucket ${id}`);
  return { min: bucket.minMonths, max: bucket.maxMonths };
}

/**
 * The search body. Every filter is optional; none = the whole eligible population, ranked.
 *
 * NO `payer_id`, ANYWHERE (XB-A): the payer is the verified session. `.strict()` makes a
 * smuggled `payer_id` a 400 rather than a silently ignored key.
 *
 * FILTERS REORDER BY DEFAULT (ADR-0040 Decision 1): candidates who match every supplied filter
 * lead, everyone else follows, nobody is removed. `strict: true` (Decision 2 — opt-in, explicit,
 * never remembered) drops the non-matching rows instead. Either way the response carries the
 * counts (Decision 3), and a filtered field the worker never recorded excludes nobody (Decision 4).
 */
export const CandidateSearchSchema = z
  .object({
    /** The roles asked for (closed `mskill_*` vocabulary). Unknown ids are a 400, never ignored. */
    skill_ids: z
      .array(
        matchSkillIdSchema.refine((id) => isMatchSkillId(id), {
          message: "not a known match skill",
        }),
      )
      .max(CANDIDATE_SEARCH_MAX_ROLES)
      .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate skill ids" })
      .default([]),
    /** Years on the role the card leads with (see the service for which role that is). */
    experience: z.enum(EXPERIENCE_BUCKET_IDS).nullable().default(null),
    industry_id: z.enum(INDUSTRY_IDS).nullable().default(null),
    /** Years in the industry of the lead role (chosen from the filtered industry when he holds one). */
    industry_experience: z.enum(EXPERIENCE_BUCKET_IDS).nullable().default(null),
    /**
     * A city the gazetteer recognises (any other text is a 400, so the filter can never probe a
     * free-text location the card hides), matched against every spelling of it the pool records.
     * `GET /payer/candidates/filters` offers the cities the pool actually records.
     */
    city: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .nullable()
      .default(null),
    strict: z.boolean().default(false),
    limit: z
      .number()
      .int()
      .min(1)
      .max(CANDIDATE_SEARCH_MAX_LIMIT)
      .default(CANDIDATE_SEARCH_DEFAULT_LIMIT),
    /**
     * The previous page's `nextCursor`, untouched. A value that is not a well-formed cursor is a
     * 400 and never reaches a query; a cursor minted under other filters is a 400 too (the service
     * checks its fingerprint). A well-formed cursor is not signed: hand-built, it can only move the
     * position within the same consented pool every payer may page through.
     */
    cursor: z
      .string()
      .max(CANDIDATE_CURSOR_MAX_LENGTH)
      .transform((raw, ctx) => {
        const cursor = decodeCandidateCursor(raw);
        if (cursor === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cursor is malformed" });
          return z.NEVER;
        }
        return cursor;
      })
      .nullable()
      .default(null),
  })
  .strict();

export type CandidateSearchDto = z.infer<typeof CandidateSearchSchema>;
export type CandidateSearchInput = z.input<typeof CandidateSearchSchema>;

/** A closed-vocabulary id with its display label. */
export interface LabelledIdDto {
  id: string;
  label: string;
}

/**
 * One MASKED candidate. Every field is closed-vocabulary, bucketed or a count — the same family
 * of facts the company applicant card already shows (`MatchCandidateRowDto`). NEVER a name, a
 * phone, a photo, an employer, a salary, an address or free text: identity stays behind
 * `POST /payer/unlocks` (ADR-0010). `workerId` is the SAME id that route takes (E2 item 7) —
 * one identifier per worker, never a second "more pseudonymous" one.
 */
export interface CandidateSearchRowDto {
  workerId: string;
  /** ADR-0040 `filter_match`: true when every supplied filter matched (always true unfiltered). */
  matchesFilters: boolean;
  /**
   * Only with a role filter: 1 = he holds a role that was asked for, 2 = he holds one RELATED to
   * it (`role` names which), null = neither, or no role filter. Never overwritten by the tier floor.
   */
  matchTier: 1 | 2 | null;
  /** The role the card leads with — the best match to the filters, else his most experienced. */
  role: LabelledIdDto;
  /** His other roles (wanted only), most experienced first, at most four. */
  otherRoles: LabelledIdDto[];
  /** Months on `role`, BUCKETED to 6 by config (never exact). */
  skillMonths: number;
  /** The industry of `role`. */
  industry: LabelledIdDto;
  /** Calendar months in `industry`, floored to 6; null = not recorded. */
  industryMonths: number | null;
  /** The worker's own city, only when the gazetteer recognises it; null = not recorded. */
  city: string | null;
  /** The rungs he stated per trade (display-only, the applicant card's own badge source). */
  tradeLevels: TradeLevelBadge[];
}

export interface CandidateSearchResponseDto {
  /** The eligible population (ADR-0040 §6 membership) — never the whole worker table. */
  total: number;
  /** Candidates whose RECORDED values match every supplied filter. */
  matched: number;
  /** Candidates kept only because a filtered field is unrecorded — never folded into `matched`. */
  unrecorded: number;
  /** True when any filter was supplied (the badge reads "N of M match" only then). */
  filtered: boolean;
  /** Echo of the request's mode. */
  strict: boolean;
  candidates: CandidateSearchRowDto[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/** `GET /payer/candidates/filters` — the options the filter controls offer. */
export interface CandidateFiltersDto {
  roles: (LabelledIdDto & { industryId: string })[];
  industries: LabelledIdDto[];
  experienceBuckets: LabelledIdDto[];
  /** Cities the eligible pool actually records (gazetteer-canonical), A→Z. */
  cities: string[];
  maxRoles: number;
}
