import type { WorkerConsent } from "@badabhai/db";
import type { ConsentPurpose } from "@badabhai/types";
import { uuidSchema } from "@badabhai/validators";

/**
 * The consent purpose that lets a worker's data improve a model (ADR-0018 Decision 1). A distinct
 * purpose, never implied by `profiling`; the worker app asks for it on its own line (#2748).
 */
export const MODEL_TRAINING_PURPOSE = "model_training" as const satisfies ConsentPurpose;

/**
 * What the gate reads: each worker's LATEST consent row, `purposes` and `revokedAt` only.
 * `ConsentRepository.findLatestStatesByWorkers` satisfies it in one query for a whole batch.
 */
export interface LatestConsentStatesReader {
  findLatestStatesByWorkers(
    workerIds: readonly string[],
  ): Promise<ReadonlyMap<string, Pick<WorkerConsent, "purposes" | "revokedAt">>>;
}

/** The one rule: the latest row is not revoked and names `model_training`. Anything else is no. */
function grants(latest: Pick<WorkerConsent, "purposes" | "revokedAt"> | undefined): boolean {
  if (!latest) return false;
  // Strictly null: a missing or malformed `revokedAt` is an unknown answer, and unknown is no.
  if (latest.revokedAt !== null) return false;
  return Array.isArray(latest.purposes) && latest.purposes.includes(MODEL_TRAINING_PURPOSE);
}

/**
 * MAY THIS WORKER'S DATA BE USED TO IMPROVE A MODEL? (#2753 item 13, ADR-0018 D1.)
 *
 * THE ONE GATE for every use of a worker's chat or profiling transcripts, answers or behaviour
 * labels to train, tune or evaluate a model: a training export, an eval corpus built from real
 * workers, the LEARN label producer. True only when the worker's LATEST `worker_consents` row is
 * not revoked AND carries `model_training` in its purposes. The rule is `ConsentGuard`'s latest-row
 * rule (ADR-0010) and the ai-service corpus gate's (`apps/ai-service/app/corpus/consent_gate.py`).
 *
 * FAILS CLOSED. No reader, an id that is not a uuid, no row, a revoked row, no `model_training`, a
 * malformed row, or a read that throws: every one of them is "no". No worker has given this
 * consent yet (the app has never asked, ADR-0051 R36), so today the answer is "no" for everyone.
 *
 * Two shapes, one read:
 *   - `modelTrainingAllowed(reader, workerId)` → boolean;
 *   - `modelTrainingAllowed(reader, workerIds)` → the set of the ids that may be used, from ONE
 *     query, so a batch job never asks per row. An id absent from the set may not be used.
 *
 * A static test (`model-training-gate.static.test.ts`) fails when a file that reads worker text or
 * labels for a learn, export, corpus or eval purpose does not call this.
 */
export function modelTrainingAllowed(
  reader: LatestConsentStatesReader | undefined,
  workerId: string,
): Promise<boolean>;
export function modelTrainingAllowed(
  reader: LatestConsentStatesReader | undefined,
  workerIds: readonly string[],
): Promise<ReadonlySet<string>>;
export async function modelTrainingAllowed(
  reader: LatestConsentStatesReader | undefined,
  idOrIds: string | readonly string[],
): Promise<boolean | ReadonlySet<string>> {
  const asked = typeof idOrIds === "string" ? [idOrIds] : idOrIds;
  const allowed = await allowedOf(reader, asked);
  return typeof idOrIds === "string" ? allowed.has(idOrIds) : allowed;
}

async function allowedOf(
  reader: LatestConsentStatesReader | undefined,
  asked: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!reader) return new Set();
  // Only well-formed ids reach the query: one malformed id must not fail the whole batch's read
  // (it is simply not allowed), and nothing unparsed is interpolated into SQL.
  const ids = [...new Set(asked)].filter((id) => uuidSchema.safeParse(id).success);
  if (ids.length === 0) return new Set();
  try {
    const latest = await reader.findLatestStatesByWorkers(ids);
    return new Set(ids.filter((id) => grants(latest.get(id))));
  } catch {
    return new Set();
  }
}
