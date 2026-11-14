import { Injectable, NotFoundException } from "@nestjs/common";
import type { Database, InstituteApplicationRow, InstituteCode } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { CampusRefusal } from "./campus-errors";
import type { CAMPUS_APPLICATION_STAGES } from "./campus-link.contract";
import {
  CampusApplicationsRepository,
  type CampusApplicationView,
} from "./campus-applications.repository";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  CAMPUS_FEED_OVERLAP_MS,
} from "./campus-postings.service";
import { InstituteLinkService } from "./institute-link.service";

const RVM: InstituteCode = "rvm";

/** One application in the contract's shape (`CampusApplicationSchema`). */
export interface CampusApplicationAnswer {
  application_id: string;
  external_ref: string;
  posting_id: string;
  student_ref: string;
  stage: (typeof CAMPUS_APPLICATION_STAGES)[number];
  changed_at: string;
}

/**
 * Campus applications (#2752 item 8): a student applies on Campus and appears in the company's
 * BadaBhai applicant list; Campus polls his status; he may withdraw.
 *
 * THE GATE, in order, every refusal before anything is written:
 *   1. a ref Campus used before answers its own row (the lasting idempotency guard, for good), or
 *      `EXTERNAL_REF_CONFLICT` when it named another posting or student;
 *   2. the posting exists (404), includes RVM students (`AUDIENCE_EXCLUDES_RVM`), is open and not
 *      hidden (`POSTING_NOT_OPEN`) and is approved for the content it has NOW
 *      (`POSTING_NOT_APPROVED`, `approvedForRvmStudents`);
 *   3. RVM answers for the student (`STUDENT_NOT_AVAILABLE`; `RVM_UNAVAILABLE` when it is down) —
 *      he is linked then, his six agreed fields refreshed;
 *   4. in one transaction, serialised per ref, the posting re-read under `FOR SHARE` (a posting
 *      that closes at the same moment refuses rather than taking him), the `applications` row the
 *      company sees, the Campus record, `application.submitted` and `worker.institute_applied`.
 *
 * Branch and course targeting is enforced by Campus, which decides which jobs a student sees from
 * his RVM location id; the Student API returns his branch only by name, so BadaBhai has nothing to
 * compare the posting's branch ids against yet.
 */
@Injectable()
export class CampusApplicationsService {
  constructor(
    private readonly repo: CampusApplicationsRepository,
    private readonly links: InstituteLinkService,
    private readonly events: EventsService,
  ) {}

  async apply(
    body: { external_ref: string; posting_id: string; student_ref: string; applied_at?: string },
    ctx: RequestContext,
  ): Promise<{ created: boolean; application: CampusApplicationAnswer }> {
    const studentRef = body.student_ref.toLowerCase();
    const known = await this.repo.findByRef(RVM, body.external_ref);
    if (known)
      return { created: false, application: sameOrConflict(known, body.posting_id, studentRef) };

    this.assertGate(await this.repo.postingGate(body.posting_id));
    const linked = await this.links.linkStudent(studentRef, ctx);

    const outcome = await this.repo.withTransaction(async (tx) => {
      await this.repo.lockRef(tx, RVM, body.external_ref);
      const raced = await this.repo.findByRef(RVM, body.external_ref, tx);
      if (raced) return { created: false, view: raced };
      this.assertGate(await this.repo.postingGate(body.posting_id, tx));

      // One Campus record per student and posting: a second Campus ref for the same pair is a
      // Campus-side duplicate, never a second application.
      if (await this.repo.findForWorkerPosting(tx, linked.workerId, body.posting_id)) {
        throw new CampusRefusal("EXTERNAL_REF_CONFLICT", 409);
      }
      // He may already have a decision on it from the worker app. An apply is the row the company
      // sees and stays his own; a skip becomes this apply.
      const decision = await this.repo.findDecision(tx, linked.workerId, body.posting_id);
      let applicationId: string;
      let ownsApplication = true;
      if (decision?.action === "applied") {
        applicationId = decision.id;
        ownsApplication = false;
      } else if (decision) {
        applicationId = decision.id;
        await this.repo.turnSkipIntoApply(tx, decision.id);
        await this.emitSubmitted(tx, linked.workerId, body.posting_id, decision.id, ctx);
      } else {
        applicationId = await this.insertApplied(tx, linked.workerId, body.posting_id, ctx);
      }
      const row = await this.repo.insertCampusApplication(tx, {
        instituteCode: RVM,
        externalRef: body.external_ref,
        applicationId,
        ownsApplication,
        jobPostingId: body.posting_id,
        workerId: linked.workerId,
        campusAppliedAt: body.applied_at === undefined ? null : new Date(body.applied_at),
      });
      await this.emit(tx, "worker.institute_applied", row, applicationId, ctx);
      return { created: true, view: { ...row, studentRef, stage: null, changedAt: row.updatedAt } };
    });
    return { created: outcome.created, application: answer(outcome.view) };
  }

  /** Withdraws (the student changed his mind on Campus). Idempotent; an unknown ref is a 404. */
  async withdraw(externalRef: string, ctx: RequestContext): Promise<CampusApplicationAnswer> {
    const view = await this.repo.withTransaction(async (tx) => {
      await this.repo.lockRef(tx, RVM, externalRef);
      const known = await this.repo.findByRef(RVM, externalRef, tx);
      if (!known) throw new NotFoundException();
      if (known.withdrawnAt !== null) return known;
      const now = new Date();
      const applicationId = known.applicationId;
      await this.repo.withdraw(tx, known, now);
      if (applicationId !== null) {
        await this.emit(tx, "worker.institute_application_withdrawn", known, applicationId, ctx);
      }
      return { ...known, applicationId: null, withdrawnAt: now, updatedAt: now, changedAt: now };
    });
    return answer(view);
  }

  /** The status feed Campus polls, in `(changed_at, id)` order. */
  async feed(query: {
    changed_since?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ applications: CampusApplicationAnswer[]; next_cursor: string | null }> {
    const rows = await this.repo.listFeed({
      instituteCode: RVM,
      changedSince:
        query.changed_since === undefined
          ? undefined
          : new Date(new Date(query.changed_since).getTime() - CAMPUS_FEED_OVERLAP_MS),
      after: query.cursor === undefined ? undefined : decodeFeedCursor(query.cursor),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      applications: page.map(answer),
      next_cursor: rows.length > query.limit ? encodeFeedCursor(page[page.length - 1]!) : null,
    };
  }

  private assertGate(gate: Awaited<ReturnType<CampusApplicationsRepository["postingGate"]>>): void {
    if (!gate) throw new CampusRefusal("POSTING_NOT_OPEN", 404);
    if (!gate.reachesRvm) {
      throw new CampusRefusal("AUDIENCE_EXCLUDES_RVM", 409);
    }
    if (gate.status !== "open" || gate.hidden) throw new CampusRefusal("POSTING_NOT_OPEN", 409);
    if (!gate.approved) throw new CampusRefusal("POSTING_NOT_APPROVED", 409);
  }

  /** The `applications` row, with the same `application.submitted` every apply emits. */
  private async insertApplied(
    tx: Database,
    workerId: string,
    postingId: string,
    ctx: RequestContext,
  ): Promise<string> {
    const applicationId = await this.repo.insertApplication(tx, workerId, postingId);
    await this.emitSubmitted(tx, workerId, postingId, applicationId, ctx);
    return applicationId;
  }

  /** `application.submitted`, as every apply emits it (source surface `other`). */
  private async emitSubmitted(
    tx: Database,
    workerId: string,
    postingId: string,
    applicationId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"application.submitted"> = {
      worker_id: workerId,
      job_id: postingId,
      rank: null,
      source_surface: "other",
    };
    await this.events.emit({
      event_name: "application.submitted",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      idempotencyKey: `application.submitted:${applicationId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }

  private async emit(
    tx: Database,
    eventName: "worker.institute_applied" | "worker.institute_application_withdrawn",
    row: InstituteApplicationRow,
    applicationId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<typeof eventName> = {
      institute_application_id: row.id,
      application_id: applicationId,
      worker_id: row.workerId,
      job_posting_id: row.jobPostingId,
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

/** The same ref again answers its own row; for another posting or student it is a conflict. */
function sameOrConflict(
  known: CampusApplicationView,
  postingId: string,
  studentRef: string,
): CampusApplicationAnswer {
  if (known.jobPostingId !== postingId.toLowerCase() || known.studentRef !== studentRef) {
    throw new CampusRefusal("EXTERNAL_REF_CONFLICT", 409);
  }
  return answer(known);
}

function answer(view: CampusApplicationView): CampusApplicationAnswer {
  return {
    // The Campus record's own id: the `applications` row goes on a withdrawal; this one stays.
    application_id: view.id,
    external_ref: view.externalRef,
    posting_id: view.jobPostingId,
    student_ref: view.studentRef ?? "",
    stage: view.withdrawnAt !== null ? "withdrawn" : (view.stage ?? "new"),
    changed_at: view.changedAt.toISOString(),
  };
}
