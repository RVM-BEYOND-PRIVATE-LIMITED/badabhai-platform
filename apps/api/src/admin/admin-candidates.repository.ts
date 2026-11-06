import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql as dsql,
  type SQL,
} from "drizzle-orm";
import {
  adminCandidateIndex,
  type AdminCandidateIndexRow,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type {
  AdminCandidateSearchDto,
  CandidateSearchSort,
} from "./admin-candidates.dto";

/** Facet columns — all nullable text labels on the index row. */
type FacetColumn =
  | typeof adminCandidateIndex.status
  | typeof adminCandidateIndex.tradeLabel
  | typeof adminCandidateIndex.currentCity
  | typeof adminCandidateIndex.profileStatus;

/**
 * DB reads for `POST /admin/candidates/search` (B5, #2559). SELECT-ONLY,
 * explicit projections, one shared WHERE across the page, the exact total,
 * the identity-match count and the facets — so the counts describe the rows.
 *
 * NEVER PROJECTED: `phone_hash`, `name_token_hashes`, `name_token_key_id`
 * (lookup material — pinned by `admin-static-guards.test.ts`) and anything
 * the index never stored (names, phones). No business logic: term
 * classification (phone vs name vs labels) and token computation happen in the
 * service; this file only renders predicates.
 */
export interface CandidateSearchInput {
  filters: NonNullable<AdminCandidateSearchDto["filters"]>;
  /** Folded, LIKE-escaped label fragment, or null for no text branch. */
  textLike: string | null;
  /** Exact phone hash to match, or null for no phone branch. */
  phoneHash: string | null;
  /** Whole-word name token hashes (ALL must be present), or null for no name branch. */
  nameHashes: string[] | null;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface CandidateSearchResult {
  /** The explicit projection — lookup material omitted by construction. */
  rows: Omit<
    AdminCandidateIndexRow,
    "phoneHash" | "nameTokenHashes" | "nameTokenKeyId" | "searchDoc" | "projectedAt"
  >[];
  total: number;
  /** Rows matching via an identity branch (phone OR name) — the audited match_count. */
  identityMatches: number;
  byStatus: { value: string; count: number }[];
  byTrade: { value: string; count: number }[];
  byCity: { value: string; count: number }[];
  byProfileStatus: { value: string; count: number }[];
}

const SORT_COLUMNS = {
  last_active_at: adminCandidateIndex.lastActiveAt,
  created_at: adminCandidateIndex.createdAt,
  updated_at: adminCandidateIndex.updatedAt,
  total_experience_years: adminCandidateIndex.totalExperienceYears,
  role_experience_months: adminCandidateIndex.roleExperienceMonths,
  ai_cost_inr: adminCandidateIndex.aiCostInr,
  resume_count: adminCandidateIndex.resumeCount,
  current_city: adminCandidateIndex.currentCity,
  current_state: adminCandidateIndex.currentState,
  status: adminCandidateIndex.status,
  trade_label: adminCandidateIndex.tradeLabel,
  role_label: adminCandidateIndex.roleLabel,
  domain_label: adminCandidateIndex.domainLabel,
  profile_status: adminCandidateIndex.profileStatus,
  salary_min_inr: adminCandidateIndex.salaryMinInr,
  salary_max_inr: adminCandidateIndex.salaryMaxInr,
  availability_status: adminCandidateIndex.availabilityStatus,
  shift_preference: adminCandidateIndex.shiftPreference,
  form_level: adminCandidateIndex.formLevel,
  education_level: adminCandidateIndex.educationLevel,
} as const;

/**
 * The sort allow-list as the repository serves it — exported for the parity
 * test against the DTO enum (a drifted pair 400s a legal sort or orders by an
 * unlisted column).
 */
export const CANDIDATE_SEARCH_SORT_KEYS = Object.keys(SORT_COLUMNS).sort();

/**
 * Render a `text[]` literal from individually bound elements (`ARRAY[$1,$2]`).
 * A JS array must NOT be bound as a single param into raw SQL — the driver
 * sends it as scalar `text`, and `text[] @> text` fails (measured: the whole
 * perf battery aborted on the first name-token query). Values stay bound, so
 * no injection surface; empty input is rejected by callers (branches only run
 * with non-empty arrays).
 */
function textArray(values: string[]): SQL {
  return dsql`ARRAY[${dsql.join(
    values.map((v) => dsql`${v}`),
    dsql`, `,
  )}]`;
}

@Injectable()
export class AdminCandidatesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The filter predicate (WITHOUT the q branches) — shared by page/total/facets. */
  filtersWhere(filters: CandidateSearchInput["filters"]): SQL | undefined {
    const f = filters;
    const parts: SQL[] = [];
    if (f.status?.length) parts.push(inArray(adminCandidateIndex.status, f.status));
    if (f.trade_id?.length) parts.push(inArray(adminCandidateIndex.canonicalTradeId, f.trade_id));
    if (f.role_id?.length) parts.push(inArray(adminCandidateIndex.canonicalRoleId, f.role_id));
    if (f.min_experience_years !== undefined)
      parts.push(gte(adminCandidateIndex.totalExperienceYears, String(f.min_experience_years)));
    if (f.max_experience_years !== undefined)
      parts.push(lte(adminCandidateIndex.totalExperienceYears, String(f.max_experience_years)));
    if (f.role_experience_months_min !== undefined)
      parts.push(gte(adminCandidateIndex.roleExperienceMonths, f.role_experience_months_min));
    if (f.role_experience_months_max !== undefined)
      parts.push(lte(adminCandidateIndex.roleExperienceMonths, f.role_experience_months_max));
    if (f.state?.length) parts.push(inArray(adminCandidateIndex.currentState, f.state));
    if (f.city?.length) parts.push(inArray(adminCandidateIndex.currentCity, f.city));
    if (f.language?.length)
      parts.push(dsql`${adminCandidateIndex.languages} && ${textArray(f.language)}`);
    if (f.profile_status?.length)
      parts.push(inArray(adminCandidateIndex.profileStatus, f.profile_status));
    if (f.has_resume !== undefined)
      parts.push(
        f.has_resume ? gt(adminCandidateIndex.resumeCount, 0) : eq(adminCandidateIndex.resumeCount, 0),
      );
    if (f.last_active_from !== undefined)
      parts.push(gte(adminCandidateIndex.lastActiveAt, new Date(f.last_active_from)));
    if (f.last_active_to !== undefined)
      parts.push(lte(adminCandidateIndex.lastActiveAt, new Date(f.last_active_to)));
    if (f.registered_from !== undefined)
      parts.push(gte(adminCandidateIndex.createdAt, new Date(f.registered_from)));
    if (f.registered_to !== undefined)
      parts.push(lte(adminCandidateIndex.createdAt, new Date(f.registered_to)));
    if (f.deletion_scheduled !== undefined)
      parts.push(
        f.deletion_scheduled
          ? isNotNull(adminCandidateIndex.deletionScheduledAt)
          : isNull(adminCandidateIndex.deletionScheduledAt),
      );
    if (f.flagged !== undefined) parts.push(eq(adminCandidateIndex.flagged, f.flagged));
    if (f.is_test_account !== undefined)
      parts.push(eq(adminCandidateIndex.isTestAccount, f.is_test_account));
    if (f.form_level?.length) parts.push(inArray(adminCandidateIndex.formLevel, f.form_level));
    return parts.length > 0 ? and(...parts) : undefined;
  }

  /** The q OR-branches (text OR phone OR name) — undefined when no branch runs. */
  searchWhere(input: Pick<CandidateSearchInput, "textLike" | "phoneHash" | "nameHashes">): SQL | undefined {
    const branches: SQL[] = [];
    if (input.textLike !== null) branches.push(ilike(adminCandidateIndex.searchDoc, input.textLike));
    if (input.phoneHash !== null) branches.push(eq(adminCandidateIndex.phoneHash, input.phoneHash));
    if (input.nameHashes !== null && input.nameHashes.length > 0)
      branches.push(dsql`${adminCandidateIndex.nameTokenHashes} @> ${textArray(input.nameHashes)}`);
    return branches.length > 0 ? or(...branches) : undefined;
  }

  /** The identity-only branches (phone OR name) — for the audited match count. */
  identityWhere(input: Pick<CandidateSearchInput, "phoneHash" | "nameHashes">): SQL | undefined {
    const branches: SQL[] = [];
    if (input.phoneHash !== null) branches.push(eq(adminCandidateIndex.phoneHash, input.phoneHash));
    if (input.nameHashes !== null && input.nameHashes.length > 0)
      branches.push(dsql`${adminCandidateIndex.nameTokenHashes} @> ${textArray(input.nameHashes)}`);
    return branches.length > 0 ? or(...branches) : undefined;
  }

  private combinedWhere(input: CandidateSearchInput): SQL | undefined {
    const filters = this.filtersWhere(input.filters);
    const search = this.searchWhere(input);
    if (filters && search) return and(filters, search);
    return filters ?? search;
  }

  async search(input: CandidateSearchInput): Promise<CandidateSearchResult> {
    const where = this.combinedWhere(input);
    const orderCol = SORT_COLUMNS[input.sort];
    const orderPrimary = input.dir === "asc" ? asc(orderCol) : desc(orderCol);
    // Stable tiebreaker: `worker_id` always ASC, so concurrent inserts never
    // reorder two rows that tie on the sort column.
    //
    // EXPLICIT projection — never a bare `.select()`: the lookup material
    // (`phone_hash`, `name_token_hashes`, `name_token_key_id`) and the folded
    // `search_doc` are filter-only and must never be selected into a response
    // (pinned by `admin-static-guards.test.ts`).
    const page = this.db
      .select({
        workerId: adminCandidateIndex.workerId,
        status: adminCandidateIndex.status,
        flagged: adminCandidateIndex.flagged,
        isTestAccount: adminCandidateIndex.isTestAccount,
        deletionScheduledAt: adminCandidateIndex.deletionScheduledAt,
        employerSharingConsent: adminCandidateIndex.employerSharingConsent,
        currentCity: adminCandidateIndex.currentCity,
        currentState: adminCandidateIndex.currentState,
        canonicalTradeId: adminCandidateIndex.canonicalTradeId,
        canonicalRoleId: adminCandidateIndex.canonicalRoleId,
        jobDomainId: adminCandidateIndex.jobDomainId,
        tradeLabel: adminCandidateIndex.tradeLabel,
        roleLabel: adminCandidateIndex.roleLabel,
        domainLabel: adminCandidateIndex.domainLabel,
        totalExperienceYears: adminCandidateIndex.totalExperienceYears,
        roleExperienceMonths: adminCandidateIndex.roleExperienceMonths,
        salaryMinInr: adminCandidateIndex.salaryMinInr,
        salaryMaxInr: adminCandidateIndex.salaryMaxInr,
        salaryPeriod: adminCandidateIndex.salaryPeriod,
        availabilityStatus: adminCandidateIndex.availabilityStatus,
        shiftPreference: adminCandidateIndex.shiftPreference,
        formLevel: adminCandidateIndex.formLevel,
        skills: adminCandidateIndex.skills,
        languages: adminCandidateIndex.languages,
        educationLevel: adminCandidateIndex.educationLevel,
        resumeCount: adminCandidateIndex.resumeCount,
        latestResumeStatus: adminCandidateIndex.latestResumeStatus,
        latestResumeVersion: adminCandidateIndex.latestResumeVersion,
        profileStatus: adminCandidateIndex.profileStatus,
        profileSource: adminCandidateIndex.profileSource,
        appVersion: adminCandidateIndex.appVersion,
        lastActiveAt: adminCandidateIndex.lastActiveAt,
        createdAt: adminCandidateIndex.createdAt,
        updatedAt: adminCandidateIndex.updatedAt,
        aiCostInr: adminCandidateIndex.aiCostInr,
        referralSource: adminCandidateIndex.referralSource,
      })
      .from(adminCandidateIndex)
      .where(where)
      .orderBy(orderPrimary, asc(adminCandidateIndex.workerId))
      .limit(input.limit)
      .offset(input.offset);

    const total = this.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(adminCandidateIndex)
      .where(where);

    const identity = this.identityWhere(input);
    const identityMatches = identity
      ? this.db
          .select({ n: dsql<number>`count(*)::int` })
          .from(adminCandidateIndex)
          .where(this.identityScopedWhere(input))
      : Promise.resolve([{ n: 0 }]);

    const [rows, totalRows, identityRows, byStatus, byTrade, byCity, byProfileStatus] =
      await Promise.all([
        page,
        total,
        identityMatches,
        this.facet(where, adminCandidateIndex.status),
        this.facet(where, adminCandidateIndex.tradeLabel),
        this.facet(where, adminCandidateIndex.currentCity),
        this.facet(where, adminCandidateIndex.profileStatus),
      ]);
    return {
      rows,
      total: totalRows[0]?.n ?? 0,
      identityMatches: identityRows[0]?.n ?? 0,
      byStatus,
      byTrade,
      byCity,
      byProfileStatus,
    };
  }

  private identityScopedWhere(input: CandidateSearchInput): SQL | undefined {
    const filters = this.filtersWhere(input.filters);
    // Identity matches are counted within the FILTER set (filters apply, the
    // text branch does not) — "how many of these rows did the lookup match".
    const search = this.searchWhere({ textLike: null, phoneHash: input.phoneHash, nameHashes: input.nameHashes });
    if (filters && search) return and(filters, search);
    return filters ?? search;
  }

  private async facet(
    where: SQL | undefined,
    column: FacetColumn,
  ): Promise<{ value: string; count: number }[]> {
    const rows = await this.db
      .select({ value: column, count: dsql<number>`count(*)::int` })
      .from(adminCandidateIndex)
      .where(where)
      .groupBy(column)
      .orderBy(dsql`count(*) DESC`, column);
    return rows
      .filter((r) => r.value !== null)
      .map((r) => ({ value: r.value as string, count: r.count }));
  }
}
