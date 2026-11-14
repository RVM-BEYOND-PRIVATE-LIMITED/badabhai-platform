import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql, type SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * DB access for the payer's ALL-CANDIDATES search (`POST /payer/candidates/search`, ADR-0040,
 * phase E2). Read-only. No statement here selects an identity column (`full_name`, `phone_e164`,
 * `photo_storage_key`, employment rows, résumé, expected pay): the projection is the first
 * masking layer, the service's row builder the second. The pool is sourced from `worker_skill`,
 * never from a profile row (E2_BUILD; E2_CHECK item 8).
 *
 * ── THE POOL (ADR-0040 §6 — MEMBERSHIP, NOT FILTERS) ────────────────────────────────────────
 * A worker is in the population — and in `total` — only when ALL of these hold, in every mode:
 *   - his LATEST consent row (max `accepted_at`) is unrevoked AND lists `employer_sharing` — and
 *     when several rows tie on that instant, EVERY tied row must pass, so the search can never be
 *     wider than the unlock gate whichever tied row that gate happens to read. Latest-row
 *     semantics are load-bearing: the E0 exit APPENDS a newer row without `employer_sharing`
 *     rather than revoking the old one, so an `EXISTS` over all rows would keep an opted-out
 *     worker visible;
 *   - `deletion_scheduled_at IS NULL` (ADR-0031 ruling (b), the payer-surface freeze);
 *   - `status` is `pending` or `active` — an ALLOWLIST, so a suspended worker, and any status
 *     added later, fails closed;
 *   - he holds at least one `worker_skill` row with `wants = true` (ADR-0036 §1). A skill he
 *     turned off is invisible here: it can neither match a filter nor appear on his card;
 *   - he is NOT an actively linked institute student (#2752 item 9). His RVM consent covers only
 *     the companies he applies to, so he is out of search even on the day he also accepts
 *     BadaBhai's own consent in the worker app (issue question 2: hidden while the link is
 *     active). Without that consent he is already out (no row, no wanted skill); this is the
 *     second lock. Unflagged: the rule holds with the Campus link switched off.
 * NEVER WIDEN THIS TO MAKE ROWS APPEAR (E2_BUILD "THE EMPTY-RESULT TRAP"): a search that returns
 * a worker who never consented has already disclosed him.
 *
 * ── FILTERS: MATCH, UNRECORDED, NO (ADR-0040 §1, §2, §4) ────────────────────────────────────
 *   `filter_match` is TRUE when every supplied filter matched on a RECORDED value. A filter over
 *   an unrecorded value is neither a match nor a "no" — the row is counted in `unrecorded`, never
 *   in `matched`, and NEITHER mode excludes it. Strict mode drops only the definite "no"s.
 *   What counts as unrecorded:
 *     - role months of 0 and industry tenure of 0 (or no tenure row). The derivation writes 0 for
 *       "we do not know" (`bucketMonths(null)` → 0; a form-only worker has no total years), so a 0
 *       can never be read as a fresher match or an experienced "no";
 *     - a city that is NULL, or recorded but not one the gazetteer recognises (the card shows no
 *       city for it, so the count must not call it a "no" either).
 *   Role and industry are NOT NULL on every `worker_skill` row, so they are always recorded.
 *
 * ── THE ORDER (ADR-0040 §5) ────────────────────────────────────────────────────────────────
 *   filter_match DESC, then the ADR-0036 §2 rank key with the payer's role filter standing in
 *   for the posting's skills:
 *     effective tier ASC   (1 = holds an asked role, 2 = holds a RELATED one — promoted to 1 at
 *                           `tier_floor_months`, exactly `effectiveTier` — 3 = neither; 1 for
 *                           everyone when no role is asked)
 *     role months DESC     (`months_bucketed` of the lead role)
 *     industry months DESC (calendar months in the lead role's industry, floored to 6;
 *                           unrecorded last)
 *     last active DESC     (the spec's `last_active_at`: the UTC day of his latest unrevoked
 *                           device sighting or worker-row update)
 *     worker id ASC        (the spec's `stable_hash`: a total order, always)
 *   `last_worked_at` (the key's 4th term) is NULL for every worker at launch by design (coarse
 *   history), so it cannot order anyone and is omitted rather than compared as a constant.
 *   `filter_match` is a BOOLEAN from the payer's own request: never a score, never a gradient,
 *   and nothing a payer buys can reach it (ADR-0036 §7 fence (c)).
 *
 * ── THE LEAD ROLE ────────────────────────────────────────────────────────────────────────────
 *   Per worker, the ONE wanted skill the card leads with and every per-role fact is read from:
 *   an asked role first, else a related one, else any; within that, one in the filtered industry
 *   first; then the most months; then the skill id (deterministic).
 *
 * ── PAGING ──────────────────────────────────────────────────────────────────────────────────
 *   The six sort keys are computed in ASCENDING form (`k_*`). A page resumes strictly after the
 *   ANCHOR — the last worker served — at his CURRENT keys; if he has left the visible set, at
 *   position `served` of the current order (everyone after him moved up one place). The keys
 *   never leave the database (see the cursor's doc).
 */

/** The validated, service-resolved search inputs. Every list is closed-vocabulary. */
export interface CandidatePoolQuery {
  /** The asked roles; empty = no role filter. */
  skillIds: readonly string[];
  /** The asked roles' related skills, minus the asked roles themselves. */
  relatedSkillIds: readonly string[];
  /** `[min, max)` months on the lead role; null = no filter. */
  experience: { min: number; max: number | null } | null;
  industryId: string | null;
  /** `[min, max)` calendar months in the lead role's industry; null = no filter. */
  industryExperience: { min: number; max: number | null } | null;
  /**
   * The city filter, resolved against the pool's recorded spellings (lower-cased): `matchKeys`
   * canonicalise to the asked city; `unrecognisedKeys` canonicalise to nothing (unrecorded).
   * null = no city filter.
   */
  city: { matchKeys: readonly string[]; unrecognisedKeys: readonly string[] } | null;
  tierFloorMonths: number;
  strict: boolean;
  /** Resume after this worker (rows served so far as the fallback); null = from the top. */
  after: { workerId: string; served: number } | null;
  /** Rows to read (the service asks for one past the page). */
  limit: number;
  /**
   * ADR-0062 (#2560) — narrow the POOL to this one worker; absent = the whole pool, and the
   * statement is then byte-identical to the one the payer search runs. Membership, order and every
   * value stay the search's own: the admin candidate read uses it to show exactly the card an
   * employer would see (or that he is not in the pool at all), never a re-implementation of it.
   */
  onlyWorkerId?: string;
}

/** One candidate in the pool, before labelling. */
export interface CandidatePoolRow {
  workerId: string;
  /** ADR-0040 `filter_match`: every supplied filter matched on a recorded value. */
  matched: boolean;
  /** 1 holds an asked role · 2 holds a related one · 3 neither (always 1 with no role filter). */
  matchClass: 1 | 2 | 3;
  skillId: string;
  industryId: string;
  skillMonths: number;
  /** Floored to 6; null = not recorded (no tenure row, or the derivation's 0). */
  industryMonths: number | null;
  /** Trimmed raw `workers.current_city`; null = not recorded. */
  currentCity: string | null;
  /** 1-based position in the current order — what the next cursor's fallback resumes from. */
  position: number;
}

export interface CandidatePoolCounts {
  total: number;
  matched: number;
  unrecorded: number;
}

/** One wanted skill of a page worker, most months first. */
export interface CandidateRoleRow {
  workerId: string;
  skillId: string;
  monthsBucketed: number;
}

/**
 * The eligible pool's membership as a CTE body (`consenting`): worker id, trimmed city and the
 * worker row's `updated_at`. Shared by the search and the city facet so the two can never
 * disagree about who is in the population.
 */
function consentingWorkers(onlyWorkerId: string | null = null): SQL {
  const only =
    onlyWorkerId === null
      ? dsql``
      : dsql`
      AND w.id = ${onlyWorkerId}::uuid`;
  return dsql`
    SELECT w.id AS worker_id,
           NULLIF(btrim(w.current_city), '') AS current_city,
           w.updated_at
    FROM workers w
    WHERE w.deletion_scheduled_at IS NULL
      AND w.status IN ('pending', 'active')
      AND (
        SELECT bool_and(c.revoked_at IS NULL AND c.purposes @> '["employer_sharing"]'::jsonb)
        FROM worker_consents c
        WHERE c.worker_id = w.id
          AND c.accepted_at = (
            SELECT max(c2.accepted_at) FROM worker_consents c2 WHERE c2.worker_id = w.id
          )
      ) IS TRUE
      AND EXISTS (
        SELECT 1 FROM worker_skill ws0 WHERE ws0.worker_id = w.id AND ws0.wants
      )
      AND NOT EXISTS (
        SELECT 1 FROM worker_institute_links il
        WHERE il.worker_id = w.id AND il.status = 'active'
      )${only}`;
}

/** `[min, max)` over an int expression. */
function inRange(column: SQL, range: { min: number; max: number | null }): SQL {
  return range.max === null
    ? dsql`(${column} >= ${range.min}::int)`
    : dsql`(${column} >= ${range.min}::int AND ${column} < ${range.max}::int)`;
}

/**
 * A filter over a nullable value, three-valued: TRUE (a recorded match), FALSE (a recorded
 * "no"), NULL (unrecorded). Absent filter = TRUE.
 */
function nullableFilter(value: SQL, predicate: SQL | null): SQL {
  if (predicate === null) return dsql`TRUE`;
  return dsql`(CASE WHEN ${value} IS NULL THEN NULL ELSE ${predicate} END)`;
}

/** The search statement: the counts row, LEFT JOINed to the page (so counts always return). */
export function candidateSearchStatement(q: CandidatePoolQuery): SQL {
  const skills = dsql.param([...q.skillIds]);
  const related = dsql.param([...q.relatedSkillIds]);
  const roleFiltered = q.skillIds.length > 0;
  const industry = q.industryId;

  const matchClass = roleFiltered
    ? dsql`CASE
             WHEN ws.skill_id = ANY(${skills}::text[]) THEN 1
             WHEN ws.skill_id = ANY(${related}::text[]) THEN 2
             ELSE 3
           END`
    : dsql`1`;
  const industryPreference =
    industry === null ? dsql`` : dsql`(ws_industry_id = ${industry}::text) DESC,`;

  // Recorded-always filters: TRUE / FALSE.
  const fRole = roleFiltered ? dsql`(p.match_class = 1)` : dsql`TRUE`;
  // 0 role months is the derivation's "we do not know" — unrecorded, never a recorded value.
  const fExp = nullableFilter(
    dsql`NULLIF(p.skill_months, 0)`,
    q.experience === null ? null : inRange(dsql`p.skill_months`, q.experience),
  );
  const fIndustry = industry === null ? dsql`TRUE` : dsql`(p.industry_id = ${industry}::text)`;
  // Nullable filters: TRUE / FALSE / NULL.
  const fIndExp = nullableFilter(
    dsql`p.industry_months`,
    q.industryExperience === null ? null : inRange(dsql`p.industry_months`, q.industryExperience),
  );
  const fCity =
    q.city === null
      ? dsql`TRUE`
      : dsql`(CASE
          WHEN p.current_city IS NULL
            OR lower(p.current_city) = ANY(${dsql.param([...q.city.unrecognisedKeys])}::text[])
            THEN NULL
          ELSE lower(p.current_city) = ANY(${dsql.param([...q.city.matchKeys])}::text[])
        END)`;

  const strictOnly = q.strict ? dsql`WHERE k.verdict IS DISTINCT FROM FALSE` : dsql``;
  const after =
    q.after === null
      ? dsql`TRUE`
      : dsql`(
          (EXISTS (SELECT 1 FROM anchor)
             AND (v.k_match, v.k_tier, v.k_skill, v.k_industry, v.k_active, v.worker_id)
                 > (SELECT a.k_match, a.k_tier, a.k_skill, a.k_industry, a.k_active, a.worker_id
                    FROM anchor a))
          -- The anchor left: everyone after him moved up one place, so the row now at HIS old
          -- position is the next one unserved.
          OR (NOT EXISTS (SELECT 1 FROM anchor) AND v.ord >= ${q.after.served}::int)
        )`;
  const anchorWorker = q.after === null ? null : q.after.workerId;

  return dsql`
    WITH consenting AS (${consentingWorkers(q.onlyWorkerId ?? null)}),
    wanted AS (
      SELECT ws.worker_id, ws.skill_id, ws.industry_id AS ws_industry_id, ws.months_bucketed,
             ${matchClass} AS match_class
      FROM worker_skill ws
      JOIN consenting cw ON cw.worker_id = ws.worker_id
      WHERE ws.wants
    ),
    lead AS (
      SELECT DISTINCT ON (worker_id)
             worker_id, skill_id, ws_industry_id AS industry_id, months_bucketed, match_class
      FROM wanted
      ORDER BY worker_id, match_class ASC, ${industryPreference} months_bucketed DESC, skill_id ASC
    ),
    pool AS (
      SELECT l.worker_id, l.skill_id, l.industry_id, l.months_bucketed AS skill_months,
             l.match_class,
             CASE WHEN l.match_class = 2 AND l.months_bucketed >= ${q.tierFloorMonths}::int
                  THEN 1 ELSE l.match_class END AS eff_tier,
             -- 0 calendar months is the derivation's "we do not know" (unrecorded, like no row).
             CASE WHEN t.calendar_months IS NULL OR t.calendar_months = 0 THEN NULL
                  ELSE (t.calendar_months / 6) * 6 END AS industry_months,
             cw.current_city,
             GREATEST(cw.updated_at, d.last_seen_at) AS last_active_at
      FROM lead l
      JOIN consenting cw ON cw.worker_id = l.worker_id
      -- Tenure in the LEAD ROLE's industry — the one the card names. (With an industry filter the
      -- lead role is chosen from that industry whenever the worker holds one there.)
      LEFT JOIN worker_industry_tenure t
        ON t.worker_id = l.worker_id AND t.industry_id = l.industry_id
      LEFT JOIN LATERAL (
        SELECT max(wd.last_seen_at) AS last_seen_at
        FROM worker_devices wd
        WHERE wd.worker_id = l.worker_id AND wd.revoked_at IS NULL
      ) d ON TRUE
    ),
    judged AS (
      -- Three-valued AND: TRUE = every filter a recorded match · FALSE = a recorded "no" ·
      -- NULL = no "no", but at least one filter fell on an unrecorded value.
      SELECT p.*, (${fRole} AND ${fExp} AND ${fIndustry} AND ${fIndExp} AND ${fCity}) AS verdict
      FROM pool p
    ),
    keyed AS (
      SELECT j.*,
             (CASE WHEN j.verdict IS TRUE THEN 0 ELSE 1 END) AS k_match,
             j.eff_tier AS k_tier,
             (- j.skill_months) AS k_skill,
             (- COALESCE(j.industry_months, -1)) AS k_industry,
             (- extract(epoch FROM date_trunc('day', j.last_active_at AT TIME ZONE 'UTC')))::bigint
               AS k_active
      FROM judged j
    ),
    counts AS (
      SELECT count(*)::int AS total,
             (count(*) FILTER (WHERE verdict IS TRUE))::int AS matched,
             (count(*) FILTER (WHERE verdict IS NULL))::int AS unrecorded
      FROM keyed
    ),
    visible AS (
      SELECT k.*,
             (row_number() OVER (
               ORDER BY k.k_match, k.k_tier, k.k_skill, k.k_industry, k.k_active, k.worker_id
             ))::int AS ord
      FROM keyed k
      ${strictOnly}
    ),
    anchor AS (
      SELECT k_match, k_tier, k_skill, k_industry, k_active, worker_id
      FROM visible
      WHERE worker_id = ${anchorWorker}::uuid
    ),
    page AS (
      SELECT v.* FROM visible v
      WHERE ${after}
      ORDER BY v.ord
      LIMIT ${q.limit}::int
    )
    SELECT c.total, c.matched, c.unrecorded,
           p.worker_id, p.verdict, p.match_class, p.skill_id, p.industry_id, p.skill_months,
           p.industry_months, p.current_city, p.ord
    FROM counts c
    LEFT JOIN page p ON TRUE
    ORDER BY p.ord
  `;
}

type SearchSqlRow = {
  total: number | string;
  matched: number | string;
  unrecorded: number | string;
  worker_id: string | null;
  verdict: boolean | null;
  match_class: number | string | null;
  skill_id: string | null;
  industry_id: string | null;
  skill_months: number | string | null;
  industry_months: number | string | null;
  current_city: string | null;
  ord: number | string | null;
};

@Injectable()
export class CandidateSearchRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The counts and one page of the pool, in the search order. */
  async searchPool(
    q: CandidatePoolQuery,
  ): Promise<{ counts: CandidatePoolCounts; rows: CandidatePoolRow[] }> {
    const raw = (await this.db.execute<SearchSqlRow>(
      candidateSearchStatement(q),
    )) as unknown as SearchSqlRow[];
    const head = raw[0];
    // The counts CTE always yields exactly one row; none at all is a defect, never data.
    if (!head) throw new Error("candidate search: the counts row is missing");
    const counts: CandidatePoolCounts = {
      total: toInt(head.total),
      matched: toInt(head.matched),
      unrecorded: toInt(head.unrecorded),
    };
    const rows = raw.filter((r) => r.worker_id !== null).map(toPoolRow);
    return { counts, rows };
  }

  /**
   * ONE worker's unfiltered search row — the card an employer's all-candidates search would serve
   * for him — or null when he is not in the eligible pool (ADR-0062, #2560, the admin candidate
   * read). The search statement itself, narrowed by {@link CandidatePoolQuery.onlyWorkerId}, with
   * no filter engaged: so the lead role, the floored industry months and the trimmed city are the
   * search's own values, and pool membership is the search's own rule.
   *
   * `tierFloorMonths` is inert here: it only promotes a RELATED role, and with no role asked every
   * row is class 1.
   */
  async findCardRow(workerId: string): Promise<CandidatePoolRow | null> {
    const { rows } = await this.searchPool({
      skillIds: [],
      relatedSkillIds: [],
      experience: null,
      industryId: null,
      industryExperience: null,
      city: null,
      tierFloorMonths: 0,
      strict: false,
      after: null,
      limit: 1,
      onlyWorkerId: workerId,
    });
    return rows[0] ?? null;
  }

  /** Every trimmed raw city the eligible pool records — the city facet's source. */
  async listPoolCities(): Promise<string[]> {
    const rows = (await this.db.execute<{ city: string }>(dsql`
      WITH consenting AS (${consentingWorkers()})
      SELECT DISTINCT current_city AS city FROM consenting WHERE current_city IS NOT NULL
    `)) as unknown as { city: string }[];
    return rows.map((r) => r.city);
  }

  /** The page workers' WANTED skills, most months first (the card's other roles). */
  async listWantedRoles(workerIds: readonly string[]): Promise<CandidateRoleRow[]> {
    if (workerIds.length === 0) return [];
    const rows = (await this.db.execute<{
      worker_id: string;
      skill_id: string;
      months_bucketed: number | string;
    }>(dsql`
      SELECT ws.worker_id, ws.skill_id, ws.months_bucketed
      FROM worker_skill ws
      WHERE ws.worker_id = ANY(${dsql.param([...workerIds])}::uuid[])
        AND ws.wants
      ORDER BY ws.worker_id, ws.months_bucketed DESC, ws.skill_id ASC
    `)) as unknown as { worker_id: string; skill_id: string; months_bucketed: number | string }[];
    return rows.map((r) => ({
      workerId: r.worker_id,
      skillId: r.skill_id,
      monthsBucketed: toInt(r.months_bucketed),
    }));
  }
}

function toInt(value: number | string | null): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`candidate search: non-integer ${String(value)}`);
  return n;
}

function toClass(value: number | string | null): 1 | 2 | 3 {
  const n = toInt(value);
  if (n === 1 || n === 2 || n === 3) return n;
  throw new Error(`candidate search: unexpected class ${String(value)}`);
}

function toPoolRow(r: SearchSqlRow): CandidatePoolRow {
  // Non-null by the page filter above; every NOT NULL source column is asserted, never defaulted.
  if (r.worker_id === null || r.skill_id === null || r.industry_id === null || r.ord === null) {
    throw new Error("candidate search: a page row is missing a required column");
  }
  return {
    workerId: r.worker_id,
    matched: r.verdict === true,
    matchClass: toClass(r.match_class),
    skillId: r.skill_id,
    industryId: r.industry_id,
    skillMonths: toInt(r.skill_months),
    industryMonths: r.industry_months === null ? null : toInt(r.industry_months),
    currentCity: r.current_city,
    position: toInt(r.ord),
  };
}
