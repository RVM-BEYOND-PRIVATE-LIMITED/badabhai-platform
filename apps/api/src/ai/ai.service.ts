import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  ProfilingTurnOutputSchema,
  ProfileExtractionOutputSchema,
  ResumeGenerationOutputSchema,
  DraftProfileSchema,
  type ProfilingTurnInput,
  type ProfilingTurnOutput,
  type ProfileExtractionInput,
  type ProfileExtractionOutput,
  type ResumeGenerationInput,
  type ResumeGenerationOutput,
} from "@badabhai/ai-contracts";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * Client for the FastAPI AI service.
 *
 * IMPORTANT: pseudonymization happens INSIDE the AI service before any LLM call.
 * This client just forwards requests. If the AI service is unreachable (e.g. not
 * running in local dev), every method falls back to a SAFE mock so the profiling
 * flow keeps working — it never silently sends raw data anywhere.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  async profilingRespond(input: ProfilingTurnInput): Promise<ProfilingTurnOutput> {
    const remote = await this.post("/profiling/respond", input, ProfilingTurnOutputSchema);
    if (remote) return remote;
    return ProfilingTurnOutputSchema.parse({
      reply_text:
        "Bada Bhai here 👋 — tell me about your work: which machines do you run (CNC/VMC/HMC), and how many years of experience do you have?",
      blocked: false,
      suggested_followups: ["Which controller — Fanuc or Siemens?", "How many years on VMC?"],
      is_mock: true,
    });
  }

  async extractProfile(input: ProfileExtractionInput): Promise<ProfileExtractionOutput> {
    const remote = await this.post("/profile/extract", input, ProfileExtractionOutputSchema);
    if (remote) return remote;
    return ProfileExtractionOutputSchema.parse({
      profile: DraftProfileSchema.parse({}),
      blocked: false,
      is_mock: true,
    });
  }

  async generateResume(input: ResumeGenerationInput): Promise<ResumeGenerationOutput> {
    const remote = await this.post("/resume/generate", input, ResumeGenerationOutputSchema);
    if (remote) return remote;
    const { profile } = input;
    const lines = [
      "PROFESSIONAL SUMMARY (draft)",
      profile.canonical_role_id ? `Role: ${profile.canonical_role_id}` : "Role: (to be confirmed)",
      profile.skills.length ? `Skills: ${profile.skills.join(", ")}` : "Skills: (to be confirmed)",
      profile.machines.length ? `Machines: ${profile.machines.join(", ")}` : "Machines: (to be confirmed)",
    ];
    return ResumeGenerationOutputSchema.parse({
      resume_text: lines.join("\n"),
      resume_json: { profile },
      format: "text",
      is_mock: true,
    });
  }

  /**
   * POST helper. Returns parsed output on success, or `null` on any failure so
   * the caller can fall back to a mock. Uses a short timeout.
   */
  private async post<TOut>(
    path: string,
    body: unknown,
    schema: { parse: (v: unknown) => TOut },
  ): Promise<TOut | null> {
    const url = `${this.config.AI_SERVICE_URL}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`AI service ${path} returned ${res.status}; using mock fallback`);
        return null;
      }
      return schema.parse(await res.json());
    } catch (err) {
      this.logger.warn(`AI service ${path} unreachable (${String(err)}); using mock fallback`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
