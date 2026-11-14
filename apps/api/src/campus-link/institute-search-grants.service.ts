import { HttpException, Injectable } from "@nestjs/common";
import type { Database, InstituteCode, InstituteSearchGrantRow } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { instituteCourseMatchSkill } from "@badabhai/taxonomy";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { isBarredPayerStatus } from "../payers/payer-barred-status";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService, StudentNotAvailableError } from "./institute-link.service";
import {
  InstituteSearchGrantsRepository,
  type InstituteSearchGrantView,
} from "./institute-search-grants.repository";
import { RvmStudentApiClient } from "./rvm-student-api.client";

const RVM: InstituteCode = "rvm";

/** The company Campus names does not exist, or is barred. A neutral 404 to Campus. */
export class GrantCompanyNotFoundError extends Error {
  constructor() {
    super("company not found");
    this.name = "GrantCompanyNotFoundError";
  }
}

/** The grant ref Campus sent already names a grant for another company or student. */
export class GrantRefConflictError extends Error {
  constructor() {
    super("grant ref conflict");
    this.name = "GrantRefConflictError";
  }
}

/** No grant is known by that ref. */
export class GrantNotFoundError extends Error {
  constructor() {
    super("grant not found");
    this.name = "GrantNotFoundError";
  }
}

/** A grant as Campus sees it. */
export interface SearchGrantView {
  grantRef: string;
  companyId: string;
  studentRef: string;
  state: "active" | "revoked";
  changedAt: Date;
}

/**
 * Named-company search grants (#2752 item 10). A company asked to see an RVM student in its own
 * search; RVM asked him; he said yes. BadaBhai stores the grant only after reading that yes from
 * RVM by `consent_ref`, for THIS company and THIS student. While it is live he appears in that
 * company's search alone, and that company may open him (`InstituteOpenGate`).
 *
 * ORDER, AND WHAT A REFUSAL LEAVES. The company is checked, then RVM's consent request is read,
 * BEFORE the student is linked: a student who said no, or whose yes names another company, gets
 * no grant and no `workers` row (issue check: "stays hidden and has no grant row"). Only then is
 * he linked (his six agreed fields read and refreshed), and the grant written in one transaction
 * with its event, serialised per Campus grant ref.
 *
 * IDEMPOTENT FOR GOOD on `grant_ref`: the same ref again answers the row it made, revoked or
 * not; the same ref for another company or student is a conflict. The company is stored as its
 * TENANT key (ADR-0053), the key its search and its opens are asked by.
 */
@Injectable()
export class InstituteSearchGrantsService {
  constructor(
    private readonly repo: InstituteSearchGrantsRepository,
    private readonly links: InstituteLinkService,
    private readonly linkRepo: InstituteLinkRepository,
    private readonly rvm: RvmStudentApiClient,
    private readonly tenancy: PayerTenantScopeService,
    private readonly events: EventsService,
  ) {}

  /**
   * @throws GrantRefConflictError — the ref names another company's or student's grant.
   * @throws GrantCompanyNotFoundError — no such company, or it is barred.
   * @throws StudentNotAvailableError — no yes from him for this company (or RVM refuses him).
   * @throws RvmStudentApiUnavailableError — RVM did not answer usably. Retryable; nothing stored.
   */
  async grant(
    grantRef: string,
    body: { company_id: string; student_ref: string; consent_ref: string },
    ctx: RequestContext,
  ): Promise<SearchGrantView> {
    const companyId = body.company_id.toLowerCase();
    const studentRef = body.student_ref.toLowerCase();

    const status = await this.repo.companyStatus(companyId);
    if (status === undefined || isBarredPayerStatus(status)) throw new GrantCompanyNotFoundError();
    // Stored and compared as the TENANT key: the key its search and its opens are asked by.
    const tenant = await this.tenantOf(companyId);

    const known = await this.repo.findByRef(RVM, grantRef);
    if (known) return this.sameGrantOrConflict(known, tenant, studentRef);

    // His own yes, for this company, BEFORE anything about him is written.
    const consent = await this.rvm.readConsentRequest(body.consent_ref);
    if (
      consent.kind !== "found" ||
      consent.companyRef !== companyId ||
      consent.answers.get(studentRef) !== "yes"
    ) {
      throw new StudentNotAvailableError();
    }

    const linked = await this.links.linkStudent(studentRef, ctx);
    const link = await this.linkRepo.findActiveByWorker(linked.workerId);
    if (!link) throw new StudentNotAvailableError();
    const skill = instituteCourseMatchSkill(link.course);

    const row = await this.repo.withTransaction(async (tx) => {
      await this.repo.lockRef(tx, RVM, grantRef);
      const raced = await this.repo.findByRef(RVM, grantRef, tx);
      if (raced) return raced;
      const live = await this.repo.findLive(tx, tenant, linked.workerId, RVM);
      if (live) throw new GrantRefConflictError();

      const now = new Date();
      const inserted = await this.repo.insertLive(tx, {
        instituteCode: RVM,
        grantRef,
        tenant,
        workerId: linked.workerId,
        consentRef: body.consent_ref,
        skillId: skill?.skillId ?? null,
        industryId: skill?.industryId ?? null,
        now,
      });
      if (!inserted) throw new GrantRefConflictError();
      await this.emit(tx, "worker.institute_search_granted", inserted, ctx);
      return { ...inserted, studentRef };
    });
    return this.sameGrantOrConflict(row, tenant, studentRef);
  }

  /**
   * Revokes a grant (the student or the company withdrew). Idempotent: a revoked grant answers
   * revoked again with its first revocation time.
   *
   * @throws GrantNotFoundError — no grant is known by that ref.
   */
  async revoke(grantRef: string, ctx: RequestContext): Promise<SearchGrantView> {
    const row = await this.repo.withTransaction(async (tx) => {
      await this.repo.lockRef(tx, RVM, grantRef);
      const known = await this.repo.findByRef(RVM, grantRef, tx);
      if (!known) throw new GrantNotFoundError();
      if (known.revokedAt !== null) return known;
      const revoked = await this.repo.revoke(tx, known.id, new Date());
      if (!revoked) return known;
      await this.emit(tx, "worker.institute_search_revoked", revoked, ctx);
      return { ...revoked, studentRef: known.studentRef };
    });
    return view(row);
  }

  /**
   * The company's tenant key. The resolver's own refusal (a company it cannot place in an org) is
   * the same neutral not-found as an unknown company; anything else propagates (fail closed).
   */
  private async tenantOf(companyId: string): Promise<TenantKey> {
    try {
      return (await this.tenancy.resolve(companyId)).tenantKey;
    } catch (err) {
      if (err instanceof HttpException) throw new GrantCompanyNotFoundError();
      throw err;
    }
  }

  private sameGrantOrConflict(
    row: InstituteSearchGrantView,
    tenant: TenantKey,
    studentRef: string,
  ): SearchGrantView {
    const theirs = view(row);
    if (theirs.companyId !== tenant || theirs.studentRef !== studentRef) {
      throw new GrantRefConflictError();
    }
    return theirs;
  }

  private async emit(
    tx: Database,
    eventName: "worker.institute_search_granted" | "worker.institute_search_revoked",
    row: InstituteSearchGrantRow,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<typeof eventName> = {
      grant_id: row.id,
      worker_id: row.workerId,
      payer_id: row.payerId,
      institute_code: RVM,
    };
    await this.events.emit({
      event_name: eventName,
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "worker", subject_id: row.workerId },
      payload,
      idempotencyKey: `${eventName}:${row.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }
}

/** The grant as Campus sees it. A grant whose link was erased answers its stored refs only. */
function view(row: InstituteSearchGrantView): SearchGrantView {
  return {
    grantRef: row.grantRef,
    companyId: row.payerId,
    // A grant outlives a deleted worker only as a cascade, so a missing link means an unlink that
    // kept the row withdrawn: the reference is still on it. Never empty in practice.
    studentRef: row.studentRef ?? "",
    state: row.revokedAt === null ? "active" : "revoked",
    changedAt: row.revokedAt ?? row.grantedAt,
  };
}
