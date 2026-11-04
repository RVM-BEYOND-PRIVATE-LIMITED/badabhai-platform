/**
 * The id namespaces of the two SEEDED candidate cohorts — and, from them, what a SAMPLE candidate is.
 *
 *   - the synthetic workforce (#2149, `seed-synthetic-workforce.ts`): 250 workers, ids `face…`;
 *   - the payer demo (#2651, `seed-payer-demo-candidates.ts`): 480 workers, 30 per postable
 *     trade, ids `be16…`, seeded on production 2026-11-03 so the payer surfaces had candidates.
 *
 * WHY THIS LIVES OUTSIDE THE SEEDS. The seeds mint these ids; the API must recognise them at run
 * time (R74, owner ruling 2026-11-04): seeded workers are in the payers' all-candidates search
 * because they hold `employer_sharing`, but they are not people, so their cards are badged
 * "Sample candidate" and unlocking one is refused before any credit moves. One module owns both
 * namespaces so a writer and the reader cannot drift apart.
 *
 * Valid hex only ("face", "be16"): a UUID cannot carry a literal word with non-hex letters, and an
 * earlier prefix that tried silently produced invalid UUIDs. Disjoint from each other, from the
 * demo seed's "de30…" and from the reach seed's "5eed…". Layout mirrors `demoUuid`.
 */
export const WORKFORCE_ID_PREFIX = "face";

const WORKFORCE_KIND_TAG = {
  payer: "10",
  worker: "20",
  profile: "21",
  consent: "22",
  posting: "30",
} as const;

export type WorkforceIdKind = keyof typeof WORKFORCE_KIND_TAG;

export function workforceUuid(kind: WorkforceIdKind, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`workforceUuid: bad index ${index}`);
  return `${WORKFORCE_ID_PREFIX}${WORKFORCE_KIND_TAG[kind]}00-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** SQL `LIKE` pattern matching every workforce-seed id of one kind (and nothing else). */
export function workforceIdLikePattern(kind: WorkforceIdKind): string {
  return `${WORKFORCE_ID_PREFIX}${WORKFORCE_KIND_TAG[kind]}00-0000-4000-8000-%`;
}

/** The payer-demo cohort's prefix (#2651). Same layout as the workforce's. */
export const PAYER_DEMO_ID_PREFIX = "be16";

const PAYER_DEMO_KIND_TAG = {
  worker: "20",
  profile: "21",
  consent: "22",
} as const;

export type PayerDemoIdKind = keyof typeof PAYER_DEMO_KIND_TAG;

export function payerDemoUuid(kind: PayerDemoIdKind, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`payerDemoUuid: bad index ${index}`);
  return `${PAYER_DEMO_ID_PREFIX}${PAYER_DEMO_KIND_TAG[kind]}00-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** SQL `LIKE` pattern matching every payer-demo id of one kind (and nothing else). */
export function payerDemoIdLikePattern(kind: PayerDemoIdKind): string {
  return `${PAYER_DEMO_ID_PREFIX}${PAYER_DEMO_KIND_TAG[kind]}00-0000-4000-8000-%`;
}

/** Exactly the worker ids {@link workforceUuid} mints: `face2000-0000-4000-8000-<12 hex>`. */
const WORKFORCE_WORKER_ID = new RegExp(
  `^${WORKFORCE_ID_PREFIX}${WORKFORCE_KIND_TAG.worker}00-0000-4000-8000-[0-9a-f]{12}$`,
  "i",
);

/** Exactly the worker ids {@link payerDemoUuid} mints: `be162000-0000-4000-8000-<12 hex>`. */
const PAYER_DEMO_WORKER_ID = new RegExp(
  `^${PAYER_DEMO_ID_PREFIX}${PAYER_DEMO_KIND_TAG.worker}00-0000-4000-8000-[0-9a-f]{12}$`,
  "i",
);

/**
 * R74 — is this worker a SAMPLE candidate (a seeded row from either cohort, not a person)?
 *
 * A pure id test, no database read. A real worker id is a random v4 UUID, which cannot start with
 * either fixed 24-character prefix except by chance far below any practical rate.
 */
export function isSampleWorkerId(workerId: string): boolean {
  return WORKFORCE_WORKER_ID.test(workerId) || PAYER_DEMO_WORKER_ID.test(workerId);
}
