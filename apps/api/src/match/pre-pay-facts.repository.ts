import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import { CURRENT_PROFILE_ORDER, type Database } from "@badabhai/db";
import { BRIEF_CONTACT_NOTICE_VERSIONS } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** The salary attributes the card reads (`worker_attributes`, one live row per key). */
const SALARY_ATTRIBUTE_KEYS = [
  "salary_expected_min",
  "salary_expected_max",
  "salary_period",
] as const;

/** The worker's active institute link (#2752): the source label, and an RVM student's course. */
export interface ActiveInstituteLinkRow {
  workerId: string;
  instituteCode: string;
  course: string | null;
  branch: string | null;
}

/** One worker's raw pre-pay inputs. `fullNameEnc` is CIPHERTEXT; the service decrypts it. */
export interface PrePayFactsRawRow {
  workerId: string;
  fullNameEnc: string | null;
  workersCity: string | null;
  canonicalTradeId: string | null;
  canonicalRoleId: string | null;
  machineIds: unknown;
  salaryContainer: unknown;
  salaryExpectedMin: number | null;
  salaryExpectedMax: number | null;
  salaryPeriod: string | null;
  lastSeenAt: Date | string | null;
  /**
   * His LATEST consent row is unrevoked and lists `employer_sharing` — the search pool's rule
   * (`consentingWorkers`): a tie on `accepted_at` must pass on every tied row. False with no row.
   */
  employerSharing: boolean;
  /**
   * #2747 (ADR-0064 §3.8) — that same latest row was given on a notice that DESCRIBES the facts
   * shown before paying (`BRIEF_CONTACT_NOTICE_VERSIONS`). False on the 2026-11-04 notice, which
   * tells him his name is not shown before an unlock.
   */
  onBriefNotice: boolean;
}

/**
 * The batched reads behind the pre-pay facts and the source label (#2747 items 1 and 4).
 *
 * Membership is decided upstream (applied to an owned posting, or in the search pool), so these
 * reads never filter and never gate: every id handed in gets a row, and a worker with nothing
 * stored gets nulls. One statement per source table, run as one parallel wave per page.
 *
 * PROJECTION IS THE PRIVACY BOUNDARY. Each select names its columns. The only personal column is
 * the encrypted `full_name`, which leaves here as ciphertext; no phone, e-mail, address, photo key,
 * employer name or free-text field is selected.
 */
@Injectable()
export class PrePayFactsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Active links only — an unlinked or withdrawn student is a BadaBhai worker again. */
  async listActiveInstituteLinks(workerIds: readonly string[]): Promise<ActiveInstituteLinkRow[]> {
    const ids = [...new Set(workerIds)];
    if (ids.length === 0) return [];
    const rows = await this.db.execute<{
      worker_id: string;
      institute_code: string;
      course: string | null;
      branch: string | null;
    }>(dsql`
      SELECT il.worker_id, il.institute_code, il.course, il.branch
      FROM worker_institute_links il
      WHERE il.worker_id = ANY(${dsql.param(ids)}::uuid[])
        AND il.status = 'active'
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      workerId: String(r.worker_id),
      instituteCode: String(r.institute_code),
      course: typeof r.course === "string" ? r.course : null,
      branch: typeof r.branch === "string" ? r.branch : null,
    }));
  }

  async listForWorkers(
    workerIds: readonly string[],
    opts: { readonly briefNoticeVersions?: readonly string[] } = {},
  ): Promise<PrePayFactsRawRow[]> {
    const briefVersions = [...(opts.briefNoticeVersions ?? BRIEF_CONTACT_NOTICE_VERSIONS)];
    const ids = [...new Set(workerIds)];
    if (ids.length === 0) return [];
    const [workers, profiles, attributes, seen] = await Promise.all([
      this.db.execute<{
        id: string;
        full_name: string | null;
        current_city: string | null;
        employer_sharing: boolean | null;
        on_brief_notice: boolean | null;
      }>(dsql`
        SELECT w.id, w.full_name, w.current_city,
               (
                 SELECT bool_and(
                   c.revoked_at IS NULL AND c.purposes @> '["employer_sharing"]'::jsonb
                 )
                 FROM worker_consents c
                 WHERE c.worker_id = w.id
                   AND c.accepted_at = (
                     SELECT max(c2.accepted_at) FROM worker_consents c2 WHERE c2.worker_id = w.id
                   )
               ) IS TRUE AS employer_sharing,
               (
                 SELECT bool_and(
                   c.revoked_at IS NULL
                   AND c.purposes @> '["employer_sharing"]'::jsonb
                   AND c.consent_version = ANY(${dsql.param(briefVersions)}::text[])
                 )
                 FROM worker_consents c
                 WHERE c.worker_id = w.id
                   AND c.accepted_at = (
                     SELECT max(c2.accepted_at) FROM worker_consents c2 WHERE c2.worker_id = w.id
                   )
               ) IS TRUE AS on_brief_notice
        FROM workers w
        WHERE w.id = ANY(${dsql.param(ids)}::uuid[])
      `),
      this.db.execute<{
        worker_id: string;
        canonical_trade_id: string | null;
        canonical_role_id: string | null;
        machines: unknown;
        salary_expectation: unknown;
      }>(dsql`
        SELECT DISTINCT ON (worker_profiles.worker_id)
          worker_profiles.worker_id AS worker_id,
          worker_profiles.canonical_trade_id AS canonical_trade_id,
          worker_profiles.canonical_role_id AS canonical_role_id,
          worker_profiles.machines AS machines,
          worker_profiles.salary_expectation AS salary_expectation
        FROM worker_profiles
        WHERE worker_profiles.worker_id = ANY(${dsql.param(ids)}::uuid[])
        ORDER BY worker_profiles.worker_id, ${dsql.join([...CURRENT_PROFILE_ORDER], dsql`, `)}
      `),
      this.db.execute<{
        worker_id: string;
        attribute_key: string;
        value_number: string | number | null;
        value_text: string | null;
      }>(dsql`
        SELECT worker_id, attribute_key, value_number, value_text
        FROM worker_attributes
        WHERE worker_id = ANY(${dsql.param(ids)}::uuid[])
          AND attribute_key = ANY(${dsql.param([...SALARY_ATTRIBUTE_KEYS])}::text[])
      `),
      this.db.execute<{ worker_id: string; last_seen_at: Date | string | null }>(dsql`
        SELECT worker_id, MAX(last_seen_at) AS last_seen_at
        FROM worker_devices
        WHERE worker_id = ANY(${dsql.param(ids)}::uuid[])
        GROUP BY worker_id
      `),
    ]);

    const byWorker = new Map<string, PrePayFactsRawRow>();
    for (const workerId of ids) {
      byWorker.set(workerId.toLowerCase(), {
        workerId,
        fullNameEnc: null,
        workersCity: null,
        canonicalTradeId: null,
        canonicalRoleId: null,
        machineIds: null,
        salaryContainer: null,
        salaryExpectedMin: null,
        salaryExpectedMax: null,
        salaryPeriod: null,
        lastSeenAt: null,
        employerSharing: false,
        onBriefNotice: false,
      });
    }
    // Keyed in lower case: Postgres prints a uuid that way, and the ids handed in may not be.
    const at = (workerId: unknown): PrePayFactsRawRow | undefined =>
      typeof workerId === "string" ? byWorker.get(workerId.toLowerCase()) : undefined;

    for (const w of workers as unknown as Array<Record<string, unknown>>) {
      const row = at(w.id);
      if (!row) continue;
      row.fullNameEnc = nonBlank(w.full_name);
      row.workersCity = nonBlank(w.current_city);
      row.employerSharing = w.employer_sharing === true;
      row.onBriefNotice = w.on_brief_notice === true;
    }
    for (const p of profiles as unknown as Array<Record<string, unknown>>) {
      const row = at(p.worker_id);
      if (!row) continue;
      row.canonicalTradeId = nonBlank(p.canonical_trade_id);
      row.canonicalRoleId = nonBlank(p.canonical_role_id);
      row.machineIds = p.machines;
      row.salaryContainer = p.salary_expectation;
    }
    for (const a of attributes as unknown as Array<Record<string, unknown>>) {
      const row = at(a.worker_id);
      if (!row) continue;
      if (a.attribute_key === "salary_expected_min")
        row.salaryExpectedMin = numberOrNull(a.value_number);
      else if (a.attribute_key === "salary_expected_max")
        row.salaryExpectedMax = numberOrNull(a.value_number);
      else if (a.attribute_key === "salary_period") row.salaryPeriod = nonBlank(a.value_text);
    }
    for (const s of seen as unknown as Array<Record<string, unknown>>) {
      const row = at(s.worker_id);
      if (!row) continue;
      const v = s.last_seen_at;
      row.lastSeenAt = v instanceof Date || typeof v === "string" ? v : null;
    }
    return [...byWorker.values()];
  }
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** `numeric` arrives as a string from the driver. */
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
