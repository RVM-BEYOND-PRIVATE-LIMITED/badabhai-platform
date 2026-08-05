import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type {
  DraftProfile,
  AICallMetadata,
  ConversationMessage,
  ProfileExtractionOutput,
} from "@badabhai/ai-contracts";
import type { NewWorkerProfile } from "@badabhai/db";
import { SKILL_TAXONOMY_VERSION } from "@badabhai/taxonomy";
import { EventsService } from "../events/events.service";
import { AiService } from "../ai/ai.service";
import { ChatRepository } from "../chat/chat.repository";
import { ChatTranscriptBuffer } from "../chat/chat-transcript.buffer";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { redactKnownName } from "../common/redact-known-name";
import { WorkerSkillsService } from "../match/worker-skills.service";
import { SkillsRepository } from "../skills/skills.repository";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository, type AiJobUsageMetadata } from "./ai-jobs.repository";
import { hasExtractedContent, type ProfileContentFields } from "./profile-content";
import { AI_SPEND_CAP_REASONS, type AiSpendCapReason } from "@badabhai/event-schema";
import {
  PROFILE_EXTRACTION_QUEUE,
  type ProfileExtractionJobData,
} from "../queue/queue.constants";

/**
 * TD27 spend-cap / circuit-breaker block codes the AI gateway returns in
 * `ai_metadata.error_code` when it REFUSES a real provider call. Mirrors the
 * `AI_SPEND_CAP_REASONS` enum in @badabhai/event-schema (single source of truth).
 */
const SPEND_CAP_REASONS: ReadonlySet<string> = new Set(AI_SPEND_CAP_REASONS);

/** Narrow an arbitrary `error_code` to a known spend-cap reason, or null. */
function asSpendCapReason(code: string | null | undefined): AiSpendCapReason | null {
  return code != null && SPEND_CAP_REASONS.has(code) ? (code as AiSpendCapReason) : null;
}

/**
 * Runs profile extraction off the request path. The AI service pseudonymizes
 * before any LLM call (and falls back to a safe mock if it is down), so this
 * never sends raw PII anywhere. Emits profile.extraction_completed on success
 * and profile.extraction_failed on terminal failure — keeping async outcomes in
 * the event stream. In-process for Phase 1; splittable to its own worker later.
 */
@Processor(PROFILE_EXTRACTION_QUEUE)
export class ProfileExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(ProfileExtractionProcessor.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly chat: ChatRepository,
    // The in-flight transcript, for the early-finish path — see `buildMessages`. Comes
    // from ChatModule, which ProfilesModule already imports for ChatRepository.
    private readonly buffer: ChatTranscriptBuffer,
    private readonly events: EventsService,
    private readonly ai: AiService,
    // R32 — the two collaborators needed to remove the worker's OWN name from the
    // transcript before it crosses the ai-service boundary. Both are @Global
    // (WorkersModule / CryptoModule), so ProfilesModule needs no new import edge.
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    // ADR-0036 moments ①/② — derive the worker's matchable skills + industry tenure
    // from the profile this processor just wrote, then reconcile his `job_reach` rows.
    // `MatchModule` is @Global, so ProfilesModule needs no new import edge (same shape
    // as WorkersRepository/PiiCryptoService above).
    private readonly matchSkills: WorkerSkillsService,
    // Generalized profiling: re-validates the RAG-matched `job_domain_id` against the
    // catalog before it is written. `SkillsModule` exports this repository; the query
    // has to run on the api's owner connection because `job_domain` is RLS-locked.
    private readonly skills: SkillsRepository,
  ) {
    super();
  }

  async process(job: Job<ProfileExtractionJobData>): Promise<{ profile_id: string }> {
    const { workerId, sessionId, aiJobId, correlationId, requestId } = job.data;

    // Idempotency: if a prior attempt already completed (e.g. BullMQ stalled-job
    // redelivery), don't reprocess or create a duplicate profile — return the
    // profile_id the previous run recorded.
    const existing = await this.aiJobs.findById(aiJobId);
    const existingProfileId = (existing?.outputRef as { profile_id?: string } | null)?.profile_id;
    if (existing?.status === "completed" && existingProfileId) {
      this.logger.log(`extraction job ${aiJobId} already completed; skipping reprocess`);
      return { profile_id: existingProfileId };
    }

    try {
      await this.aiJobs.markRunning(aiJobId);

      // Both shapes of the same conversation, deliberately. `transcript` is the
      // flat both-directions blob the model reads (and the rollback lever — drop
      // `messages` and the AI service behaves exactly as it did before the split).
      // `messages` carries the per-line role so the AI service's deterministic
      // detector can read the WORKER's lines only; on the flat blob it read our
      // own question text as the worker's answers.
      const messages = await this.buildMessages(sessionId);
      const transcript = this.renderTranscript(messages);
      // R32 — the transcript is the OTHER worker-free-text egress to the ai-service
      // (chat turns are the first, redacted in ChatService.postMessage), and it is
      // the wider one: it replays EVERY inbound line, so an introduction typed on
      // turn 1 rides along on every later extraction. Redact the worker's own known
      // name out of BOTH shapes, which must describe the same lines. Fail SAFE — a
      // null/undecryptable name sends the transcript as before (the ai-service's
      // fail-closed pseudonymize gate still fronts the LLM); a name lookup must
      // never fail an extraction.
      const fullName = await this.workerFullName(workerId);
      const result = await this.ai.extractProfile({
        worker_ref: workerId,
        transcript: redactKnownName(transcript, fullName),
        messages: messages.map((m) => ({ ...m, text: redactKnownName(m.text, fullName) })),
      });
      const profile: DraftProfile = result.profile;
      // Issue #419 — the RICH draft the response has always carried (persisted below).
      // HOISTED out of the `create()` call because the profile_status decision reads it
      // too: the legacy columns are a strict SUBSET of what an extraction produces, so
      // judging content on them alone would demote a real TD94 extraction to "draft".
      const richProfileDraft = result.worker_profile_draft ?? null;
      const profileStatus = this.decideProfileStatus(result.blocked, profile, richProfileDraft);
      // T3: make the degraded case VISIBLE rather than silently successful. The
      // `blocked` leg is already an expected, documented outcome (pseudonymization
      // failing closed) and has always been recorded as "draft" without comment; a
      // NOT-blocked extraction that nonetheless produced nothing is the interesting
      // one — it is what an unreachable ai-service looks like from in here. Opaque job
      // id only, never transcript/PII (§2 no-PII-in-logs).
      if (profileStatus === "draft" && !result.blocked) {
        this.logger.warn(
          `extraction job ${aiJobId} produced NO extracted content; recorded as "draft" ` +
            `(re-extractable) instead of "extracted" — check ai-service reachability`,
        );
      }
      const aiMeta = result.ai_metadata; // operational usage/cost (null on the mock/AI-down path)
      const domain = await this.resolveJobDomain(result.job_domain_match, aiJobId);

      const saved = await this.profiles.create({
        workerId,
        // Ties the profile to this job so a partial-success retry returns the
        // existing row instead of orphaning a duplicate (TD14).
        aiJobId,
        profileStatus,
        canonicalTradeId: profile.canonical_trade_id,
        canonicalRoleId: profile.canonical_role_id,
        skills: profile.skills,
        // B-6: stamp the taxonomy version in force at this skills WRITE (ADR-0030
        // §c "versioned"). Write-path only — reads never touch it; older rows
        // honestly carry NULL ("written before versioning").
        taxonomyVersion: String(SKILL_TAXONOMY_VERSION),
        machines: profile.machines,
        experience: profile.experience,
        salaryExpectation: profile.salary_expectation,
        locationPreference: profile.location_preference,
        availability: profile.availability,
        rawProfile: profile,
        // Issue #419 — persist the RICH draft the response has always carried. Before
        // this, apps/api read only `result.profile` (the narrow legacy DraftProfile) and
        // silently dropped controllers, education, certifications, the current-vs-expected
        // salary split, availability and current_city/current_state — every answer the
        // interview collected beyond the legacy shape. `?? null` because the field is
        // nullable in the contract (the mock/AI-down path returns none), and NULL is the
        // honest value for "this extraction produced no rich draft".
        richProfileDraft,
        // Generalized profiling: the RAG job-domain classification, spread so that a
        // pass which did not run writes NOTHING (the columns stay NULL) rather than
        // writing a "degraded" status that would be indistinguishable from a real
        // failed match. See `resolveJobDomain`.
        ...domain,
      });

      await this.aiJobs.markCompleted(aiJobId, { profile_id: saved.id }, toAiJobUsage(aiMeta));

      // ── ADR-0036 MOMENTS ①/② ──────────────────────────────────────────────────
      // "Everything is computed on WRITE. Every read is an indexed sort." The profile
      // row above is the write; this derives `worker_skill` + `worker_industry_tenure`
      // from it and reconciles the worker's rows in `job_reach` so an already-published
      // posting can reach him.
      //
      // It runs INSIDE this existing BullMQ processor — no new queue, and it inherits
      // the retry/stall semantics already tuned here.
      //
      // A FAILURE HERE MUST NOT FAIL THE EXTRACTION. `rebuildQuietly` swallows and logs
      // (opaque ids + error class only): the three tables it writes are rebuildable
      // projections (migration runbook §7), `db:backfill:worker-skills` +
      // `db:materialize:reach` repair them, and `db:verify:match-v1` fails the deploy
      // gate if they were not. Losing a worker's extracted profile to a reach-cache
      // hiccup would be the far worse trade.
      //
      // NOT gated on MATCH_V1_ENABLED, deliberately: the flag selects which SOURCE the
      // feed/apply/candidate-list READ from. Writing the projections while it is off is
      // exactly what makes the flip safe — flipping it on a database where nobody has
      // been derived since the backfill would serve a stale feed.
      //
      // `rebuildQuietly` is contractually never-throwing, and the try/catch here is
      // belt-and-braces on purpose: this processor, not the match service, owns the
      // "an extraction that produced a profile is a SUCCESS" invariant, so it must not
      // rest on another service keeping a promise. One line, and a future edit to
      // WorkerSkillsService cannot silently start failing extractions.
      try {
        await this.matchSkills.rebuildQuietly(workerId, { correlationId, requestId });
      } catch (matchErr) {
        const cls = matchErr instanceof Error ? matchErr.name : "UnknownError";
        this.logger.error(
          `match rebuild threw for job ${aiJobId} (${cls}); extraction stands — ` +
            `db:backfill:worker-skills + db:materialize:reach will repair it`,
        );
      }

      await this.events.emit({
        event_name: "profile.extraction_completed",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "profile", subject_id: saved.id },
        payload: {
          worker_id: workerId,
          profile_id: saved.id,
          ai_job_id: aiJobId,
          profile_status: profileStatus,
          field_count: this.countFields(profile),
        },
        // Exactly one completion per job, even under BullMQ stalled-job
        // redelivery that races past the early-return idempotency guard above.
        idempotencyKey: `profile.extraction_completed:${aiJobId}`,
        correlationId,
        requestId,
      });

      // Record AI usage/cost on the dedicated observability event. Guarded: an
      // observability emit must never turn a SUCCESSFUL extraction into a failure.
      await this.recordAiCost(aiMeta, aiJobId, correlationId, requestId);

      // TD27: if the gateway BLOCKED a real call because a spend cap / circuit
      // breaker tripped, surface it on its own observability event (in addition
      // to the cost record above, which is unchanged). Same guarded, fire-and-
      // forget pattern — a cap signal must never fail the extraction.
      await this.recordSpendCap(aiMeta, aiJobId, correlationId, requestId);

      return { profile_id: saved.id };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 256);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      // Only record the terminal failure once (BullMQ retries before this).
      if (isFinalAttempt) {
        await this.aiJobs.markFailed(aiJobId, reason);
        await this.events.emit({
          event_name: "profile.extraction_failed",
          actor: { actor_type: "system" },
          subject: { subject_type: "ai_job", subject_id: aiJobId },
          payload: { worker_id: workerId, session_id: sessionId, ai_job_id: aiJobId, reason },
          // One terminal failure per job (final attempt). Shares the key namespace
          // with the enqueue-failure emit in ProfilesService — mutually exclusive.
          idempotencyKey: `profile.extraction_failed:${aiJobId}`,
          correlationId,
          requestId,
        });
      }
      this.logger.warn(`extraction job ${aiJobId} failed (attempt ${job.attemptsMade + 1}): ${reason}`);
      throw err; // rethrow so BullMQ records/retries the failure
    }
  }

  /**
   * The `profile_status` decision — and the ONE place a FABRICATED extraction is
   * stopped from being recorded as truth (TD81 / T3, the audit's "skill_ids:[]
   * passes silently" gap).
   *
   * THE DEFECT. When the ai-service is unreachable, `AiService.extractProfile`
   * FABRICATES a result — `DraftProfileSchema.parse({})` (null canonical ids, empty
   * skills/machines, null total_years, availability "unknown") carrying
   * `blocked: false` — so the worker's flow keeps moving. This used to read
   * `result.blocked ? "draft" : "extracted"`, consulting ONLY that flag and never the
   * CONTENT, so the fabrication was stamped "extracted": the status that means "this
   * worker is profiled". Paired with `ChatService.autoTriggerExtraction` skipping on
   * any existing profile ROW, that empty row became the worker's PERMANENT profile —
   * no later turn and no re-completed interview ever replaced it.
   *
   * THIS FIX IS ABOUT RECORDING, NOT FAILING. The AI-down path still does not throw
   * and still does not block anyone — the same deliberate posture job-postings holds
   * ("an AI-service outage NEVER blocks the posting"). The profile row is still
   * created, the ai_job is still marked `completed`, `profile.extraction_completed` is
   * still emitted, and the chat turn that triggered this is untouched. Only the STATUS
   * changes: an extraction that produced nothing is recorded as "draft" — the column's
   * schema default, and the very status the fail-closed `blocked` leg has always
   * used — which is the honest value for "we have no profile for this worker yet"
   * and, being not-"extracted", is what lets the session self-heal later.
   *
   * NO EVENT PAYLOAD CHANGES (invariant #8). `ProfileExtractionCompletedPayload`
   * (packages/event-schema/src/payloads.ts) already types `profile_status` as
   * `z.enum(["draft","extracting","extracted","confirmed"])` and "draft" is already
   * emitted on the blocked leg, so this is a different VALUE of a shipped field, not a
   * new or altered field. `field_count` keeps using `countFields` unchanged.
   *
   * WHY CONTENT AND NOT `is_mock` — the candidate mechanism deliberately REJECTED.
   * `is_mock` is a REACHABILITY probe, not a content signal: the ai-service sets it as
   * `is_mock = not meta.real_call` (apps/ai-service/app/main.py:810), so it is true
   * for the AI-down fabrication AND for every perfectly good deterministic extraction
   * while `AI_ENABLE_REAL_CALLS=false` — which is the COMMITTED DEFAULT (CLAUDE.md §2
   * invariant 5) and precisely the posture TD81 records staging as running in. Keying
   * profile_status off it would mean NO worker ever reaches "extracted" outside a
   * real-provider environment, breaking the Phase-1 exit criteria. That is the same
   * trap `profile-content.ts` already documents for `ai_jobs.real_call`, rejected here
   * for identical reasons.
   *
   * WHY `hasExtractedContent` AND NOT `countFields > 0`. `countFields` counts only the
   * canonical/legacy columns, a strict SUBSET of what an extraction produces — the
   * skill labels and the rest live in the rich draft and are counted by nothing. A
   * REAL extraction the gazetteer could not canonicalize (TD94: a plain "CNC
   * operator") scores 0 there while genuinely carrying content, and demoting THAT to
   * "draft" would make a good profile look unprofiled. `hasExtractedContent` is the
   * codebase's existing answer to "did this extraction extract anything?" (issue #420,
   * PRs #430/#438) and is ALREADY the predicate `ProfilesService.extract` dedupes on.
   * Reusing it — over the row projection this processor is about to WRITE — gives that
   * question exactly ONE definition, so the status stamped here and the dedupe/retry
   * decision taken later can never drift apart and disagree about the same row.
   */
  /**
   * The `job_domain_*` columns to write for this extraction — the persistence half of
   * the generalized-profiling RAG match.
   *
   * THREE OUTCOMES, and keeping them apart is the whole job of this method:
   *
   *   - `{}` — the pass DID NOT RUN (the ai-service returned no match object, because
   *     `DOMAIN_MATCH_ENABLED` is off or the extraction was blocked). Nothing is
   *     written, so the columns stay NULL. This must NOT be recorded as "degraded": a
   *     disabled feature and a workforce the catalog cannot describe are different
   *     facts, and only one of them is worth investigating.
   *   - a matched id + score + timestamp — the classification succeeded and survived
   *     re-validation.
   *   - a status with a NULL id — the pass ran and honestly failed, with the reason
   *     kept so ops can tell "nothing close in the catalog" from "the seam was down".
   *
   * THE RE-VALIDATION, and why it exists in a THIRD place. The ai-service already
   * checks the model's pick against the shortlist it was given, and that shortlist came
   * from this database — so this looks redundant. It is not: the shortlist travelled
   * over HTTP, and `job_domain_id` carries a foreign key. An id that does not resolve
   * would fail the INSERT, and that INSERT is the worker's entire extracted profile. A
   * cheap SELECT here means a bad label costs the label; skipping it means a bad label
   * costs the profile.
   *
   * Never throws. A validation query that itself fails degrades to "no domain" — this
   * method exists to protect the extraction, so it must not become a way to break one.
   */
  private async resolveJobDomain(
    match: ProfileExtractionOutput["job_domain_match"],
    aiJobId: string,
  ): Promise<Partial<NewWorkerProfile>> {
    if (!match) return {};

    const base = {
      jobDomainMatchStatus: match.status,
      jobDomainMatchedAt: new Date(),
    } satisfies Partial<NewWorkerProfile>;

    if (!match.job_domain_id) return base;

    try {
      if (!(await this.skills.isSelectableDomain(match.job_domain_id))) {
        this.logger.warn(
          `extraction job ${aiJobId} matched a job_domain that is not selectable or no ` +
            `longer exists; recording the profile UNMATCHED rather than failing the insert`,
        );
        return { ...base, jobDomainMatchStatus: "unmatched_llm_declined" };
      }
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      this.logger.warn(
        `extraction job ${aiJobId} could not validate the matched job_domain (${cls}); ` +
          `recording the profile UNMATCHED (the label is never worth the extraction)`,
      );
      return { ...base, jobDomainMatchStatus: "unmatched_degraded" };
    }

    return {
      ...base,
      jobDomainId: match.job_domain_id,
      jobDomainMatchScore: match.score,
    };
  }

  private decideProfileStatus(
    blocked: boolean,
    profile: DraftProfile,
    richProfileDraft: unknown,
  ): "draft" | "extracted" {
    // Unchanged first leg: pseudonymization failed closed upstream, so there is no
    // extraction to judge. Kept ahead of the content check so a blocked result is
    // never re-litigated on content it was never allowed to produce.
    if (blocked) return "draft";

    // The row as `ProfilesRepository`/`WorkersRepository.latestProfile` will hand it
    // back, assembled from the exact values `create()` writes below — so this reads
    // the profile the way every later reader does, not a parallel notion of it.
    const asPersisted: ProfileContentFields = {
      canonicalTradeId: profile.canonical_trade_id,
      canonicalRoleId: profile.canonical_role_id,
      skills: profile.skills,
      machines: profile.machines,
      experience: profile.experience,
      salaryExpectation: profile.salary_expectation,
      locationPreference: profile.location_preference,
      availability: profile.availability,
      richProfileDraft,
    };
    return hasExtractedContent(asPersisted) ? "extracted" : "draft";
  }

  /**
   * Emit the dedicated `ai.cost_recorded` observability event for a completed
   * job. No-ops on the mock/AI-down path (no metadata = no real call to record),
   * and swallows any emit/validation error so it can never fail the extraction.
   * Carries operational fields only — never prompts, completions, or PII.
   */
  private async recordAiCost(
    meta: AICallMetadata | null,
    aiJobId: string,
    correlationId: string,
    requestId: string,
  ): Promise<void> {
    if (!meta) return;
    try {
      await this.events.emit({
        event_name: "ai.cost_recorded",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: aiJobId },
        payload: {
          ai_call_id: meta.ai_call_id,
          ai_job_id: aiJobId,
          task_type: "profile_extraction",
          model: meta.model_name || "unknown",
          provider: meta.provider || "unknown",
          real_call: meta.real_call,
          tokens_in: meta.input_tokens,
          tokens_out: meta.output_tokens,
          estimated_cost_inr: meta.estimated_cost_inr,
          latency_ms: meta.latency_ms,
          cost_alert: meta.cost_alert,
          above_target: meta.above_target,
        },
        // One cost record per job — dedups if a redelivery re-emits after the
        // completion guard is bypassed.
        idempotencyKey: `ai.cost_recorded:${aiJobId}`,
        correlationId,
        requestId,
      });
    } catch (err) {
      this.logger.warn(`ai.cost_recorded emit failed for job ${aiJobId} (non-fatal): ${String(err)}`);
    }
  }

  /**
   * Emit `ai.spend_cap_exceeded` when the AI gateway refused a real call because
   * a TD27 cap / circuit breaker tripped (`ai_metadata.error_code` is one of the
   * five block codes). No-ops on the mock/AI-down path and on any non-cap
   * error_code, and swallows any emit/validation error so it can never fail the
   * extraction. Carries operational fields only — never prompts/completions/PII.
   */
  private async recordSpendCap(
    meta: AICallMetadata | null,
    aiJobId: string,
    correlationId: string,
    requestId: string,
  ): Promise<void> {
    if (!meta) return;
    const reason = asSpendCapReason(meta.error_code);
    if (!reason) return;
    try {
      await this.events.emit({
        event_name: "ai.spend_cap_exceeded",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: aiJobId },
        payload: {
          ai_call_id: meta.ai_call_id,
          ai_job_id: aiJobId,
          task_type: "profile_extraction",
          model: meta.model_name || "unknown",
          provider: meta.provider || "unknown",
          reason,
          real_call: meta.real_call,
        },
        // One cap record per job — dedups if a redelivery re-emits after the
        // completion guard is bypassed (mirrors ai.cost_recorded).
        idempotencyKey: `ai.spend_cap_exceeded:${aiJobId}`,
        correlationId,
        requestId,
      });
    } catch (err) {
      this.logger.warn(
        `ai.spend_cap_exceeded emit failed for job ${aiJobId} (non-fatal): ${String(err)}`,
      );
    }
  }

  /**
   * R32 — the worker's DECRYPTED `full_name`, or `null` when there is none or it
   * cannot be decrypted. Mirrors `ChatService.workerFullName`: the plaintext is used
   * ONLY to remove text on the way out (`redactKnownName`) and is never logged,
   * evented, stored, or forwarded.
   *
   * Never throws — this runs on the extraction path, and a rotated key must degrade
   * to "not redacted" (the pre-existing behaviour, still gated downstream) rather
   * than fail the job. The warning carries the opaque worker id only.
   */
  private async workerFullName(workerId: string): Promise<string | null> {
    try {
      const worker = await this.workers.findById(workerId);
      if (!worker?.fullName) return null;
      return this.pii.decrypt(worker.fullName);
    } catch {
      this.logger.warn(
        `could not resolve full_name for worker ${workerId}; ` +
          `extraction transcript is not name-redacted (pseudonymize gate still applies)`,
      );
      return null;
    }
  }

  /**
   * The conversation as role-tagged lines. `inbound` is the worker; everything
   * else is us. Same `bodyText` filter the flat transcript has always used, so
   * the two shapes always describe the same set of lines.
   *
   * POSTGRES FIRST, THEN THE REDIS BUFFER — and the fallback is not an optimization,
   * it is what keeps the early-finish escape hatch honest.
   *
   * The worker app offers "Phir bhi profile banaiye" ("make the profile anyway") at any
   * point before the interview completes, promising an INCOMPLETE profile. It posts
   * `/profile/extract` mid-interview. Under the flush-at-end design there are no
   * `chat_messages` rows yet — the transcript is still buffered — so a Postgres-only
   * read handed the AI service the literal "(no conversation captured)" and produced an
   * EMPTY profile every single time. Worse than useless: `latestProfile` orders by
   * `created_at DESC`, so a worker who already had a good profile and tapped this had
   * their summary replaced by the empty one.
   *
   * The two sources are never both populated for a session — the buffer is dropped in
   * the same breath as the flush — so there is nothing to merge and no ordering to
   * reconcile. Postgres leads because after the flush it is authoritative and the
   * buffer is gone.
   */
  private async buildMessages(sessionId: string | null): Promise<ConversationMessage[]> {
    if (!sessionId) return [];
    const rows = await this.chat.listMessages(sessionId);
    if (rows.length > 0) {
      return rows
        .filter((m) => m.bodyText)
        .map((m) => ({
          role: m.direction === "inbound" ? ("worker" as const) : ("assistant" as const),
          text: m.bodyText as string,
        }));
    }

    // Mid-interview. Never throws: `buffer.load` fails CLOSED with a 503 because a chat
    // TURN must not silently restart an interview, but an EXTRACTION is a different
    // trade — if Redis is unreachable we genuinely have no transcript, and degrading to
    // the empty one (exactly today's behaviour) beats failing the job.
    try {
      const buffered = await this.buffer.load(sessionId);
      const lines = buffered?.messages ?? [];
      if (lines.length > 0) {
        this.logger.log(
          `session ${sessionId} not yet flushed; extracting from the ` +
            `${lines.length}-line transcript buffer (early-finish path)`,
        );
      }
      return lines.map((m) => ({ role: m.role, text: m.text }));
    } catch (err) {
      this.logger.warn(
        `could not read the transcript buffer for session ${sessionId}; extracting ` +
          `from an empty transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Renders the role-tagged lines back into the exact flat string this processor
   * has always sent. Byte-identical to the old `buildTranscript`, including the
   * "(no conversation captured)" placeholder — the AI service still gates and
   * prompts on this, so it must not drift.
   */
  private renderTranscript(messages: ConversationMessage[]): string {
    const text = messages
      .map((m) => `${m.role === "worker" ? "Worker" : "Bada Bhai"}: ${m.text}`)
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

/**
 * Map the AI router's `ai_metadata` to the PII-free operational columns stored on
 * the `ai_jobs` row. Returns `undefined` when there is no metadata (mock/AI-down),
 * leaving the columns null. Only usage/cost scalars are forwarded.
 */
function toAiJobUsage(meta: AICallMetadata | null): AiJobUsageMetadata | undefined {
  if (!meta) return undefined;
  return {
    modelName: meta.model_name || null,
    realCall: meta.real_call,
    inputTokens: meta.input_tokens,
    outputTokens: meta.output_tokens,
    totalTokens: meta.input_tokens + meta.output_tokens,
    costInr: meta.estimated_cost_inr,
  };
}
