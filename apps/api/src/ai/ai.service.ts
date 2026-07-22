import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  ProfilingTurnOutputSchema,
  ProfileExtractionOutputSchema,
  ProfilingOpeningOutputSchema,
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

  /**
   * Memoized one-shot openers, keyed by role family. SUCCESSES ONLY — see
   * `profilingOpening`. In-process and unbounded is fine: the key space is the
   * role-family set (one today), not anything worker-derived.
   */
  private readonly openingCache = new Map<string, string>();

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

  /**
   * The one-shot composite opener, or `null` when the AI service cannot supply it.
   *
   * NO MOCK FALLBACK, deliberately. Every other method here falls back to a local
   * mock so the caller always gets something; this one must not, because a local
   * fallback would be a THIRD copy of the opener copy (after `question_bank.py` and
   * the Flutter const) and they would drift. `null` means "render your own const",
   * which is exactly what the client already does today.
   *
   * Successes are memoized per role family: the opener is a module constant on the
   * other side, so re-fetching it on every chat mount is a pointless hop on a 2G
   * connection. Failures are NEVER cached — a single blip must not pin every later
   * session to the fallback for the lifetime of the process.
   */
  async profilingOpening(roleFamily = "cnc_vmc"): Promise<string | null> {
    const cached = this.openingCache.get(roleFamily);
    if (cached !== undefined) return cached;

    const remote = await this.post(
      "/profiling/opening",
      { role_family: roleFamily },
      ProfilingOpeningOutputSchema,
    );
    const text = remote?.opening_text?.trim() ? remote.opening_text : null;
    if (text !== null) this.openingCache.set(roleFamily, text);
    return text;
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
    // Q14: local mock fallback (AI service unreachable — NO LLM involved) renders
    // ids + the worker-confirmed raw labels, deduped case-insensitively against
    // the ids with the `skill_` prefix stripped (label "Milling" dupes skill_milling).
    // SAFE UNGATED BY CONSTRUCTION: skill_labels is CERTIFIED CLEAN AT REST by the
    // AI service at population (/profile/extract → sanitize_skill_labels: hygiene
    // clamp + pseudonymize certification — a blocked/masked/altered label never
    // persists in profiles.raw_profile), so this no-LLM path only ever echoes
    // already-certified labels. No TS-side pseudonymize equivalent is needed here.
    const idKeys = new Set(profile.skills.map((s) => s.replace(/^skill_/, "").replace(/_/g, " ").toLowerCase()));
    const skills = [
      ...profile.skills,
      ...profile.skill_labels.filter((l) => !idKeys.has(l.toLowerCase())),
    ];
    const lines = [
      "PROFESSIONAL SUMMARY (draft)",
      profile.canonical_role_id ? `Role: ${profile.canonical_role_id}` : "Role: (to be confirmed)",
      skills.length ? `Skills: ${skills.join(", ")}` : "Skills: (to be confirmed)",
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
   *
   * TIMEOUT BUDGET (D-2 chunked-sync STT — the ONE call that legitimately runs
   * long; every other AI call keeps the 8s default): a REAL 120s note inside
   * the ai-service is storage fetch <=20s (storage.py _TIMEOUT_SECONDS) +
   * ceil(5 chunks / concurrency 2) = 3 waves x <=60s Sarvam per-call timeout =
   * <=180s + translate <=60s => <=260s worst case; +10s overhead => 270s. The
   * caller is the BullMQ VoiceTranscriptionProcessor (off the request path;
   * BullMQ auto-extends the job lock while the handler runs), so holding the
   * fetch is safe. Mock mode still answers in milliseconds.
   */
  async transcribe(input: TranscriptionInput): Promise<TranscriptionOutput> {
    const remote = await this.post("/voice/transcribe", input, TranscriptionOutputSchema, 270_000);
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
   * the caller can fall back to a mock. Uses a short timeout by default;
   * `timeoutMs` lets the one legitimately-long call (chunked STT — see
   * `transcribe`) raise ONLY its own budget without touching every other path.
   */
  private async post<TOut>(
    path: string,
    body: unknown,
    schema: { parse: (v: unknown) => TOut },
    timeoutMs = 8000,
  ): Promise<TOut | null> {
    const url = `${this.config.AI_SERVICE_URL}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // TD67: attach the service-level bearer when configured (the ai-service enforces
      // it on every route except /health once ITS side sets the same env var).
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.AI_INTERNAL_TOKEN) {
        headers["x-ai-internal-token"] = this.config.AI_INTERNAL_TOKEN;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401) {
          // TD67: a 401 is DETERMINISTIC misconfiguration (AI_INTERNAL_TOKEN mismatch
          // between the api and the ai-service), not a transient outage — log it at
          // ERROR so a half-flipped env is loud, while keeping the same safe mock
          // degradation as any other non-OK (canonicalization/profiling never block).
          this.logger.error(
            `AI service ${path} rejected service auth (401) — AI_INTERNAL_TOKEN mismatch ` +
              `between api and ai-service; using mock fallback`,
          );
        } else {
          this.logger.warn(`AI service ${path} returned ${res.status}; using mock fallback`);
        }
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
