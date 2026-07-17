import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { UNLOCK_WINDOW_DAYS, type UnlockDenyReason, type RoutingChannel } from "@badabhai/db";
import { randomUUID } from "node:crypto";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  UnlocksRepository,
  type Tx,
  type UnlockProjection,
  type CreditLedgerItem,
} from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";
import {
  neutralUnavailable,
  type NeutralUnavailableResponse,
  type UnlockGrantedResponse,
  type ContactRevealedResponse,
} from "./unlock-response";

/** The disclosure consent purpose this gate keys on (DISTINCT from profiling). */
const EMPLOYER_SHARING = "employer_sharing";

/** Either the one distinguishable success, or the byte-identical neutral body (F-3). */
type UnlockOutcome = UnlockGrantedResponse | NeutralUnavailableResponse;
type RevealOutcome = ContactRevealedResponse | NeutralUnavailableResponse;

/**
 * A deferred event emission: a zero-arg thunk that closes over already-computed,
 * PII-FREE values (ids/enums/counts only) and calls `this.events.emit(...)`. We
 * collect these INSIDE the locked transaction but FIRE them only AFTER the
 * transaction commits — see {@link UnlockService} class doc (deadlock fix).
 */
type DeferredEmit = () => Promise<void>;

/** What a transaction step returns: the HTTP body + the events to emit post-commit. */
interface TxResult<R> {
  response: R;
  events: DeferredEmit[];
}

/**
 * UnlockService — the SINGLE fail-closed disclosure chokepoint (ADR-0010 §D4; the
 * {@link UnlockGuardService} of the contract). It is the ONLY writer of `unlocks` /
 * `unlock_routing` and the ONLY resolver of routing tokens (structural F-2/F-5/T5-b:
 * no other module imports {@link UnlocksRepository}). The raw phone is read here at
 * EXACTLY ONE step (reveal), transiently, and is NEVER returned, evented, logged, or
 * stored (F-5, CLAUDE.md invariant 2).
 *
 * FAIL-CLOSED ORDERING for POST /unlocks (every gate denies + discloses nothing on
 * failure):
 *   [F-1] credit precondition (worker-state INDEPENDENT) FIRST — a zero-credit payer
 *         gets the SAME neutral body regardless of any worker's state (closes the
 *         payment_required consent oracle, BC-1).
 *   [1]   employer_sharing CONSENT gate (fail closed; no/revoked → neutral).
 *   [1b]  ADR-0031 pending-deletion FREEZE (ruling (b)): a worker inside the deletion
 *         grace window is denied like [1] (same neutral body; re-checked in-tx).
 *   [2]   worker CAPS — atomic check-and-write under an advisory lock on worker_id
 *         (F-2: N concurrent requests can never exceed the cap). caps precede payment.
 *   [3]   PAYMENT/credit debit + [4] GRANT in ONE transaction (F-6: both-or-neither,
 *         idempotent, balance never negative).
 *
 * Every state change emits a validated PII-FREE event (invariant 1). NO LLM anywhere.
 *
 * CONCURRENCY / DEADLOCK FIX (F-2 e2e): the DB state changes run inside
 * {@link UnlocksRepository.withTransaction}, which holds a per-worker
 * `pg_advisory_xact_lock` AND one postgres-js pool connection (pool max=10). Event
 * emission, however, uses the GLOBAL db pool (a SEPARATE connection), not `tx`. If
 * we emitted WHILE the locked transaction were held, N concurrent same-worker
 * requests would each hold a connection + queue on the advisory lock, and the
 * lock-holder would need an (N+1)th connection to emit — exhausting the pool and
 * deadlocking until timeout. So the transaction NEVER emits: it returns a list of
 * deferred, PII-free emit thunks ({@link DeferredEmit}), and we fire them ONLY
 * AFTER the tx commits (connection + advisory lock released). This bounds each
 * request to ONE pool connection while it holds the lock.
 *
 * POST-COMMIT TRADE-OFF: because emission moves after COMMIT, an emit that fails
 * cannot roll back the (already-committed) state. The committed DB state is the
 * source of truth; the event is the audit record. On emit failure we LOG (id +
 * event class, NO PII) and STILL return the committed result. This is the accepted
 * trade-off — the alternative (emit-in-tx) reintroduces the pool-vs-lock deadlock.
 */
@Injectable()
export class UnlockService {
  private readonly logger = new Logger(UnlockService.name);

  constructor(
    private readonly repo: UnlocksRepository,
    private readonly consents: ConsentRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly payments: PaymentGateway,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  // ===========================================================================
  // POST /unlocks  —  request an unlock (F-1 → [4])
  // ===========================================================================
  async requestUnlock(
    input: { payerId: string; workerId: string; jobId: string | null },
    ctx: RequestContext,
  ): Promise<UnlockOutcome> {
    const { payerId, workerId, jobId } = input;

    // Audit the attempt at entry (PII-free). We do NOT yet have an unlock_id, so this
    // is keyed on (payer, worker) so a retry is one logical request in the spine. The
    // *granted* row id (if any) is carried by unlock.granted below.
    await this.emitRequested(payerId, workerId, jobId, ctx);

    // ---- [F-1] worker-state-INDEPENDENT credit precondition (BC-1) -----------
    // Checked BEFORE consent/caps/worker existence. A zero-balance payer can never
    // distinguish a consented-uncapped worker from a non-consented/unknown one: every
    // branch from here that ends in "no contact" returns the IDENTICAL neutral body.
    const balance = await this.repo.getBalance(payerId);
    if (balance < 1) {
      // INSUFFICIENT CREDITS collapses into the neutral response (F-1 option (a)).
      // No worker state was consulted → no oracle. We do NOT record a per-worker deny
      // row (that would itself be a probe signal); we emit an internal payment.failed
      // for ops audit only.
      await this.emitPaymentFailed(null, payerId, "insufficient_credits", ctx);
      return neutralUnavailable();
    }

    // ---- [1] employer_sharing CONSENT gate — read BEFORE the advisory lock ----
    // These are tx-EXTERNAL reads (ConsentRepository / WorkersRepository use the global
    // pool). Doing them INSIDE the advisory-locked transaction would need a 2nd pool
    // connection while N concurrent requests hold theirs blocked on the lock → pool-vs-
    // lock DEADLOCK (the F-2 failure). So resolve them here, before the lock; the tx below
    // only ever uses its own connection. SAFE: the reveal step re-checks consent as the
    // last gate before any disclosure, so a grant-time pre-lock consent read cannot leak a
    // contact even if consent is revoked between here and the grant (the grant is not the
    // disclosure). unknown_worker vs no_consent both return the IDENTICAL neutral body;
    // workerExists only picks the internal audit reason (consented ⇒ worker exists).
    const consented = await this.isConsentedForSharing(workerId);
    const workerPresent = consented || (await this.workerExists(workerId));

    // ---- ADR-0031 payer-surface freeze (ruling (b)) — pending-deletion gate -----
    // A worker inside the deletion grace window must stop surfacing to payers: a NEW
    // unlock is denied with the SAME byte-identical neutral body (no oracle — a payer
    // cannot distinguish "leaving" from no-consent/capped/unknown). Read tx-EXTERNALLY
    // here, beside the consent read (same deadlock rule); the tx below RE-CHECKS under
    // the advisory lock (the schedule-vs-unlock race). No deny row / unlock.denied is
    // written: the deny-reason enums carry no pending value and a leaving worker should
    // accrue no new rows keyed on them — unlock.requested (above) already audits the
    // attempt on the spine.
    if (await this.isPendingDeletion(workerId)) return neutralUnavailable();

    // From here, ALL deny branches return the same neutral body (F-3). The single
    // atomic transaction holds the advisory lock so caps cannot be raced (F-2) and the
    // debit+grant are both-or-neither (F-6). The transaction does ALL the DB work and
    // returns WHICH events to emit — but it does NOT emit (deadlock fix; see class doc):
    // emission happens AFTER commit, below.
    const { response, events: deferred } = await this.repo.withTransaction<TxResult<UnlockOutcome>>(
      async (tx): Promise<TxResult<UnlockOutcome>> => {
        const events: DeferredEmit[] = [];

        // Serialize all grants/reveals for this worker (F-2 atomicity).
        await this.repo.lockWorker(tx, workerId);

        // Idempotency: a live grant for (payer, worker) → return it, no second debit (F-6).
        const existing = await this.repo.findByPayerWorker(tx, payerId, workerId);
        if (existing && (existing.status === "granted" || existing.status === "revealed")) {
          if (existing.expiresAt && existing.expiresAt.getTime() > Date.now()) {
            return { response: this.grantedResponse(existing.id, existing.expiresAt), events };
          }
          // else: expired — fall through to re-grant (a fresh window) below.
        }

        // ---- [1] employer_sharing CONSENT gate (fail closed) ------------------
        // `consented`/`workerPresent` were resolved BEFORE the lock (deadlock fix above).
        if (!consented) {
          // unknown_worker and no_consent BOTH return the same neutral body — the consent
          // read returns false for a worker with no consent row at all, so existence is not
          // distinguishable from non-consent at the HTTP layer.
          const reason: UnlockDenyReason = workerPresent ? "no_consent" : "unknown_worker";
          if (workerPresent) {
            const row = await this.repo.recordDeny(tx, { payerId, workerId, jobId, denyReason: reason });
            events.push(() => this.emitDenied(row.id, payerId, workerId, jobId, reason, ctx));
          } else {
            // F-A (no-oracle): a non-existent worker_id would violate the
            // unlocks.worker_id FK on INSERT and surface as a 500 — distinguishable from
            // the 200 neutral body, i.e. a worker-enumeration oracle. Do NOT write a row
            // for an unknown worker; emit the internal audit event WITHOUT one (unlock_id
            // null, subject = worker) and return the identical neutral body.
            events.push(() => this.emitDenied(null, payerId, workerId, jobId, reason, ctx));
          }
          return { response: neutralUnavailable(), events };
        }

        // ---- ADR-0031 pending-deletion RE-CHECK (under the advisory lock) ------
        // The pre-lock gate (beside the consent read above) denied the common case;
        // this closes the race where the deletion is scheduled between that read and
        // the lock. ONE cheap tx-SCOPED pk read (a global-pool read inside the locked
        // tx would recreate the pool-vs-lock deadlock). A gone row collapses to the
        // same neutral too (the grant INSERT would otherwise 500 on the FK — no
        // oracle). Same neutral body; no deny row (see the pre-lock gate note).
        const marker = await this.repo.getWorkerDeletionMarker(tx, workerId);
        if (!marker || marker.deletionScheduledAt !== null) {
          return { response: neutralUnavailable(), events };
        }

        // ---- [2] worker CAPS (atomic, before payment) -------------------------
        const cap = await this.checkCaps(tx, workerId);
        if (cap) {
          const row = await this.repo.recordDeny(tx, { payerId, workerId, jobId, denyReason: "capped" });
          // Order preserved: cap_exceeded THEN denied (unchanged from emit-in-tx).
          events.push(() => this.emitCapExceeded(payerId, workerId, cap, ctx));
          events.push(() => this.emitDenied(row.id, payerId, workerId, jobId, "capped", ctx));
          return { response: neutralUnavailable(), events };
        }

        // ---- [3] PAYMENT / credit debit (atomic with [4] grant; F-6) ----------
        const debit = await this.payments.debitOneCreditWithinTx(tx, payerId);
        if (!debit.ok) {
          // Lost a concurrent debit race after the precondition — collapse to neutral
          // (still no worker-state oracle; consent already passed but the BODY is neutral).
          events.push(() => this.emitPaymentFailed(null, payerId, "insufficient_credits", ctx));
          return { response: neutralUnavailable(), events };
        }

        // ---- [4] GRANT (same tx) ----------------------------------------------
        const now = new Date();
        const expiresAt = new Date(now.getTime() + UNLOCK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const routingTokenRef = randomUUID(); // 122-bit, server-internal only (F-4)
        const granted = await this.repo.upsertGrant(tx, {
          payerId,
          workerId,
          jobId,
          routingTokenRef,
          grantedAt: now,
          expiresAt,
        });
        // Ledger debit in the SAME tx (balance + ledger never drift; F-6).
        await this.repo.appendLedger(tx, {
          payerId,
          delta: -1,
          reason: "unlock_debit",
          unlockId: granted.id,
        });

        // Order preserved: payment.authorized → payment.captured → unlock.granted.
        events.push(() => this.emitPaymentAuthorized(granted.id, payerId, ctx));
        events.push(() => this.emitPaymentCaptured(granted.id, payerId, ctx));
        events.push(() => this.emitGranted(granted.id, payerId, workerId, jobId, expiresAt, ctx));

        return { response: this.grantedResponse(granted.id, expiresAt), events };
      },
    );

    // COMMITTED — connection + advisory lock released. Now emit the audit events.
    await this.flushEvents(deferred);
    return response;
  }

  // ===========================================================================
  // POST /unlocks/:id/reveal  —  routed reveal (step [5]); the ONLY decrypt site
  // ===========================================================================
  async reveal(
    unlockId: string,
    ctx: RequestContext,
    expectedPayerId?: string,
  ): Promise<RevealOutcome> {
    // Consent re-check BEFORE the advisory lock (same pool-vs-lock deadlock fix as
    // requestUnlock): a tx-external consent read inside the locked tx would need a 2nd
    // pool connection while concurrent reveals on this worker hold theirs → deadlock.
    // Resolve the unlock's worker via a tx-external projection read and check consent
    // here. RR-3: the revoke-vs-reveal TOCTOU is irreducible; the window stays minimal
    // (lock-acquire + the in-tx validations) and the threat model already accepts it —
    // eliminating the deadlock outweighs the marginal widening. A missing/own-by-other
    // unlock falls through to the tx, which returns the IDENTICAL neutral body (F-3).
    const pre = await this.repo.getProjection(unlockId);
    // XB-A (payer-self path, ADR-0019): a payer may reveal ONLY their own unlock. A
    // not-owned (or unknown) unlock returns the IDENTICAL neutral body — never a 403 —
    // so a payer learns nothing about other tenants' unlocks (no-oracle, mirrors F-3).
    // Ops callers (InternalServiceGuard) pass no expectedPayerId and are UNAFFECTED.
    if (pre && expectedPayerId !== undefined && pre.payer_id !== expectedPayerId) {
      return neutralUnavailable();
    }
    // ADR-0026 Phase 5: a worker hard-delete (DSAR) SET-NULLs unlocks.worker_id while keeping
    // the PII-free paid-grant row. A reveal cannot relay to a gone worker — return the SAME
    // neutral body (no oracle; never pass null into the consent check / worker lock below).
    if (pre && pre.worker_id === null) return neutralUnavailable();
    // ADR-0031 payer-surface freeze (ruling (b)): a PENDING-deletion worker is, for a
    // payer, the same class as the gone worker above — frozen, not relayable. Deny with
    // the IDENTICAL neutral body (no oracle). Tx-external read (deadlock rule); the tx
    // below re-checks beside its own SET-NULL guards.
    if (pre && pre.worker_id !== null && (await this.isPendingDeletion(pre.worker_id)))
      return neutralUnavailable();
    if (pre && pre.worker_id !== null && !(await this.isConsentedForSharing(pre.worker_id)))
      return neutralUnavailable();

    // F-3: unknown/expired/over-cap/revoked all return the NEUTRAL body (not a 404).
    // The transaction does ALL the DB work + returns WHICH events to emit; it does NOT
    // emit (same deadlock fix as requestUnlock — contact.revealed/cap_exceeded used the
    // GLOBAL pool while this tx held the advisory lock + a connection). Emit post-commit.
    const { response, events: deferred } = await this.repo.withTransaction<TxResult<RevealOutcome>>(
      async (tx): Promise<TxResult<RevealOutcome>> => {
        const events: DeferredEmit[] = [];

        const unlock = await this.repo.findByIdForUpdate(tx, unlockId);
        if (!unlock) return { response: neutralUnavailable(), events };
        // ADR-0026 Phase 5: a hard-deleted worker SET-NULLs worker_id. The grant row survives
        // (billing history) but cannot be relayed — guard BEFORE lockWorker/relay/emit so a
        // null worker_id never reaches them; return the IDENTICAL neutral body (no oracle).
        if (unlock.workerId === null) return { response: neutralUnavailable(), events };
        // ADR-0031: pending-deletion guard beside the SET-NULL guard above — a frozen
        // worker is not relayable, so short-circuit BEFORE even taking the worker lock.
        // ONE cheap tx-SCOPED pk read (a global-pool read inside the locked tx would
        // recreate the pool-vs-lock deadlock); a gone row is the same neutral.
        const marker = await this.repo.getWorkerDeletionMarker(tx, unlock.workerId);
        if (!marker || marker.deletionScheduledAt !== null)
          return { response: neutralUnavailable(), events };

        // Serialize reveals for this worker (per-attempt cap atomicity; F-2).
        await this.repo.lockWorker(tx, unlock.workerId);

        // Re-read under the worker lock to see this txn's view consistently.
        const fresh = await this.repo.findByIdForUpdate(tx, unlockId);
        if (!fresh) return { response: neutralUnavailable(), events };
        // Re-guard after the lock (the worker could have been deleted in the TOCTOU window).
        // Bind to a non-null local so the deferred event closures (which TS won't narrow a
        // mutable property through) carry a guaranteed-non-null worker id (ADR-0026 Phase 5).
        if (fresh.workerId === null) return { response: neutralUnavailable(), events };
        const freshWorkerId: string = fresh.workerId;

        // ADR-0031 TOCTOU re-read UNDER the lock (mirrors the worker-gone re-guard
        // above): a deletion scheduled in the lock-acquire window must still freeze —
        // the marker is re-read on this txn's view before any relay/decrypt.
        const freshMarker = await this.repo.getWorkerDeletionMarker(tx, freshWorkerId);
        if (!freshMarker || freshMarker.deletionScheduledAt !== null)
          return { response: neutralUnavailable(), events };

        // Must be a live grant: granted/revealed, not expired.
        const live =
          (fresh.status === "granted" || fresh.status === "revealed") &&
          fresh.expiresAt !== null &&
          fresh.expiresAt.getTime() > Date.now() &&
          fresh.routingTokenRef !== null;
        if (!live) return { response: neutralUnavailable(), events };

        // Per-unlock attempt cap (F-2 atomic; under the worker lock).
        if (fresh.revealCount >= this.config.UNLOCK_MAX_ATTEMPTS_PER_UNLOCK) {
          events.push(() => this.emitCapExceeded(fresh.payerId, freshWorkerId, "attempts_per_unlock", ctx));
          return { response: neutralUnavailable(), events };
        }

        // Consent was re-checked just above, BEFORE the lock (deadlock fix). Per RR-3
        // the revoke-vs-reveal TOCTOU is irreducible; the remaining window is the
        // lock-acquire + the validations below, which is accepted.

        // ---- [5] ROUTED REVEAL — the ONLY place the raw phone is decrypted ------
        // It is read transiently to wire the in-app relay, then DISCARDED. It is NEVER
        // returned, evented, logged, stored, or placed in an exception (F-5). ALL
        // failures map to the neutral path (fail closed).
        const channel: RoutingChannel = "in_app_relay"; // alpha: discloses no number
        let relayHandle: string;
        try {
          relayHandle = await this.wireInAppRelay(freshWorkerId, fresh.id);
        } catch {
          // Do NOT surface the error (it could embed the phone). Log id + class only.
          this.logger.warn(`reveal failed for unlock=${fresh.id}: relay_wire_error`);
          return { response: neutralUnavailable(), events };
        }

        const revealExpiry = fresh.expiresAt!; // handle expires with the unlock window
        await this.repo.createRouting(tx, {
          unlockId: fresh.id,
          routingToken: fresh.routingTokenRef!, // server-internal; NEVER returned (F-4)
          channel,
          relayHandle,
          expiresAt: revealExpiry,
        });
        const revealCount = await this.repo.incrementReveal(tx, fresh.id);

        events.push(() => this.emitRevealed(fresh.id, fresh.payerId, freshWorkerId, channel, revealCount, ctx));

        return {
          response: {
            relay_handle: relayHandle, // opaque, non-reversible, expiring — NOT a phone
            channel,
            expires_at: revealExpiry.toISOString(),
          },
          events,
        };
      },
    );

    // COMMITTED — connection + advisory lock released. Now emit the audit events.
    await this.flushEvents(deferred);
    return response;
  }

  /**
   * Fire the deferred, PII-free event emits AFTER the transaction has committed (so
   * we hold NO advisory lock and NO pool connection while emitting — the deadlock
   * fix). The committed DB state is the source of truth; an event is the audit
   * record. POST-COMMIT TRADE-OFF: if an emit fails we CANNOT roll back the
   * already-committed state, so we LOG (event class only, NO PII) and continue —
   * still returning the committed result. We do NOT abort the remaining emits.
   */
  private async flushEvents(deferred: DeferredEmit[]): Promise<void> {
    for (const emit of deferred) {
      try {
        await emit();
      } catch (err) {
        // No PII: only the error class/message (event payloads are ids/enums, but the
        // emit thunk itself never carries a phone/name — keep this to class + message).
        const cls = err instanceof Error ? err.name : "UnknownError";
        const msg = err instanceof Error ? err.message : "unknown";
        this.logger.error(`post-commit event emit failed: ${cls}: ${msg}`);
      }
    }
  }

  // ===========================================================================
  // Ops reads (PII-free projections)
  // ===========================================================================
  async listByPayer(payerId: string): Promise<{ unlocks: UnlockProjection[] }> {
    return { unlocks: await this.repo.listByPayer(payerId) };
  }

  async getOne(unlockId: string): Promise<UnlockProjection | undefined> {
    return this.repo.getProjection(unlockId);
  }

  async getCredits(payerId: string): Promise<{ payer_id: string; balance: number }> {
    return { payer_id: payerId, balance: await this.repo.getBalance(payerId) };
  }

  /**
   * The payer's OWN credit-ledger history (the append-only movements behind the balance),
   * newest first, bounded by `limit`. PII-free by table design; scoped to the SESSION payer.
   * Read-only — no event.
   */
  async getCreditLedger(
    payerId: string,
    limit: number,
  ): Promise<{ payer_id: string; ledger: CreditLedgerItem[] }> {
    return { payer_id: payerId, ledger: await this.repo.listCreditLedgerByPayer(payerId, limit) };
  }

  // ===========================================================================
  // Credits (MOCK pack purchase — alpha; real Razorpay is a later human-gated stream)
  // ===========================================================================
  async purchaseCredits(
    payerId: string,
    packCode: string,
    ctx: RequestContext,
  ): Promise<{ payer_id: string; balance: number; credits: number; pack_code: string } | null> {
    // D-6: resolved from the LIVE catalog (legacy constants as the fallback) so the price +
    // credits CHARGED are the same ones the portal DISPLAYED. Async since D-6.
    const pack = await this.payments.resolvePack(packCode);
    if (!pack) return null; // unknown pack → 404 (this is NOT the unlock no-oracle path)

    const result = await this.payments.purchasePackMock(payerId, pack);
    // Mock purchase audit: authorized + captured, real_call:false (mock honesty, F-6).
    await this.emitPaymentAuthorized(null, payerId, ctx, {
      packCode: pack.code,
      amountInr: result.priceInr,
      amountCredits: result.credits,
    });
    await this.emitPaymentCaptured(null, payerId, ctx, {
      packCode: pack.code,
      amountInr: result.priceInr,
      amountCredits: result.credits,
    });
    return { payer_id: payerId, balance: result.balanceAfter, credits: pack.credits, pack_code: pack.code };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Fail-closed disclosure-consent read (ADR-0010 §D3): the worker's LATEST
   * worker_consents row must exist, be unrevoked, AND carry the exact
   * `employer_sharing` purpose. Profiling consent does NOT substitute. Any error →
   * false (fail closed).
   */
  private async isConsentedForSharing(workerId: string): Promise<boolean> {
    try {
      const latest = await this.consents.findLatestByWorker(workerId);
      if (!latest || latest.revokedAt !== null) return false;
      const purposes = (latest.purposes ?? []) as string[];
      return purposes.includes(EMPLOYER_SHARING);
    } catch {
      return false; // fail closed
    }
  }

  private async workerExists(workerId: string): Promise<boolean> {
    try {
      return (await this.workers.findById(workerId)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * ADR-0031 payer-surface freeze (ruling (b)): true when the worker has a PENDING
   * scheduled deletion (`deletion_scheduled_at` set). A leaving worker must stop
   * surfacing to payers — every caller denies with the byte-identical neutral body
   * (no oracle). Tx-EXTERNAL read (pre-lock only; the in-tx re-checks use the
   * tx-scoped marker read — deadlock rule). Fail closed: a read error counts as
   * pending (when in doubt, disclose nothing).
   */
  private async isPendingDeletion(workerId: string): Promise<boolean> {
    try {
      const worker = await this.workers.findById(workerId);
      return worker !== undefined && worker.deletionScheduledAt !== null;
    } catch {
      return true; // fail closed
    }
  }

  /**
   * Worker-protection caps (ADR-0010 §D4, CONFIG-DRIVEN). Returns the exceeded cap
   * kind, or null if within all caps. Reads are tx-scoped + under the advisory lock so
   * the check-and-write is atomic (F-2). Counts are derived from `unlocks`/grants, not
   * a side counter (no drift).
   */
  private async checkCaps(
    tx: Tx,
    workerId: string,
  ): Promise<"daily_reveals" | "weekly_payers" | null> {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const reveals = await this.repo.countRevealsSince(tx, workerId, dayAgo);
    if (reveals >= this.config.UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY) return "daily_reveals";

    const payers = await this.repo.countDistinctPayersSince(tx, workerId, weekAgo);
    if (payers >= this.config.UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK) return "weekly_payers";

    return null;
  }

  /**
   * Wire the in-app relay (alpha): the raw phone is decrypted HERE, transiently, used
   * to open the relay, and discarded. In alpha the "relay" is BadaBhai-mediated, so NO
   * number leaves the system — we return only an opaque, non-reversible relay handle.
   *
   * F-5: the decrypted phone is assigned to a narrowly-scoped local, never returned,
   * evented, logged, or put in an exception. The returned handle is derived WITHOUT
   * the phone (a fresh random uuid bound to the unlock), so it is not reversible to it.
   */
  private async wireInAppRelay(workerId: string, unlockId: string): Promise<string> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new Error("worker_not_found"); // mapped to neutral by caller

    // THE ONLY decrypt on this path. Narrowly scoped; never logged/returned/evented.
    const phone = this.pii.decrypt(worker.phoneE164);
    // In a real in-app relay this would register a server-side relay session keyed to
    // `phone`. Alpha: we only need to PROVE the relay can be opened without disclosing
    // the number. We deliberately do nothing reversible with `phone`.
    void phone.length; // touch the value (relay-open stand-in); do NOT log/return it.

    // The payer-facing handle is a fresh opaque uuid — NOT derived from the phone, so
    // it cannot be reversed to it (F-4). It expires with the unlock window.
    return `relay_${unlockId}_${randomUUID()}`;
  }

  private grantedResponse(unlockId: string, expiresAt: Date): UnlockGrantedResponse {
    return { ok: true, unlock_id: unlockId, status: "granted", expires_at: expiresAt.toISOString() };
  }

  // ---- Event emitters (all PII-free; ids + enums + counts only) -------------

  private async emitRequested(
    payerId: string,
    workerId: string,
    jobId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"unlock.requested"> = {
      unlock_id: randomUUID(), // a request id placeholder (no row yet); not the grant id
      payer_id: payerId,
      worker_id: workerId,
      job_id: jobId,
    };
    await this.events.emit({
      event_name: "unlock.requested",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: payload.unlock_id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitGranted(
    unlockId: string,
    payerId: string,
    workerId: string,
    jobId: string | null,
    expiresAt: Date,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"unlock.granted"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      worker_id: workerId,
      job_id: jobId,
      expires_at: expiresAt.toISOString(),
    };
    await this.events.emit({
      event_name: "unlock.granted",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      idempotencyKey: `unlock.granted:${unlockId}`, // once-only
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitDenied(
    unlockId: string | null,
    payerId: string,
    workerId: string,
    jobId: string | null,
    reason: UnlockDenyReason,
    ctx: RequestContext,
  ): Promise<void> {
    // unlockId is null for the unknown-worker deny (no row is written — see F-A); the
    // payload's unlock_id is nullable and the subject falls back to the worker, matching
    // unlock.cap_exceeded's worker subject.
    const payload: PayloadInputOf<"unlock.denied"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      worker_id: workerId,
      job_id: jobId,
      reason, // INTERNAL audit only — NEVER echoed to the payer (F-3)
    };
    await this.events.emit({
      event_name: "unlock.denied",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: unlockId
        ? { subject_type: "unlock", subject_id: unlockId }
        : { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitCapExceeded(
    payerId: string,
    workerId: string,
    cap: "daily_reveals" | "weekly_payers" | "attempts_per_unlock",
    ctx: RequestContext,
  ): Promise<void> {
    const window = cap === "daily_reveals" ? "day" : cap === "weekly_payers" ? "week" : "unlock";
    const payload: PayloadInputOf<"unlock.cap_exceeded"> = {
      payer_id: payerId,
      worker_id: workerId,
      cap,
      window,
    };
    await this.events.emit({
      event_name: "unlock.cap_exceeded",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitRevealed(
    unlockId: string,
    payerId: string,
    workerId: string,
    channel: RoutingChannel,
    revealCount: number,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"contact.revealed"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      worker_id: workerId,
      channel, // KIND only — NEVER the number/handle/destination (F-5)
      reveal_count: revealCount,
    };
    await this.events.emit({
      event_name: "contact.revealed",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentAuthorized(
    unlockId: string | null,
    payerId: string,
    ctx: RequestContext,
    extra?: { packCode?: string; amountInr?: number; amountCredits?: number },
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.authorized"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      pack_code: extra?.packCode ?? null,
      amount_inr: extra?.amountInr ?? null,
      amount_credits: extra?.amountCredits ?? 1,
      real_call: this.payments.realCall, // honest mock flag (false in alpha)
    };
    await this.events.emit({
      event_name: "payment.authorized",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(unlockId ? { idempotencyKey: `payment.authorized:${unlockId}` } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentCaptured(
    unlockId: string | null,
    payerId: string,
    ctx: RequestContext,
    extra?: { packCode?: string; amountInr?: number; amountCredits?: number },
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.captured"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      pack_code: extra?.packCode ?? null,
      amount_inr: extra?.amountInr ?? null,
      amount_credits: extra?.amountCredits ?? 1,
      real_call: this.payments.realCall,
    };
    await this.events.emit({
      event_name: "payment.captured",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(unlockId ? { idempotencyKey: `payment.captured:${unlockId}` } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentFailed(
    unlockId: string | null,
    payerId: string,
    reason: "insufficient_credits" | "gateway_error",
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.failed"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      reason,
      real_call: this.payments.realCall,
    };
    await this.events.emit({
      event_name: "payment.failed",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
