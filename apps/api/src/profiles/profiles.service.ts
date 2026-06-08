import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { DraftProfile } from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ChatRepository } from "../chat/chat.repository";
import { AiService } from "../ai/ai.service";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import type { ExtractProfileDto, ConfirmProfileDto } from "./profiles.dto";

@Injectable()
export class ProfilesService {
  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly workers: WorkersRepository,
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {}

  async extract(dto: ExtractProfileDto, ctx: RequestContext) {
    const worker = await this.workers.findById(dto.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${dto.worker_id} not found`);

    // 1. Track the async AI work + emit "requested".
    const job = await this.aiJobs.create({
      jobType: "profile_extraction",
      status: "running",
      inputRef: { worker_id: dto.worker_id, session_id: dto.session_id ?? null },
    });
    await this.events.emit({
      event_name: "profile.extraction_requested",
      actor: { actor_type: "system" },
      subject: { subject_type: "ai_job", subject_id: job.id },
      payload: {
        worker_id: dto.worker_id,
        session_id: dto.session_id ?? null,
        ai_job_id: job.id,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // 2. Build a transcript (the AI service pseudonymizes before any LLM call).
    const transcript = await this.buildTranscript(dto.session_id);

    // 3. Call extraction (mock fallback if the AI service is down).
    const result = await this.ai.extractProfile({
      worker_ref: dto.worker_id,
      transcript,
    });
    const profile: DraftProfile = result.profile;
    const profileStatus = result.blocked ? "draft" : "extracted";

    // 4. Persist the draft profile.
    const saved = await this.profiles.create({
      workerId: dto.worker_id,
      profileStatus,
      canonicalTradeId: profile.canonical_trade_id,
      canonicalRoleId: profile.canonical_role_id,
      skills: profile.skills,
      machines: profile.machines,
      experience: profile.experience,
      salaryExpectation: profile.salary_expectation,
      locationPreference: profile.location_preference,
      availability: profile.availability,
      rawProfile: profile,
    });

    await this.aiJobs.markCompleted(job.id, { profile_id: saved.id });

    // 5. Emit "completed".
    await this.events.emit({
      event_name: "profile.extraction_completed",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "profile", subject_id: saved.id },
      payload: {
        worker_id: dto.worker_id,
        profile_id: saved.id,
        ai_job_id: job.id,
        profile_status: profileStatus,
        field_count: this.countFields(profile),
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { profile_id: saved.id, profile_status: profileStatus, is_mock: result.is_mock, profile };
  }

  async confirm(dto: ConfirmProfileDto, ctx: RequestContext) {
    const profile = await this.profiles.findById(dto.profile_id);
    if (!profile) throw new NotFoundException(`Profile ${dto.profile_id} not found`);
    if (profile.workerId !== dto.worker_id) {
      throw new BadRequestException("worker_id does not match the profile owner");
    }

    const confirmedAt = new Date();
    await this.profiles.confirm(dto.profile_id, confirmedAt);

    await this.events.emit({
      event_name: "profile.confirmed",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "profile", subject_id: dto.profile_id },
      payload: {
        worker_id: dto.worker_id,
        profile_id: dto.profile_id,
        confirmed_at: confirmedAt.toISOString(),
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { profile_id: dto.profile_id, profile_status: "confirmed", confirmed_at: confirmedAt.toISOString() };
  }

  private async buildTranscript(sessionId?: string): Promise<string> {
    if (!sessionId) return "(no conversation captured)";
    const messages = await this.chat.listMessages(sessionId);
    const text = messages
      .filter((m) => m.bodyText)
      .map((m) => `${m.direction === "inbound" ? "Worker" : "Bada Bhai"}: ${m.bodyText}`)
      .join("\n");
    return text || "(no conversation captured)";
  }

  private countFields(p: DraftProfile): number {
    let n = 0;
    if (p.canonical_role_id) n += 1;
    if (p.canonical_trade_id) n += 1;
    n += p.skills.length;
    n += p.machines.length;
    if (p.experience.total_years != null) n += 1;
    if (p.salary_expectation.amount_min != null || p.salary_expectation.amount_max != null) n += 1;
    if (p.location_preference.preferred_cities.length) n += 1;
    if (p.availability.status !== "unknown") n += 1;
    return n;
  }
}
