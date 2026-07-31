import { Injectable, Logger } from "@nestjs/common";
import { AgencyService } from "../agency/agency.service";
import { InviteService } from "./invite.service";

/**
 * INTERNAL outcome of a public click — the HTTP surface returns a neutral body regardless.
 *
 * `agency_or_unknown` is deliberately FUSED: `AgencyService.recordInviteClick` is neutral by
 * contract (it returns the same `{ok:true}` for a known and an unknown code, and emits
 * nothing for the latter), so this path CANNOT tell a valid agency code from a code that
 * exists nowhere. That is a property, not a gap — it means not even an internal log line
 * can be turned into an existence oracle for the agency code space.
 */
export type PublicClickKind = "worker" | "agency_or_unknown" | "error";

export interface PublicClickOutcome {
  /** Which code space handled it (logging + tests only; NEVER returned to the client). */
  kind: PublicClickKind;
}

/**
 * The ONE public, worker-reachable click path for BOTH referral funnels (closes TD113).
 *
 * THE BUG THIS FIXES: `POST /invites/:code/click` is public and works for worker→worker
 * codes, but the agency equivalent (`POST /payer/agency/invites/:code/click`) sits behind
 * `PayerAuthGuard` + `@PayerRoles('agent')`. The invited WORKER is the only party who can
 * actually click a shared link, and they hold no agency session — so the agency funnel's
 * `clicked` stage had no live producer at all. This service makes the PUBLIC endpoint fall
 * through to the agency code space.
 *
 * NAMESPACE (the same rule ReferralAttributionService applies to attribution): both tables
 * mint `randomUUID().replace(/-/g,"").slice(0,12)` — 12 random hex, disjoint by
 * construction — so trying the worker table first and falling through ONLY on
 * `unknown_code` is unambiguous.
 *
 * NO-ORACLE (the property that matters most here — this route is unauthenticated): the
 * caller gets the IDENTICAL neutral `{ ok: true }` for a valid worker code, a valid agency
 * code, and a code that exists in neither. Nothing about existence, ownership, funnel
 * stage, or the inviter ever crosses the boundary. The internal `kind` above stays internal.
 *
 * FAIL-SAFE: a click is a best-effort funnel signal, so a repository/event failure is
 * neutralized rather than surfaced — a DB blip must not turn a shared link into an error
 * page, and must not leak a distinguishable 500 for a code that happens to exist.
 */
@Injectable()
export class InviteClickService {
  private readonly logger = new Logger(InviteClickService.name);

  constructor(
    private readonly workerInvites: InviteService,
    private readonly agency: AgencyService,
  ) {}

  /** Resolve a public click across both code spaces. Never throws; never reveals which. */
  async recordPublicClick(code: string): Promise<PublicClickOutcome> {
    try {
      // 1) Worker→worker (ADR-0020). Emits invite.clicked when the code resolves.
      const worker = await this.workerInvites.recordClick(code);
      if (worker.ok) return { kind: "worker" };

      // 2) Agency→worker (ADR-0022 / TD113). Emits agency_invite.clicked when it resolves,
      //    and is itself neutral + event-free on an unknown code.
      await this.agency.recordInviteClick(code);
      return { kind: "agency_or_unknown" };
    } catch (err) {
      // Never surface the failure: the response must stay neutral + identical. Log the
      // error CLASS only — never the code (it is a shareable bearer token), never an id.
      this.logger.warn(`invite click failed (neutralized) (${(err as Error).name})`);
      return { kind: "error" };
    }
  }
}
