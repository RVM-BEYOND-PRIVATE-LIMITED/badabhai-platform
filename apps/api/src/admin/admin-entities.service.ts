import { Injectable, NotFoundException } from "@nestjs/common";
import { AdminEntitiesRepository } from "./admin-entities.repository";
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
 * The admin faceless-entity read service (BP-1).
 *
 * Thin by design: validation happens at the Zod pipe, the PII projection happens in the
 * repository's select list, and authorization happens in the guards. What is left — and the
 * only thing this layer owns — is keyset paging.
 *
 * NO EVENTS. A read is not a state change, so it emits nothing (CLAUDE.md §1). The
 * privileged read that IS audited is the PII reveal, which lives in its own service behind
 * its own capability and its own default-off flag; that asymmetry is the point.
 */
@Injectable()
export class AdminEntitiesService {
  constructor(private readonly repo: AdminEntitiesRepository) {}

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

  async listWorkers(dto: AdminWorkersQueryDto): Promise<AdminPage<AdminWorkerListItem>> {
    const rows = await this.repo.listWorkers(
      { status: dto.status, pendingDeletion: dto.pendingDeletion },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    return AdminEntitiesService.page(rows, dto.limit);
  }

  async getWorker(id: string): Promise<AdminWorkerDetail> {
    const worker = await this.repo.findWorker(id);
    if (!worker) throw new NotFoundException("Worker not found");
    return worker;
  }

  async listPayers(dto: AdminPayersQueryDto): Promise<AdminPage<AdminPayerListItem>> {
    const rows = await this.repo.listPayers(
      { role: dto.role, status: dto.status },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    return AdminEntitiesService.page(rows, dto.limit);
  }

  async getPayer(id: string): Promise<AdminPayerDetail> {
    const payer = await this.repo.findPayer(id);
    if (!payer) throw new NotFoundException("Payer not found");
    return payer;
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
