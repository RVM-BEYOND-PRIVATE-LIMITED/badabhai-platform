/**
 * The synthetic-workforce seed's id namespace (#2149) — and, from it, what a SAMPLE candidate is.
 *
 * WHY THIS LIVES OUTSIDE THE SEED. The seed (`seed-synthetic-workforce.ts`) mints these ids; the
 * API must recognise them at run time (R74, owner ruling 2026-11-04): the 250 seeded workers are in
 * the payers' all-candidates search because they hold `employer_sharing`, but they are not people,
 * so their cards are badged "Sample candidate" and unlocking one is refused before any credit
 * moves. One module owns the namespace so the writer and the reader cannot drift apart.
 *
 * Valid hex only ("face"): a UUID cannot carry a literal word with non-hex letters, and an earlier
 * prefix that tried silently produced invalid UUIDs. Disjoint from the demo seed's "de30…" and the
 * reach seed's "5eed…". Layout mirrors `demoUuid`.
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

/** Exactly the worker ids {@link workforceUuid} mints: `face2000-0000-4000-8000-<12 hex>`. */
const SAMPLE_WORKER_ID = new RegExp(
  `^${WORKFORCE_ID_PREFIX}${WORKFORCE_KIND_TAG.worker}00-0000-4000-8000-[0-9a-f]{12}$`,
  "i",
);

/**
 * R74 — is this worker a SAMPLE candidate (a synthetic-workforce seed row, not a person)?
 *
 * A pure id test, no database read. A real worker id is a random v4 UUID, which cannot start with
 * this fixed 24-character prefix except by chance far below any practical rate.
 */
export function isSampleWorkerId(workerId: string): boolean {
  return SAMPLE_WORKER_ID.test(workerId);
}
