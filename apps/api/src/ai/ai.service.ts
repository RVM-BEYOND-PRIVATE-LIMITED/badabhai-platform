import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  ProfilingTurnOutputSchema,
  ProfileExtractionOutputSchema,
  ResumeGenerationOutputSchema,
  DraftProfileSchema,
  TranscriptionOutputSchema,
  SkillCanonicalizationSchema,
  type SkillCanonicalizationInput,
  type SkillCanonicalization,
  type ProfilingTurnInput,
  type ProfilingTurnOutput,
  type ProfileExtractionInput,
  type ProfileExtractionOutput,
  type ResumeGenerationInput,
  type ResumeGenerationOutput,
  type TranscriptionInput,
  type TranscriptionOutput,
} from "@badabhai/ai-contracts";
import { SERVER_CONFIG } from "../config/config.module";
import { mockProfilingTurn } from "./mock-interview";

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
    // `input` carries the loaded conversation_state + role_family, so the remote
    // service progresses the interview statefully.
    const remote = await this.post("/profiling/respond", input, ProfilingTurnOutputSchema);
    if (remote) return remote;

    // Mock fallback: advance the interview locally (stateful) so it does not
    // restart from Q1 when the AI service is unreachable.
    const turn = mockProfilingTurn(input.conversation_state ?? null, input.role_family);
    return ProfilingTurnOutputSchema.parse({
      reply_text: turn.reply_text,
      blocked: false,
      suggested_followups: turn.suggested_followups,
      is_mock: true,
      asked_question_id: turn.asked_question_id,
      extraction_ready: turn.extraction_ready,
      updated_state: turn.updated_state,
    });
  }

  async extractProfile(input: ProfileExtractionInput): Promise<ProfileExtractionOutput> {
    const remote = await this.post("/profile/extract", input, ProfileExtractionOutputSchema);
    if (remote) return remote;
    // Mock fallback (AI service unreachable): still surface operational metadata so
    // an ai_jobs row records that this job ran on the MOCK path (real_call=false,
    // zero cost/tokens) instead of leaving cost/usage blank. PII-free.
    return ProfileExtractionOutputSchema.parse({
      profile: DraftProfileSchema.parse({}),
      blocked: false,
      is_mock: true,
      ai_metadata: this.mockCallMetadata("profile_extraction"),
    });
  }

  /** Operational AICallMetadata for the local mock path — a real LLM call did NOT happen. */
  private mockCallMetadata(taskType: string) {
    return {
      ai_call_id: randomUUID(),
      task_type: taskType,
      model_name: "mock",
      provider: "mock",
      real_call: false,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_inr: 0,
      latency_ms: 0,
      success: true,
      error_code: null,
      cost_alert: false,
      above_target: false,
      created_at: new Date().toISOString(),
    };
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
   * Transcribe a voice note. The AI service pseudonymizes nothing here (STT
   * input is audio); the real Sarvam call is gated off by default, so the mock
   * path returns a deterministic transcript. If the AI service is unreachable,
   * fall back to an EMPTY transcript (never fabricate one) so the processor
   * records a degraded result rather than inventing words.
   */
  async transcribe(input: TranscriptionInput): Promise<TranscriptionOutput> {
    const remote = await this.post("/voice/transcribe", input, TranscriptionOutputSchema);
    if (remote) return remote;
    return TranscriptionOutputSchema.parse({ transcript_text: "", confidence: 0, english_text: "", is_mock: true });
  }

  /**
   * ADR-0030 / TAX-6: canonicalize ONE skill phrase through the SAME pipeline the
   * worker side uses (shared id space). Returns null when the AI service is
   * unreachable — the caller treats null exactly like UNRESOLVED (a posting is
   * NEVER blocked or failed by canonicalization; the raw phrase is kept either way).
   * SG-3 rides the contract: skill_id is only ever a vector-layer-assigned id.
   */
  async canonicalizeSkill(
    input: SkillCanonicalizationInput,
  ): Promise<SkillCanonicalization | null> {
    return this.post("/skills/canonicalize", input, SkillCanonicalizationSchema);
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
