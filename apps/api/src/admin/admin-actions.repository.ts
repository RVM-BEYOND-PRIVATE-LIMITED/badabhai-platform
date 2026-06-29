import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  type Database,
  type JobPosting,
  type PayerStatus,
  type WorkerFlag,
  type WorkerFlagReasonCode,
  creditLedger,
  jobPostings,
  payerCredits,
  payers,
  workerFlags,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The outcome of a credit grant — the new balance + the ledger row id, plus whether THIS call
 * actually moved the balance (false on an idempotent replay of the same key). */
export interface GrantCreditsResult {
  ledgerId: string;
  balance: number;
  /** True when a new ledger row was inserted + the balance moved; false on a deduped replay. */
  applied: boolean;
}

/**
 * Data access for the ADMIN-3a governed entity actions (ADR-0025 Decision 3/5/6) — the
 * SYSTEM-OF-RECORD writes behind each admin mutation. EACH method writes the VALUE (the new
 * status, the credit delta, the flag reason CODE) to its SoR table; the emitted
 * `admin.action_performed` event (in {@link import("./admin-actions.service").AdminActionsService})
 * carries only the action CODE + opaque target id — never the value (CLAUDE.md invariant #2).
 *
 * SPINE READ-ONLY (must-fix #3): this repository NEVER touches the `events` table. Admin events
 * are emitted exclusively through EventsService.emit. PII-FREE: payers' contact PII stays
 * encrypted in `payers` and is never read here; worker identity stays in `workers` (the only
 * join is the opaque `worker_id`); the flag reason is a closed CODE, not free text.
 *
 * IDEMPOTENCY: every terminal transition is guarded on the current state IN THE WHERE — so a
 * redelivered/concurrent call matches no row and returns `undefined`, which the service treats
 * as an idempotent no-op (no duplicate event). No TOCTOU window between a read and the write.
 */
@Injectable()
export class AdminActionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Run `cb` inside one Drizzle transaction (must-fix H3) — the service uses this to commit a
   * SoR write + its `admin.action_performed` event atomically. The `tx` handed to `cb` is a
   * `Database`-shaped executor the write methods below + EventsService.emit accept.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  // ----- payers.status (suspend / reinstate) --------------------------------

  /** Fetch a payer's id + status only (no contact PII decrypted). undefined if gone. */
  async findPayerStatus(id: string): Promise<{ id: string; status: PayerStatus } | undefined> {
    const [row] = await this.db
      .select({ id: payers.id, status: payers.status })
      .from(payers)
      .where(eq(payers.id, id))
      .limit(1);
    return row;
  }

  /**
   * Transition a payer to a terminal status, guarded so a no-op transition (already in the
   * target status) matches NO row → returns undefined. `from`/`to` are the only allowed pair
   * the service passes. Returns the new status when the row actually changed. `tx` runs the
   * write on a caller-provided transaction (H3) so it commits with the event atomically.
   */
  private async transitionPayer(
    id: string,
    from: PayerStatus,
    to: PayerStatus,
    tx: Database = this.db,
  ): Promise<{ status: PayerStatus } | undefined> {
    const [row] = await tx
      .update(payers)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(payers.id, id), eq(payers.status, from)))
      .returning({ status: payers.status });
    return row;
  }

  /** active → suspended. undefined when not active (already suspended/pending = no-op). */
  suspendPayer(id: string, tx?: Database): Promise<{ status: PayerStatus } | undefined> {
    return this.transitionPayer(id, "active", "suspended", tx);
  }

  /** suspended → active. undefined when not suspended (already active/pending = no-op). */
  reinstatePayer(id: string, tx?: Database): Promise<{ status: PayerStatus } | undefined> {
    return this.transitionPayer(id, "suspended", "active", tx);
  }

  // ----- credit ledger (positive admin grant) -------------------------------

  /**
   * Append a POSITIVE admin-grant credit movement and materialize the balance, in ONE
   * transaction (mirrors the unlocks `creditPack` seam, reason='grant'). The AMOUNT lives on
   * the ledger row + balance (the SoR) — NEVER in the event. Returns the new balance + the
   * opaque ledger row id (the audit target). The CHECK (balance >= 0) holds (a grant is +ve).
   *
   * EXACTLY-ONCE (H2): the ledger insert is `ON CONFLICT (idempotency_key) DO NOTHING` and the
   * balance is bumped ONLY when a NEW ledger row was actually inserted. So a retry with the SAME
   * `idempotencyKey` inserts NO second row and moves the balance ZERO times — `applied:false`,
   * the existing balance + ledger id are returned. A genuinely new grant (new key) = one row +
   * one balance move = `applied:true`. The order (ledger first, then balance) is what binds the
   * dedup to the balance — there is no path where the balance moves without a new ledger row.
   *
   * `tx` lets a CALLER run this inside its own transaction (H3) so the SoR write + the event
   * emit commit atomically; default opens its own tx.
   */
  async grantCredits(
    payerId: string,
    amount: number,
    idempotencyKey: string,
    tx?: Database,
  ): Promise<GrantCreditsResult> {
    const run = <T>(cb: (e: Database) => Promise<T>): Promise<T> =>
      tx ? cb(tx) : this.db.transaction(cb as (e: unknown) => Promise<T>);
    return run(async (tx) => {
      // 1) Append the ledger movement, deduped on the opaque idempotency key. A replay of the
      //    same key inserts NO row and returns nothing (the SoR is the dedup authority).
      const [ledger] = await tx
        .insert(creditLedger)
        .values({ payerId, delta: amount, reason: "grant", idempotencyKey })
        .onConflictDoNothing({ target: creditLedger.idempotencyKey })
        .returning({ id: creditLedger.id });

      if (!ledger) {
        // Idempotent replay: the row already exists. Do NOT touch the balance. Return the
        // existing (already-applied) ledger id + the current balance.
        const [existingLedger] = await tx
          .select({ id: creditLedger.id })
          .from(creditLedger)
          .where(eq(creditLedger.idempotencyKey, idempotencyKey))
          .limit(1);
        const [cur] = await tx
          .select({ balance: payerCredits.balance })
          .from(payerCredits)
          .where(eq(payerCredits.payerId, payerId))
          .limit(1);
        if (!existingLedger) throw new Error("Failed to resolve idempotent credit grant");
        return { ledgerId: existingLedger.id, balance: cur?.balance ?? 0, applied: false };
      }

      // 2) A new ledger row WAS inserted → move the balance exactly once.
      const [bal] = await tx
        .insert(payerCredits)
        .values({ payerId, balance: amount })
        .onConflictDoUpdate({
          target: payerCredits.payerId,
          set: { balance: sql`${payerCredits.balance} + ${amount}`, updatedAt: sql`now()` },
        })
        .returning({ balance: payerCredits.balance });
      if (!bal) throw new Error("Failed to grant credits");
      return { ledgerId: ledger.id, balance: bal.balance, applied: true };
    });
  }

  // ----- job_postings.status (force close) ----------------------------------

  /** Fetch a posting's id + status only. undefined if gone. */
  async findPostingStatus(
    id: string,
  ): Promise<{ id: string; status: JobPosting["status"] } | undefined> {
    const [row] = await this.db
      .select({ id: jobPostings.id, status: jobPostings.status })
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);
    return row;
  }

  /**
   * Force a posting to `closed`, guarded on status != 'closed' so an already-closed posting
   * matches NO row → undefined (idempotent no-op). Returns the row id when it actually closed.
   * `tx` runs the write on a caller transaction (H3) so it commits with the event atomically.
   */
  async forceClosePosting(
    id: string,
    closedAt: Date,
    tx: Database = this.db,
  ): Promise<{ id: string } | undefined> {
    const [row] = await tx
      .update(jobPostings)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(and(eq(jobPostings.id, id), ne(jobPostings.status, "closed")))
      .returning({ id: jobPostings.id });
    return row;
  }

  // ----- worker_flags (flag / unflag) ---------------------------------------

  /** The worker's current OPEN flag (resolved_at IS NULL), or undefined. */
  async findOpenFlag(workerId: string): Promise<WorkerFlag | undefined> {
    const [row] = await this.db
      .select()
      .from(workerFlags)
      .where(and(eq(workerFlags.workerId, workerId), isNull(workerFlags.resolvedAt)))
      .limit(1);
    return row;
  }

  /**
   * Open a flag on a worker. IDEMPOTENT: the partial unique index `worker_flags_open_uq` allows
   * at most ONE open flag per worker, so a concurrent/repeat flag `ON CONFLICT DO NOTHING`s and
   * returns undefined (the existing open flag is left intact — the service treats it as a no-op).
   * The reason CODE lives on the ROW (the SoR), never in the event. Returns the new flag id.
   */
  async openFlag(
    workerId: string,
    reasonCode: WorkerFlagReasonCode,
    adminId: string,
    tx: Database = this.db,
  ): Promise<{ id: string } | undefined> {
    const [row] = await tx
      .insert(workerFlags)
      .values({ workerId, flagReasonCode: reasonCode, flaggedByAdminId: adminId })
      .onConflictDoNothing({ target: workerFlags.workerId, where: isNull(workerFlags.resolvedAt) })
      .returning({ id: workerFlags.id });
    return row;
  }

  /**
   * Resolve (unflag) the worker's open flag — stamp resolved_at + the resolving admin. Guarded
   * on resolved_at IS NULL so a worker with no open flag matches NO row → undefined (idempotent
   * no-op). Keeping the row (vs delete) is what makes flag → unflag → re-flag auditable.
   * Returns the resolved flag id when one was actually closed.
   */
  async resolveFlag(
    workerId: string,
    adminId: string,
    tx: Database = this.db,
  ): Promise<{ id: string } | undefined> {
    const now = new Date();
    const [row] = await tx
      .update(workerFlags)
      .set({ resolvedAt: now, resolvedByAdminId: adminId, updatedAt: now })
      .where(and(eq(workerFlags.workerId, workerId), isNull(workerFlags.resolvedAt)))
      .returning({ id: workerFlags.id });
    return row;
  }
}
