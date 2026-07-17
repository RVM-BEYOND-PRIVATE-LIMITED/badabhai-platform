import { Injectable, NotFoundException } from "@nestjs/common";
import type { JobNeededBy, JobShift, TradeKey } from "@badabhai/db";
import { JobsRepository } from "./jobs.repository";

/**
 * Wire shape of the worker-visible job detail — EXACTLY the ADR-0024
 * final-addendum (2026-07-16) SHOW set: title, city/area, the pay band AS STORED
 * (band columns, never an exact salary), the experience window, needed_by, and
 * the four worker-visible content columns (description / shift / benefits /
 * requirements — write-guarded fail-closed, so no PII/employer name can be in
 * them). Nulls are passed through HONESTLY — a null field is absent data the
 * client simply hides; it is never fabricated (same doctrine as the FeedItem
 * experience window). NEVER carries `payer_id`, `status`, or applicant counts —
 * employer identity stays off the worker path ENTIRELY (the ruling is stricter
 * than Option 3: not even a masked descriptor).
 */
export interface WorkerVisibleJob {
  job_id: string;
  trade_key: TradeKey;
  title: string;
  city: string;
  area: string | null;
  pay_min: number | null;
  pay_max: number | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  needed_by: JobNeededBy | null;
  shift: JobShift | null;
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
}

/**
 * Worker-scoped job detail read (ADR-0024 final addendum, 2026-07-16 — the
 * ruling of record for TD53). Business logic only: repo → neutral 404 → explicit
 * wire projection. DISTINCT from the ops `GET /job-postings/:id`, which exposes
 * the employer org label and remains FORBIDDEN on the worker path.
 */
@Injectable()
export class JobsService {
  constructor(private readonly repo: JobsRepository) {}

  /**
   * Fetch the worker-visible projection of ONE open job.
   *
   * NEUTRAL 404 (the XB-A/F-3 precedent, cf. `AgencyService.getOwnJob`): the
   * message never echoes the id, and an unknown id and a CLOSED job are
   * byte-identical — the repository's `status='open'` WHERE folds both into
   * `undefined`, so there is no closed-vs-unknown oracle.
   *
   * NO EVENT EMISSION — load-bearing, per the ADR-0024 final addendum §"Event
   * ruling": this is a pure read of already-served content. The impression was
   * already evented by `feed.shown` when `/feed` served the card, and the
   * material state change that may follow (apply) emits `application.submitted`.
   * Reusing `feed.shown` for detail renders was considered and REJECTED — its
   * payload requires a positive 1-based feed position (`rank`), which a detail
   * render does not have; emitting a fake rank would corrupt the impression
   * spine, and mutating the shipped payload schema is barred by §2.8. If
   * detail-view analytics are wanted later, that is a NEW versioned event, not a
   * repurposed one.
   */
  async getWorkerVisibleJob(jobId: string): Promise<WorkerVisibleJob> {
    const row = await this.repo.findWorkerVisibleJobById(jobId);
    if (!row) throw new NotFoundException("Job not found");
    return {
      job_id: row.id,
      trade_key: row.tradeKey,
      title: row.title,
      city: row.city,
      area: row.area,
      pay_min: row.payMin,
      pay_max: row.payMax,
      min_experience_years: row.minExperienceYears,
      max_experience_years: row.maxExperienceYears,
      needed_by: row.neededBy,
      shift: row.shift,
      description: row.description,
      benefits: row.benefits,
      requirements: row.requirements,
    };
  }
}
