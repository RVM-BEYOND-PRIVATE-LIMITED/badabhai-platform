import { Controller, Get, Query } from "@nestjs/common";
import { clampLimit } from "../common/pagination";
import { AiJobsRepository } from "./ai-jobs.repository";

/** Read-only AI-jobs list for the ops console (refs only, never raw PII). */
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
        created_at: j.createdAt,
        updated_at: j.updatedAt,
      })),
    };
  }
}
