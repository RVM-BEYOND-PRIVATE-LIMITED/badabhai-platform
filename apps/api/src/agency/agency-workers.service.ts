import { Injectable } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AgencyWorkersRepository } from "./agency-workers.repository";

/** One referred worker as the agency portal sees him. PII-FREE by construction. */
export interface AgencyWorkerView {
  /**
   * A per-agency pseudonym, NOT the worker uuid.
   *
   * Two agencies who both referred the same man see two unrelated handles, so they
   * cannot collude to build a joint profile of him — and neither handle is the id
   * the rest of the platform uses, so it cannot be joined against anything an
   * agency might obtain elsewhere. Stable for one agency across requests, which is
   * what makes the list usable.
   */
  ref: string;
  profileComplete: boolean;
  appliedCount: number;
  unlockedCount: number;
  /** Coarse UTC day (`YYYY-MM-DD`), or null. Never a time of day. */
  lastActiveOn: string | null;
}

/**
 * B5 — "how are the workers I referred actually doing?" (ADR-0022 portal).
 *
 * THE PRODUCT QUESTION IS A FUNNEL QUESTION, so the answer is funnel-shaped:
 * did he finish his profile, is he applying, is anyone unlocking him, is he still
 * around. An agent needs that to know whether their referrals are worth anything.
 * They do not need, and never get: his name, his phone, WHICH jobs he applied to,
 * or WHO unlocked him.
 *
 * THREE INDEPENDENT PROTECTIONS, because one is never enough on a surface that
 * exposes a real person to a commercial party:
 *   1. CONSENT — the repository's SQL selects only workers carrying an active
 *      `agent_activity_visibility` consent. No consent, no row, ever.
 *   2. TENANCY — scoped to `agency_invites.inviter_payer_id`, so an agency sees
 *      only the workers it referred.
 *   3. PSEUDONYMITY — the worker uuid never leaves this service.
 *
 * NO EVENT IS EMITTED. This is a read that changes nothing, and one event per
 * agency dashboard refresh would fill the audit spine with noise while telling us
 * nothing we cannot get from the access log. The DECISIONS an agency takes
 * (minting an invite, requesting a payout) are evented where they happen.
 */
@Injectable()
export class AgencyWorkersService {
  /**
   * Hard cap on the list. An agency with thousands of referrals gets the most
   * recently active ones, not an unbounded scan — the same bound every other
   * faceless list on this portal carries.
   */
  static readonly MAX_ROWS = 200;

  constructor(
    private readonly repo: AgencyWorkersRepository,
    private readonly pii: PiiCryptoService,
  ) {}

  async listReferred(payerId: string): Promise<{ workers: AgencyWorkerView[] }> {
    const rows = await this.repo.listReferredWithConsent(payerId, AgencyWorkersService.MAX_ROWS);
    return {
      workers: rows.map((r) => ({
        // Keyed HMAC over (agency, worker). Including the PAYER id in the input is
        // what makes the pseudonym per-agency rather than global — without it, two
        // agencies would derive the SAME handle for a shared referral and could
        // join their lists. Truncated to 16 hex chars: enough that a collision is
        // not a practical concern at this scale, short enough to render.
        ref: this.pii.hmac(`agency_worker:${payerId}:${r.workerId}`).slice(0, 16),
        profileComplete: r.profileComplete,
        appliedCount: r.appliedCount,
        unlockedCount: r.unlockedCount,
        // Passed straight through. The repository formats the UTC day IN SQL
        // precisely so nothing here can shift it: an earlier version returned a
        // timestamptz and did `.toISOString().slice(0, 10)`, which on an IST server
        // rendered the PREVIOUS day (measured against a real Postgres, not guessed).
        lastActiveOn: r.lastActiveOn,
      })),
    };
  }
}
