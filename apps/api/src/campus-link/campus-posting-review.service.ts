import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  RVM_INSTITUTE_CODE,
  audienceReachesRvmStudents,
  type Database,
  type RvmTargetingKind,
} from "@badabhai/db";
import type { z } from "zod";
import { isCanonicalUuid } from "../common/uuid";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type {
  CampusErrorCode,
  CampusReviewBodySchema,
  CampusReviewResponseSchema,
} from "./campus-link.contract";
import {
  CampusPostingReviewRepository,
  type DecisionWriteResult,
  type LockedReviewTarget,
  type ReviewBefore,
  type ReviewTarget,
} from "./campus-posting-review.repository";
import type { CampusCall } from "./campus-call";
import { cleanReviewReason } from "./campus-review-reason";

/** The parsed body of `PUT job-postings/:id/review`. */
export type CampusReviewDecision = z.output<typeof CampusReviewBodySchema>;

/** The answer to `PUT job-postings/:id/review`. */
export type CampusReviewResult = z.input<typeof CampusReviewResponseSchema>;

/** A course id the review row cannot store (`jpir_narrowing_chk` reads `^.{1,64}$`). */
const LINE_BREAK = /[\r\n]/;

/** The house neutral 404: nothing in it says whether the posting exists. */
function neutralNotFound(): NotFoundException {
  return new NotFoundException();
}

/** A 409 with the Campus `error.code`. */
function campusConflict(code: CampusErrorCode): ConflictException {
  return new ConflictException({ code });
}

/** Sorted and de-duplicated, so the stored narrowing (and a replay's comparison) is canonical. */
function canonical<T extends number | string>(ids: readonly T[]): T[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Can this posting be reviewed at all? Anything else is the neutral 404. */
function reviewable(target: ReviewTarget): target is ReviewTarget & { ownerPayerId: string } {
  return target.status !== "draft" && !target.hidden && target.ownerPayerId !== null;
}

/**
 * #2746 PR 5 — THE PLACEMENT TEAM REVIEWS THE RVM PART OF A POSTING (`PUT job-postings/:id/review`,
 * mounted only behind `CampusServiceGuard`).
 *
 * WHICH POSTINGS. Neutral 404 (no `code`, no hint that the posting exists): an id that is not a
 * posting, a draft, a hidden posting, a posting with no owning company (ops postings, agency
 * twins), and every posting while `job_audience` is not live for its owner — globally off, or in
 * `pilot` with the owner off the list (`CAMPUS_LINK_ENABLED` off is the guard's 404). Then, under
 * the posting's row lock: 409 `AUDIENCE_EXCLUDES_RVM` for a BadaBhai-only audience, 409
 * `POSTING_NOT_OPEN` for a CLOSED posting, 409 `POSTING_CHANGED` when the body's `content_hash` is
 * not the posting's hash now.
 *
 * CLOSED IS REFUSED, PAUSED AND SUSPENDED ARE NOT. `closed` is terminal (no edit, no reopen), so a
 * decision on it could never reach a student; refusing it keeps the review history to decisions
 * that can take effect, and the feed already tells Campus it closed. A paused or suspended posting
 * returns to `open` with the same content (resume, reinstatement), so its decision is kept and
 * holds then.
 *
 * NARROWING. A narrowed `branch_ids` / `course_ids` replaces the posting's own for RVM students.
 * Each id must be within the posting's own list; when that list is `[]` (every branch / course),
 * each must be an ACTIVE `rvm_targeting_options` row of the kind instead. Otherwise 400
 * `VALIDATION_FAILED`. On a rejection the narrowing is validated and stored the same way, because
 * `jpir_decision_chk` allows it on either decision; it has no effect while the posting is rejected.
 *
 * THE WRITE: one transaction, posting `FOR SHARE` → hash compared → review row `FOR UPDATE` → one
 * upsert that stores the hash it computes (`CampusPostingReviewRepository`, lock order there).
 * A re-decision replaces the earlier one. A replay of the decision the row already holds, on the
 * same content, writes nothing and answers the stored decision, so the route is idempotent by
 * content (the `Idempotency-Key` is required and checked, not stored). A decision that changed
 * the row emits `job_posting.rvm_reviewed` v1 and writes its `audit_logs` row (actor =
 * `reviewer_ref`) in the same transaction. `job_reach` is never touched: the RVM review does not
 * change who among BadaBhai workers sees the posting.
 *
 * LOGS AND EVENTS CARRY IDS AND ENUMS: never the reason text, which goes to the review row alone.
 */
@Injectable()
export class CampusPostingReviewService {
  private readonly logger = new Logger(CampusPostingReviewService.name);

  constructor(
    private readonly repo: CampusPostingReviewRepository,
    private readonly options: PostingAudienceRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly events: EventsService,
  ) {}

  async review(
    postingId: string,
    decision: CampusReviewDecision,
    call: CampusCall,
  ): Promise<CampusReviewResult> {
    // A malformed id cannot name a posting: the same 404 as an unknown one, before any read.
    if (!isCanonicalUuid(postingId)) throw neutralNotFound();
    // Off everywhere: no read at all. In `pilot` this is true for every company; the owner check
    // below is the pilot-list read.
    if (!this.rollout.isLiveForServiceCaller("job_audience")) throw neutralNotFound();

    const id = postingId.toLowerCase();
    const target = await this.repo.findTarget(id);
    if (target === undefined || !reviewable(target)) throw neutralNotFound();
    // Before the transaction: the tenancy and pilot reads use their own connections, and a
    // transaction holding a pool connection while waiting for another can starve the pool.
    if (!(await this.liveForOwner(target.ownerPayerId, id))) throw neutralNotFound();

    const reviewerRef = decision.reviewer_ref.toLowerCase();
    const reason = cleanReviewReason(decision.reason) ?? null;
    const branchIds = decision.branch_ids === undefined ? null : canonical(decision.branch_ids);
    const courseIds = decision.course_ids === undefined ? null : canonical(decision.course_ids);

    const answer = await this.repo.withTransaction(async (tx) => {
      const locked = await this.repo.lockTarget(id, tx);
      // Re-checked under the lock: a posting hidden (or re-owned) since the pre-check is a 404.
      if (
        locked === undefined ||
        !reviewable(locked) ||
        locked.ownerPayerId !== target.ownerPayerId
      ) {
        throw neutralNotFound();
      }
      if (!audienceReachesRvmStudents(locked.audience)) {
        throw campusConflict("AUDIENCE_EXCLUDES_RVM");
      }
      if (locked.status === "closed") throw campusConflict("POSTING_NOT_OPEN");
      if (locked.contentHash !== decision.content_hash) {
        this.logOutcome(id, decision.state, "posting_changed");
        throw campusConflict("POSTING_CHANGED");
      }
      await this.assertNarrowing("branch", branchIds, locked.rvmBranchIds, tx);
      await this.assertNarrowing("course", courseIds, locked.rvmCourseIds, tx);

      const before = await this.repo.lockReviewBefore(id, tx);
      const written = await this.repo.writeDecision(tx, {
        jobPostingId: id,
        state: decision.state,
        reviewerRef,
        reason,
        branchIds,
        courseIds,
        expectedContentHash: decision.content_hash,
      });
      return this.settle(tx, locked, before, written, {
        reviewerRef,
        hasReason: reason !== null,
        branchIds,
        courseIds,
        state: decision.state,
        call,
      });
    });
    return answer;
  }

  /**
   * Is `job_audience` live for the posting's OWNER? The owner's tenant key comes from
   * `PayerTenantScopeService`, exactly as a request by that company resolves it; a tenancy
   * refusal (`on` mode: an inactive org, a resolve error) fails closed as "not live".
   */
  private async liveForOwner(owner: string, postingId: string): Promise<boolean> {
    let scope: PayerTenantScope;
    try {
      scope = await this.tenancy.resolve(owner);
    } catch (err) {
      if (!(err instanceof ForbiddenException)) throw err;
      this.logger.warn(`campus review: owner tenancy refused (posting=${postingId}); answered 404`);
      return false;
    }
    return this.rollout.isEnabledFor("job_audience", scope.tenantKey);
  }

  /** 400 `VALIDATION_FAILED` unless every narrowed id is within the posting's own targeting. */
  private async assertNarrowing(
    kind: RvmTargetingKind,
    narrowed: readonly (number | string)[] | null,
    own: readonly (number | string)[],
    tx: Database,
  ): Promise<void> {
    if (narrowed === null) return;
    const refs = narrowed.map(String);
    const unstorable = refs.filter((ref) => LINE_BREAK.test(ref));
    let outside: string[];
    if (own.length > 0) {
      const held = new Set(own.map(String));
      outside = refs.filter((ref) => !held.has(ref));
    } else {
      // `[]` = every branch / course: each id must then be one Campus currently offers.
      const active = await this.options.activeOptionRefs(kind, refs, tx);
      outside = refs.filter((ref) => !active.has(ref));
    }
    const refused = [...new Set([...unstorable, ...outside])];
    if (refused.length === 0) return;
    // Reference ids (RVM location / Scheduler course ids), never personal data: safe to name.
    throw new BadRequestException({
      code: "VALIDATION_FAILED" satisfies CampusErrorCode,
      message: "Validation failed",
      issues: [
        {
          path: `${kind}_ids`,
          message: `not within the posting's own ${kind} targeting: ${refused.join(", ")}`,
        },
      ],
    });
  }

  /** The answer, and — when the row changed — the event and the audit row, on the same tx. */
  private async settle(
    tx: Database,
    locked: LockedReviewTarget,
    before: ReviewBefore | undefined,
    written: DecisionWriteResult,
    decision: {
      reviewerRef: string;
      hasReason: boolean;
      branchIds: number[] | null;
      courseIds: string[] | null;
      state: "approved" | "rejected";
      call: CampusCall;
    },
  ): Promise<CampusReviewResult> {
    const id = locked.id;
    switch (written.outcome) {
      case "missing":
        throw neutralNotFound();
      case "posting_changed":
        // The hash moved between the locked read and the write: impossible under `FOR SHARE`,
        // and refused the same way if it ever happens.
        this.logOutcome(id, decision.state, "posting_changed");
        throw campusConflict("POSTING_CHANGED");
      case "unchanged": {
        if (before === undefined || before.reviewedAt === null) {
          throw new Error("campus review: an unchanged decision with no stored decision");
        }
        this.logOutcome(id, decision.state, "unchanged");
        return {
          posting_id: id,
          review_state: before.state,
          reviewed_at: before.reviewedAt.toISOString(),
        };
      }
      case "written": {
        const payload: PayloadInputOf<"job_posting.rvm_reviewed"> = {
          job_posting_id: id,
          institute_code: RVM_INSTITUTE_CODE,
          state: decision.state,
          previous_state: before?.stateNow ?? null,
          reviewer_ref: decision.reviewerRef,
          branch_ids: decision.branchIds,
          course_ids: decision.courseIds,
          has_reason: decision.hasReason,
          content_hash: written.contentHash,
        };
        const event = await this.events.emit({
          event_name: "job_posting.rvm_reviewed",
          // Campus is a service caller, not a BadaBhai principal (#2752's events do the same);
          // the staff member is `reviewer_ref` in the payload and the audit row's actor.
          actor: { actor_type: "system", actor_id: null },
          subject: { subject_type: "job_posting", subject_id: id },
          payload,
          correlationId: decision.call.ctx.correlationId,
          requestId: decision.call.ctx.requestId,
          tx,
        });
        await this.repo.writeAudit(tx, {
          jobPostingId: id,
          reviewerRef: decision.reviewerRef,
          metadata: {
            institute_code: RVM_INSTITUTE_CODE,
            state: decision.state,
            previous_state: payload.previous_state,
            narrowed_branch_ids: decision.branchIds,
            narrowed_course_ids: decision.courseIds,
            has_reason: decision.hasReason,
            content_hash: written.contentHash,
            campus_call_id: decision.call.callId,
            event_id: event.event_id,
          },
        });
        this.logOutcome(id, decision.state, "written");
        return {
          posting_id: id,
          review_state: decision.state,
          reviewed_at: written.reviewedAt.toISOString(),
        };
      }
    }
  }

  /** Ids and enums only. */
  private logOutcome(id: string, state: string, outcome: string): void {
    this.logger.log(`campus review: posting=${id} state=${state} outcome=${outcome}`);
  }
}
