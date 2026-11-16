import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { getRazorpayCredentials, type ServerConfig } from "@badabhai/config";
import {
  isSampleWorkerId,
  UNLOCK_WINDOW_DAYS,
  type Database,
  type ExpiredCreditLot,
  type UnlockDenyReason,
  type UnlockRouting,
  type RoutingChannel,
} from "@badabhai/db";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { PayerCreditsResponse } from "@badabhai/types";
import {
  normalizeTradeLevelKey,
  priceTierForTradeRows,
} from "@badabhai/taxonomy";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  InstituteOpenGate,
  type InstituteOpener,
} from "../campus-link/institute-open-gate.service";
import { MatchConfigService } from "../match/match-config.service";
import { PayersRepository } from "../payers/payers.repository";
import { isBarredPayerStatus } from "../payers/payer-barred-status";
import type { JobRefPolicy } from "../payers/job-ref-policy";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import {
  PAYER_VISIBLE_STORED_STATUSES,
  toPayerUnlocks,
  type PayerUnlockProjection,
} from "./payer-unlock-view";
import {
  UnlocksRepository,
  type Tx,
  type UnlockProjection,
  type CreditLedgerItem,
} from "./unlocks.repository";
import { PaymentGateway, type RealOrderHandoff, type SettleResult } from "./payment-gateway";
import { creditsExpiredEvent } from "./credits-expired-event";
import { verifyCheckoutSignature } from "./razorpay-signature";
import { assertExpectedPrice } from "../pricing/charge-price";
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
  type ContactReadResponse,
} from "./unlock-response";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import {
  isOpenGrant,
  needsOpenForGoodDate,
  OPEN_FOR_GOOD_UNTIL,
  openUntilOf,
} from "./open-grant";
import { onBriefNotice } from "./brief-notice";
import { searchExitRefuses } from "../search-exit/search-exit-gate";

/** The disclosure consent purpose this gate keys on (DISTINCT from profiling). */
const EMPLOYER_SHARING = "employer_sharing";
/**
 * The ninth consent purpose, minted for messaging (E0 §A ruling, 2026-09-07). The relay's
 * use-time ladder requires BOTH this and `EMPLOYER_SHARING` on the latest consent row —
 * disclosing a routed contact does not authorise messaging over it.
 */
const EMPLOYER_MESSAGING = "employer_messaging";

/** Either the one distinguishable success, or the byte-identical neutral body (F-3). */
type UnlockOutcome = UnlockGrantedResponse | NeutralUnavailableResponse;
type RevealOutcome = ContactRevealedResponse | NeutralUnavailableResponse;

/**
 * What a successful relay resolution yields: the unlock the handle names and the worker
 * on the other side. NEVER put this on the wire — the payer receives the neutral body or
 * nothing; the ids stay server-side (E0 item 1: "do NOT return a worker_id").
 */
export interface RelayResolution {
  readonly unlockId: string;
  readonly workerId: string;
}

/**
 * A deferred event emission: a zero-arg thunk that closes over already-computed,
 * PII-FREE values (ids/enums/counts only) and calls `this.events.emit(...)`. We
 * collect these INSIDE the locked transaction but FIRE them only AFTER the
 * transaction commits — see {@link UnlockService} class doc (deadlock fix).
 */
type DeferredEmit = () => Promise<void>;

/** #1899 — the job context an unlock may store, or a refusal (the reference is not the payer's). */
/**
 * `jobContext` is the `jobs` id (or null) every row AND event carries. `jobPostingId` (#2033)
 * is the owned company posting, ROW-ONLY — it is never put on an event (event schemas are
 * never mutated). At most one of the two is non-null.
 */
type JobContextResolution =
  | { ok: true; jobContext: string | null; jobPostingId: string | null }
  | { ok: false };

/** What a transaction step returns: the HTTP body + the events to emit post-commit. */
interface TxResult<R> {
  response: R;
  events: DeferredEmit[];
}

/**
 * ADR-0053 §7 — who a tenant business event names. The envelope `actor.actor_id` is the login
 * that ACTED; every payload payer reference (`payer_id`, `viewer_payer_id`) is the TENANT key —
 * the wallet, and the `payer_id` of the row the event describes. In mode `off` the two are the
 * same session payer, so every event is byte-identical to before. No event schema changes: only
 * which id fills which existing field.
 */
interface EventParty {
  /** `actor.actor_id` — the acting login. */
  readonly actorId: string;
  /** Every payload payer reference — the tenant key. */
  readonly payerId: string;
}

/** The party of a request the tenant resolver scoped. */
function partyOf(scope: PayerTenantScope): EventParty {
  return { actorId: scope.actorPayerId, payerId: scope.tenantKey };
}

/**
 * The party when no payer login acted on the tenant's behalf — the ops reveal route and the
 * Razorpay webhook. The row's (or the order's) own `payer_id` is both, exactly as before.
 */
function rowOwnerParty(rowPayerId: string): EventParty {
  return { actorId: rowPayerId, payerId: rowPayerId };
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
 *   [1]   employer_sharing CONSENT gate (fail closed; no/revoked → neutral). An actively linked
 *         institute student is judged by {@link InstituteOpenGate} instead (#2752): only a company
 *         he applied to, with his RVM consent re-confirmed, passes; the deny is the same neutral.
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
 *
 * ONE EXCEPTION (#2749): `payer.credits_expired` is written ON `tx`. `EventsService.emit({ tx })`
 * builds and validates the event in memory and inserts it on the executor it is handed, so it
 * takes no second connection and the pool-vs-lock deadlock above cannot arise; in exchange the
 * event commits or rolls back with the expiry it records, so a committed expiry can never lose it.
 *
 * ORG TENANCY (ADR-0053, PAY-DB-01). Every public entry point that names a payer resolves the
 * tenant ONCE through {@link PayerTenantScopeService} — the payer-session routes and the ops
 * routes alike (§5.2 rules 1 and 4) — and passes the branded `tenantKey` down. Unlocks, the
 * wallet (`payer_credits`), the ledger and payment orders are keyed by it; the acting login
 * stays on every event envelope (§7). In mode `off` the key is the caller itself (identical to
 * before); in `on` it is the acting org's anchor, so a team shares ONE wallet (O-1) — the
 * anchor's existing row, so no money moves — and a member's personal pre-team wallet stays
 * theirs and out of view (O-2). Rate limits and the `Idempotency-Key` seam stay per login.
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
    // ADR-0036 §7 — the free-tier grant size, for the credits_exhausted signal + the
    // signup grant. MatchModule is @Global, so no new import edge on UnlocksModule.
    private readonly matchConfig: MatchConfigService,
    // ADR-0037 Decision 6 — the lifecycle read behind the suspended-capture alert. Reuses
    // the narrow {role, status} projection the payer guard uses, NOT `findById` (which
    // returns the encrypted-PII row).
    private readonly payers: PayersRepository,
    // ADR-0053 — the ONE tenant resolver (exported by PayersModule, already imported above).
    private readonly tenancy: PayerTenantScopeService,
    // #2752 — the institute rule for a linked student (CampusLinkModule, one-way edge).
    private readonly instituteGate: InstituteOpenGate,
    // #2747 — the `contact_rules` switch (open for good, the contact read). Optional only so the
    // hand-built unit instances keep compiling; absent reads as off. Nest always injects it.
    @Optional() private readonly rollout?: FeatureRolloutService,
  ) {}

  /**
   * #2747 — is `contact_rules` on for this company? Off when the rollout service is absent; a
   * pilot-list read error is `unavailable` (the unlock path refuses rather than charge a pilot
   * company again for a contact it holds), and off everywhere else: the old window, never a wider
   * opening.
   */
  private async contactRulesState(tenant: TenantKey): Promise<"on" | "off" | "unavailable"> {
    if (this.rollout === undefined) return "off";
    return this.rollout.stateFor("contact_rules", tenant);
  }

  private async contactRulesOn(tenant: TenantKey): Promise<boolean> {
    return (await this.contactRulesState(tenant)) === "on";
  }

  // ===========================================================================
  // POST /unlocks  —  request an unlock (F-1 → [4])
  // ===========================================================================
  async requestUnlock(
    input: { payerId: string; workerId: string; jobId: string | null },
    ctx: RequestContext,
    jobRefPolicy: JobRefPolicy = "normalise",
  ): Promise<UnlockOutcome> {
    const { workerId } = input;
    const _r21_start = Date.now();
    try {

    // ADR-0053 — resolve the tenant ONCE, at the entry point, for the payer-session route and
    // the ops route alike (§5.2 rules 1 and 4). `input.payerId` is the ACTING login; every
    // tenant row below — the unlock, the wallet debit, the ledger line — is keyed by `tenant`,
    // and every event names the actor on its envelope and the tenant in its payload (§7). In
    // `off` tenant === actor. In `on` a refusal is the resolver's one neutral 403, raised
    // before anything is read, written or emitted (it depends only on the CALLER's own
    // memberships, never on the worker, so it is no worker-state oracle).
    const scope = await this.tenancy.resolve(input.payerId);
    const tenant = scope.tenantKey;
    const party = partyOf(scope);
    // #2747 (ADR-0064 §3.4) — read ONCE per request. With it on (and the brief's rules applying to
    // this worker, below), a held contact is re-opened free whatever its date and a new grant is
    // stored open for good. A pilot list that cannot be read is "unavailable": the request goes on
    // as if off, EXCEPT that a re-grant over a contact the company already holds is refused (below)
    // — reading a pilot company as "off" there would debit it again. First opens are unaffected.
    const contactRules = await this.contactRulesState(tenant);

    // #1903 — normalise the caller's job context ONCE, before anything is written or
    // emitted: every row and event below carries `jobContext`, never the raw input. It is
    // resolved here, BEFORE the advisory lock, because it is a global-pool read (the
    // deadlock rule above the consent read below). See resolveJobContext.
    // #1899 — on the payer-session route a reference the TENANT does not own is REFUSED here
    // with the one neutral body: no event, no deny row, no debit (and still latency-padded).
    const resolved = await this.resolveJobContext(input.jobId, tenant, jobRefPolicy);
    if (!resolved.ok) {
      // Ops visibility only (ids, no PII): repeated hits from one payer are tenant probing.
      this.logger.warn(`unlock refused: job ref not owned by payer=${scope.actorPayerId}`);
      return neutralUnavailable();
    }
    const { jobContext, jobPostingId } = resolved;

    // Audit the attempt at entry (PII-free). We do NOT yet have an unlock_id, so this
    // is keyed on (payer, worker) so a retry is one logical request in the spine. The
    // *granted* row id (if any) is carried by unlock.granted below.
    await this.emitRequested(party, workerId, jobContext, ctx);

    // ---- [F-1] worker-state-INDEPENDENT credit precondition (BC-1) -----------
    // Checked BEFORE consent/caps/worker existence. A zero-balance payer can never
    // distinguish a consented-uncapped worker from a non-consented/unknown one: every
    // branch from here that ends in "no contact" returns the IDENTICAL neutral body.
    // The balance is the TENANT's wallet (the org's in `on`, ADR-0053 W1).
    //
    // #2749 — SPENDABLE credits, not the raw balance: credits in lots past `expires_at` do not
    // count. Read on the raw balance, a wallet whose credits were all past due would pass this
    // gate, reach the debit only for a worker who passed the consent / deletion / cap gates, and
    // (before the review fix) leave an `expired` line only in that case — a worker-state oracle
    // the company could read back from its own ledger. Refused here, before any worker read.
    const balance = await this.repo.getSpendableBalance(tenant);
    if (balance < 1) {
      // INSUFFICIENT CREDITS collapses into the neutral response (F-1 option (a)).
      // No worker state was consulted → no oracle. We do NOT record a per-worker deny
      // row (that would itself be a probe signal); we emit an internal payment.failed
      // for ops audit only.
      await this.emitPaymentFailed(null, party, "insufficient_credits", ctx);
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
      // #2747 — the SAME reads answer whether the brief's contact rules apply to him (§3.8): only
      // then, and only with the company's `contact_rules` on, is the contact open for good.
      const access = await this.contactAccess(workerId, { tenant }, ctx);
      const consented = access.openable;
      const openForGood = contactRules === "on" && access.brief;
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
    if (await this.isPayerSurfaceFrozen(workerId)) return neutralUnavailable();

    // ---- R74 (owner ruling 2026-11-04) — a SAMPLE candidate is never unlocked ---------------
    // The synthetic-workforce seed's workers hold `employer_sharing` so payers can see the pool,
    // but they are not people: an unlock would spend a credit on a relay that reaches no one and a
    // résumé that does not exist. Their cards say "Sample candidate" and offer no unlock; this is
    // the server's half of that. A pure id test (no read), AFTER the credit precondition so a
    // zero-balance payer still learns nothing from the worker id, and BEFORE the transaction, so
    // nothing is debited or written. Same shape as the pending-deletion gate above: the neutral
    // body, no deny row and no new deny reason (`unlock.requested` already audits the attempt).
    if (isSampleWorkerId(workerId)) return neutralUnavailable();

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

        // Idempotency: a live grant for (tenant, worker) → return it, no second debit (F-6).
        // In `on` that is per ORG: a teammate re-unlocking a worker the org already holds gets
        // the org's existing grant and is charged nothing.
        const existing = await this.repo.findByPayerWorker(tx, tenant, workerId);
        if (existing && isOpenGrant(existing, { openForGood })) {
          // #2747 — with `contact_rules` on and the brief's rules applying to him, a held contact
          // is open whatever its date (past opens included) and re-opening it is free. Its stored
          // dates move to "for good" here, under the worker lock, so switching the rule off later
          // never re-charges it. `openForGood` implies his consent passed (`brief` ⇒ `openable`):
          // a worker who withdrew is never re-opened. The re-open is audited (`unlock.reopened`).
          if (openForGood && needsOpenForGoodDate(existing)) {
            await this.repo.extendOpenUntil(tx, existing.id, OPEN_FOR_GOOD_UNTIL);
            const reopenedId = existing.id;
            events.push(() => this.emitReopened(reopenedId, party, workerId, ctx));
            return {
              response: this.grantedResponse(existing.id, OPEN_FOR_GOOD_UNTIL, true),
              events,
            };
          }
          return {
            response: this.grantedResponse(existing.id, existing.expiresAt!, openForGood),
            events,
          };
        }
        // #2747 — the pilot list could not be read: this company may be a pilot one whose contact is
        // open for good. Never charge it again on a guess; the neutral body, nothing written.
        if (
          contactRules === "unavailable" &&
          existing &&
          (existing.status === "granted" || existing.status === "revealed")
        ) {
          return { response: neutralUnavailable(), events };
        }
        // else: none, or lapsed with the rule off — fall through to a (paid) grant below.

        // ---- [1] employer_sharing CONSENT gate (fail closed) ------------------
        // `consented`/`workerPresent` were resolved BEFORE the lock (deadlock fix above).
        if (!consented) {
          // unknown_worker and no_consent BOTH return the same neutral body — the consent
          // read returns false for a worker with no consent row at all, so existence is not
          // distinguishable from non-consent at the HTTP layer.
          const reason: UnlockDenyReason = workerPresent ? "no_consent" : "unknown_worker";
          if (workerPresent) {
            const row = await this.repo.recordDeny(tx, {
              payerId: tenant,
              workerId,
              jobId: jobContext,
              jobPostingId,
              denyReason: reason,
            });
            events.push(() => this.emitDenied(row.id, party, workerId, jobContext, reason, ctx));
          } else {
            // F-A (no-oracle): a non-existent worker_id would violate the
            // unlocks.worker_id FK on INSERT and surface as a 500 — distinguishable from
            // the 200 neutral body, i.e. a worker-enumeration oracle. Do NOT write a row
            // for an unknown worker; emit the internal audit event WITHOUT one (unlock_id
            // null, subject = worker) and return the identical neutral body.
            events.push(() => this.emitDenied(null, party, workerId, jobContext, reason, ctx));
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
        if (
          !marker ||
          marker.deletionScheduledAt !== null ||
          marker.status === "suspended"
        ) {
          return { response: neutralUnavailable(), events };
        }

        // #2753 item 6 — he left company search: only a company he applied to opens him.
        if (await searchExitRefuses(tx, this.config, workerId, tenant)) {
          events.push(() => this.emitDenied(null, party, workerId, jobContext, "no_consent", ctx));
          return { response: neutralUnavailable(), events };
        }

        // ---- [2] worker CAPS (atomic, before payment) -------------------------
        // Counted over `unlocks.payer_id`, the tenant key: distinct ORGS in `on` (O-3).
        const cap = await this.checkCaps(tx, workerId);
        if (cap) {
          const row = await this.repo.recordDeny(tx, {
            payerId: tenant,
            workerId,
            jobId: jobContext,
            jobPostingId,
            denyReason: "capped",
          });
          // Order preserved: cap_exceeded THEN denied (unchanged from emit-in-tx).
          events.push(() => this.emitCapExceeded(party, workerId, cap, ctx));
          events.push(() => this.emitDenied(row.id, party, workerId, jobContext, "capped", ctx));
          return { response: neutralUnavailable(), events };
        }

        // ---- [3] PAYMENT / credit debit (atomic with [4] grant; F-6) ----------
        //
        // Middle Way P5 price-tier HOOK (spec §4.1). The tier is READ here, from the
        // worker's stated rungs at grant time — and then deliberately NOTHING happens
        // with it: the debit below stays exactly one credit (₹40 flat live), and the
        // tier rides only this log line (ids + tier, no PII). When the CEO rules the
        // Higher/Lower prices, THIS is the call site that quotes them: the rung read
        // is done, the debit is the one expression to change, and the log proves the
        // tiers were already flowing before money ever depended on them.
        // Each rung is priced by ITS OWN trade's sheet (A4 item 8): a PLC technician prices
        // Higher, an electrician technician Lower — same key, two sheets.
        const priceTier = priceTierForTradeRows(
          (await this.repo.findTradeLevels(tx, workerId)).map((r) => ({
            skillId: r.skillId,
            tradeLevel: normalizeTradeLevelKey(r.tradeLevel),
          })),
        );
        this.logger.log(
          `unlock price tier worker=${workerId} tier=${priceTier} job=${jobContext ?? "none"}`,
        );
        // The TENANT's wallet row: in `on`, two members spending at once serialize on the org
        // wallet's row lock inside this UPDATE, so the team can never overdraw it.
        const debit = await this.payments.debitOneCreditWithinTx(tx, tenant);
        if (!debit.ok) {
          // Lost a concurrent debit race after the precondition — or (#2749) a lot fell due
          // since the precondition read — collapse to neutral (still no worker-state oracle;
          // consent already passed but the BODY is neutral). The wallet helper wrote NOTHING on
          // this path: no expiry, no lot, no balance.
          events.push(() => this.emitPaymentFailed(null, party, "insufficient_credits", ctx));
          return { response: neutralUnavailable(), events };
        }
        // #2749 — one `payer.credits_expired` per lot this spend expired before it spent, written
        // on THIS transaction (`tx`), not deferred: the event commits or rolls back with the
        // expiry, so a committed expiry can never lose its event. Safe under the worker lock
        // because `EventsService.emit({ tx })` does no global-pool I/O (it validates in memory
        // and inserts on the executor it is given) — the deadlock rule above is about the pool.
        for (const lot of debit.expiredLots) {
          await this.emitCreditsExpired(party, lot, ctx, tx as unknown as Database);
        }

        // ---- [4] GRANT (same tx) ----------------------------------------------
        const now = new Date();
        // #2747 — open for good with `contact_rules` on; the 14-day window otherwise.
        const expiresAt = openForGood
          ? OPEN_FOR_GOOD_UNTIL
          : new Date(now.getTime() + UNLOCK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const routingTokenRef = randomUUID(); // 122-bit, server-internal only (F-4)
        const granted = await this.repo.upsertGrant(tx, {
          payerId: tenant,
          workerId,
          jobId: jobContext,
          jobPostingId,
          routingTokenRef,
          grantedAt: now,
          expiresAt,
        });
        // Ledger debit in the SAME tx, on the SAME key as the wallet it debited (balance +
        // ledger never drift; F-6 — and `balance = Σ delta` per payer_id holds, ADR-0053 §6),
        // naming the lot the credit came from (#2749: one line per lot; one credit, one lot).
        await this.repo.appendLedger(tx, {
          payerId: tenant,
          delta: -1,
          reason: "unlock_debit",
          unlockId: granted.id,
          lotId: debit.lotId,
        });

        // Order preserved: payment.authorized → payment.captured → unlock.granted.
        events.push(() => this.emitPaymentAuthorized(granted.id, party, ctx));
        events.push(() => this.emitPaymentCaptured(granted.id, party, ctx));
        events.push(() =>
          this.emitGranted(granted.id, party, workerId, jobContext, expiresAt, ctx),
        );
        // E0 C-1 (owner ruling 2026-09-21, route ii-v2) — THE WORKER IS TOLD HE WAS UNLOCKED.
        // Deferred like its siblings so an emit failure costs a notification, never the grant:
        // the grant is committed, the event is the audit trail (F-4). Idempotency-keyed on the
        // unlock, so an at-least-once flush records it once. Only on a NEW grant — the early
        // idempotent-replay branch above returns before this, so a payer re-requesting a live
        // unlock cannot re-notify the worker.
        events.push(() => this.emitProfileViewedV2(granted.id, party, workerId, jobContext, ctx));
        // §X.6 — a granted unlock is LEG 2 of the ₹20 activation-bonus rule (the leg a
        // fraudster cannot fake, because it costs a paying party money). Deferred like the
        // emits above, so it runs POST-COMMIT and inherits flushEvents' log-and-continue:
        // a Redis blip costs a (recoverable, idempotent) accrual, never the unlock.
        events.push(() => this.enqueueReferralBonusEvaluation(workerId));

        // ── ADR-0036 §7 — THE CONVERSION SIGNAL ──────────────────────────────
        // The balance landed on ZERO. This is the moment the whole conversion engine
        // fires on, so it is EXACT, not approximate:
        //  * it reads `debit.balanceAfter` — the value the ATOMIC conditional decrement
        //    RETURNED — never a re-read, which would race a concurrent debit and could
        //    report zero twice or miss it entirely;
        //  * it fires only on the `>0 → 0` transition, which is structural here: the
        //    debit updated a row only if `balance >= 1`, so `balanceAfter === 0` means
        //    the balance was exactly 1 before;
        //  * it is keyed on the debiting unlock, so an at-least-once replay of the
        //    post-commit flush records it once.
        if (debit.balanceAfter === 0) {
          events.push(() => this.emitCreditsExhausted(party, granted.id, ctx));
        }

        return { response: this.grantedResponse(granted.id, expiresAt, openForGood), events };
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
    // ADR-0053 — the payer route names its session payer; the unlock it may reveal is its
    // TENANT's (in `on`, any member of the org may reveal the org's unlock). Resolved once,
    // before anything else. The ops route names no payer and is unaffected.
    const scope =
      expectedPayerId === undefined ? undefined : await this.tenancy.resolve(expectedPayerId);
    // #2747 — the company route only (the ops route keeps the window): with `contact_rules` on and
    // the brief's rules applying to him (resolved with his consent below), an open contact is
    // revealed whatever its date and its dates are stored "for good". A pilot-list read error is off
    // here: a reveal charges nothing, so off is the safe answer.
    const rulesOn = scope !== undefined && (await this.contactRulesOn(scope.tenantKey));
    let openForGood = false;
    // Consent re-check BEFORE the advisory lock (same pool-vs-lock deadlock fix as
    // requestUnlock): a tx-external consent read inside the locked tx would need a 2nd
    // pool connection while concurrent reveals on this worker hold theirs → deadlock.
    // Resolve the unlock's worker via a tx-external projection read and check consent
    // here. RR-3: the revoke-vs-reveal TOCTOU is irreducible; the window stays minimal
    // (lock-acquire + the in-tx validations) and the threat model already accepts it —
    // eliminating the deadlock outweighs the marginal widening. A missing/own-by-other
    // unlock falls through to the tx, which returns the IDENTICAL neutral body (F-3).
    const pre = await this.repo.getProjection(unlockId);
    // XB-A (payer-self path, ADR-0019): a payer may reveal ONLY their own tenant's unlock. A
    // not-owned (or unknown) unlock returns the IDENTICAL neutral body — never a 403 —
    // so a payer learns nothing about other tenants' unlocks (no-oracle, mirrors F-3).
    // Ops callers (InternalServiceGuard) pass no expectedPayerId and are UNAFFECTED.
    if (pre && scope !== undefined && pre.payer_id !== scope.tenantKey) {
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
    if (pre && pre.worker_id !== null && (await this.isPayerSurfaceFrozen(pre.worker_id)))
      return neutralUnavailable();
    // #2752 — the institute rule is asked about the company that HOLDS this unlock (the ops
    // route included), by the unlock's id: its holder is read in SQL, never passed as a raw id.
    if (pre && pre.worker_id !== null) {
      const access = await this.contactAccess(pre.worker_id, { unlockId }, ctx);
      if (!access.openable) return neutralUnavailable();
      openForGood = rulesOn && access.brief;
    }

    // F-3: unknown/expired/over-cap/revoked all return the NEUTRAL body (not a 404).
    // The transaction does ALL the DB work + returns WHICH events to emit; it does NOT
    // emit (same deadlock fix as requestUnlock — contact.revealed/cap_exceeded used the
    // GLOBAL pool while this tx held the advisory lock + a connection). Emit post-commit.
    const { response, events: deferred } = await this.repo.withTransaction<TxResult<RevealOutcome>>(
      async (tx): Promise<TxResult<RevealOutcome>> => {
        const events: DeferredEmit[] = [];

        const unlock = await this.repo.findByIdForUpdate(tx, unlockId);
        if (!unlock) return { response: neutralUnavailable(), events };
        // Ownership, re-asserted on the LOCKED row (ADR-0053): the pre-lock check above only
        // runs when the projection existed then. A row that was absent at that read and is
        // present now is held to the same rule — same neutral body.
        if (scope !== undefined && unlock.payerId !== scope.tenantKey) {
          return { response: neutralUnavailable(), events };
        }
        // ADR-0026 Phase 5: a hard-deleted worker SET-NULLs worker_id. The grant row survives
        // (billing history) but cannot be relayed — guard BEFORE lockWorker/relay/emit so a
        // null worker_id never reaches them; return the IDENTICAL neutral body (no oracle).
        if (unlock.workerId === null) return { response: neutralUnavailable(), events };
        // ADR-0031: pending-deletion guard beside the SET-NULL guard above — a frozen
        // worker is not relayable, so short-circuit BEFORE even taking the worker lock.
        // ONE cheap tx-SCOPED pk read (a global-pool read inside the locked tx would
        // recreate the pool-vs-lock deadlock); a gone row is the same neutral.
        const marker = await this.repo.getWorkerDeletionMarker(tx, unlock.workerId);
        if (
          !marker ||
          marker.deletionScheduledAt !== null ||
          marker.status === "suspended"
        )
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
        // ADR-0053 §7 — the payer route's events name the acting login on the envelope and the
        // tenant (this row's owner, checked above) in the payload; the ops route has no login
        // of its own, so the row's owner is both — exactly as before.
        const party = scope !== undefined ? partyOf(scope) : rowOwnerParty(fresh.payerId);

        // ADR-0031 TOCTOU re-read UNDER the lock (mirrors the worker-gone re-guard
        // above): a deletion scheduled in the lock-acquire window must still freeze —
        // the marker is re-read on this txn's view before any relay/decrypt.
        const freshMarker = await this.repo.getWorkerDeletionMarker(tx, freshWorkerId);
        if (
          !freshMarker ||
          freshMarker.deletionScheduledAt !== null ||
          freshMarker.status === "suspended"
        )
          return { response: neutralUnavailable(), events };

        // Must be an OPEN grant (`isOpenGrant`, the one definition): granted/revealed, and either
        // unexpired or — #2747, `contact_rules` on — whatever its date.
        if (!isOpenGrant(fresh, { openForGood }) || fresh.routingTokenRef === null) {
          return { response: neutralUnavailable(), events };
        }
        // #2747 — a lapsed past open, revealed while the rule is on, is stored "for good" (grant
        // and relay row), so the relay it reveals stays usable and a later rollback keeps it open.
        if (openForGood && needsOpenForGoodDate(fresh)) {
          await this.repo.extendOpenUntil(tx, fresh.id, OPEN_FOR_GOOD_UNTIL);
        }
        const openUntil: Date = openForGood ? OPEN_FOR_GOOD_UNTIL : fresh.expiresAt!;

        // P-021 — read the routing row first (see [5] below): a repeat reveal re-uses it.
        let routing: UnlockRouting | undefined = await this.repo.findRoutingByUnlock(tx, fresh.id);

        // Per-unlock attempt cap (F-2 atomic; under the worker lock). #2747 — with `contact_rules`
        // on it limits FIRST opens only: once the relay is wired, a repeat reveal hands back the
        // same handle and reads nothing new, so it is never refused for the count.
        if (
          !(openForGood && routing !== undefined) &&
          fresh.revealCount >= this.config.UNLOCK_MAX_ATTEMPTS_PER_UNLOCK
        ) {
          events.push(() => this.emitCapExceeded(party, freshWorkerId, "attempts_per_unlock", ctx));
          return { response: neutralUnavailable(), events };
        }

        // Consent was re-checked just above, BEFORE the lock (deadlock fix). Per RR-3
        // the revoke-vs-reveal TOCTOU is irreducible; the remaining window is the
        // lock-acquire + the validations below, which is accepted.

        // ---- [5] ROUTED REVEAL — the ONLY place the raw phone is decrypted ------
        // It is read transiently to wire the in-app relay, then DISCARDED. It is NEVER
        // returned, evented, logged, stored, or placed in an exception (F-5). ALL
        // failures map to the neutral path (fail closed).
        //
        // P-021 (owner ruling 2026-09-21, idempotent direction) — ONE ROUTING ROW PER
        // UNLOCK, AND THE SAME HANDLE ON EVERY REVEAL. `routing_token` is minted once per
        // GRANT and carries a unique index, so the old blind insert made reveal 2 of the
        // cap-permitted 3 violate the constraint and escape as a 500 — a crash AND a
        // distinct observable beside a surface whose every denial is one neutral body.
        // Reading first (under the worker lock taken above, so two concurrent reveals
        // cannot both miss) means a repeat reveal never re-inserts, never re-decrypts the
        // phone, and answers with the handle the payer already holds.
        const channel: RoutingChannel = "in_app_relay"; // alpha: discloses no number
        const wiredBefore = routing !== undefined;
        if (!routing) {
          let relayHandle: string;
          try {
            relayHandle = await this.wireInAppRelay(freshWorkerId, fresh.id);
          } catch {
            // Do NOT surface the error (it could embed the phone). Log id + class only.
            this.logger.warn(`reveal failed for unlock=${fresh.id}: relay_wire_error`);
            return { response: neutralUnavailable(), events };
          }

          routing = await this.repo.createRouting(tx, {
            unlockId: fresh.id,
            routingToken: fresh.routingTokenRef!, // server-internal; NEVER returned (F-4)
            channel,
            relayHandle,
            // Handle expires with the unlock window (#2747: "for good" while the rule is on).
            expiresAt: openUntil,
          });
        }
        // #2747 — a REPEAT reveal of a wired relay while the brief's rules apply re-reads nothing
        // and is not counted: `reveal_count` feeds the per-worker daily caps, so counting it would
        // let one company lock every other company out of this worker for a day.
        const repeat = openForGood && wiredBefore;
        const revealCount = repeat
          ? fresh.revealCount
          : await this.repo.incrementReveal(tx, fresh.id);
        // Bound to a const so the deferred closure below carries a definitely-assigned
        // row (TypeScript will not narrow a mutable `let` through a closure).
        const routingRow: UnlockRouting = routing;

        // The routing TOKEN never leaves this row (F-4); only the KIND is evented.
        events.push(() =>
          this.emitRevealed(fresh.id, party, freshWorkerId, routingRow.channel, revealCount, ctx),
        );

        return {
          response: {
            relay_handle: routingRow.relayHandle, // opaque, non-reversible, expiring — NOT a phone
            channel: routingRow.channel,
            expires_at: routingRow.expiresAt.toISOString(),
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

  // ===========================================================================
  // GET /payer/unlocks/:id/contact  —  what a credit opens, on screen (#2747 item 5)
  // ===========================================================================
  /**
   * The full name and phone number of a contact the company OPENED (ADR-0064 §3.3, brief 4B.6).
   * This reverses ADR-0010 Decision 2 (the number never crossed the API) for the company that
   * paid, and only while `contact_rules` is on for it.
   *
   * THE LADDER — every refusal is the ONE neutral body (no oracle), checked in this order:
   *   1. the switch is on for the company (off: 404, the route is not there);
   *   2. the unlock exists and belongs to the company's TENANT (another tenant's is neutral);
   *   3. the worker still exists (erasure SET-NULLs `worker_id`) and the grant is OPEN
   *      (`isOpenGrant` — granted/revealed, any date while the rule is on);
   *   4. he is not a sample candidate (R74), not pending deletion or suspended (ADR-0031) — the
   *      freeze re-read on the row that is decrypted;
   *   5. the company may still open him, AND the brief's rules apply to him (§3.8): his latest
   *      consent carries `employer_sharing` on a notice that describes them, or for an actively
   *      linked RVM student the institute rule (`contactAccess`, the reads the grant used).
   *   "For good" cannot outlive 3–5: an erasure, a deletion freeze or a withdrawn consent closes it.
   *
   * AUDIT BEFORE DISCLOSURE. `contact.viewed` is written first; if it cannot be written, the
   * request fails and no number leaves. The per-login hourly limit is the controller's.
   *
   * Never cached (`Cache-Control: no-store` on the route), never logged: the decrypted values live
   * for this one response. Not a FIRST open, so the attempt and per-worker caps (written for the
   * relay's first opens) do not apply. Latency-padded like the reveal (R21).
   *
   * @throws NotFoundException while `contact_rules` is off for the company.
   */
  async readContact(
    unlockId: string,
    payerId: string,
    ctx: RequestContext,
  ): Promise<ContactReadResponse | NeutralUnavailableResponse> {
    const start = Date.now();
    try {
      const scope = await this.tenancy.resolve(payerId);
      if (!(await this.contactRulesOn(scope.tenantKey))) throw new NotFoundException();

      const unlock = await this.repo.getProjection(unlockId);
      if (!unlock || unlock.payer_id !== scope.tenantKey) return neutralUnavailable();
      if (unlock.worker_id === null) return neutralUnavailable();
      const workerId: string = unlock.worker_id;
      if (
        !isOpenGrant(
          { status: unlock.status, expiresAt: unlock.expires_at },
          { openForGood: true },
        )
      ) {
        return neutralUnavailable();
      }
      // R74 — a sample candidate is not a person (an unlock of one made before R74 still exists).
      if (isSampleWorkerId(workerId)) return neutralUnavailable();
      if (await this.isPayerSurfaceFrozen(workerId)) return neutralUnavailable();
      // His consent, AND the brief's rules (§3.8): a worker on the 2026-11-04 notice agreed to
      // initials and 14 days, so his number never reaches this screen.
      const access = await this.contactAccess(workerId, { unlockId }, ctx);
      if (!access.openable || !access.brief) return neutralUnavailable();

      const contact = await this.decryptContact(workerId, unlock.unlock_id);
      if (contact === null) return neutralUnavailable();

      await this.emitContactViewed(unlock.unlock_id, partyOf(scope), workerId, ctx);
      return {
        ok: true,
        full_name: contact.fullName,
        phone: contact.phone,
        opened_at: unlock.granted_at === null ? null : unlock.granted_at.toISOString(),
      };
    } finally {
      await this.padToTarget(start);
    }
  }

  /**
   * #2747 — THE CONTACT READ'S decrypt site (ADR-0064 §3.3; the BC-5 static guard names it): the
   * phone number and the full name, for one response. Never logged, evented, stored or put in an
   * exception. A phone that does not decrypt is the neutral body (logged by unlock id); a name that
   * does not decrypt is "not given".
   */
  private async decryptContact(
    workerId: string,
    unlockId: string,
  ): Promise<{ phone: string; fullName: string | null } | null> {
    let worker: Awaited<ReturnType<WorkersRepository["findById"]>>;
    try {
      worker = await this.workers.findById(workerId);
    } catch {
      this.logger.warn(`contact read failed for unlock=${unlockId}: worker_read_error`);
      return null;
    }
    if (!worker?.phoneE164) return null;
    // ADR-0031 — re-checked on the SAME row that is decrypted, so a deletion scheduled (or a
    // suspension) while the consent read above ran still closes the contact.
    if (worker.deletionScheduledAt !== null || worker.status === "suspended") return null;
    let phone: string;
    try {
      phone = this.pii.decrypt(worker.phoneE164);
    } catch {
      this.logger.warn(`contact read failed for unlock=${unlockId}: decrypt_error`);
      return null;
    }
    let fullName: string | null = null;
    if (worker.fullName) {
      try {
        const name = this.pii.decrypt(worker.fullName).trim();
        fullName = name === "" ? null : name;
      } catch {
        this.logger.warn(`contact read: full_name did not decrypt for unlock=${unlockId}`);
      }
    }
    return { phone, fullName };
  }

  /**
   * #2747 — a held contact re-opened while the brief's rules apply: its dates moved to "for good",
   * no credit spent. Ids only; deferred post-commit like the grant's events.
   */
  private async emitReopened(
    unlockId: string,
    party: EventParty,
    workerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"unlock.reopened"> = {
      unlock_id: unlockId,
      payer_id: party.payerId,
      worker_id: workerId,
    };
    await this.events.emit({
      event_name: "unlock.reopened",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `unlock.reopened:${unlockId}`,
    });
  }

  private async emitContactViewed(
    unlockId: string,
    party: EventParty,
    workerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"contact.viewed"> = {
      unlock_id: unlockId,
      payer_id: party.payerId,
      worker_id: workerId,
    };
    await this.events.emit({
      event_name: "contact.viewed",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
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
  /**
   * Ops: the unlocks of the tenant `payerId` acts in (ADR-0053 §5.2 rule 4 — the ops route's
   * payer id goes through the same resolver). In `off` that is `payerId`'s own rows.
   */
  async listByPayer(payerId: string): Promise<{ unlocks: UnlockProjection[] }> {
    const scope = await this.tenancy.resolve(payerId);
    return { unlocks: await this.repo.listByPayer(scope.tenantKey) };
  }

  /**
   * #2033 — the SESSION payer's tenant's unlocks on the payer contract (GET /payer/unlocks):
   * only payer-visible rows (internal `requested` / `denied` rows are filtered in SQL, so they
   * neither leak nor consume the list cap), with `expired` derived from `expires_at`. See
   * {@link toPayerUnlocks}. In mode `on` a team member sees the org's unlocks (ADR-0053 §3.3).
   * Read-only: no event.
   */
  async listOwnForPayer(
    payerId: string,
    now: Date = new Date(),
  ): Promise<{ unlocks: PayerUnlockProjection[] }> {
    const scope = await this.tenancy.resolve(payerId);
    const rows = await this.repo.listByPayerWithStatus(
      scope.tenantKey,
      PAYER_VISIBLE_STORED_STATUSES,
    );
    // #2747 — the list reads STORED dates: a contact opened, re-opened or revealed for good never
    // reads `expired` (`open_until: null`). Whether a lapsed one would re-open free depends on the
    // worker's own notice (§3.8), which a list of rows does not read; `POST /payer/unlocks` answers it.
    return { unlocks: toPayerUnlocks(rows, now) };
  }

  async getOne(unlockId: string): Promise<UnlockProjection | undefined> {
    return this.repo.getProjection(unlockId);
  }

  /**
   * The balance of the wallet `payerId` spends from: the org wallet in mode `on` (the anchor's
   * existing row, O-1), never a member's personal pre-team balance (O-2), and `payerId`'s own
   * wallet in `off`. `payer_id` in the response echoes the CALLER, not the wallet (ADR-0053 §10).
   *
   * #2749 — plus the wallet's OPEN lots in spend order (soonest expiry first, never-expiring
   * last): source, what is left, what it granted, when it ends and its pack. Additive: a reader
   * that knows only `{ payer_id, balance }` is unaffected. Two non-tx reads, so a purchase landing
   * between them can show a lot the balance does not include yet (the next read agrees).
   */
  async getCredits(payerId: string): Promise<PayerCreditsResponse> {
    const scope = await this.tenancy.resolve(payerId);
    const [balance, lots] = await Promise.all([
      this.repo.getBalance(scope.tenantKey),
      this.repo.listOpenLots(scope.tenantKey),
    ]);
    return { payer_id: payerId, balance, lots };
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
   * The ledger of the wallet the SESSION payer spends from (the append-only movements behind
   * the balance), newest first, bounded by `limit` — the org wallet's in mode `on`. PII-free by
   * table design. `payer_id` in the response echoes the caller. Read-only — no event.
   */
  async getCreditLedger(
    payerId: string,
    limit: number,
  ): Promise<{ payer_id: string; ledger: CreditLedgerItem[] }> {
    const scope = await this.tenancy.resolve(payerId);
    return {
      payer_id: payerId,
      ledger: await this.repo.listCreditLedgerByPayer(scope.tenantKey, limit),
    };
  }

  // ===========================================================================
  // Credits (MOCK pack purchase — alpha; real Razorpay is a later human-gated stream)
  // ===========================================================================
  async purchaseCredits(
    payerId: string,
    packCode: string,
    ctx: RequestContext,
    expectedPriceInr?: number,
  ): Promise<{ payer_id: string; balance: number; credits: number; pack_code: string } | null> {
    // ADR-0053 — any member's purchase credits the ORG wallet in mode `on` (O-1; owner ruling
    // 2026-10-07, any authenticated payer may buy). Resolved once, before the catalog read.
    const scope = await this.tenancy.resolve(payerId);
    // D-6: resolved from the LIVE catalog so the price + credits CHARGED are the same ones the
    // portal DISPLAYED. #2749: only a pack the catalogue lists AND has on sale resolves.
    const pack = await this.payments.resolvePack(packCode);
    if (!pack) return null; // unknown or off-sale pack → 404 (NOT the unlock no-oracle path)
    // #2085: the ₹ the payer confirmed must be the ₹ charged — refused (409) BEFORE the
    // ledger write, so a mismatch grants and records nothing.
    assertExpectedPrice(expectedPriceInr, pack.priceInr);

    const result = await this.payments.purchasePackMock(scope.tenantKey, pack);
    const party = partyOf(scope);
    // Mock purchase audit: authorized + captured, real_call:false (mock honesty, F-6).
    await this.emitPaymentAuthorized(null, party, ctx, {
      packCode: pack.code,
      amountInr: result.priceInr,
      amountCredits: result.credits,
    });
    await this.emitPaymentCaptured(null, party, ctx, {
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
   * Returns null for an unknown or off-sale pack (#2749) (→ the caller's 404 — a pack code is
   * a public catalog item, not a per-tenant resource, so a 404 leaks nothing).
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
    expectedPriceInr?: number,
  ): Promise<RealOrderHandoff | null> {
    // ADR-0053 §6 — the order is STAMPED with the tenant's wallet at intent; settlement credits
    // that wallet and never re-resolves.
    const scope = await this.tenancy.resolve(payerId);
    const pack = await this.payments.resolvePack(packCode);
    if (!pack) return null;
    // #2085: refused BEFORE the provider order and the payment_orders row exist.
    assertExpectedPrice(expectedPriceInr, pack.priceInr);

    const order = await this.payments.createRealOrder(scope.tenantKey, pack);

    await this.emitPaymentAuthorized(null, partyOf(scope), ctx, {
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
   * cannot produce that HMAC. Ownership is additionally bound to the SESSION payer's TENANT
   * (ADR-0053 §6): the order's stamped wallet must be the caller's, so in mode `on` any member
   * may verify the org's order, and the credits land where the order was stamped.
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

    // ADR-0053 — resolved after the two pure checks above (no DB read before them), once.
    const scope = await this.tenancy.resolve(payerId);
    const result = await this.settleAndEmit(
      {
        providerOrderId: input.orderId,
        providerPaymentRef: input.paymentId,
        // Ownership is enforced INSIDE settle: a mismatch is indistinguishable from
        // "no such order", so this endpoint is not an order-id oracle for other tenants.
        expectedTenantKey: scope.tenantKey,
      },
      ctx,
      scope.actorPayerId,
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
        // The wallet the order was stamped with (checked equal to the tenant inside settle);
        // read with the scope already resolved — never re-resolved (ADR-0053 §5.2 rule 1).
        const balance = await this.repo.getBalance(scope.tenantKey);
        return {
          verified: true,
          payer_id: payerId,
          balance,
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
      // Razorpay is speaking, not a login: the order's stamped wallet is both actor and payer.
      await this.emitPaymentFailed(null, rowOwnerParty(order.payerId), "gateway_error", ctx, {
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
        // NO expectedTenantKey: the webhook is Razorpay speaking, not a tenant — the order
        // row itself names the wallet to credit (stamped at intent, ADR-0053 §6).
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
   *
   * ADR-0053 §7: the payload names the WALLET the order was stamped with; the envelope names
   * `actorPayerId` — the member who verified — or, on the webhook (no login acted), the wallet.
   */
  private async settleAndEmit(
    input: { providerOrderId: string; providerPaymentRef: string; expectedTenantKey?: TenantKey },
    ctx: RequestContext,
    actorPayerId?: string,
  ): Promise<SettleResult> {
    const result = await this.payments.settleOrder(input);
    if (result.outcome === "granted") {
      const wallet = result.order.payerId;
      await this.emitPaymentCaptured(null, { actorId: actorPayerId ?? wallet, payerId: wallet }, ctx, {
        packCode: result.order.packCode,
        amountInr: result.priceInr,
        amountCredits: result.credits,
        // Keyed on the ORDER ROW: even if both channels somehow reached the emit, the
        // events table would still hold exactly one capture for this order.
        idempotencyKey: `payment.captured:order:${result.order.id}`,
      });
      await this.alertIfPayerSuspended(result.order.payerId, result.order.id, ctx);
    }
    return result;
  }

  /**
   * ADR-0037 Decision 6 — a real payment was captured and credited for a SUSPENDED payer.
   * Raise a Finance/Admin alert. Do NOT reject, and do NOT withhold the credit.
   *
   * The money is ALREADY TAKEN by the time this webhook arrives, and this codebase has no
   * refund path of any kind. Refusing the credit would leave the platform holding funds with
   * no ledger entry against them — strictly worse than crediting an account that cannot
   * spend, because every spending route sits behind `PayerAuthGuard`, which requires
   * `active`. So the grant stands, the credits are inert until reinstatement, and a human
   * is told.
   *
   * Placed in `settleAndEmit`, the ONE settle path both channels share, so the alert fires
   * whether the capture arrived by webhook or by the verified browser fallback. Putting it
   * in the webhook controller would have covered only one of the two.
   *
   * FAIL-OPEN, DELIBERATELY. This is an alert about money that has already changed hands;
   * if the status read or the emit fails, the correct outcome is still a completed,
   * granted payment. Throwing here would turn a successful capture into a 5xx, which makes
   * Razorpay redeliver a payment we already settled — trading a missing notification for a
   * retry storm on the money path. The failure is logged loudly instead.
   */
  private async alertIfPayerSuspended(
    payerId: string,
    orderId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      const facts = await this.payers.findAuthFacts(payerId);
      // #2564 - money captured for an ARCHIVED company is the same ops problem; same alert.
      if (!isBarredPayerStatus(facts?.status)) return;
      await this.events.emit({
        event_name: "payer.suspended_payment_captured",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "payer", subject_id: payerId },
        // Keyed on the ORDER, so a redelivered webhook cannot raise a second alert for the
        // same payment. (The capture itself is already idempotent one layer up; this keeps
        // the alert exactly as once-only as the money it describes.)
        idempotencyKey: `payer.suspended_payment_captured:order:${orderId}`,
        payload: { payer_id: payerId, order_id: orderId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      this.logger.warn(
        `payment captured for a SUSPENDED payer; credits granted but unspendable until ` +
          `reinstatement — finance review needed payer=${payerId} order=${orderId}`,
      );
    } catch (err) {
      this.logger.error(
        `could not raise the suspended-payer capture alert (the payment itself SUCCEEDED ` +
          `and is unaffected) payer=${payerId} order=${orderId} reason: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Two questions from ONE set of reads.
   *
   * `openable` — may this company open this worker (#2752 item 9)? An actively linked institute
   * student is decided by the institute rule alone, whatever his own BadaBhai consent says (the tag
   * rule wins while the link is active); every other worker by his LATEST consent row: unrevoked
   * and carrying the exact `employer_sharing` purpose (profiling consent does not substitute).
   *
   * `brief` — #2747 (ADR-0064 §3.8): do the brief's contact rules apply to him — open for good, his
   * full name and phone on screen? For an RVM student the institute rule answers it (RVM's consent
   * line, brief 9). Any other worker also needs that consent given on a notice that describes those
   * rules (`onBriefNotice`): on the 2026-11-04 notice (14 days, initials) it is false, whatever the
   * company's switch says. `brief` implies `openable`. Both fail closed.
   */
  private async contactAccess(
    workerId: string,
    opener: InstituteOpener,
    ctx: RequestContext,
  ): Promise<{ openable: boolean; brief: boolean }> {
    const institute = await this.instituteGate.decide(workerId, opener, ctx);
    if (institute !== "not_linked") {
      const open = institute === "open";
      return { openable: open, brief: open };
    }
    let latest: Awaited<ReturnType<ConsentRepository["findLatestByWorker"]>>;
    try {
      latest = await this.consents.findLatestByWorker(workerId);
    } catch {
      return { openable: false, brief: false }; // fail closed
    }
    const openable =
      latest !== undefined &&
      latest.revokedAt === null &&
      ((latest.purposes ?? []) as string[]).includes(EMPLOYER_SHARING);
    return { openable, brief: openable && onBriefNotice(latest) };
  }

  /**
   * The LATEST unrevoked consent row's purposes, or null (no row / revoked / read error).
   *
   * ONE read, TWO callers — and that is the C-3 property made structural. `employer_sharing`
   * (disclosure) and `employer_messaging` (the ninth purpose, §A ruling) are separate grants,
   * so the relay's use-time check needs BOTH from the SAME row; a second reader would be free
   * to resolve a different row and let a worker who used the E0-C2 exit keep receiving
   * messages from payers who unlocked him before he left.
   */
  private async latestConsentPurposes(workerId: string): Promise<string[] | null> {
    try {
      const latest = await this.consents.findLatestByWorker(workerId);
      if (!latest || latest.revokedAt !== null) return null;
      return (latest.purposes ?? []) as string[];
    } catch {
      return null; // fail closed
    }
  }

  /** Both employer-contact purposes, unrevoked, on the LATEST row — the relay invariant. */
  private async isConsentedForEmployerContact(workerId: string): Promise<boolean> {
    const purposes = await this.latestConsentPurposes(workerId);
    if (purposes === null) return false;
    return purposes.includes(EMPLOYER_SHARING) && purposes.includes(EMPLOYER_MESSAGING);
  }

  /**
   * E0 item 1 — RESOLUTION, SERVER-SIDE AND FAIL-CLOSED (`docs/agent/phases/E0_BUILD.md`).
   *
   * `relay_handle -> unlock_routing -> unlocks -> worker`, re-checked AT USE TIME rather
   * than trusted from grant time: the caller owns the unlock, the unlock is live
   * (`granted`/`revealed`, unexpired, and the routing row unexpired), the worker exists
   * (DSAR SET-NULL guard), is not pending deletion, and still holds BOTH employer-contact
   * purposes on the latest consent row. `null` means every one of those failed — and the
   * caller must serve the ONE neutral body, never a reason (`neutralUnavailable()`); a
   * distinguishing answer would be a worker-state oracle.
   *
   * NO PHONE IS READ, EVER, ON THIS PATH. The handle is the only input; no worker_id is
   * accepted or returned to the caller's wire.
   *
   * The try/catch is the fail-closed wall: a read error resolves to null, never to an
   * allow. This is a non-tx read path — it writes nothing on `unlocks`/`unlock_routing`
   * (single-writer stays structural) and needs no advisory lock.
   *
   * `tenant` is the caller's {@link TenantKey}, resolved ONCE by the relay service at its entry
   * point (ADR-0053): in mode `on` any member of the org may use the org's unlock's thread.
   */
  async resolveRelayForPayer(handle: string, tenant: TenantKey): Promise<RelayResolution | null> {
    try {
      const routing = await this.repo.findRoutingByHandle(handle);
      if (!routing) return null;
      const unlock = await this.repo.getProjection(routing.unlockId);
      if (!unlock) return null;
      // Ownership (XB-A): a payer resolves only their own tenant's unlock, and not-owned is
      // indistinguishable from unknown.
      if (unlock.payer_id !== tenant) return null;
      if (unlock.worker_id === null) return null; // DSAR SET NULL — a gone worker is not relayable
      if (!this.isLiveGrant(unlock)) return null;
      if (routing.expiresAt.getTime() <= Date.now()) return null; // handle expires with the window
      if (await this.isPayerSurfaceFrozen(unlock.worker_id)) return null;
      if (!(await this.isConsentedForEmployerContact(unlock.worker_id))) return null;
      return { unlockId: unlock.unlock_id, workerId: unlock.worker_id };
    } catch {
      return null; // fail closed
    }
  }

  /**
   * The WORKER half of the same ladder: the caller owns the unlock (worker_id), the grant
   * is live, the worker is not pending deletion, and both employer-contact purposes are
   * still held. Used by the worker's read/reply routes (E0 item 3) so a withdrawn
   * `employer_messaging` closes the worker's own reply path too — one ladder, both sides.
   */
  async resolveRelayForWorker(unlockId: string, workerId: string): Promise<RelayResolution | null> {
    try {
      const unlock = await this.repo.getProjection(unlockId);
      if (!unlock) return null;
      if (unlock.worker_id !== workerId) return null;
      if (!this.isLiveGrant(unlock)) return null;
      if (await this.isPayerSurfaceFrozen(workerId)) return null;
      if (!(await this.isConsentedForEmployerContact(workerId))) return null;
      return { unlockId: unlock.unlock_id, workerId };
    } catch {
      return null; // fail closed
    }
  }

  /**
   * Relay resolution reads the STORED dates (`isOpenGrant` with the rule off): a contact opened,
   * re-opened or revealed while `contact_rules` was on is stored "for good", so its relay stays
   * live; a lapsed past open the company has not touched since stays closed to the relay until it
   * re-opens or reveals it (both free with the rule on).
   */
  private isLiveGrant(unlock: UnlockProjection): boolean {
    return isOpenGrant(
      { status: unlock.status, expiresAt: unlock.expires_at },
      { openForGood: false },
    );
  }

  private async workerExists(workerId: string): Promise<boolean> {
    try {
      return (await this.workers.findById(workerId)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * #1903 (#1823 decision O9, owner ruling 2026-10-01) — the job context an unlock may store.
   *
   * `unlocks.job_id` is an FK to `jobs.id`, but the payer's `job_id` is any uuid the client
   * holds: payer-web sends a company posting's `job_postings.id`, and that insert violated
   * the FK — a 500 with the debit rolled back. So: null stays null, an existing `jobs` row
   * is kept, and ANY other id is stored (and evented) as null. A posting id therefore never
   * lands in a `jobs`-id field on the row or on the spine. #1903 shipped with no migration;
   * #2033 later added the additive `unlocks.job_posting_id` (0132), written only for an
   * OWNED posting on the `"payer_owned"` policy — never on an event.
   *
   * Existence, not openness: a closed `jobs` row still satisfies the FK and is still the
   * context the payer unlocked from. A read error PROPAGATES — the request fails before
   * anything is emitted, locked or debited, rather than guessing a context (fail closed).
   *
   * That is the `"normalise"` policy (the ops route). #1899 adds `"payer_owned"` for the
   * payer-session route, where the reference must also belong to the SESSION payer's tenant
   * (ADR-0053: in mode `on` a member may unlock from the org's postings) — see
   * {@link JobRefPolicy}.
   */
  private async resolveJobContext(
    jobId: string | null,
    tenant: TenantKey,
    policy: JobRefPolicy,
  ): Promise<JobContextResolution> {
    if (jobId === null) return { ok: true, jobContext: null, jobPostingId: null };
    if (policy === "normalise") {
      if (await this.repo.legacyJobExists(jobId)) {
        return { ok: true, jobContext: jobId, jobPostingId: null };
      }
      // ADR-0050 §4.5 (C5) — an agency TWIN id resolves to its SOURCE job, which the FK holds;
      // any other non-`jobs` id is stored as null exactly as #1903 stores it. The ops route never
      // captures a `job_posting_id` (#2033), and a twin's id is never one (C5).
      return {
        ok: true,
        jobContext: await this.repo.findAgencyTwinSourceJobId(jobId),
        jobPostingId: null,
      };
    }
    // #1899 — "payer_owned": the SESSION payer must own the reference. An owned `jobs` row is
    // kept (the FK holds it); an owned posting is accepted and stored as null exactly as #1903
    // stores it; unknown and foreign are the same refusal (no id oracle).
    const owned = await this.repo.findOwnedJobRef(jobId, tenant);
    if (owned !== null) {
      // #2033 — an owned posting is now KEPT on the row as `job_posting_id` (migration 0132), so
      // the payer's list can say which posting a grant came from. `job_id` and every event still
      // carry null for it, exactly as #1903 stores it.
      return owned.kind === "job"
        ? { ok: true, jobContext: owned.id, jobPostingId: null }
        : { ok: true, jobContext: null, jobPostingId: owned.id };
    }
    // ADR-0050 §4.5 — a twin has no owner (payer_id NULL, C2), so ownership is the SOURCE's: the
    // agency that owns the agency job may unlock from its twin's context. The unlock lands in the
    // SOURCE's id space — `job_id = source`, `job_posting_id` NULL — because a twin's own id never
    // becomes an unlock key (C5), and the twin is not a company posting #2033's column describes.
    // Anyone else gets the same refusal as an unknown or foreign id.
    const source = await this.repo.findAgencyTwinSourceJobId(jobId);
    if (source === null) return { ok: false };
    const ownedSource = await this.repo.findOwnedJobRef(source, tenant);
    if (ownedSource === null || ownedSource.kind !== "job") return { ok: false };
    return { ok: true, jobContext: source, jobPostingId: null };
  }

  /**
   * ADR-0031 payer-surface freeze (ruling (b)), extended by #2562: true when the worker has a
   * PENDING scheduled deletion OR is SUSPENDED. Both are "stop surfacing to payers"; every
   * caller denies with the byte-identical neutral body (no oracle). A suspended worker is
   * unfrozen by unsuspend, exactly as a cancelled deletion unfreezes the other case.
   *
   * Tx-EXTERNAL read (pre-lock only; the in-tx re-checks use the tx-scoped marker read -
   * deadlock rule). Fail closed: a read error counts as frozen (when in doubt, disclose nothing).
   */
  private async isPayerSurfaceFrozen(workerId: string): Promise<boolean> {
    try {
      const worker = await this.workers.findById(workerId);
      // A MISSING row is deliberately NOT frozen here: the tx below already answers a gone
      // worker with the same neutral body, and (for unlocks) it must still emit the
      // `unknown_worker` audit event. Freezing it early would silently drop that event.
      if (worker === undefined) return false;
      return worker.deletionScheduledAt !== null || worker.status === "suspended";
    } catch {
      return true; // fail closed on a read error
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

  /**
   * The one distinguishable success. `expires_at` stays a date string for the shipped apps; #2747
   * adds `open_until` (null = open for good, else the window's end).
   */
  private grantedResponse(
    unlockId: string,
    expiresAt: Date,
    openForGood: boolean,
  ): UnlockGrantedResponse {
    return {
      ok: true,
      unlock_id: unlockId,
      status: "granted",
      expires_at: expiresAt.toISOString(),
      open_until: openUntilOf(openForGood, expiresAt),
    };
  }

  // ---- Event emitters (all PII-free; ids + enums + counts only) -------------
  // ADR-0053 §7: each takes an {@link EventParty} — `actor.actor_id` is the acting login, every
  // payload payer reference is the tenant key. In mode `off` both are the session payer.

  private async emitRequested(
    party: EventParty,
    workerId: string,
    jobId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"unlock.requested"> = {
      unlock_id: randomUUID(), // a request id placeholder (no row yet); not the grant id
      payer_id: party.payerId,
      worker_id: workerId,
      job_id: jobId,
    };
    await this.events.emit({
      event_name: "unlock.requested",
      actor: { actor_type: "payer", actor_id: party.actorId },
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
    party: EventParty,
    workerId: string,
    jobId: string | null,
    expiresAt: Date,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"unlock.granted"> = {
      unlock_id: unlockId,
      payer_id: party.payerId,
      worker_id: workerId,
      job_id: jobId,
      expires_at: expiresAt.toISOString(),
    };
    await this.events.emit({
      event_name: "unlock.granted",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      idempotencyKey: `unlock.granted:${unlockId}`, // once-only
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * C-1 (E0, owner ruling 2026-09-21, route ii-v2) — TELL THE WORKER HE WAS UNLOCKED.
   *
   * THE THIRD HIT `E0_CHECK` DEMANDED. `profile.viewed` was registered with a faceless
   * notification template from the start, but NOTHING EVER EMITTED IT, so a worker's first
   * knowledge that a stranger holds his contact was the stranger's message. This emits the
   * v2 generation from the grant path; v1 keeps its definition, unmodified, as history
   * (CLAUDE.md §3 / invariant #8) — see `ProfileViewedV2Payload` for why the optional
   * `job_id` needed a new NAME rather than a relaxed v1.
   *
   * PII-FREE BY CONSTRUCTION: three opaque ids. The counterparty is `viewer_payer_id`,
   * never a key literally named `payer_id` — the worker Alerts feed's payload-shape ban
   * rejects the latter on purpose (notifications.service.test.ts), and naming this field
   * the v1 way is what keeps this event allowlistable at all.
   *
   * `job_id` IS OMITTED, never null: an unlock found by search carries no job context, nor
   * does one whose context was not a `jobs` row (#1903, {@link resolveJobContext}), and the
   * payload's optional field means the key simply does not appear.
   *
   * `viewer_payer_id` is the TENANT key (ADR-0053 §7): the company that holds the contact.
   */
  private async emitProfileViewedV2(
    unlockId: string,
    party: EventParty,
    workerId: string,
    jobId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"profile.viewed_v2"> = {
      worker_id: workerId,
      viewer_payer_id: party.payerId,
      ...(jobId === null ? {} : { job_id: jobId }),
    };
    await this.events.emit({
      event_name: "profile.viewed_v2",
      actor: { actor_type: "payer", actor_id: party.actorId },
      // The WORKER is the subject: the feed scopes on subject/actor/payload, and this
      // reads as a fact about the worker ("he was unlocked"), not about the unlock row.
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      idempotencyKey: `profile.viewed_v2:${unlockId}`, // once per grant, replay-safe
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitDenied(
    unlockId: string | null,
    party: EventParty,
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
      payer_id: party.payerId,
      worker_id: workerId,
      job_id: jobId,
      reason, // INTERNAL audit only — NEVER echoed to the payer (F-3)
    };
    await this.events.emit({
      event_name: "unlock.denied",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: unlockId
        ? { subject_type: "unlock", subject_id: unlockId }
        : { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitCapExceeded(
    party: EventParty,
    workerId: string,
    cap: "daily_reveals" | "weekly_payers" | "attempts_per_unlock",
    ctx: RequestContext,
  ): Promise<void> {
    const window = cap === "daily_reveals" ? "day" : cap === "weekly_payers" ? "week" : "unlock";
    const payload: PayloadInputOf<"unlock.cap_exceeded"> = {
      payer_id: party.payerId,
      worker_id: workerId,
      cap,
      window,
    };
    await this.events.emit({
      event_name: "unlock.cap_exceeded",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitRevealed(
    unlockId: string,
    party: EventParty,
    workerId: string,
    channel: RoutingChannel,
    revealCount: number,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"contact.revealed"> = {
      unlock_id: unlockId,
      payer_id: party.payerId,
      worker_id: workerId,
      channel, // KIND only — NEVER the number/handle/destination (F-5)
      reveal_count: revealCount,
    };
    await this.events.emit({
      event_name: "contact.revealed",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentAuthorized(
    unlockId: string | null,
    party: EventParty,
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
      payer_id: party.payerId,
      pack_code: extra?.packCode ?? null,
      amount_inr: extra?.amountInr ?? null,
      amount_credits: extra?.amountCredits ?? 1,
      real_call: this.payments.realCall, // honest flag: false on the mock path, true when live
    };
    const idempotencyKey =
      extra?.idempotencyKey ?? (unlockId ? `payment.authorized:${unlockId}` : undefined);
    await this.events.emit({
      event_name: "payment.authorized",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * #2749 — a lot the spend path expired, on the unlock transaction (`tx`): the event shares the
   * expiry's fate (see {@link creditsExpiredEvent}).
   */
  private async emitCreditsExpired(
    party: EventParty,
    lot: ExpiredCreditLot,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    await this.events.emit({
      ...creditsExpiredEvent({
        walletKey: party.payerId,
        lot,
        trigger: "spend",
        actor: { actor_type: "payer", actor_id: party.actorId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      }),
      tx,
    });
  }

  /**
   * ADR-0036 §7 — the payer's credit balance hit EXACTLY zero on this debit.
   *
   * `free_tier_credits` carries the size of the free-tier grant this payer started with
   * (`match_config.free_unlock_credits`), because "he used up his 50 free unlocks" and
   * "he used up a 1000-credit pack" are different conversion moments and the consumer
   * cannot tell them apart from the balance alone.
   *
   * FACELESS: an opaque payer id, an opaque unlock id, one integer. No email, no org
   * name, no worker.
   */
  private async emitCreditsExhausted(
    party: EventParty,
    unlockId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const cfg = await this.matchConfig.get();
    const payload: PayloadInputOf<"payer.credits_exhausted"> = {
      payer_id: party.payerId,
      unlock_id: unlockId,
      free_tier_credits: cfg.freeUnlockCredits,
    };
    await this.events.emit({
      event_name: "payer.credits_exhausted",
      actor: { actor_type: "payer", actor_id: party.actorId },
      // The subject is the WALLET that ran dry — the tenant's (ADR-0053 §7).
      subject: { subject_type: "payer", subject_id: party.payerId },
      payload,
      // Keyed on the DEBITING unlock: a post-commit flush replay re-emits at most one
      // audit row, and a payer who tops up and drains again gets a NEW event (a
      // different unlock id) rather than being silently deduped forever.
      idempotencyKey: `payer.credits_exhausted:${unlockId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentCaptured(
    unlockId: string | null,
    party: EventParty,
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
      payer_id: party.payerId,
      pack_code: extra?.packCode ?? null,
      amount_inr: extra?.amountInr ?? null,
      amount_credits: extra?.amountCredits ?? 1,
      real_call: this.payments.realCall,
    };
    const idempotencyKey =
      extra?.idempotencyKey ?? (unlockId ? `payment.captured:${unlockId}` : undefined);
    await this.events.emit({
      event_name: "payment.captured",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPaymentFailed(
    unlockId: string | null,
    party: EventParty,
    reason: "insufficient_credits" | "gateway_error",
    ctx: RequestContext,
    extra?: { idempotencyKey?: string },
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.failed"> = {
      unlock_id: unlockId,
      payer_id: party.payerId,
      reason,
      real_call: this.payments.realCall,
    };
    await this.events.emit({
      event_name: "payment.failed",
      actor: { actor_type: "payer", actor_id: party.actorId },
      subject: { subject_type: "unlock", subject_id: unlockId },
      payload,
      ...(extra?.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
