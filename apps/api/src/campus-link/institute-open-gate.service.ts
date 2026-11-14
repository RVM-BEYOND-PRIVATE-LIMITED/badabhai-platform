import { Injectable, Logger } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService } from "./institute-link.service";

/**
 * What the institute rule says about one company opening one worker.
 *
 * - `not_linked`: he is not an active institute student. The caller's own rule (his BadaBhai
 *   `employer_sharing` consent) decides, exactly as before.
 * - `open`: an active student, he applied to one of this company's jobs, and RVM still confirms
 *   his consent.
 * - `closed`: an active student and any of that failed, a read included. The caller refuses with
 *   its one neutral body, so a company cannot tell a student from anyone else it may not open.
 */
export type InstituteOpenVerdict = "not_linked" | "open" | "closed";

/**
 * The company asking to open him: the resolved tenant on a request (unlock, résumé disclosure),
 * or the unlock being revealed, whose holder is that company (the ops reveal names no payer).
 */
export type InstituteOpener = { readonly tenant: TenantKey } | { readonly unlockId: string };

/**
 * The institute rule for opening a worker (#2752 item 9): a linked student opens only for a
 * company he applied to. His RVM consent ("share my profile with companies I apply to") is the
 * only consent he gave, and his own BadaBhai consent does not widen it while the link is active
 * (issue question 2, default: the tag rule wins). Named-company grants (item 10) add a second
 * way in when they land.
 *
 * Asked by every open: `UnlockService.requestUnlock`, its `reveal`, and
 * `ResumeDisclosureService.requestDisclosure`. Each asks BEFORE its advisory lock, where it read
 * consent before, because the RVM read is a network call and the reads here use the global pool.
 *
 * FAIL CLOSED. Any error is `closed`, an RVM outage included: an outage is never a withdrawal,
 * so it ends nothing, and it opens nothing either. Logs carry ids and an error class only.
 */
@Injectable()
export class InstituteOpenGate {
  private readonly logger = new Logger(InstituteOpenGate.name);

  constructor(
    private readonly repo: InstituteLinkRepository,
    private readonly links: InstituteLinkService,
  ) {}

  async decide(
    workerId: string,
    opener: InstituteOpener,
    ctx: RequestContext,
  ): Promise<InstituteOpenVerdict> {
    try {
      const link = await this.repo.findActiveByWorker(workerId);
      if (!link) return "not_linked";
      // Cheap and local first: a company he never applied to is refused without asking RVM.
      const applied =
        "tenant" in opener
          ? await this.repo.hasAppliedToTenant(workerId, opener.tenant)
          : await this.repo.hasAppliedToUnlockHolder(workerId, opener.unlockId);
      if (!applied) return "closed";
      return (await this.links.confirmConsent(link, ctx)) ? "open" : "closed";
    } catch (err) {
      this.logger.warn(
        `institute open gate failed closed worker=${workerId.slice(0, 8)} ` +
          `(${err instanceof Error ? err.name : "unknown"})`,
      );
      return "closed";
    }
  }
}
