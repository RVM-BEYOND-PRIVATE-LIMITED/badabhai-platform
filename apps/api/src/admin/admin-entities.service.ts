import { Injectable, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { AdminIdentityService } from "./admin-identity.service";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import type {
  AdminApplicationListItem,
  AdminApplicationsQueryDto,
  AdminCreditLedgerQueryDto,
  AdminCreditsView,
  AdminJobPostingDetail,
  AdminJobPostingListItem,
  AdminJobPostingsQueryDto,
  AdminPage,
  AdminPayerDetail,
  AdminPayerListItem,
  AdminPayersQueryDto,
  AdminWorkerDetail,
  AdminWorkerListItem,
  AdminWorkersQueryDto,
} from "./admin-entities.dto";

/**
 * The admin entity read service (BP-1).
 *
 * Thin by design: validation happens at the Zod pipe, the PII projection happens in the
 * repository's select list, and ROUTE authorization happens in the guards. What is left is
 * keyset paging, and — since the 2026-08-18 ruling — deciding whether this particular admin is
 * shown the NAMES behind the ids.
 *
 * ── WHY THE SERVICE TAKES AN ADMIN, WHEN IT USED TO TAKE ONLY A DTO ─────────────────────
 * Because the identity gate CANNOT be a second `@RequireAdminRole`. The routes must stay
 * reachable on `read_entities` for all four roles — an analyst still gets the full faceless
 * page — so the decision is per-RESPONSE, not per-route, and `@RequireAdminRole` sets exactly
 * one capability per route by design (`admin-static-guards.test.ts` asserts exactly one). The
 * capability check therefore happens INSIDE {@link AdminIdentityService}, over the session
 * admin the guard already resolved and threaded here as `@CurrentAdmin()`. It is never taken
 * from a query param or a body: the actor is non-spoofable or it is not an actor.
 *
 * EVENTS: still none for the faceless read — a read is not a state change. The NAME read does
 * emit (`admin.identity_viewed`, awaited and fail-closed, before any decrypt), for the same
 * reason the feedback and journey reads do: it is a disclosure, not a state snapshot. That
 * emission lives entirely in `AdminIdentityService`.
 *
 * NAMES ARE RESOLVED FOR THE RETURNED PAGE ONLY, never the peeked `limit + 1` row. Auditing —
 * and charging the egress budget for — a name the admin was never shown would make both the
 * trail and the cap describe reading that did not happen.
 */
@Injectable()
export class AdminEntitiesService {
  constructor(
    private readonly repo: AdminEntitiesRepository,
    private readonly identity: AdminIdentityService,
  ) {}

  /**
   * Turn `limit + 1` fetched rows into a page plus an HONEST `nextCursor`.
   *
   * Over-fetching by one is what makes it honest. Deriving the cursor from "we returned
   * exactly `limit` rows" produces a phantom next page whenever the total is an exact
   * multiple of the page size — the operator clicks Next and lands on an empty screen,
   * which reads as data loss rather than as the end of the list.
   */
  private static page<T extends { id: string; created_at: Date }>(
    rows: T[],
    limit: number,
  ): AdminPage<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeEntityCursor({ createdAt: last.created_at.toISOString(), id: last.id })
          : null,
    };
  }

  async listWorkers(
    admin: AuthenticatedAdmin,
    dto: AdminWorkersQueryDto,
    ctx: RequestContext,
  ): Promise<AdminPage<AdminWorkerListItem>> {
    const rows = await this.repo.listWorkers(
      { status: dto.status, pendingDeletion: dto.pendingDeletion },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    const page = AdminEntitiesService.page(rows, dto.limit);
    const names = await this.identity.resolve(
      admin,
      "workers",
      page.items.map((w) => w.id),
      // A LIST spans many subjects, so the audit carries no single subject id.
      null,
      ctx,
    );
    if (!names) return page;
    return {
      ...page,
      items: page.items.map((w) => ({ ...w, full_name: names.get(w.id) ?? null })),
    };
  }

  async getWorker(
    admin: AuthenticatedAdmin,
    id: string,
    ctx: RequestContext,
  ): Promise<AdminWorkerDetail> {
    const worker = await this.repo.findWorker(id);
    if (!worker) throw new NotFoundException("Worker not found");
    // The 404 comes FIRST: resolving a name for a worker who does not exist would spend budget
    // and write an audit row for a disclosure that cannot happen.
    const names = await this.identity.resolve(admin, "workers", [id], id, ctx);
    if (!names) return worker;
    return { ...worker, full_name: names.get(id) ?? null };
  }

  async listPayers(
    admin: AuthenticatedAdmin,
    dto: AdminPayersQueryDto,
    ctx: RequestContext,
  ): Promise<AdminPage<AdminPayerListItem>> {
    const rows = await this.repo.listPayers(
      { role: dto.role, status: dto.status },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    const page = AdminEntitiesService.page(rows, dto.limit);
    const names = await this.identity.resolve(
      admin,
      "payers",
      page.items.map((p) => p.id),
      null,
      ctx,
    );
    if (!names) return page;
    return {
      ...page,
      items: page.items.map((p) => ({ ...p, org_name: names.get(p.id) ?? null })),
    };
  }

  async getPayer(
    admin: AuthenticatedAdmin,
    id: string,
    ctx: RequestContext,
  ): Promise<AdminPayerDetail> {
    const payer = await this.repo.findPayer(id);
    if (!payer) throw new NotFoundException("Payer not found");
    const names = await this.identity.resolve(admin, "payers", [id], id, ctx);
    if (!names) return payer;
    return { ...payer, org_name: names.get(id) ?? null };
  }

  async listJobPostings(
    dto: AdminJobPostingsQueryDto,
  ): Promise<AdminPage<AdminJobPostingListItem>> {
    const rows = await this.repo.listJobPostings(
      { status: dto.status, verificationStatus: dto.verificationStatus, payerId: dto.payerId },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    return AdminEntitiesService.page(rows, dto.limit);
  }

  async getJobPosting(id: string): Promise<AdminJobPostingDetail> {
    const posting = await this.repo.findJobPosting(id);
    if (!posting) throw new NotFoundException("Job posting not found");
    return posting;
  }

  async listApplications(
    dto: AdminApplicationsQueryDto,
  ): Promise<AdminPage<AdminApplicationListItem>> {
    const rows = await this.repo.listApplications(
      { workerId: dto.workerId, jobPostingId: dto.jobPostingId, action: dto.action },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    return AdminEntitiesService.page(rows, dto.limit);
  }

  /**
   * Balance + a page of the append-only ledger.
   *
   * Deliberately served together: the balance is a MATERIALIZATION of the ledger, and an
   * operator investigating "why is this number wrong" needs both sides in one response to
   * see a divergence at all. Fetched in parallel — they are independent reads.
   */
  async getCredits(payerId: string, dto: AdminCreditLedgerQueryDto): Promise<AdminCreditsView> {
    const [balance, rows] = await Promise.all([
      this.repo.getCreditBalance(payerId),
      this.repo.listCreditLedger(payerId, decodeEntityCursor(dto.cursor), dto.limit + 1),
    ]);
    return { payer_id: payerId, balance, ledger: AdminEntitiesService.page(rows, dto.limit) };
  }
}
