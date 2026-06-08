import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from "@nestjs/common";
import { WorkersRepository } from "./workers.repository";

@Controller("workers")
export class WorkersController {
  constructor(private readonly workers: WorkersRepository) {}

  /** Worker + latest profile + latest generated resume. */
  @Get(":id/profile")
  async getProfile(@Param("id", new ParseUUIDPipe()) id: string) {
    const worker = await this.workers.findById(id);
    if (!worker) throw new NotFoundException(`Worker ${id} not found`);

    const [profile, resume] = await Promise.all([
      this.workers.latestProfile(id),
      this.workers.latestResume(id),
    ]);

    return {
      worker: {
        id: worker.id,
        status: worker.status,
        preferred_language: worker.preferredLanguage,
        // NOTE: full_name/phone are intentionally NOT returned by this endpoint.
        created_at: worker.createdAt,
      },
      profile: profile ?? null,
      resume: resume ?? null,
    };
  }
}
