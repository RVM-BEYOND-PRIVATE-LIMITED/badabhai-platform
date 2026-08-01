import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ReachWidenSchema, type ReachWidenDto } from "../match/match.dto";
import { JobPostingsService } from "./job-postings.service";
import {
  CreateJobPostingSchema,
  ListJobPostingsQuerySchema,
  UpdateJobPostingSchema,
  type CreateJobPostingDto,
  type ListJobPostingsQueryDto,
  type UpdateJobPostingDto,
} from "./job-postings.dto";

/**
 * Ops-created, vacancy-banded, stored-only job postings (ADR-0012). Thin HTTP
 * layer: validation via ZodValidationPipe, all logic + events in the service.
 * No ops auth in alpha — `created_by` is supplied on the create body.
 */
@Controller("job-postings")
@UseGuards(InternalServiceGuard)
export class JobPostingsController {
  constructor(private readonly jobPostings: JobPostingsService) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreateJobPostingSchema)) dto: CreateJobPostingDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.create(dto, ctx);
  }

  /** List postings, newest first; optional `?status=` filter. Read-only. */
  @Get()
  list(
    @Query(new ZodValidationPipe(ListJobPostingsQuerySchema)) query: ListJobPostingsQueryDto,
  ) {
    return this.jobPostings.list(query);
  }

  /** Get one posting; 404 if missing. Read-only. */
  @Get(":id")
  getOne(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.jobPostings.getOne(id);
  }

  /** Edit fields and/or publish (draft -> open). Transition guards in service. */
  @Patch(":id")
  @HttpCode(200)
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateJobPostingSchema)) dto: UpdateJobPostingDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.update(id, dto, ctx);
  }

  /** Close a posting (draft|open -> closed). Terminal. */
  @Post(":id/close")
  @HttpCode(200)
  close(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.close(id, ctx);
  }

  /**
   * Ops trust review — mark a posting VERIFIED (the worker-visible "Verified job"
   * badge). Idempotent. Rides the same alpha ops-auth posture as the sibling routes.
   */
  @Post(":id/verify")
  @HttpCode(200)
  verify(@Param("id", new ParseUUIDPipe()) id: string, @Ctx() ctx: RequestContext) {
    return this.jobPostings.verify(id, ctx);
  }

  /** Ops trust review — mark a posting REJECTED (reviewed and declined). Idempotent. */
  @Post(":id/reject")
  @HttpCode(200)
  reject(@Param("id", new ParseUUIDPipe()) id: string, @Ctx() ctx: RequestContext) {
    return this.jobPostings.reject(id, ctx);
  }

  /**
   * POLICY 27 (ADR-0036) — "Ops may widen a reach set, never narrow one. Expiring,
   * audited, evented."
   *
   * GUARDED, UNLIKE ITS SIBLINGS. Every other route on this controller rides the alpha
   * open ops posture; this one does not, and the difference is deliberate: widening a
   * reach set changes WHICH WORKERS SEE A JOB, on a posting whose owner explicitly
   * chose a narrower net. That is not the same class of action as reading a register or
   * flipping a verification badge, so it takes the ops service guard even though the
   * surrounding routes do not. If the whole controller later gains ops auth, this line
   * becomes redundant rather than wrong.
   *
   * APPEND-ONLY: the DTO has no field that can remove a skill, so "ops narrowed a reach
   * set" is not expressible on this route.
   *
   * EXPIRY IS NOT IMPLEMENTED — the widen is permanent until the posting is
   * re-published from its posted skills. That needs a column + a sweep (a migration),
   * which is outside this change's boundary; see `PublishReachService.opsWiden`.
   */
  @Post(":id/reach/widen")
  @HttpCode(200)
  @UseGuards(InternalServiceGuard)
  widenReach(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ReachWidenSchema)) dto: ReachWidenDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobPostings.opsWidenReach(id, dto.add_skill_ids, dto.ops_actor, ctx);
  }
}
