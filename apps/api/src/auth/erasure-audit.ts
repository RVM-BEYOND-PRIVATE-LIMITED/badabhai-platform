/**
 * The evidence that a DSAR erasure actually HAPPENED — TD58's "provably", as a pure value.
 *
 * WHAT WAS MISSING. `worker.account_deleted` already records that deletion was REQUESTED and how
 * many objects two aggregate counters saw. The 2026-08-07 owner ruling re-scoped TD58 to
 * *"delete on request, provably"*, and provably means being able to answer, per erasure, WHICH
 * stores were swept, what each one was asked to delete, and what it reported back.
 *
 * THE THREE OUTCOMES THIS EXISTS TO SEPARATE, which were previously the same silence:
 *
 *   - `deleted`            — the store reported objects removed.
 *   - `nothing_to_delete`  — the sweep ran and there was nothing there. An empty bucket is a
 *                            legitimate result for a worker who never recorded anything.
 *   - `failed`             — the store errored. Indistinguishable from the one above in the
 *                            counters, and the ONLY one that means the worker's data may still
 *                            exist. It must never be reported as success.
 *   - `skipped`            — the leg never ran, because its bucket is unconfigured
 *                            (WIRED-BUT-DORMANT). Distinct from `nothing_to_delete` on purpose:
 *                            "we looked and it was empty" and "we never looked" are different
 *                            claims, and only one of them is evidence.
 *
 * PURE, AND SEPARATE FROM THE SERVICE, so the rules that decide an erasure was incomplete can be
 * tested without a database, a bucket, or a Redis — and so the one place that decides "did this
 * erasure succeed" cannot quietly disagree with the counters emitted beside it.
 *
 * NO RAW PII, AND NO OBJECT KEYS. `AccountDeletionService`'s own contract is that
 * *"resume object keys NEVER enter the event, logs, ai_jobs, or audit_logs"*, and a legacy
 * `voice_notes.storage_path` is client-supplied text that predates the minted-key shape guard —
 * neither belongs in a durable record. What is recorded instead is the TARGET the leg swept: a
 * prefix derived from the worker id (which the row is already keyed by), or the literal
 * `by-row` for the loops that read paths out of the database. That is "the prefix and/or keys
 * attempted" answered on the safe side of the ambiguity.
 */

/** Which store this leg swept. A closed set, so a new leg cannot arrive unnamed. */
export type ErasureLeg =
  | "resume_objects"
  | "voice_objects"
  | "voice_prefix"
  | "photo_prefix"
  // #1191 — the images a worker attached to a feedback submission. Its own leg rather than a
  // second target under `photo_prefix`: they live in a DIFFERENT bucket (a face photo and a
  // photograph of a broken screen are different sensitivity classes), the two are armed by
  // different env vars, and a DSAR record that fused them could report a sweep that only one
  // of the two buckets actually received.
  | "feedback_attachment_prefix"
  | "conversation_prefix"
  | "transcript_buffer";

export type ErasureOutcome = "deleted" | "nothing_to_delete" | "failed" | "skipped";

export interface ErasureLegRecord {
  readonly leg: ErasureLeg;
  /** The prefix swept, or `by-row` — never an object key. See the module header. */
  readonly target: string;
  /** How many deletions were attempted. For a prefix sweep the store decides, so this is 1. */
  readonly attempted: number;
  /** What the storage API reported actually removed. */
  readonly deleted: number;
  readonly outcome: ErasureOutcome;
}

/** The whole erasure's storage evidence, as it lands in `audit_logs.metadata`. */
export interface ErasureAudit {
  /**
   * `failed` if ANY leg failed — fail closed. An erasure with one dead bucket is not a
   * successful erasure with a footnote; it is an erasure that may have left the worker's audio
   * in a bucket, and the row has to say so in the field a reader will actually look at.
   */
  readonly outcome: ErasureOutcome;
  readonly objects_deleted: number;
  readonly objects_failed: number;
  readonly legs: readonly ErasureLegRecord[];
}

/**
 * Accumulate one leg at a time, then read the verdict.
 *
 * The service records a leg immediately after attempting it, so a throw between legs cannot
 * silently produce a record claiming a leg succeeded.
 */
export class ErasureAuditBuilder {
  private readonly legs: ErasureLegRecord[] = [];

  /** A leg that ran. `deleted` is what the store reported; 0 means there was nothing there. */
  swept(leg: ErasureLeg, target: string, attempted: number, deleted: number): void {
    this.legs.push({
      leg,
      target,
      attempted,
      deleted,
      outcome: deleted > 0 ? "deleted" : "nothing_to_delete",
    });
  }

  /** A leg that errored. `deleted` is what it managed before failing, which may be non-zero. */
  failed(leg: ErasureLeg, target: string, attempted: number, deleted = 0): void {
    this.legs.push({ leg, target, attempted, deleted, outcome: "failed" });
  }

  /** A leg that never ran — an unconfigured bucket. Recorded so the gap is visible, not implied. */
  skipped(leg: ErasureLeg, target: string): void {
    this.legs.push({ leg, target, attempted: 0, deleted: 0, outcome: "skipped" });
  }

  build(): ErasureAudit {
    const objects_deleted = this.legs.reduce((sum, leg) => sum + leg.deleted, 0);
    const objects_failed = this.legs.filter((leg) => leg.outcome === "failed").length;
    return {
      // FAIL CLOSED, and in that order: a single failure outranks every success. `skipped` legs
      // do not make an erasure incomplete — an unconfigured bucket holds nothing to erase — but
      // an erasure where every leg was skipped or empty is `nothing_to_delete`, not `deleted`.
      outcome:
        objects_failed > 0 ? "failed" : objects_deleted > 0 ? "deleted" : "nothing_to_delete",
      objects_deleted,
      objects_failed,
      legs: this.legs,
    };
  }
}
