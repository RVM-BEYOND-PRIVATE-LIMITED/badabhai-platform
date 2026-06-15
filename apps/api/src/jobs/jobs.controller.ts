import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { JobsService } from "./jobs.service";
import {
  ActivateJobSchema,
  BoostJobSchema,
  CloseJobSchema,
  CreateJobSchema,
  ListJobsSchema,
  RecordApplicantsSchema,
  type ActivateJobDto,
  type BoostJobDto,
  type CloseJobDto,
  type CreateJobDto,
  type ListJobsDto,
  type RecordApplicantsDto,
} from "./jobs.dto";

/**
 * Phase-2 Job lifecycle (the `posting_fee` billable object).
 *
 * INTERIM POSTURE: there is no payer auth yet, so every route is behind
 * `InternalServiceGuard` (the same shared-secret seam used by the resume PII
 * routes) until per-payer auth lands. Thin HTTP layer only — all business logic,
 * the state machine, and event emission live in JobsService.
 */
@Controller("jobs")
@UseGuards(InternalServiceGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreateJobSchema)) dto: CreateJobDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobs.create(dto, ctx);
  }

  @Get()
  list(@Query(new ZodValidationPipe(ListJobsSchema)) query: ListJobsDto) {
    return this.jobs.list(query);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.jobs.getOrThrow(id);
  }

  @Post(":id/activate")
  @HttpCode(200)
  activate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ActivateJobSchema)) dto: ActivateJobDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobs.activate(id, dto, ctx);
  }

  @Post(":id/pause")
  @HttpCode(200)
  pause(@Param("id", new ParseUUIDPipe()) id: string, @Ctx() ctx: RequestContext) {
    return this.jobs.pause(id, ctx);
  }

  @Post(":id/resume")
  @HttpCode(200)
  resume(@Param("id", new ParseUUIDPipe()) id: string, @Ctx() ctx: RequestContext) {
    return this.jobs.resume(id, ctx);
  }

  /** INTERIM ops/test seam — see JobsService.recordApplicants. */
  @Post(":id/applicants")
  @HttpCode(200)
  recordApplicants(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RecordApplicantsSchema)) dto: RecordApplicantsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobs.recordApplicants(id, dto, ctx);
  }

  @Post(":id/boost")
  @HttpCode(200)
  boost(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(BoostJobSchema)) dto: BoostJobDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobs.boost(id, dto, ctx);
  }

  @Post(":id/close")
  @HttpCode(200)
  close(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CloseJobSchema)) dto: CloseJobDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.jobs.close(id, dto, ctx);
  }
}
