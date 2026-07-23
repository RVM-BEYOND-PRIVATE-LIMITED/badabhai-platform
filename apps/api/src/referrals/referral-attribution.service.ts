import { Injectable, Logger } from "@nestjs/common";
import { ConsentRepository } from "../consent/consent.repository";
import { InviteService } from "../messaging/invite.service";
import { AgencyService } from "../agency/agency.service";

/** INTERNAL outcome kinds — the HTTP surface returns a neutral body regardless. */
export type AttributionKind = "worker" | "agency" | "none";

export interface AttributionOutcome {
  attributed: boolean;
  kind: AttributionKind;
  /** Internal reason for a no-op (logging + tests only; NEVER returned to the client). */
  reason?: string;
}

/**
 * Closes the referral-attribution loop (ADR-0020 worker→worker + ADR-0022 agency→worker)
 * by wiring the two consent-gated seams — {@link InviteService.recordAccept} and
 * {@link AgencyService.attributeWorkerToInvite} — to the worker onboarding hook. Both
 * seams were built to be invoked "from the signup/consent flow when an invite code is
 * present" but had NO caller (inert). This is that caller.
 *
 * INVARIANTS enforced here:
 *  - CONSENT GATE (invariant #6, fail-CLOSED): attribution proceeds ONLY when the worker
 *    has an ACTIVE consent row (latest exists AND `revokedAt IS NULL`). Otherwise it is a
 *    NO-OP — no attribution write, no event. The agency seam re-checks this (harmless);
 *    the worker seam does NOT, so the gate is enforced HERE for BOTH paths.
 *  - NAMESPACE: `invites` and `agency_invites` share the opaque `/i/<code>` shape across
 *    two tables. Codes are random 12-hex (disjoint by construction), so we try the WORKER
 *    seam first and fall through to the AGENCY seam ONLY on `unknown_code` — a KNOWN worker
 *    invite that cannot attribute (self / already-attributed) is terminal, never re-tried
 *    against the agency table.
 *  - FAIL-SAFE: NEVER throws to the caller. Attribution is a best-effort side-signal; a
 *    failure must never break the worker's onboarding.
 *  - PII-FREE / NO-ORACLE: only opaque ids cross this path; the validated events live in
 *    the seams; the outcome distinctions never reach the client (see the controller).
 */
@Injectable()
export class ReferralAttributionService {
  private readonly logger = new Logger(ReferralAttributionService.name);

  constructor(
    private readonly consent: ConsentRepository,
    private readonly workerInvites: InviteService,
    private readonly agency: AgencyService,
  ) {}

  /**
   * Attribute the (already-onboarding) worker to the invite `code` that brought them in.
   * Idempotent + neutral: safe to call more than once and on any/unknown code.
   */
  async attribute(code: string, workerId: string): Promise<AttributionOutcome> {
    try {
      // 1) DPDP gate (invariant #6): require ACTIVE consent before ANY attribution.
      const latest = await this.consent.findLatestByWorker(workerId);
      if (!latest || latest.revokedAt !== null) {
        return { attributed: false, kind: "none", reason: "no_consent" };
      }

      // 2) Worker→worker first (ADR-0020). Only `unknown_code` falls through to agency; a
      //    KNOWN worker invite that can't attribute (self / already) is terminal here.
      const w = await this.workerInvites.recordAccept(code, workerId);
      if (w.ok) return { attributed: true, kind: "worker" };
      if (w.reason !== "unknown_code") {
        return { attributed: false, kind: "worker", reason: w.reason };
      }

      // 3) Agency→worker (ADR-0022). Its own consent re-check is harmless (already active).
      const a = await this.agency.attributeWorkerToInvite(code, workerId);
      if (a.ok) return { attributed: true, kind: "agency" };
      return { attributed: false, kind: "none", reason: a.reason };
    } catch (err) {
      // FAIL-SAFE: attribution is a side-signal — never surface or propagate to onboarding.
      // Log the error CLASS (name) + an opaque worker-id prefix only — never a driver
      // message that could widen the surface beyond the codebase's opaque-ids norm.
      this.logger.warn(
        `referral attribution failed (neutralized) worker=${workerId.slice(0, 8)}… (${
          (err as Error).name
        })`,
      );
      return { attributed: false, kind: "none", reason: "error" };
    }
  }
}
