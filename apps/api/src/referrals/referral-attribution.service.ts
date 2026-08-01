import { Injectable, Logger } from "@nestjs/common";
import type { InviteInstallSource } from "@badabhai/event-schema";
import { ConsentRepository } from "../consent/consent.repository";
import { InviteService } from "../messaging/invite.service";
import { AgencyService } from "../agency/agency.service";
import { ReferralLinkService } from "./referral-link.service";

/** INTERNAL outcome kinds — the HTTP surface returns a neutral body regardless. */
export type AttributionKind = "worker" | "agency" | "none";

export interface AttributionOutcome {
  attributed: boolean;
  kind: AttributionKind;
  /** Internal reason for a no-op (logging + tests only; NEVER returned to the client). */
  reason?: string;
  /**
   * B4 — whether the click→install MATCH WINDOW admitted a first-touch claim for this
   * worker. Independent of `attributed`: the legacy funnels (`invites` / `agency_invites`)
   * have no click log, so a code shared before the resolver existed still attributes with
   * no claim. Tests + logs only; never returned to the client.
   */
  claimed?: boolean;
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
    private readonly referralLinks: ReferralLinkService,
  ) {}

  /**
   * Attribute the (already-onboarding) worker to the invite `code` that brought them in.
   * Idempotent + neutral: safe to call more than once and on any/unknown code.
   */
  async attribute(
    code: string,
    workerId: string,
    /**
     * B4 — which leg of the post-Dynamic-Links chain delivered the code (app_link /
     * install_referrer / custom_scheme). Threaded into the `invite.install` event emitted by
     * whichever seam attributes. Defaults to "unknown" so pre-B4 clients (which send no
     * `source`) and every existing caller keep working unchanged.
     */
    source: InviteInstallSource = "unknown",
  ): Promise<AttributionOutcome> {
    try {
      // 1) DPDP gate (invariant #6): require ACTIVE consent before ANY attribution.
      const latest = await this.consent.findLatestByWorker(workerId);
      if (!latest || latest.revokedAt !== null) {
        return { attributed: false, kind: "none", reason: "no_consent" };
      }

      // 2) B4 FIRST-TOUCH CLAIM against the match window. Runs BEFORE the two funnel seams
      //    and is INDEPENDENT of them: it resolves at most one click per worker ever (the
      //    partial unique index on `referral_clicks.claimed_by_worker_id`), which is what
      //    makes a concurrent duplicate post idempotent.
      //
      //    NON-BREAKING BY CONSTRUCTION: a `none`/`unknown_code` claim does NOT block
      //    attribution below. Codes shared before the resolver existed have no click row at
      //    all, so gating the legacy funnels on a claim would retroactively break every
      //    invite already in the wild. The window therefore governs CLAIMS (what a
      //    commission is computed from), while the funnel seams keep their existing
      //    behaviour. That split is deliberate — see the B4 report.
      const claim = await this.referralLinks.claimInstall({ code, workerId, source });

      // 3) Worker→worker (ADR-0020). Only `unknown_code` falls through to agency; a
      //    KNOWN worker invite that can't attribute (self / already) is terminal here.
      const w = await this.workerInvites.recordAccept(code, workerId, source);
      if (w.ok) return { attributed: true, kind: "worker", claimed: claim.claimed };
      if (w.reason !== "unknown_code") {
        return { attributed: false, kind: "worker", reason: w.reason, claimed: claim.claimed };
      }

      // 4) Agency→worker (ADR-0022). Its own consent re-check is harmless (already active).
      const a = await this.agency.attributeWorkerToInvite(code, workerId, source);
      if (a.ok) return { attributed: true, kind: "agency", claimed: claim.claimed };
      return { attributed: false, kind: "none", reason: a.reason, claimed: claim.claimed };
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
