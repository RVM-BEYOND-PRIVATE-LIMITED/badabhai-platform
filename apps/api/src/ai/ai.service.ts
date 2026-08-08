import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import {
  ProfileExtractionOutputSchema,
  ResumeGenerationOutputSchema,
  DraftProfileSchema,
  TranscriptionOutputSchema,
  SkillCanonicalizationSchema,
  JobPostingChatOpeningOutputSchema,
  JobPostingChatTurnOutputSchema,
  PseudonymizationOutputSchema,
  ProfileParseOutputSchema,
  type PseudonymizationOutput,
  type ProfileParseInput,
  type ProfileParseOutput,
  type JobPostingChatTurnInput,
  type JobPostingChatTurnOutput,
  type SkillCanonicalizationInput,
  type SkillCanonicalization,
  type ProfileExtractionInput,
  type ProfileExtractionOutput,
  type ResumeGenerationInput,
  type ResumeGenerationOutput,
  type TranscriptionInput,
  type TranscriptionOutput,
} from "@badabhai/ai-contracts";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * TD81 — what the api can learn about the ai-service from ITS `GET /health`.
 *
 * Deliberately ONE field. The ai-service's health payload is rich (spend, caps,
 * langfuse, ledger backend) but that is recon data on a shared network — TD67 is
 * exactly why the ai-service stopped disclosing it tokenlessly — and the api's own
 * `/health` is UNAUTHENTICATED, so anything surfaced here becomes public. The one
 * thing an operator genuinely cannot get elsewhere is "am I looking at real AI or
 * mocked AI", so that is the only thing this carries.
 */
export interface AiServiceHealthSnapshot {
  /**
   * The ai-service's own `real_calls_enabled`, or `null` when it did not disclose it.
   *
   * `null` is NOT "false" and must never be collapsed into it: under the TD67 LOCKED
   * posture (`AI_INTERNAL_TOKEN` set on the ai-service) the tokenless `/health` returns
   * liveness + `service_auth_enabled` ONLY (apps/ai-service/app/main.py:174-175), so the
   * flag is genuinely unknowable from here. Reporting that as `false` would tell an
   * operator "your AI is mocked" about a correctly-hardened service.
   */
  realCallsEnabled: boolean | null;
}

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
   * ADR-0035 — the same successes-only memo for the job-posting chat opener, kept
   * SEPARATE from {@link openingCache} so a role-family key and a trade-hint key can
   * never collide and serve a worker opener to a payer.
   *
   * BOUNDED TODAY BY THE CALLER, not by this map: `trade_hint` is server-controlled in
   * this slice (the payer portal does not send one), so the key space is a single
   * entry. If a later slice ever accepts a client-supplied hint, this must gain a cap
   * BEFORE that lands — an unbounded map keyed by attacker-controlled text is a memory
   * leak. Failures are never cached (a blip must not pin later sessions to the
   * fallback).
   */
  private readonly jobPostingOpeningCache = new Map<string, string>();

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  // ── DELETED WITH THE LLM INTERVIEW (OIE Phase 8) ────────────────────────────────────
  //
  // `profilingRespond` and `profilingOpening` lived here, and both routes behind them are
  // gone. The worker interview is deterministic: `ProfilingOrchestrator` picks the next
  // question from a reviewed pack, in-process, with no model and no network hop. The
  // opener is a reviewed constant (`CHAT_OPENING_TEXT` in `ChatService`) rather than a
  // `capable`-tier call spent on the chat MOUNT before the worker had said anything.
  //
  // `openingCache` went with them. `jobPostingOpeningCache` below is a DIFFERENT map for a
  // DIFFERENT conversation and is untouched — the payer side still has an LLM interview.
  //
  // THE ONE LLM CALL LEFT ON THIS PATH IS `parseProfile`, at the very end. That is the
  // whole economic case for the project: ~12 `capable` calls per interview became 1.

  /**
   * ADR-0035 — the payer-facing job-posting chat opener, or `null` when the AI service
   * cannot supply it.
   *
   * NO MOCK FALLBACK, on the same reasoning as {@link profilingOpening}: a second copy
   * would be a second copy of the opener copy and the two would drift. `null` means
   * "the client renders its own constant", which is what it already does.
   *
   * PRIVACY: the request body carries a trade hint and nothing else — no payer id, no
   * session id, and never the payer's organisation name (ADR-0035 §Decision 3: the
   * chat does not ask for it and the AI service never receives it).
   */
  async jobPostingChatOpening(tradeHint: string | null = null): Promise<string | null> {
    const key = tradeHint ?? "";
    const cached = this.jobPostingOpeningCache.get(key);
    if (cached !== undefined) return cached;

    const remote = await this.post(
      "/job-posting-chat/opening",
      { trade_hint: tradeHint },
      JobPostingChatOpeningOutputSchema,
    );
    const text = remote?.opening_text?.trim() ? remote.opening_text : null;
    if (text !== null) this.jobPostingOpeningCache.set(key, text);
    return text;
  }

  /**
   * ADR-0035 — one payer turn of the deterministic job-posting interview. Returns
   * `null` when the AI service is unreachable or rejects the call.
   *
   * NO MOCK FALLBACK — the posture {@link profilingRespond} has now adopted too, for
   * the same reason stated first here. The job-posting engine — its topic bank, its
   * ordering, its banding — lives ONLY in `apps/ai-service/app/job_posting_chat/`,
   * where it remains deterministic (that is the difference: the WORKER interview is
   * now model-driven, this payer one is not). A TS mock here
   * would be a second interview engine for the same conversation, free to drift on
   * topic order, banding boundaries, or which fields it fills; a payer would then get a
   * draft the real engine would never have produced. Returning `null` lets the caller
   * fail the turn loudly and keep the stored state and draft untouched, which is the
   * honest outcome — the payer's session is durable and resumable by construction.
   *
   * PRIVACY: `input.message_text` is payer free text and is pseudonymized FAIL-CLOSED
   * on the other side BEFORE the engine or any model sees it (invariant #3); no LLM
   * call happens on this route today at all. `payer_ref` is the opaque payer uuid for
   * spend attribution — never a name, email, or organisation.
   */
  async jobPostingChatRespond(
    input: JobPostingChatTurnInput,
  ): Promise<JobPostingChatTurnOutput | null> {
    return this.post("/job-posting-chat/respond", input, JobPostingChatTurnOutputSchema);
  }

  async extractProfile(input: ProfileExtractionInput): Promise<ProfileExtractionOutput> {
    const remote = await this.post("/profile/extract", input, ProfileExtractionOutputSchema);
    if (remote) return remote;
    // THE FALLBACK HAS TO CONFESS — the same fix `transcribe` got, for the same reason.
    //
    // Returning an empty draft is right: never fabricate a worker's profile. But the object
    // this returned was otherwise INDISTINGUISHABLE from a successful extraction of a worker
    // who said nothing — `blocked: false`, `extraction_status` defaulting to `"completed"`,
    // and `is_mock: true`, which is NOT a discriminator because the ai-service sets
    // `is_mock = not real_call` on its own success path and `AI_ENABLE_REAL_CALLS=false` is
    // the committed default. So a healthy mock extraction and a total outage arrived here
    // identically. `extract_service_unreachable` is authored on THIS side because it describes
    // something only this side can know: the request never arrived.
    //
    // `ai_metadata: null`, AND THAT IS A DELIBERATE REVERSAL. It used to synthesize a record
    // claiming `success: true, error_code: null, model_name: "mock"` for a call that never left
    // the process — which then reached `ai_jobs` as usage and emitted an `ai.cost_recorded`
    // event describing a provider call that did not happen. Null is what the sibling
    // `/profile/parse` path already does and what `recordAiCost` already documents as its
    // contract ("no metadata = no real call to record"); the caller's own comment on this path
    // said null too. The diagnosis moves to `error_code`, which cannot be mistaken for a
    // successful call the way fabricated metadata could.
    return ProfileExtractionOutputSchema.parse({
      profile: DraftProfileSchema.parse({}),
      blocked: false,
      is_mock: true,
      ai_metadata: null,
      error_code: "extract_service_unreachable",
    });
  }

  async generateResume(input: ResumeGenerationInput): Promise<ResumeGenerationOutput> {
    const remote = await this.post("/resume/generate", input, ResumeGenerationOutputSchema);
    if (remote) return remote;
    const { profile } = input;
    // Q14: local mock fallback (AI service unreachable — NO LLM involved) renders the
    // canonical skill NAMES (ids resolved via the taxonomy — the résumé must never show
    // a raw skill_* id) + the worker-confirmed raw labels, deduped case-insensitively.
    // SAFE UNGATED BY CONSTRUCTION: skill_labels is CERTIFIED CLEAN AT REST by the
    // AI service at population (/profile/extract → sanitize_skill_labels: hygiene
    // clamp + pseudonymize certification — a blocked/masked/altered label never
    // persists in profiles.raw_profile), so this no-LLM path only ever echoes
    // already-certified labels. No TS-side pseudonymize equivalent is needed here.
    const resolvedSkills = profile.skills.map(labelForTaxonomyId);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const seenSkills = new Set(resolvedSkills.map(norm));
    const skills = [...resolvedSkills];
    for (const l of profile.skill_labels) {
      const label = labelForTaxonomyId(l);
      const key = norm(label);
      if (key && !seenSkills.has(key)) {
        seenSkills.add(key);
        skills.push(label);
      }
    }
    const lines = [
      "PROFESSIONAL SUMMARY (draft)",
      profile.canonical_role_id
        ? `Role: ${labelForTaxonomyId(profile.canonical_role_id)}`
        : "Role: (to be confirmed)",
      skills.length ? `Skills: ${skills.join(", ")}` : "Skills: (to be confirmed)",
      profile.machines.length
        ? `Machines: ${profile.machines.map(labelForTaxonomyId).join(", ")}`
        : "Machines: (to be confirmed)",
      // #499 — education + certifications (closed-set tokens), emitted only when
      // present so the AI-service-unreachable fallback matches the real resume.
      // Highest academic level + stream ride the same block; PII-free labels, each
      // emitted only when present.
      ...(profile.education_level ? [`Education Level: ${profile.education_level}`] : []),
      ...(profile.education_field ? [`Field of Study: ${profile.education_field}`] : []),
      ...(profile.education.length ? [`Education: ${profile.education.join(", ")}`] : []),
      ...(profile.certifications.length ? [`Certifications: ${profile.certifications.join(", ")}`] : []),
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
    // THE FALLBACK HAS TO CONFESS. Returning an empty transcript is right — never fabricate the
    // worker's words — but the object above this line was otherwise INDISTINGUISHABLE from a
    // successful call on a worker who said nothing: same empty string, same zero confidence, and
    // (until `error_code` existed) no field capable of telling the two apart. The processor
    // stored it and marked the job completed, so an ai-service outage read as a wave of silent
    // workers. `stt_service_unreachable` is authored HERE because it describes something only
    // this side can know: the request never arrived.
    return TranscriptionOutputSchema.parse({
      transcript_text: "",
      confidence: 0,
      english_text: "",
      is_mock: true,
      error_code: "stt_service_unreachable",
    });
  }

  /**
   * THE ONE LLM CALL IN THE WHOLE INTERVIEW (OIE Phase 8).
   *
   * `/profile/parse` receives the deterministic answer map as its PRIMARY input and the
   * transcript as an indexed evidence store. It is never asked "what is this worker's salary";
   * it is asked "the worker's answer for `salary_expected` was `pandrah hazaar mahina` — return
   * the typed value and quote the span it came from". The framing IS the enforcement, and the
   * six gates on both sides of the wire are what make it hold.
   *
   * `null` ON EVERY FAILURE, and that is the fail-closed design rather than a convenience. The
   * caller projects a real profile from the answer map alone when this returns null — down,
   * blocked, mis-shaped, all one outcome — so the worker gets a profile regardless and the LLM
   * is an overlay adding coverage regexes cannot reach.
   *
   * NO MOCK FALLBACK. A fabricated parse result would be indistinguishable from a real one at
   * every later read, and `deterministic_only` is a strictly more honest answer.
   */
  async parseProfile(input: ProfileParseInput): Promise<ProfileParseOutput | null> {
    return this.post("/profile/parse", input, ProfileParseOutputSchema);
  }

  /**
   * Run text through the pseudonymization gateway and get the masked version back.
   *
   * NOT AN AI CALL. `/pseudonymize` is a regex-and-gazetteer pass with no model behind it, no
   * router entry and no spend — which is what makes it callable from the deterministic
   * interview without violating the plan's "zero LLM calls between session start and
   * completion". It is the same gateway every LLM path already goes through; this exposes it
   * to the ONE Nest caller that holds raw worker text and needs a masked copy of it (the
   * occupation growth queue, whose table contract is pseudonymized-only).
   *
   * `null` on unreachable/non-OK, like every other method here. `blocked: true` is NOT null and
   * must not be treated as one: it means the text carried PII the gateway would not mask, which
   * is a definitive "do not store this", not an outage.
   */
  async pseudonymize(text: string): Promise<PseudonymizationOutput | null> {
    return this.post(
      "/pseudonymize",
      { text, request_id: randomUUID() },
      PseudonymizationOutputSchema,
    );
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
   * TD81 — REACHABILITY + POSTURE probe, for `HealthService` only. NOT an AI call:
   * it is a `GET` of the ai-service's own `/health`, carries no worker data, and can
   * never reach an LLM, so nothing here touches the pseudonymization boundary.
   *
   * THROWS (unlike every other method on this class) on unreachable / non-OK / bad
   * shape. That inversion is deliberate: every other method degrades to a mock because
   * a worker mid-interview must keep moving, but the whole POINT of this one is to make
   * the degraded state VISIBLE — swallowing the failure into a `null` here would rebuild
   * the exact silence TD81 records ("`/health` still returns 200, so staging reports
   * healthy while running AI entirely mocked"). The caller is `HealthService.runProbe`,
   * which never rethrows and logs only a secret-free `safeReason` tag, so the throw
   * cannot escape into an HTTP body or a log line. The message deliberately carries the
   * status code only — never the URL.
   *
   * NO Zod schema, on purpose, where every sibling method parses one: the ai-service's
   * `/health` payload is VARIABLE BY POSTURE (the TD67 locked shape drops
   * `real_calls_enabled` and most of the body — main.py:168-192). A strict schema would
   * turn a correctly-hardened ai-service into a parse failure, i.e. report `down` for a
   * service that is up — a false alarm in the one place we are adding to kill false
   * comfort. So the read is duck-typed and tolerant: anything that is not a boolean is
   * "not disclosed" (`null`), never `false`.
   *
   * The TD67 bearer is NOT sent: `/health` is auth-exempt on the other side
   * (`_AUTH_EXEMPT_PATHS`, main.py:132) so it would buy nothing, and a secret should not
   * ride a request that does not need it — least privilege on the wire.
   */
  async probeHealth(timeoutMs = 2000): Promise<AiServiceHealthSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.AI_SERVICE_URL}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) {
        // Named so `HealthService.safeReason` logs a useful, secret-free tag.
        const e = new Error(`ai-service /health returned ${res.status}`);
        e.name = "AiServiceUnhealthyError";
        throw e;
      }
      const body: unknown = await res.json();
      const flag = (body as { real_calls_enabled?: unknown } | null)?.real_calls_enabled;
      return { realCallsEnabled: typeof flag === "boolean" ? flag : null };
    } finally {
      clearTimeout(timeout);
    }
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
