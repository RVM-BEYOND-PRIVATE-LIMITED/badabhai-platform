import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One referred worker's ENGAGEMENT row. No name, no phone, no employer, no job. */
export interface AgencyWorkerEngagementRow {
  /** The raw worker uuid. NEVER returned — the service pseudonymizes it per-agency. */
  workerId: string;
  /** Has a confirmed profile. The agency's own funnel signal. */
  profileComplete: boolean;
  /** How many jobs he APPLIED to. Not which. */
  appliedCount: number;
  /** How many times a paying party unlocked him. Not who. */
  unlockedCount: number;
  /** Coarse UTC day as `YYYY-MM-DD`, or null when never active. Never a time. */
  lastActiveOn: string | null;
}

/**
 * B5 — the AGENCY ENGAGEMENT read (ADR-0022 portal).
 *
 * THE CONSENT GATE LIVES IN THE SQL, NOT ABOVE IT. The `EXISTS` on
 * `worker_consents` is part of the join, so a worker without an ACTIVE
 * `agent_activity_visibility` consent is not filtered out late — he is never
 * selected at all. A gate applied after the fact is one refactor away from being
 * dropped; this one cannot be, because removing it changes the result set
 * visibly and the test below asserts the count.
 *
 * SCOPE: `inviter_payer_id = :payerId` is the tenancy predicate. An agency sees
 * only workers IT referred, and only via `agency_invites` rows it owns.
 *
 * WHAT IS DELIBERATELY NOT SELECTED: `workers.full_name_enc`, `phone_hash`,
 * `job_postings.org_label`, and the ids of the jobs applied to. The projection
 * cannot leak them because it never reads them — the same discipline as the V1
 * feed repository.
 */
@Injectable()
export class AgencyWorkersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Engagement rows for workers this agency referred AND who consented to the
   * agency seeing their activity. Newest-active first; unbounded lists are
   * capped by the caller.
   */
  async listReferredWithConsent(
    payerId: string,
    limit: number,
  ): Promise<AgencyWorkerEngagementRow[]> {
    const rows = await this.db.execute<{
      worker_id: string;
      profile_complete: boolean;
      applied_count: string;
      unlocked_count: string;
      last_active_on: string | null;
    }>(sql`
      SELECT
        ai.invited_worker_id                                   AS worker_id,
        EXISTS (
          -- profile_status, NOT status: worker_profiles names this column
          -- differently from every sibling table, so wp.status would have failed
          -- only at runtime. Caught by replaying this query against a real cluster.
          SELECT 1 FROM worker_profiles wp
          WHERE wp.worker_id = ai.invited_worker_id
            AND wp.profile_status = 'confirmed'
        )                                                      AS profile_complete,
        (
          SELECT count(*) FROM applications a
          WHERE a.worker_id = ai.invited_worker_id AND a.action = 'applied'
        )                                                      AS applied_count,
        (
          -- ('granted','revealed'), NOT 'granted' alone: the status advances IN
          -- PLACE when a payer reveals, so a granted-then-revealed unlock no
          -- longer reads as 'granted'. Counting only 'granted' would undercount
          -- exactly the unlocks that went furthest. Same predicate the unlocks
          -- repository already uses for the contact cap.
          SELECT count(*) FROM unlocks u
          WHERE u.worker_id = ai.invited_worker_id
            AND u.status IN ('granted', 'revealed')
        )                                                      AS unlocked_count,
        (
          -- COARSE: the DAY, never a timestamp. "Last seen Tuesday" is the product
          -- signal; an exact minute would let an agency infer a shift pattern,
          -- which is surveillance rather than engagement.
          --
          -- FORMATTED IN SQL, IN UTC, ON PURPOSE. date_trunc('day', ts) truncates
          -- in the SESSION timezone and returns a timestamptz — so on an IST server
          -- it yields 2026-07-29T00:00+05:30, which is 2026-07-28T18:30Z, and a
          -- downstream toISOString().slice(0,10) then renders the PREVIOUS day.
          -- Measured, not theorised: the first replay of this query returned exactly
          -- that. Returning the string from SQL removes the round-trip that could
          -- shift it, so the day means the same thing wherever the server runs.
          SELECT to_char(
            date_trunc('day', max(wd.last_seen_at) AT TIME ZONE 'UTC'),
            'YYYY-MM-DD'
          )
          FROM worker_devices wd
          WHERE wd.worker_id = ai.invited_worker_id AND wd.revoked_at IS NULL
        )                                                      AS last_active_on
      FROM agency_invites ai
      WHERE ai.inviter_payer_id = ${payerId}
        AND ai.invited_worker_id IS NOT NULL
        -- THE DPDP GATE (invariant #6). Latest consent row per worker must be
        -- unrevoked AND carry the purpose. A worker who consented under an older
        -- notice simply never carries it, so he is never selected.
        AND EXISTS (
          SELECT 1
          FROM worker_consents wc
          WHERE wc.worker_id = ai.invited_worker_id
            AND wc.revoked_at IS NULL
            -- jsonb_exists(...), not the question-mark operator: that character is
            -- ALSO a bind placeholder in several drivers, so the operator form is a
            -- portability hazard inside a template that already interpolates params.
            -- Identical semantics (top-level key/element existence), no ambiguity.
            AND jsonb_exists(wc.purposes, 'agent_activity_visibility')
            AND wc.accepted_at = (
              SELECT max(wc2.accepted_at) FROM worker_consents wc2
              WHERE wc2.worker_id = ai.invited_worker_id
            )
        )
      ORDER BY last_active_on DESC NULLS LAST, ai.invited_worker_id ASC
      LIMIT ${limit}
    `);

    // Same narrowing the match-feed repository does: drizzle's `execute` result is
    // not a plain array at the type level, so the row shape is re-asserted here.
    const list = rows as unknown as {
      worker_id: string;
      profile_complete: boolean;
      // Postgres count() is bigint, which the driver may hand back as a string.
      applied_count: string | number;
      unlocked_count: string | number;
      last_active_on: string | null;
    }[];

    return list.map((r) => ({
      workerId: r.worker_id,
      profileComplete: r.profile_complete,
      appliedCount: Number(r.applied_count),
      unlockedCount: Number(r.unlocked_count),
      // Already `YYYY-MM-DD` in UTC from SQL — no Date round-trip to shift it.
      lastActiveOn: r.last_active_on,
    }));
  }
}
