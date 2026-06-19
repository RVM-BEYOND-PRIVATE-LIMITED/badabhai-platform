/**
 * PACE supply-widening queue (ADR-0021). PACE is the FIRST delayed/scheduled-job
 * consumer of the live BullMQ wiring — each wave is a job enqueued with a `delay`
 * (the 6–24h cadence). The processor re-evaluates and (if still thin) schedules the
 * next wave. Job data is FACELESS: the opaque job_id + correlation/request ids only.
 */
export const PACE_QUEUE = "pace-waves";

/** The job name for a single PACE wave on the queue. */
export const PACE_WAVE_JOB = "pace-wave";

/** Faceless payload for a scheduled PACE wave — opaque ids only, never PII. */
export interface PaceWaveJobData {
  jobId: string;
  correlationId: string;
  requestId: string;
}
