import { Injectable } from "@nestjs/common";
import { ConsentRepository } from "../consent/consent.repository";
import { modelTrainingAllowed } from "../consent/model-training-gate";
import {
  LearnLabelsRepository,
  type LearnEventRow,
  type LearnIngestSummary,
} from "./learn-labels.repository";

/** The worker an event is about: every LEARN event carries `payload.worker_id`. */
function workerIdOf(ev: LearnEventRow): string | undefined {
  const id = ev.payload.worker_id;
  return typeof id === "string" ? id : undefined;
}

/**
 * LEARN label producer (migration 0091) — turns already-emitted spine events into the
 * durable per-impression training labels `@badabhai/reach-learn` needs.
 *
 * WHY A PRODUCER AT ALL. reach-learn's eval ran on synthetic data because nothing ever
 * captured real `feed.shown_v2` impressions together with what the worker did next.
 * The events exist; this service is the ONLY writer that joins them into
 * (worker, posting) → outcome labels with show-time context.
 *
 * ROUTING (one event name → one write shape):
 *   - feed.shown_v2        → INSERT a pending label row (outcome 'none').
 *   - application.submitted → resolve that pair's pending impressions to 'applied'.
 *   - application.skipped   → resolve to 'skipped' (+ coarse reason).
 * Anything else in the batch is counted as skipped and never touches the store.
 *
 * IDEMPOTENCY IS STRUCTURAL, NOT COORDINATED: impression inserts dedupe on the UNIQUE
 * impression_event_id; resolutions are guarded by resolved_at IS NULL. The sweep can
 * therefore re-read an overlapping window safely — at-least-once delivery collapses to
 * exactly-once state.
 *
 * PRIVACY: every field handled here is a registry-validated id/integer/boolean. No free
 * text exists on any of these payloads (the registry's `.strict()` schemas enforce it),
 * so no PII can enter this table even by accident.
 *
 * CONSENT (#2753 item 13, ADR-0018 D1). These labels exist to train reach-learn's calibrator, so
 * a worker's behaviour becomes a label only when `modelTrainingAllowed` says yes for him: his
 * latest consent row is live and names `model_training`. One read per batch; anyone else's events
 * write nothing and are counted `withheldNoConsent`. FAIL CLOSED: a failed consent read withholds
 * the whole batch. No worker has that consent yet, so an armed sweep writes no label today
 * (`LEARN_LABELS_ENABLED` cannot reach the production container anyway: compose does not
 * declare it).
 */
@Injectable()
export class LearnLabelsService {
  constructor(
    private readonly repo: LearnLabelsRepository,
    private readonly consents: ConsentRepository,
  ) {}

  /**
   * One producer tick: ingest + resolve one bounded batch after the cursor watermark,
   * then advance the watermark over the batch's LAST event (never past it).
   */
  async processBatch(batchLimit: number): Promise<LearnIngestSummary> {
    const summary: LearnIngestSummary = {
      impressionsIngested: 0,
      submittedResolved: 0,
      skippedResolved: 0,
      skippedEvents: 0,
      withheldNoConsent: 0,
    };

    const fromMs = await this.repo.getWatermark();
    const batch = await this.repo.readEventBatch(fromMs, batchLimit);
    if (batch.length === 0) return summary;

    // ONE consent read for the batch's workers, before any write.
    const ids = batch.map(workerIdOf).filter((id): id is string => id !== undefined);
    const mayTrain = await modelTrainingAllowed(this.consents, ids);

    let highWaterMs = fromMs;
    for (const ev of batch) {
      highWaterMs = Math.max(highWaterMs, ev.createdAt.getTime());
      const workerId = workerIdOf(ev);
      if (workerId === undefined || !mayTrain.has(workerId)) {
        // Not his yes to give a label: nothing written. The cursor still moves past it, so a
        // consent given later is never applied to behaviour from before it.
        summary.withheldNoConsent += 1;
        continue;
      }
      let handled = true;
      switch (ev.eventName) {
        case "feed.shown_v2":
          if (await this.repo.ingestImpression(ev)) summary.impressionsIngested += 1;
          break;
        case "application.submitted":
          if (await this.repo.resolvePending(ev, "applied")) summary.submittedResolved += 1;
          else handled = false;
          break;
        case "application.skipped":
          if (await this.repo.resolvePending(ev, "skipped")) summary.skippedResolved += 1;
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (!handled) {
        // Not applicable: a legacy-shaped application event, or a payload the validator
        // would never have emitted. Counted, never written.
        summary.skippedEvents += 1;
      }
    }

    await this.repo.setWatermark(highWaterMs);
    return summary;
  }

  /** Dry-run report — counts only, writes nothing. */
  async countPending(): Promise<number> {
    return this.repo.countRelevantAfter(await this.repo.getWatermark());
  }

  /**
   * Safety net for the offline consumer: an application event whose (worker, posting)
   * has NO prior impression still resolves nothing here — reach-learn's dataset treats
   * applications as membership anyway, and inventing an impression row post-hoc would
   * fabricate a rank that was never served. This method exists so a reader of the code
   * finds the DECISION, documented, instead of wondering whether the case was missed.
   */
  explainUnhandledApplication(_ev: LearnEventRow): string {
    return (
      "applications without a matching pending impression stay unprojected: " +
      "reach-learn reads them as set membership directly from `applications`; " +
      "this table only owns IMPRESSION-context labels."
    );
  }
}
