import { Injectable } from "@nestjs/common";
import type { Database, InstituteCode } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { isSyntheticTestPhone } from "../auth/auth.dto";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { StudentRefSchema } from "./campus-link.contract";
import {
  INSTITUTE_LINK_AUDIT_ACTIONS,
  InstituteLinkRepository,
  type InstituteLinkFacts,
} from "./institute-link.repository";
import { RvmStudentApiClient, type RvmStudentRead } from "./rvm-student-api.client";

const RVM: InstituteCode = "rvm";

/**
 * The student is not available to BadaBhai: RVM refused (no consent, not linked, any reason), or
 * linking him would clash with a row that needs a human (the manual list). One neutral outcome,
 * so a caller cannot tell the reasons apart. Nothing about him was created.
 */
export class StudentNotAvailableError extends Error {
  constructor() {
    super("student not available");
    this.name = "StudentNotAvailableError";
  }
}

/**
 * Inside BadaBhai only. `workerCreated` says whether he already had a BadaBhai account, so a
 * route must never return it to Campus or to a company.
 */
export interface LinkedStudent {
  workerId: string;
  /** True when this call created his BadaBhai row (he has never signed in). */
  workerCreated: boolean;
}

type LinkOutcome = { kind: "linked"; student: LinkedStudent } | { kind: "refused" };

/** Why a worker row may not carry a link, or null when it may. */
function unfitReason(worker: {
  status: string;
  deletionScheduledAt: Date | null;
}): "worker_suspended" | "worker_deletion_scheduled" | null {
  if (worker.status === "suspended") return "worker_suspended";
  if (worker.deletionScheduledAt !== null) return "worker_deletion_scheduled";
  return null;
}

/**
 * Links an RVM student to one BadaBhai worker (#2752 items 6 and 7). Campus sends only his
 * reference; his agreed fields come from RVM's Student API, under his RVM consent.
 *
 * ONE PHONE IS ONE PERSON. The worker row is found or created by the hashed +91 phone through
 * `WorkersRepository.createOrGetByPhoneHash`, the same race-safe path sign-in uses, so a student
 * who already uses BadaBhai keeps his own row and his own profile. This trusts the phone RVM
 * returns to be his: the Student API binds it by OTP at sign-in (Scheduler_Backend#159).
 *
 * ORDER. RVM is read FIRST, outside any transaction: a refusal or an outage writes nothing, and
 * no workers row is ever created for a student RVM refused. Then one transaction, serialised per
 * reference, holds the worker row, the link, the origin and `worker.institute_linked`.
 *
 * WHAT IS NEVER DONE HERE. No `worker_consents` row (BadaBhai's own notice still meets him at
 * first sign-in); no `worker.created` (it fires at that sign-in); no change to the name, phone or
 * origin of a worker who already uses BadaBhai; nothing logged about him but ids.
 */
@Injectable()
export class InstituteLinkService {
  constructor(
    private readonly repo: InstituteLinkRepository,
    private readonly workers: WorkersRepository,
    private readonly rvm: RvmStudentApiClient,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /**
   * Finds or creates the link for one student and refreshes his agreed fields.
   *
   * @throws StudentNotAvailableError — RVM refused, or the link needs a human. Nothing created.
   * @throws RvmStudentApiUnavailableError — RVM did not answer usably. Retryable; nothing created.
   */
  async linkStudent(studentRef: string, ctx: RequestContext): Promise<LinkedStudent> {
    const ref = StudentRefSchema.parse(studentRef);

    const lookup = await this.rvm.readStudent(ref);
    if (lookup.kind === "not_available") throw new StudentNotAvailableError();

    const student = lookup.student;
    const phoneE164 = `+91${student.phone}`;
    const phoneHash = this.pii.hashPhone(phoneE164);
    const facts = toFacts(student);

    const outcome = await this.repo.withTransaction((tx) =>
      this.linkInTransaction(tx, { ref, student, phoneE164, phoneHash, facts }, ctx),
    );
    // Thrown only after the transaction committed, so a manual-list row it wrote is kept.
    if (outcome.kind === "refused") throw new StudentNotAvailableError();
    return outcome.student;
  }

  private async linkInTransaction(
    tx: Database,
    input: {
      ref: string;
      student: RvmStudentRead;
      phoneE164: string;
      phoneHash: string;
      facts: InstituteLinkFacts;
    },
    ctx: RequestContext,
  ): Promise<LinkOutcome> {
    const now = new Date();
    // One link at a time per student: a concurrent call for the same reference waits here.
    await this.repo.lockStudentRef(tx, RVM, input.ref);
    const existing = await this.repo.findByRefForUpdate(tx, RVM, input.ref);

    if (existing) {
      const standing = await this.repo.workerStanding(tx, existing.workerId);
      const unfit = standing ? unfitReason(standing) : "worker_deletion_scheduled";
      if (unfit) return this.refuse(tx, existing.workerId, input.ref, unfit);

      await this.followPhoneChange(tx, existing.workerId, input);
      await this.repo.refreshActive(tx, existing.workerId, input.facts, now);
      if (existing.status === "withdrawn") {
        // Re-linked after a withdrawal (he gave RVM his consent again): a fact worth an event.
        await this.emitLinked(tx, existing.workerId, false, now, ctx);
      }
      return { kind: "linked", student: { workerId: existing.workerId, workerCreated: false } };
    }

    const { worker, created } = await this.workers.createOrGetByPhoneHash(
      {
        phoneE164: this.pii.encrypt(input.phoneE164),
        phoneHash: input.phoneHash,
        fullName: this.pii.encrypt(input.student.name),
        // No sign-in yet: `pending` keeps him out of the funnel and the journey until his first
        // worker-app sign-in activates him (and emits `worker.created`, once).
        status: "pending",
        isTestAccount: isSyntheticTestPhone(input.phoneE164),
      },
      tx,
    );

    if (!created) {
      const unfit = unfitReason(worker);
      if (unfit) return this.refuse(tx, worker.id, input.ref, unfit);
    }

    const link = await this.repo.insertActive(tx, {
      workerId: worker.id,
      instituteCode: RVM,
      studentRef: input.ref,
      facts: input.facts,
      now,
    });
    if (!link) {
      // Under the reference lock the only conflict left is his row being linked under ANOTHER
      // reference (two RVM accounts on one phone). A row created a moment ago cannot be: if it
      // were, roll back rather than leave a worker row for a student who was not linked.
      if (created) throw new Error("institute link invariant: a new worker row is already linked");
      return this.refuse(tx, worker.id, input.ref, "worker_linked_to_another_ref");
    }

    // A worker who already uses BadaBhai keeps his own row untouched: name, phone and origin.
    if (created) await this.repo.recordOrigin(tx, worker.id, "institute", RVM);
    await this.emitLinked(tx, worker.id, created, link.linkedAt, ctx);
    return { kind: "linked", student: { workerId: worker.id, workerCreated: created } };
  }

  /** A manual-list case, committed with the transaction; the caller throws after commit. */
  private async refuse(
    tx: Database,
    workerId: string,
    ref: string,
    reason: string,
  ): Promise<LinkOutcome> {
    await this.repo.recordManualCase(tx, INSTITUTE_LINK_AUDIT_ACTIONS.refused, workerId, {
      institute_code: RVM,
      student_ref: ref,
      reason,
    });
    return { kind: "refused" };
  }

  private async emitLinked(
    tx: Database,
    workerId: string,
    workerCreated: boolean,
    at: Date,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"worker.institute_linked"> = {
      worker_id: workerId,
      institute_code: RVM,
      worker_created: workerCreated,
    };
    await this.events.emit({
      event_name: "worker.institute_linked",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      // One per link made (or re-made). Keyed on ids BadaBhai owns, never on RVM's reference.
      idempotencyKey: `worker.institute_linked:${workerId}:${at.toISOString()}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }

  /**
   * RVM changed his phone. The link is keyed by the reference, so it stays; the phone moves only
   * on a row this link created and he has never signed in to, and only when no other worker holds
   * the new number. Anything else is a manual case: a worker's own login phone is never
   * rewritten from here.
   */
  private async followPhoneChange(
    tx: Database,
    workerId: string,
    input: { ref: string; phoneE164: string; phoneHash: string },
  ): Promise<void> {
    const holder = await this.workers.findByPhoneHash(input.phoneHash, tx);
    if (holder?.id === workerId) return;

    const moved =
      holder === undefined &&
      (await this.repo.moveLinkCreatedWorkerPhone(tx, workerId, RVM, {
        phoneE164Enc: this.pii.encrypt(input.phoneE164),
        phoneHash: input.phoneHash,
      }));
    if (moved) return;

    await this.repo.recordManualCase(tx, INSTITUTE_LINK_AUDIT_ACTIONS.phoneMismatch, workerId, {
      institute_code: RVM,
      student_ref: input.ref,
      reason: holder ? "phone_held_by_another_worker" : "worker_signs_in_himself",
    });
  }
}

function toFacts(student: RvmStudentRead): InstituteLinkFacts {
  return {
    studentStatus: student.status,
    course: student.course,
    branch: student.branch,
    testScore: student.test_score === null ? null : student.test_score.toFixed(2),
  };
}
