import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { getRazorpayCredentials, type ServerConfig } from "@badabhai/config";
import { UNLOCK_WINDOW_DAYS, type UnlockDenyReason, type RoutingChannel } from "@badabhai/db";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
import { PaymentGateway, type RealOrderHandoff, type SettleResult } from "./payment-gateway";
import { verifyCheckoutSignature } from "./razorpay-signature";
import {
  RAZORPAY_CAPTURE_EVENTS,
  RAZORPAY_FAILURE_EVENTS,
  type RazorpayPaymentEvent,
} from "./razorpay-webhook.dto";
import { REFERRAL_BONUS_QUEUE, type ReferralBonusJobData } from "../queue/queue.constants";
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
    // §X.6 — leg 2 of the activation-bonus rule completes here. Injected as a QUEUE, not as
    // ReferralBonusService, so this module gains no dependency on `referrals`.
    @InjectQueue(REFERRAL_BONUS_QUEUE)
    private readonly referralBonusQueue: Queue<ReferralBonusJobData>,
  ) {}

  // ===========================================================================
  // POST /unlocks  —  request an unlock (F-1 → [4])
  // ===========================================================================
  async requestUnlock(
    input: { payerId: string; workerId: string; jobId: string | null },
    ctx: RequestContext,
  ): Promise<UnlockOutcome> {
    const { payerId, workerId, jobId } = input;
    const _r21_start = Date.now();
    try {

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
        // §X.6 — a granted unlock is LEG 2 of the ₹20 activation-bonus rule (the leg a
        // fraudster cannot fake, because it costs a paying party money). Deferred like the
        // emits above, so it runs POST-COMMIT and inherits flushEvents' log-and-continue:
        // a Redis blip costs a (recoverable, idempotent) accrual, never the unlock.
        events.push(() => this.enqueueReferralBonusEvaluation(workerId));

        return { response: this.grantedResponse(granted.id, expiresAt), events };
      },
    );

    // COMMITTED — connection + advisory lock released. Now emit the audit events.
    await this.flushEvents(deferred);
    return response;
  } finally {
    await this.padToTarget(_r21_start);
  }
}

  // ===========================================================================
  // POST /unlocks/:id/reveal  —  routed reveal (step [5]); the ONLY decrypt site
  // ===========================================================================
  async reveal(
    unlockId: string,
    ctx: RequestContext,
    expectedPayerId?: string,
  ): Promise<RevealOutcome> {
    const _r21_start = Date.now();
    try {
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
  } finally {
    await this.padToTarget(_r21_start);
  }
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

  // R21 / LC-7: latency-normalisation helper. Pads the response to
  // UNLOCK_LATENCY_TARGET_MS so the timing of a neutral deny does not
  // leak the reason. No-op when target is 0 (trusted-shared-secret alpha).
  private async padToTarget(start: number): Promise<void> {
    const target = this.config.UNLOCK_LATENCY_TARGET_MS;
    if (target <= 0) return;
    const elapsed = Date.now() - start;
    const remaining = target - elapsed;
    if (remaining > 0) await sleep(remaining);
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

  // ===========================================================================
  // REAL Razorpay credit purchase (behind PAYMENTS_ENABLE_REAL + the full
  // credential set). Order → checkout → capture, where the webhook is the source
  // of truth and the browser verify is a convergent fallback.
  // ===========================================================================

  /** True when a REAL gateway is fully wired. The controller gates the real routes on this. */
  get realPaymentsLive(): boolean {
    return this.payments.realCall;
  }

  /**
   * Create a REAL provider order for a credit pack (`POST /payer/credits/order`).
   *
   * Returns null for an unknown pack (→ the caller's 404 — a pack code is a public catalog
   * item, not a per-tenant resource, so a 404 leaks nothing).
   *
   * PRICE AUTHORITY: {@link PaymentGateway.resolvePack} — the same live-catalog path the
   * portal renders from (D-6). The advertised price and the charged price are the same
   * lookup, and the client never supplies an amount at any point in this chain.
   *
   * EVENT (§1): exactly one `payment.authorized`, keyed on our order row so a retried
   * request that produced a second provider order still produces one event per order.
   * `real_call` is the honest `true` here — this event means money is genuinely in flight.
   */
  async createCreditOrder(
    payerId: string,
    packCode: string,
    ctx: RequestContext,
  ): Promise<RealOrderHandoff | null> {
    const pack = await this.payments.resolvePack(packCode);
    if (!pack) return null;

    const order = await this.payments.createRealOrder(payerId, pack);

    await this.emitPaymentAuthorized(null, payerId, ctx, {
      packCode: order.packCode,
      amountInr: order.amountInr,
      amountCredits: order.credits,
      // One authorization per ORDER ROW (not per request): a client that retries the call
      // creates a distinct order and gets a distinct event; a duplicate emit cannot happen.
      idempotencyKey: `payment.authorized:order:${order.orderRowId}`,
    });
    return order;
  }

  /**
   * Verify a browser-returned checkout result and settle (`POST /payer/credits/verify`).
   *
   * WHY THIS EXISTS: on a flaky Indian mobile network the browser sees Razorpay's success
   * callback seconds before the webhook reaches our server. Without this path the payer
   * would be shown "payment failed" for a payment that actually succeeded. It converges on
   * the SAME order row and the SAME idempotent settle as the webhook, so the two can race
   * freely — whichever lands first grants, the other reports the already-settled state.
   *
   * TRUST: the `razorpay_signature` is HMAC(order_id|payment_id, KEY SECRET), compared
   * constant-time. A payer cannot mint credits by POSTing ids they invented, because they
   * cannot produce that HMAC. Ownership is additionally bound to the SESSION payer.
   *
   * NO-ORACLE: an invalid signature, an unknown order, and another tenant's order all
   * return the same `{ verified: false }` shape — the caller learns nothing about which.
   */
  async verifyCheckoutPayment(
    payerId: string,
    input: { orderId: string; paymentId: string; signature: string },
    ctx: RequestContext,
  ): Promise<
    | { verified: true; payer_id: string; balance: number; credits: number; pack_code: string }
    | { verified: false }
  > {
    const creds = getRazorpayCredentials(this.config);
    if (!creds) return { verified: false }; // real payments not live ⇒ nothing to verify

    if (!verifyCheckoutSignature(input, creds.keySecret)) {
      // Log the FACT only — no ids, no signature, nothing an attacker could confirm.
      this.logger.warn("razorpay checkout signature verification failed");
      return { verified: false };
    }

    const result = await this.settleAndEmit(
      {
        providerOrderId: input.orderId,
        providerPaymentRef: input.paymentId,
        // Ownership is enforced INSIDE settle: a mismatch is indistinguishable from
        // "no such order", so this endpoint is not an order-id oracle for other tenants.
        expectedPayerId: payerId,
      },
      ctx,
    );

    switch (result.outcome) {
      case "granted":
        return {
          verified: true,
          payer_id: payerId,
          balance: result.balanceAfter,
          credits: result.credits,
          pack_code: result.order.packCode,
        };
      case "already_settled": {
        // The webhook won the race. This is a SUCCESS for the payer — report the real
        // balance, never a failure, or a paying customer is told their purchase failed.
        const credits = await this.getCredits(payerId);
        return {
          verified: true,
          payer_id: payerId,
          balance: credits.balance,
          credits: 0, // already credited by the winning channel; nothing added here
          pack_code: result.order.packCode,
        };
      }
      case "unknown_order":
        return { verified: false };
    }
  }

  /**
   * Handle ONE verified Razorpay webhook delivery (`POST /payments/razorpay/webhook`).
   *
   * The signature is already verified over the raw bytes by {@link RazorpayWebhookGuard} —
   * by the time this runs, the delivery is authentic.
   *
   * RETRY SEMANTICS (Razorpay retries non-2xx for hours):
   *  - a duplicate/replayed capture → `no_op`, HTTP 200. Not a 500 (which would spam
   *    retries) and not a second grant (which would be free credits).
   *  - an unknown event type → `no_op`, HTTP 200. Silence, not an error.
   *  - a genuine INFRASTRUCTURE failure (DB down, the layer-3 unique index firing) is NOT
   *    caught here: it throws, the exceptions filter answers 5xx, and Razorpay redelivers.
   *    A redelivery after the problem clears finds the order already `paid` and no-ops, so
   *    captured money is never dropped and never double-granted. There is deliberately no
   *    "retry" return value: since the grant size is stamped on the order row, no business
   *    condition can leave a captured payment un-grantable.
   */
  async handleRazorpayEvent(
    event: RazorpayPaymentEvent,
    ctx: RequestContext,
  ): Promise<{ result: "granted" | "failed_recorded" | "no_op" }> {
    const isCapture = (RAZORPAY_CAPTURE_EVENTS as readonly string[]).includes(event.eventName);
    const isFailure = (RAZORPAY_FAILURE_EVENTS as readonly string[]).includes(event.eventName);
    if (!isCapture && !isFailure) return { result: "no_op" }; // unknown type → 200 no-op
    if (event.orderId === null) return { result: "no_op" }; // no order to act on → 200 no-op

    if (isFailure) {
      const order = await this.payments.failOrder(event.orderId);
      if (!order) return { result: "no_op" }; // unknown, or already paid (never walk that back)
      await this.emitPaymentFailed(null, order.payerId, "gateway_error", ctx, {
        idempotencyKey: `payment.failed:order:${order.id}`,
      });
      return { result: "failed_recorded" };
    }

    const settled = await this.settleAndEmit(
      {
        providerOrderId: event.orderId,
        // A capture without a payment id is malformed; record the order id so the ledger
        // still carries an opaque reference rather than null.
        providerPaymentRef: event.paymentId ?? event.orderId,
        // NO expectedPayerId: the webhook is Razorpay speaking, not a tenant — the order
        // row itself names the payer to credit.
      },
      ctx,
    );

    switch (settled.outcome) {
      case "granted":
        return { result: "granted" };
      case "already_settled":
      case "unknown_order":
        // Replay of a delivery we already processed, or an order we never created (a
        // payment made against a different environment's account). Both are 200 no-ops:
        // there is nothing to do and retrying will not change that.
        return { result: "no_op" };
    }
  }

  /**
   * The ONE settle+emit path both channels share. Emits `payment.captured` if and ONLY if
   * this call is the one that granted, so the event spine has exactly one capture per
   * order — matching the money exactly (§1: no important state change without an event,
   * and no event without a state change).
   */
  private async settleAndEmit(
    input: { providerOrderId: string; providerPaymentRef: string; expectedPayerId?: string },
    ctx: RequestContext,
  ): Promise<SettleResult> {
    const result = await this.payments.settleOrder(input);
    if (result.outcome === "granted") {
      await this.emitPaymentCaptured(null, result.order.payerId, ctx, {
        packCode: result.order.packCode,
        amountInr: result.priceInr,
        amountCredits: result.credits,
        // Keyed on the ORDER ROW: even if both channels somehow reached the emit, the
        // events table would still hold exactly one capture for this order.
        idempotencyKey: `payment.captured:order:${result.order.id}`,
      });
    }
    return result;
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

  /**
   * §X.6 — ask the referral module to re-evaluate the ₹20 activation bonus for this worker,
   * because one of its two legs (a granted unlock) just became true.
   *
   * A QUEUE, not a service call: `unlocks` must not gain a dependency on `referrals`, and
   * the evaluation (up to six reads) has no business on the unlock request path. The
   * processor re-checks BOTH legs from the database, so this is a no-op for the vast
   * majority of workers (never referred), and `UNIQUE (invited_worker_id)` makes a
   * duplicate delivery harmless. PII-FREE: an opaque worker id + a non-PII trigger enum.
   */
  private async enqueueReferralBonusEvaluation(workerId: string): Promise<void> {
    await this.referralBonusQueue.add("evaluate", {
      invitedWorkerId: workerId,
      trigger: "unlock_granted",
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
    extra?: {
      packCode?: string;
      amountInr?: number;
      amountCredits?: number;
      /**
       * Explicit dedup key for money movements that have NO unlock (a credit-pack
       * purchase). The real-payment path keys on the `payment_orders` row so the spine
       * inherits the money path's exactly-once property.
       */
      idempotencyKey?: string;
    },
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.authorized"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      pack_code: extra?.packCode ?? null,
      amount_inr: extra?.amountInr ?? null,
      amount_credits: extra?.amountCredits ?? 1,
      real_call: this.payments.realCall, // honest flag: false on the mock path, true when live
    };
    const idempotencyKey =
      extra?.idempotencyKey ?? (unlockId ? `payment.authorized:${unlockId}` : undefined);
    await this.events.emit({
      event_name: "payment.authorized",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentCaptured(
    unlockId: string | null,
    payerId: string,
    ctx: RequestContext,
    extra?: {
      packCode?: string;
      amountInr?: number;
      amountCredits?: number;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.captured"> = {
      unlock_id: unlockId,
      payer_id: payerId,
      pack_code: extra?.packCode ?? null,
      amount_inr: extra?.amountInr ?? null,
      amount_credits: extra?.amountCredits ?? 1,
      real_call: this.payments.realCall,
    };
    const idempotencyKey =
      extra?.idempotencyKey ?? (unlockId ? `payment.captured:${unlockId}` : undefined);
    await this.events.emit({
      event_name: "payment.captured",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentFailed(
    unlockId: string | null,
    payerId: string,
    reason: "insufficient_credits" | "gateway_error",
    ctx: RequestContext,
    extra?: { idempotencyKey?: string },
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
      ...(extra?.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
