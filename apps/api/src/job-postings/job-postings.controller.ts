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
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
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
 * Ops-created, vacancy-banded, stored-only job postings (ADR-0010). Thin HTTP
 * layer: validation via ZodValidationPipe, all logic + events in the service.
 * No ops auth in alpha — `created_by` is supplied on the create body.
 */
@Controller("job-postings")
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
}
