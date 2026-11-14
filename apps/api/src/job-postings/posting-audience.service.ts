import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  DEFAULT_JOB_POSTING_AUDIENCE,
  JOB_POSTING_AUDIENCES,
  audienceReachesRvmStudents,
  rvmReviewStateFor,
  type Database,
  type JobPostingAudience,
  type RvmTargetingKind,
} from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import type { PostingAudienceInput } from "./job-postings.dto";
import type { JobPostingApi } from "./job-postings.repository";
import { PostingAudienceRepository } from "./posting-audience.repository";
import { rvmReviewView, type RvmReviewView } from "./rvm-review-view";

/** A posting's audience and targeting, as the row holds it. */
export type PostingAudienceState = Pick<
  JobPostingApi,
  "audience" | "rvm_branch_ids" | "rvm_course_ids"
>;

/** The audience columns a company write stores (always all three: they are one decision). */
export interface PostingAudienceWrite {
  audience: JobPostingAudience;
  rvmBranchIds: number[];
  rvmCourseIds: string[];
}

/** The block a company's own posting read carries while it is shown. */
export interface PostingAudienceView {
  audience: JobPostingAudience;
  rvm_branch_ids: number[];
  rvm_course_ids: string[];
  rvm_review: RvmReviewView | null;
}

/**
 * The company's own posting: the shared projection minus the raw audience columns, plus the
 * audience block when it is shown (the switch is on for the company, or the stored audience is not
 * the default). Absent otherwise, so turning the switch off hides the fields again.
 */
export type PayerJobPostingApi = Omit<JobPostingApi, keyof PostingAudienceState> &
  Partial<PostingAudienceView>;

/** `GET /payer/job-postings/audience-options`. */
export interface AudienceOptionsDto {
  audiences: JobPostingAudience[];
  branches: { id: number; label: string; sort_order: number }[];
  courses: { id: string; label: string; sort_order: number }[];
}

/** The event actor (`JobPostingsService`'s): on every write that reaches here, the acting login. */
type PostingActor = { actor_type: "ops" | "payer" | "admin"; actor_id: string };

/** The audience half of a company body (`PostingAudienceInput`'s keys). */
const AUDIENCE_INPUT_KEYS = [
  "audience",
  "rvm_branch_ids",
  "rvm_course_ids",
] as const satisfies readonly (keyof PostingAudienceInput)[];

/** What every posting starts as: the column defaults. A create resolves against this. */
const DEFAULT_STATE: PostingAudienceState = {
  audience: DEFAULT_JOB_POSTING_AUDIENCE,
  rvm_branch_ids: [],
  rvm_course_ids: [],
};

/** Machine-readable `reason`s on this service's 400s; clients branch on these, never the text. */
export const AUDIENCE_REFUSAL_REASONS = {
  targetingNeedsRvmAudience: "targeting_needs_rvm_audience",
  targetingOptionNotOffered: "targeting_option_not_offered",
} as const;

/**
 * #2746 — WHO SEES A COMPANY'S POSTING: the audience (BadaBhai workers, RVM students, both), the
 * RVM branch / course targeting, and the RVM review row that gates the RVM part.
 *
 * ONE SWITCH, CAPABILITIES ONLY (security review M2). `job_audience` decides whether a company's
 * body may SET these fields and whether `audience-options` is mounted for it. While it is off the
 * fields are ignored — stripped, never an error, so a client that sends them gets exactly today's
 * behaviour. It never decides whether STORED state is honoured: the worker-path filter, the review
 * reset and the reads below run whatever it says, so switching it off (the rollback lever) cannot
 * re-expose an RVM-only job or silently keep an edited one approved.
 *
 * DETERMINISTIC VALIDATION. Targeting needs an audience with an RVM part; each id must be an
 * ACTIVE `rvm_targeting_options` row of its kind, except an id the posting already holds (Campus
 * may retire an option; a company re-sending its own targeting must still be able to save).
 *
 * THE REVIEW ROW, in the posting write's transaction:
 *   - an RVM audience gets a `pending` row if it has none (rows are never deleted);
 *   - any company edit puts a DECIDED row whose stored hash no longer matches back to `pending`;
 *   - an audience or targeting change bumps the row's `updated_at` (Campus's feed cursor).
 * Reads never trust the reset: they compare the hash live (`@badabhai/db` `job-review.ts`).
 *
 * WHO MAY. Only an `employer` account reaches the routes that call this (`PayerRoleGuard`, the
 * house 403); an agency's twins are pinned to BadaBhai workers by `job_postings_twin_audience_chk`.
 */
@Injectable()
export class PostingAudienceService {
  private readonly logger = new Logger(PostingAudienceService.name);

  constructor(
    private readonly rollout: FeatureRolloutService,
    private readonly repo: PostingAudienceRepository,
    private readonly events: EventsService,
  ) {}

  /** Is the audience capability on for this company (its TENANT key)? */
  enabledFor(scope: PayerTenantScope): Promise<boolean> {
    return this.rollout.isEnabledFor("job_audience", scope.tenantKey);
  }

  /**
   * The audience fields a company body carried, or `null` when it carried none OR the switch is
   * off for the company (the fields are then ignored). Reads the switch only when a field is sent.
   */
  async requestedBy(
    scope: PayerTenantScope,
    dto: PostingAudienceInput,
  ): Promise<PostingAudienceInput | null> {
    // Only the three keys, and only those the body set: the DTO is the whole company body.
    const requested: PostingAudienceInput = Object.fromEntries(
      AUDIENCE_INPUT_KEYS.flatMap((key) => (dto[key] === undefined ? [] : [[key, dto[key]]])),
    );
    if (Object.keys(requested).length === 0) return null;
    if (!(await this.enabledFor(scope))) {
      // Ids only. The fields are dropped exactly as Zod drops an unknown key.
      this.logger.debug(`job audience fields ignored: switch off for tenant=${scope.tenantKey}`);
      return null;
    }
    return requested;
  }

  /** A create's audience columns, or `null` for the default (nothing sent, switch off, default sent). */
  async resolveCreate(
    scope: PayerTenantScope,
    dto: PostingAudienceInput,
  ): Promise<PostingAudienceWrite | null> {
    const requested = await this.requestedBy(scope, dto);
    return requested === null ? null : this.resolveWrite(requested, DEFAULT_STATE);
  }

  /**
   * Decide the columns a request writes against the posting as it stands (an update passes the row
   * it LOCKED). `null` when the result equals what is stored — not a change. Throws the 400s.
   */
  async resolveWrite(
    requested: PostingAudienceInput,
    current: PostingAudienceState,
    executor?: Database,
  ): Promise<PostingAudienceWrite | null> {
    const audience = requested.audience ?? current.audience;
    let rvmBranchIds: number[] = [];
    let rvmCourseIds: string[] = [];

    if (!audienceReachesRvmStudents(audience)) {
      // `[]` is accepted (it says "no targeting"); a non-empty list has nothing to target.
      if (
        (requested.rvm_branch_ids?.length ?? 0) > 0 ||
        (requested.rvm_course_ids?.length ?? 0) > 0
      ) {
        throw audienceRefused(
          AUDIENCE_REFUSAL_REASONS.targetingNeedsRvmAudience,
          "rvm_branch_ids and rvm_course_ids need an audience that includes RVM students",
        );
      }
    } else {
      // Unsent lists keep what the posting holds; a BadaBhai-only row holds `[]` (the CHECK), so
      // a first RVM audience starts untargeted unless the body says otherwise.
      rvmBranchIds = canonical(requested.rvm_branch_ids ?? current.rvm_branch_ids);
      rvmCourseIds = canonical(requested.rvm_course_ids ?? current.rvm_course_ids);
      await this.assertOffered(
        "branch",
        rvmBranchIds.map(String),
        current.rvm_branch_ids.map(String),
        executor,
      );
      await this.assertOffered("course", rvmCourseIds, current.rvm_course_ids, executor);
    }

    const unchanged =
      audience === current.audience &&
      sameList(rvmBranchIds, current.rvm_branch_ids) &&
      sameList(rvmCourseIds, current.rvm_course_ids);
    return unchanged ? null : { audience, rvmBranchIds, rvmCourseIds };
  }

  /**
   * A new posting with a non-default audience, in its create transaction: the `pending` review row
   * for an RVM part, then `job_posting.audience_set` (no previous audience).
   */
  async recordCreateWithin(
    tx: Database,
    write: { posting: JobPostingApi; tenant: TenantKey; actor: PostingActor },
    ctx: RequestContext,
  ): Promise<void> {
    if (audienceReachesRvmStudents(write.posting.audience)) {
      await this.repo.ensurePendingReview(write.posting.id, tx);
    }
    await this.emitAudienceSet(tx, { ...write, previousAudience: null }, ctx);
  }

  /**
   * After a company edit, in its transaction (the posting row already holds the edit, so it is
   * locked before the review row — the house lock order). Every edit resets a decision the content
   * no longer matches; an audience or targeting change also opens the review row for an RVM part,
   * bumps the row and emits `job_posting.audience_set`.
   */
  async recordUpdateWithin(
    tx: Database,
    write: {
      posting: JobPostingApi;
      tenant: TenantKey;
      previousAudience: JobPostingAudience;
      audienceChanged: boolean;
      actor: PostingActor;
    },
    ctx: RequestContext,
  ): Promise<void> {
    const { posting } = write;
    if (write.audienceChanged && audienceReachesRvmStudents(posting.audience)) {
      await this.repo.ensurePendingReview(posting.id, tx);
    }
    await this.repo.resetStaleDecision(posting.id, tx);
    if (!write.audienceChanged) return;
    await this.repo.touchReview(posting.id, tx);
    await this.emitAudienceSet(tx, write, ctx);
  }

  /**
   * The company's own postings as it reads them. One switch read per call (only when some posting
   * holds the default audience, which is when the answer matters) and one review read for the
   * postings with an RVM part, so a page costs the same two queries whatever its size.
   */
  async payerViews(
    scope: PayerTenantScope,
    postings: readonly JobPostingApi[],
  ): Promise<PayerJobPostingApi[]> {
    if (postings.length === 0) return [];
    const isDefault = (p: JobPostingApi) => p.audience === DEFAULT_JOB_POSTING_AUDIENCE;
    const enabled = postings.some(isDefault) ? await this.enabledFor(scope) : false;
    const reviews = await this.repo.reviewStatesFor(
      scope.tenantKey,
      postings.filter((p) => audienceReachesRvmStudents(p.audience)).map((p) => p.id),
    );
    return postings.map((posting) => {
      const { audience, rvm_branch_ids, rvm_course_ids, ...rest } = posting;
      if (!enabled && isDefault(posting)) return rest;
      return {
        ...rest,
        audience,
        rvm_branch_ids,
        rvm_course_ids,
        rvm_review: rvmReviewView(audience, reviews.get(posting.id)),
      };
    });
  }

  /** The targeting choices, or the house neutral 404 while the switch is off for the company. */
  async optionsFor(scope: PayerTenantScope): Promise<AudienceOptionsDto> {
    if (!(await this.enabledFor(scope))) throw new NotFoundException();
    const rows = await this.repo.listActiveOptions();
    return {
      audiences: [...JOB_POSTING_AUDIENCES],
      branches: rows
        .filter((r) => r.kind === "branch")
        .map((r) => ({ id: Number(r.ref), label: r.label, sort_order: r.sortOrder })),
      courses: rows
        .filter((r) => r.kind === "course")
        .map((r) => ({ id: r.ref, label: r.label, sort_order: r.sortOrder })),
    };
  }

  /** 400 unless every id is an active option of its kind or one the posting already holds. */
  private async assertOffered(
    kind: RvmTargetingKind,
    refs: readonly string[],
    held: readonly string[],
    executor: Database | undefined,
  ): Promise<void> {
    const keep = new Set(held);
    const fresh = refs.filter((ref) => !keep.has(ref));
    if (fresh.length === 0) return;
    const active = await this.repo.activeOptionRefs(kind, fresh, executor);
    const missing = fresh.filter((ref) => !active.has(ref));
    if (missing.length === 0) return;
    // Reference ids (RVM location / Scheduler course ids), never personal data: safe to name.
    throw audienceRefused(
      AUDIENCE_REFUSAL_REASONS.targetingOptionNotOffered,
      `rvm_${kind}_ids holds an option that is not offered: ${missing.join(", ")}`,
    );
  }

  /** `job_posting.audience_set` on the write's transaction, with the review state after it. */
  private async emitAudienceSet(
    tx: Database,
    write: {
      posting: JobPostingApi;
      tenant: TenantKey;
      previousAudience: JobPostingAudience | null;
      actor: PostingActor;
    },
    ctx: RequestContext,
  ): Promise<void> {
    const { posting, actor } = write;
    const reviews = audienceReachesRvmStudents(posting.audience)
      ? await this.repo.reviewStatesFor(write.tenant, [posting.id], tx)
      : new Map();
    const payload: PayloadInputOf<"job_posting.audience_set"> = {
      job_posting_id: posting.id,
      audience: posting.audience,
      previous_audience: write.previousAudience,
      branch_ids: [...posting.rvm_branch_ids],
      course_ids: [...posting.rvm_course_ids],
      review_state: rvmReviewStateFor(posting.audience, reviews.get(posting.id)?.stateNow ?? null),
    };
    await this.events.emit({
      event_name: "job_posting.audience_set",
      actor,
      subject: { subject_type: "job_posting", subject_id: posting.id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }
}

/** Sorted and de-duplicated: the stored order is canonical, so the content hash is too. */
function canonical<T extends number | string>(ids: readonly T[]): T[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A 400 with a machine-readable `reason` beside the house keys (the #2635 shape). */
function audienceRefused(reason: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: "Bad Request", message, reason });
}
