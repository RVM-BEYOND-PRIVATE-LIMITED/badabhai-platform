/**
 * @badabhai/reach-engine — PLACEHOLDER ONLY.
 *
 * The Reach Engine (deterministic reach → rank → pace → protect → learn) is a
 * core Phase 2+ artifact. It is intentionally NOT implemented in Phase 1.
 * LLMs must never rank, reject, or decide matches — that is this engine's job
 * once built. This stub exists so the package boundary and call site are stable.
 */

export const REACH_ENGINE_NOT_IMPLEMENTED = "Reach Engine not implemented in Phase 1" as const;

export interface ScoreWorkerForJobInput {
  workerId: string;
  jobId: string;
}

export interface WorkerJobScore {
  workerId: string;
  jobId: string;
  score: number;
  reasons: string[];
}

/**
 * Placeholder. Throws until the Reach Engine is implemented in a later phase.
 * Do NOT add matching logic here in Phase 1.
 */
export function scoreWorkerForJob(_input: ScoreWorkerForJobInput): WorkerJobScore {
  throw new Error(REACH_ENGINE_NOT_IMPLEMENTED);
}
