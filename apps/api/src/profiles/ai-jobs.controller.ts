import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { clampLimit } from "../common/pagination";
import { AiJobsRepository } from "./ai-jobs.repository";

/** Read-only AI-jobs for the ops console + async-job polling (refs only, no PII). */
@Controller("ai-jobs")
export class AiJobsController {
  constructor(private readonly aiJobs: AiJobsRepository) {}

  @Get()
  async list(@Query("limit") limit?: string) {
    const rows = await this.aiJobs.list(clampLimit(limit));
    return {
      ai_jobs: rows.map((j) => ({
        id: j.id,
        job_type: j.jobType,
        status: j.status,
        // Surface cost/model so ops can scan AI spend without opening each job.
        model_name: j.modelName ?? null,
        real_call: j.realCall ?? null,
        total_tokens: j.totalTokens ?? null,
        cost_inr: j.costInr ?? null,
        created_at: j.createdAt,
        updated_at: j.updatedAt,
      })),
    };
  }

  /** Poll a single job (e.g. profile extraction): status + output_ref + AI usage/cost. */
  @Get(":id")
  async get(@Param("id", new ParseUUIDPipe()) id: string) {
    const job = await this.aiJobs.findById(id);
    if (!job) throw new NotFoundException(`AI job ${id} not found`);
    return {
      id: job.id,
      job_type: job.jobType,
      status: job.status,
      output_ref: job.outputRef ?? null,
      error_message: job.errorMessage ?? null,
      // Operational AI usage/cost metadata (PII-free; null until completed).
      ai_usage: {
        model_name: job.modelName ?? null,
        real_call: job.realCall ?? null,
        input_tokens: job.inputTokens ?? null,
        output_tokens: job.outputTokens ?? null,
        total_tokens: job.totalTokens ?? null,
        cost_inr: job.costInr ?? null,
      },
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    };
  }
}
