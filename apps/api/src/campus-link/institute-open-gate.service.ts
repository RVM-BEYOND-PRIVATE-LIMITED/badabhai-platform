import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { SERVER_CONFIG } from "../config/config.module";
import { studentMoveEnabled, type StudentMoveConfig } from "../student-move/student-move.flag";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService } from "./institute-link.service";

/**
 * What the institute rule says about one company opening one worker.
 *
 * - `not_linked`: he is not an active institute student. The caller's own rule (his BadaBhai
 *   `employer_sharing` consent) decides, exactly as before.
 * - `open`: an active student, he applied to one of this company's jobs or this company holds his
 *   named-company search grant, and RVM still confirms his consent.
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
 * company he applied to, or one that holds his named-company search grant (item 10, his own yes
 * read from RVM). His RVM consent ("share my profile with companies I apply to") is the only
 * consent he gave, and his own BadaBhai consent does not widen it while the link is active
 * (issue question 2, default: the tag rule wins).
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

  /** #2887 — STUDENT_MOVE_ENABLED, read once. Off (or no config at all) is today. */
  private readonly studentMove: boolean;

  constructor(
    private readonly repo: InstituteLinkRepository,
    private readonly links: InstituteLinkService,
    // Optional only so the hand-built instances keep compiling; absent reads as off. Nest always
    // injects it (AppConfigModule is @Global).
    @Optional() @Inject(SERVER_CONFIG) config?: StudentMoveConfig,
  ) {
    this.studentMove = studentMoveEnabled(config);
  }

  async decide(
    workerId: string,
    opener: InstituteOpener,
    ctx: RequestContext,
  ): Promise<InstituteOpenVerdict> {
    try {
      // #2887 — a moved student an admin made visible is an ordinary worker: #2752's rule lifts.
      // A hidden one is gated even with no link row: only a company he applied to opens him (no
      // RVM call: there is no link to re-confirm).
      const moved = this.studentMove ? await this.repo.studentVisibilityOf(workerId) : null;
      if (moved === "visible") return "not_linked";
      const link = await this.repo.findActiveByWorker(workerId);
      if (!link) {
        if (moved !== "hidden") return "not_linked";
        const applied =
          "tenant" in opener
            ? await this.repo.hasAppliedToTenant(workerId, opener.tenant)
            : await this.repo.hasAppliedToUnlockHolder(workerId, opener.unlockId);
        return applied ? "open" : "closed";
      }
      // Cheap and local first: a company he never applied to is refused without asking RVM.
      // "A company he applied to, or that holds his grant" (#2752 items 9 and 10).
      const entitled =
        "tenant" in opener
          ? (await this.repo.hasAppliedToTenant(workerId, opener.tenant)) ||
            (await this.repo.hasLiveGrantForTenant(workerId, opener.tenant))
          : (await this.repo.hasAppliedToUnlockHolder(workerId, opener.unlockId)) ||
            (await this.repo.hasLiveGrantForUnlockHolder(workerId, opener.unlockId));
      if (!entitled) return "closed";
      return (await this.links.confirmConsent(link, ctx)) ? "open" : "closed";
    } catch (err) {
      this.logger.warn(
        `institute open gate failed closed worker=${workerId.slice(0, 8)} ` +
          `(${err instanceof Error ? err.name : "unknown"})`,
      );
      return "closed";
    }
  }

  /**
   * #2954 — may this company's QUOTE treat him as an RVM student? `POST /payer/unlocks/quotes` prices
   * any ids a company sends, and an RVM student's price differs (always the standard cost, or a
   * waiver's 0), so pricing him as one tells the company he is one. Only a company that could open
   * him already knows: one he applied to, one holding his grant (#2752), or any company once an
   * admin made him visible (#2887: then he is priced as an RVM student on the real open too, so the
   * quote must match it). Everyone else is quoted as for an ordinary worker; the open itself is
   * still decided by {@link decide}.
   *
   * LOCAL READS ONLY: no RVM consent call (a quote is a page of prices, not an open). Fails closed:
   * an error answers false, so the quote shows an ordinary price and reveals nothing.
   */
  async quotesAsStudent(workerId: string, tenant: TenantKey): Promise<boolean> {
    try {
      if (this.studentMove && (await this.repo.studentVisibilityOf(workerId)) === "visible") {
        return true;
      }
      return (
        (await this.repo.hasAppliedToTenant(workerId, tenant)) ||
        (await this.repo.hasLiveGrantForTenant(workerId, tenant))
      );
    } catch (err) {
      this.logger.warn(
        `institute quote gate failed closed worker=${workerId.slice(0, 8)} ` +
          `(${err instanceof Error ? err.name : "unknown"})`,
      );
      return false;
    }
  }
}
