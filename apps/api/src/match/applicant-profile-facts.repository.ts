import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import { CURRENT_PROFILE_ORDER, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { EDUCATION_QUALIFICATIONS } from "../profiles/worker-preferences.vocabulary";
import type { ApplicantProfileFactsSourceRow } from "./applicant-profile-facts";

/** Closed credentials, lowest rung first — the "highest" schooling a worker holds. */
const EDUCATION_ORDER = new Map(
  Object.keys(EDUCATION_QUALIFICATIONS).map((slug, i) => [slug, i] as const),
);

/**
 * One batched read of non-contact profile facts for payer applicant rows (#2736).
 *
 * Six statements in one parallel wave over the workers already on a payer's list —
 * membership is decided upstream (applied, not pending deletion, owned posting), so this
 * read never filters and never gates: every listed worker gets a row, and a worker with
 * no stored signal gets nulls instead of dropping out (sort-never-block).
 *
 * FACELESS BY PROJECTION. The select lists name every column; nothing else enters the
 * result set, so no name, phone, email, address, employer name, licence, photo key or
 * free-text field (certificate/issuer/training/institute names, work descriptions) can
 * reach the wire, a log or an event — the PII simply is not selected
 * (CLAUDE.md §2: fail closed by projection, never by mapping).
 *
 * CURRENT-PROFILE DISCIPLINE. The profile and rung reads resolve through the shared
 * `CURRENT_PROFILE_ORDER` tail — the same total order the live path and the reach
 * signal read use — so the card reads the same profile the worker's own page shows.
 */
@Injectable()
export class ApplicantProfileFactsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listForWorkers(workerIds: readonly string[]): Promise<ApplicantProfileFactsSourceRow[]> {
    const ids = [...new Set(workerIds)];
    if (ids.length === 0) return [];
    const [profiles, education, certificates, industry, rungs, seen] = await Promise.all([
      this.db.execute<{
        worker_id: string;
        skills: unknown;
        experience: unknown;
        availability: unknown;
      }>(dsql`
        SELECT DISTINCT ON (worker_profiles.worker_id)
          worker_profiles.worker_id AS worker_id,
          worker_profiles.skills AS skills,
          worker_profiles.experience AS experience,
          worker_profiles.availability AS availability
        FROM worker_profiles
        WHERE worker_profiles.worker_id = ANY(${dsql.param([...ids])}::uuid[])
        ORDER BY worker_profiles.worker_id, ${dsql.join([...CURRENT_PROFILE_ORDER], dsql`, `)}
      `),
      this.db.execute<{ worker_id: string; credential: string | null }>(dsql`
        SELECT worker_id, credential
        FROM worker_education
        WHERE worker_id = ANY(${dsql.param([...ids])}::uuid[])
        ORDER BY worker_id, sort_order
      `),
      this.db.execute<{ worker_id: string; count: string }>(dsql`
        SELECT worker_id, COUNT(*) AS count
        FROM worker_certificate
        WHERE worker_id = ANY(${dsql.param([...ids])}::uuid[])
        GROUP BY worker_id
      `),
      this.db.execute<{ worker_id: string; months: string | null }>(dsql`
        SELECT worker_id, MAX(calendar_months) AS months
        FROM worker_industry_tenure
        WHERE worker_id = ANY(${dsql.param([...ids])}::uuid[])
        GROUP BY worker_id
      `),
      this.db.execute<{
        worker_id: string;
        skill_id: string;
        trade_level: string | null;
        level_confirmed: boolean | null;
      }>(dsql`
        SELECT DISTINCT ON (worker_profiles.worker_id, worker_profile_skill.skill_id)
          worker_profiles.worker_id AS worker_id,
          worker_profile_skill.skill_id AS skill_id,
          worker_profile_skill.trade_level AS trade_level,
          worker_profile_skill.level_confirmed AS level_confirmed
        FROM worker_profile_skill
        INNER JOIN worker_profiles ON worker_profiles.id = worker_profile_skill.worker_profile_id
        WHERE worker_profiles.worker_id = ANY(${dsql.param([...ids])}::uuid[])
        ORDER BY worker_profiles.worker_id, worker_profile_skill.skill_id, ${dsql.join([...CURRENT_PROFILE_ORDER], dsql`, `)}
      `),
      this.db.execute<{ worker_id: string; last_seen_at: Date | string | null }>(dsql`
        SELECT worker_id, MAX(last_seen_at) AS last_seen_at
        FROM worker_devices
        WHERE worker_id = ANY(${dsql.param([...ids])}::uuid[])
        GROUP BY worker_id
      `),
    ]);

    const byWorker = new Map<string, ApplicantProfileFactsSourceRow>();
    const at = (workerId: string): ApplicantProfileFactsSourceRow => {
      let row = byWorker.get(workerId);
      if (!row) {
        row = {
          workerId,
          skillIds: null,
          totalYears: null,
          availabilityStatus: null,
          educationCredential: null,
          certificateCount: 0,
          industryMonths: null,
          tradeLevels: [],
          lastSeenAt: null,
        };
        byWorker.set(workerId, row);
      }
      return row;
    };

    for (const workerId of ids) at(workerId);
    const credentialsByWorker = new Map<string, string[]>();
    const pushCredential = (workerId: string, credential: string) => {
      const list = credentialsByWorker.get(workerId);
      if (list) list.push(credential);
      else credentialsByWorker.set(workerId, [credential]);
    };
    for (const p of profiles as unknown as Array<{
      worker_id: string;
      skills: unknown;
      experience: unknown;
      availability: unknown;
    }>) {
      const row = at(p.worker_id);
      row.skillIds = p.skills;
      row.totalYears = readTotalYears(p.experience);
      row.availabilityStatus = readAvailabilityStatus(p.availability);
    }
    for (const e of education as unknown as Array<{ worker_id: string; credential: unknown }>) {
      if (typeof e.credential !== "string") continue;
      pushCredential(e.worker_id, e.credential);
    }
    for (const [workerId, slugs] of credentialsByWorker) {
      // Highest closed credential wins; an unknown slug never outranks a known one, and the
      // first unknown slug is kept so the field is honestly non-null.
      const ranked = slugs
        .map((s) => ({ slug: s, rank: EDUCATION_ORDER.get(s) ?? -1 }))
        .sort((a, b) => a.rank - b.rank);
      const known = ranked.filter((r) => r.rank !== -1);
      at(workerId).educationCredential = (known.at(-1) ?? ranked[0])!.slug;
    }
    for (const c of certificates as unknown as Array<{ worker_id: string; count: unknown }>) {
      at(c.worker_id).certificateCount = Number(c.count) || 0;
    }
    for (const t of industry as unknown as Array<{ worker_id: string; months: unknown }>) {
      const months = t.months === null ? null : Number(t.months);
      at(t.worker_id).industryMonths =
        months === null || !Number.isFinite(months) || months < 0 ? null : months;
    }
    for (const r of rungs as unknown as Array<{
      worker_id: string;
      skill_id: unknown;
      trade_level: unknown;
      level_confirmed: unknown;
    }>) {
      if (typeof r.trade_level !== "string" || r.trade_level === "") continue;
      if (typeof r.skill_id !== "string") continue;
      if (typeof r.worker_id !== "string") continue;
      at(r.worker_id).tradeLevels.push({
        skillId: r.skill_id,
        tradeLevel: r.trade_level,
        levelConfirmed: r.level_confirmed === true,
      });
    }
    for (const s of seen as unknown as Array<{ worker_id: string; last_seen_at: unknown }>) {
      const v = s.last_seen_at;
      at(s.worker_id).lastSeenAt =
        (v instanceof Date || typeof v === "string" ? v : null) ?? null;
    }
    return [...byWorker.values()];
  }
}

/** `experience` JSONB → `total_years`, or null for anything missing/unparseable. */
function readTotalYears(experience: unknown): number | null {
  if (typeof experience !== "object" || experience === null || Array.isArray(experience)) {
    return null;
  }
  const years = (experience as Record<string, unknown>).total_years;
  return typeof years === "number" && Number.isFinite(years) ? years : null;
}

/** `availability` JSONB → the worker's own status slug, or null. */
function readAvailabilityStatus(availability: unknown): string | null {
  if (typeof availability !== "object" || availability === null || Array.isArray(availability)) {
    return null;
  }
  const status = (availability as Record<string, unknown>).status;
  return typeof status === "string" && status.trim() !== "" ? status : null;
}
