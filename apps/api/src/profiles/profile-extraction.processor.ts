import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  DraftProfileSchema,
  OccupationPinSchema,
  ProfileExtractionOutputSchema,
  WorkerProfileDraftSchema,
  resumeProfileCarriesValues,
  type DraftProfile,
  type AICallMetadata,
  type ConversationMessage,
  type InterviewExtractOutput,
  type OccupationPin,
  type ProfileExtractionOutput,
  type TranscriptLine,
} from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import { PARSE_TARGET_FIELDS } from "@badabhai/profiling-lexicon";
import {
  applyParseGates,
  countByGate,
  PARSE_ENUM_VALUES,
  type Rejection,
} from "../profiling/parse-gates";
import { narrowAnswerRecords } from "../profiling/conversation-state";
import {
  projectProfile,
  type ProjectedAttribute,
  type ProjectionResult,
} from "../profiling/answer-map-projector";
import type { NewWorkerProfile } from "@badabhai/db";
import { SKILL_TAXONOMY_VERSION } from "@badabhai/taxonomy";
import { EventsService } from "../events/events.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../ai/ai-trace-recorder.service";
import { toAiJobUsage } from "../ai/ai-job-usage";
import { AiService } from "../ai/ai.service";
import { SERVER_CONFIG } from "../config/config.module";
import { ChatRepository } from "../chat/chat.repository";
import { ChatTranscriptBuffer } from "../chat/chat-transcript.buffer";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { redactKnownName } from "../common/redact-known-name";
import { WorkerSkillsService } from "../match/worker-skills.service";
import { SkillsRepository } from "../skills/skills.repository";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import { WorkerAttributesRepository } from "./worker-attributes.repository";
import { hasExtractedContent, type ProfileContentFields } from "./profile-content";
import {
  AI_SPEND_CAP_REASONS,
  type AiCostTaskType,
  type AiSpendCapReason,
} from "@badabhai/event-schema";
import { PROFILE_EXTRACTION_QUEUE, type ProfileExtractionJobData } from "../queue/queue.constants";

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
 * `error_code` values that mean THE MODEL WAS UNREACHABLE — a transient incident that
 * will clear on its own, as opposed to a deliberate posture or a quiet worker.
 *
 * THE DISTINCTION THIS DRAWS IS THE ROOT OF THE REPORTED BUG. Three completely different
 * situations used to arrive here as the same thing — an empty profile, `blocked: false`,
 * job `completed`:
 *
 *   1. the worker genuinely said nothing,
 *   2. a spend cap or the kill switch deliberately refused the call,
 *   3. the provider rate-limited us.
 *
 * Only (3) should be retried, and none of them was. Instead every dedupe guard read the
 * empty profile as "this worker is not profiled yet" and the next of four triggers
 * started a fresh extraction — so a 429 became: empty profile -> not profiled -> extract
 * -> 429, with each pass putting a full retry chain back on the wire.
 *
 * DELIBERATELY EXCLUDES the spend-cap codes in `AI_SPEND_CAP_REASONS`. A cap is a
 * decision, not an outage: retrying it in five minutes would spend money the ledger has
 * already refused, and it does not heal on a timer. Those keep their existing treatment
 * (recorded on `ai.spend_cap`, profile written from the answer map, job completed).
 */
const LLM_OUTAGE_CODES: ReadonlySet<string> = new Set([
  // Every candidate was reached and every candidate failed.
  "llm_call_failed",
  // The rolling retry budget stopped us mid-chain (TD27).
  "retry_budget_exhausted",
  // A provider returned 429 recently, so the router skipped it without calling.
  "provider_cooldown",
  // `/profile/extract` blew its deadline; the overlay never happened.
  "extract_deadline_exceeded",
]);

/**
 * The parse route's equivalent signal. `/profile/parse` reports its degradations as
 * `notes` rather than an `error_code`, and states the same split in its own comment:
 * `mock_no_parse` is a posture, `llm_unavailable` is an incident.
 */
const PARSE_OUTAGE_NOTES: ReadonlySet<string> = new Set([
  "llm_unavailable",
  "parse_deadline_exceeded",
]);

/**
 * Thrown to make BullMQ retry an extraction whose MODEL leg failed transiently.
 *
 * A named class rather than a bare `Error` so the catch block can tell "the LLM was
 * down" from "the database write threw" — the two want different logs and, on the final
 * attempt, different outcomes.
 */
class LlmUnavailableError extends Error {
  constructor(readonly cause_code: string) {
    super(`llm unavailable (${cause_code})`);
    this.name = "LlmUnavailableError";
  }
}

/** Narrow an arbitrary `error_code` to a transient LLM outage, or null. */
function outageCodeOf(code: string | null | undefined): string | null {
  return code != null && LLM_OUTAGE_CODES.has(code) ? code : null;
}

/**
 * The occupation-pin statuses that actually assert a trade — OIE O2.
 *
 * `OccupationPin.match_status` spans SEVEN values, five of which are `unmatched_*`. The pin
 * object still exists on those: the interview ran, the retrieval failed, and the schema
 * DEFAULTS the field to `unmatched_degraded`. So "a pin is present" is not "the worker has a
 * confirmed trade", and scoping a canonicalization pass on an unmatched pin would narrow
 * retrieval to a domain nobody established.
 *
 * ENUMERATED, not `startsWith("matched_")`, so a new status has to be classified deliberately.
 * `occupationPinScopesCanonicalization` is pinned against the full contract enum in the tests —
 * add a status without deciding which side it falls on and that test fails.
 */
const OCCUPATION_MATCHED_STATUSES: ReadonlySet<string> = new Set([
  "matched_auto",
  "matched_llm",
  "matched_lexical",
  "matched_worker_confirmed",
]);

/**
 * OIE O2 — should this pin scope the canonicalization pass to Path A?
 *
 * Exported for the test that checks it partitions the contract's status enum exhaustively.
 */
export function occupationPinScopesCanonicalization(pin: OccupationPin | null): boolean {
  return pin !== null && OCCUPATION_MATCHED_STATUSES.has(pin.match_status);
}

/**
 * The occupation pin off a conversation state, or null.
 *
 * ONE parse convention for both branches. `conversation_state.occupation` is persisted JSON, so
 * every read of it is untrusted input and goes through the schema; the two branches doing that
 * differently is how they would end up disagreeing about what "has a pin" means — which is the
 * exact distinction O2 hangs on.
 */
function readOccupationPin(raw: unknown): OccupationPin | null {
  const parsed = OccupationPinSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Does this Phase C overlay actually carry model-derived values?
 *
 * WHY PRESENCE IS NOT ENOUGH: the ai-service answers three of its own degrades with a healthy
 * 200 carrying an EMPTY `InterviewExtractOutput` whose `blocked` is FALSE — its own deadline
 * breach, mock mode (`not meta.real_call`), and a model response that failed the contract. An
 * `!== null` test reads all three as "the interview landed", which is the opposite of true.
 *
 * EVERY FIELD COUNTS, not just `experiences[]`. That one is the irreplaceable one — nothing
 * else on this path produces it — but a short interview yielding only a domain label or two
 * skills is still model-derived work that a retry cannot improve on, and re-running it costs
 * another capable call for the same answer.
 *
 * `blocked` and `is_mock` are deliberately NOT consulted: `blocked` is already handled by
 * `interviewOverlay` (returns null), and `is_mock` is orthogonal — a mock overlay is empty, so
 * the content test catches it without a second rule that could disagree.
 *
 * THE RULE ITSELF LIVES IN `@badabhai/ai-contracts`, BESIDE THE CONTAINER IT ALSO GUARDS. The
 * résumé asks the identical question of the identical nine keys after they are stored
 * (`resume-render-input.ts`), and a second copy here is precisely the kind of duplicate that
 * drifts: the two would have to be fixed together forever, and the blank-résumé bug was one
 * call site testing presence while this one tested content. This stays as the local name the
 * `interviewLanded` reasoning above refers to.
 */
function overlayCarriesValues(
  overlay: InterviewExtractOutput | null,
): overlay is InterviewExtractOutput {
  return resumeProfileCarriesValues(overlay);
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
    // The destination for the 77% of the pack corpus that is `attribute`-kind. `ProfilesModule`
    // provides it; it needs only DATABASE, which is a global module.
    private readonly workerAttributes: WorkerAttributesRepository,
    // #738 — the emitter this class used to OWN as a private method. Moving it out is the
    // point: while it was private here, the transcription path could not reach it, so STT
    // spend was emitted by nobody even though `aiTaskType` already listed it. `AiModule` is
    // @Global, so ProfilesModule needs no new import edge.
    private readonly aiCost: AiCostRecorder,
    // 0083 — the prompt/completion sibling of `aiCost`, emitted from the SAME delegate
    // ({@link recordAiCost}) so the two cannot drift apart call site by call site.
    private readonly aiTraces: AiTraceRecorder,
    // Phase C reads ONE flag: `CHAT_LLM_INTERVIEW_ENABLED`. Off, and this processor makes exactly
    // the calls it made before — the whole LLM-led change stays behind a single switch, on the
    // extraction side as much as on the interview side.
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
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
      const redacted = messages.map((m) => ({ ...m, text: redactKnownName(m.text, fullName) }));
      const { result, pin, attributes, pack, parseMeta, outageCode, interviewLanded } =
        await this.extractOrParse(
          { workerId, sessionId, aiJobId, correlationId, requestId },
          redacted,
          redactKnownName(transcript, fullName),
        );

      // ── THE RETRY, AND WHY IT THROWS HERE RATHER THAN COMPLETING ──────────────────
      //
      // A transiently unreachable model used to be indistinguishable from a quiet worker:
      // both wrote an empty profile and marked the job `completed`. Because nothing threw,
      // BullMQ's `attempts` never engaged — the retry machinery was present and dormant
      // for the one failure mode it was needed for — and every downstream guard read the
      // empty profile as "not profiled yet", so the next of four triggers started a fresh
      // extraction. That is the loop: 429 -> empty profile -> not profiled -> extract.
      //
      // THROWN BEFORE ANY WRITE, deliberately. `profiles.create` is idempotent on
      // `ai_jobs_id` and `upsertMany` is idempotent on its key, so writing first would be
      // survivable — but a retry that has written nothing has nothing to reconcile, and a
      // profile row that exists only because the model was down is exactly the artifact
      // that taught the dedupe guards to re-fire.
      //
      // ONLY WHILE ATTEMPTS REMAIN. On the final attempt this falls through and the
      // profile is written from the answer map, because a worker left with no profile at
      // all is strictly worse than one whose profile lacks the model overlay — the
      // posture `ProfilesService.extract` already states in its own docstring. The
      // deterministic projection is the bulk of the value; the parse is an overlay on top.
      //
      // The backoff that makes this bounded and slow lives on the JOB (see
      // `EXTRACTION_JOB_OPTS` in `ProfilesService`): 5 min, then 10. A 1 s exponential —
      // the queue-wide default — would simply be the same storm at a different cadence.
      //
      // AND WHY A LANDED PHASE C OVERLAY VETOES THE RETRY. Everything above reasons about ONE
      // model leg. Phase C added a second with an independent fate, and `outageCode` still only
      // describes the parse — so the live combination was: parse blows its deadline, the
      // interview extract succeeds, and the whole attempt is thrown away WITH the successful
      // overlay. Three times, at 5 and 10 minutes, each re-running and re-billing Phase C, for a
      // worker who ended up with no profile at all.
      //
      // The premise of the retry is "we have nothing worth writing, and waiting might fix that".
      // A landed overlay falsifies it: we are holding the model-derived values — `experiences[]`
      // among them, which NOTHING else on this path can produce — and a retry cannot improve on
      // having them. Writing now costs the parse overlay on the deterministic fields, which the
      // answer-map projection already covers; retrying costs the interview entirely.
      const retryWouldDiscardTheOverlay = interviewLanded;
      if (outageCode !== null) {
        const maxAttempts = job.opts.attempts ?? 1;
        const attemptsRemain = job.attemptsMade + 1 < maxAttempts && !retryWouldDiscardTheOverlay;
        this.logger.warn(
          `extraction job ${aiJobId} hit an LLM outage (${outageCode}) on attempt ` +
            `${job.attemptsMade + 1}/${maxAttempts}; ` +
            (attemptsRemain
              ? `retrying on the queue's backoff`
              : retryWouldDiscardTheOverlay
                ? `writing anyway — the interview overlay landed and a retry would discard it`
                : `final attempt — writing the profile from the answer map without the model overlay`),
        );
        if (attemptsRemain) throw new LlmUnavailableError(outageCode);
      }
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
        // NAMES THE CAUSE WHEN THE CAUSE IS KNOWABLE. This line used to end with "check
        // ai-service reachability" — an instruction to go and find out, because nothing in
        // the result could say. `error_code` is that missing field: an outage now logs as an
        // outage, and a worker who genuinely said nothing logs as exactly that, so the two
        // stop sharing one warning an operator has to disambiguate by hand.
        const cause = result.error_code
          ? `cause=${result.error_code}`
          : `no error reported — the interview itself produced nothing`;
        this.logger.warn(
          `extraction job ${aiJobId} produced NO extracted content; recorded as "draft" ` +
            `(re-extractable) instead of "extracted" — ${cause}`,
        );
      }
      const aiMeta = result.ai_metadata; // operational usage/cost (null on the mock/AI-down path)
      // THE PIN TAKES PRECEDENCE over anything a classifier produced, and carries two
      // things `JobDomainMatch` structurally cannot: the two OIE statuses (that contract
      // is FROZEN at the classifier's own five, deliberately — see `OccupationMatchStatus`)
      // and the retrieval layer the Phase 9 distribution gate is measured from.
      const domain = pin
        ? await this.resolvePinnedDomain(pin, aiJobId)
        : await this.resolveJobDomain(result.job_domain_match, aiJobId);

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

      // ── THE 75% ───────────────────────────────────────────────────────────────
      //
      // `attribute`-kind answers — `workplace_type`, `tools_owned`, `safety_training`,
      // `shift_work` — are 319 of the 426 active pack items, and they do not belong on
      // `worker_profiles`: they are MATCHING inputs, one row per (worker, key), filtered by the
      // matcher with a plain index. Migration 0071 built the table and V2 taught the projector to
      // fill the array; this is the write that was missing, and without it both were decoration.
      //
      // BEFORE `markCompleted`, AND ALLOWED TO THROW. That ordering is the whole safety argument:
      // `profiles.create` is idempotent on `ai_job_id`, so a retry returns the SAME profile row
      // rather than orphaning a duplicate, and `upsertMany` writes the same values over the same
      // rows. So a failure here costs a retry and loses nothing — whereas swallowing it would
      // lose 77% of what the worker actually said, permanently and silently, with the job marked
      // completed. There is no backfill runner for this table; a quiet failure is not recoverable.
      //
      // Deliberately NOT the `rebuildQuietly` treatment the match projections get below. Those
      // are derivable from other tables and have a repair script and a deploy gate. This is the
      // worker's own answers.
      const attributeRows = attributes.map((attribute) => ({
        workerId,
        attributeKey: attribute.attributeKey,
        valueKind: attribute.valueKind,
        valueBool: attribute.valueKind === "boolean" ? (attribute.value as boolean) : null,
        valueNumber: attribute.valueKind === "number" ? String(attribute.value as number) : null,
        valueText: attribute.valueKind === "text" ? (attribute.value as string) : null,
        valueTextList:
          attribute.valueKind === "text_list" ? [...(attribute.value as readonly string[])] : null,
        source: attribute.source,
        // The interview this value came from, pinned. Pack contents are immutable per version, so
        // this is what makes the value re-readable once the corpus has moved on.
        questionKey: attribute.attributeKey,
        packId: pack.packId,
        packVersion: pack.packVersion,
        sessionId,
      }));
      const attributesWritten = await this.workerAttributes.upsertMany(attributeRows);
      if (attributeRows.length > 0) {
        this.logger.log(
          `worker_attributes upserted job=${aiJobId} rows=${attributesWritten}/${attributeRows.length}`,
        );
      }

      // `aiMeta ?? parseMeta`, and the order is the contract: the legacy route's extraction call is
      // the job's spend when it happened, and the OIE route's parse is the job's spend when it did
      // not. Exactly one of the two is ever non-null today (the paths are mutually exclusive — an
      // empty answer map takes the legacy branch and returns before any parse), so this records the
      // call that actually occurred rather than summing across a case that cannot arise. If a
      // future path ever makes BOTH calls under one job, this must become a sum, not a preference.
      await this.aiJobs.markCompleted(
        aiJobId,
        { profile_id: saved.id },
        toAiJobUsage(aiMeta ?? parseMeta),
      );

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
      await this.recordAiCost(
        aiMeta,
        "profile_extraction",
        aiJobId,
        correlationId,
        requestId,
        { workerId, sessionId },
        // 0083. TRACED. `aiMeta` came off `result`, so the prompt/completion pair it carries
        // describes exactly the call this cost row describes. Which leg ran does not matter to
        // the trace any more: whichever one produced `aiMeta` also produced the masked text on
        // it, so there is no way for this row to end up holding another call's request.
        true,
      );

      // #745: THE CANONICALIZATION PASS'S EMBEDS — a SECOND set of billable calls on this
      // same job, and the one this issue's first cut missed.
      //
      // `aiMeta` above is the extraction call alone. The TAX-4 pass that runs after it
      // embeds one vector PER SKILL LABEL, and those records used to stop at an ai-service
      // log line: `canonicalize_labels` returned ids and unresolved labels only. That left
      // `skill_embedding` half-ledgered — the job-posting write emitted, this did not — and
      // a partial ledger reads as a complete one.
      //
      // ONLY THE LEGACY LEG REACHES THIS. `/profile/extract` is called when the session has
      // no answer map (a pre-cutover interview, or the "make the profile anyway" escape
      // hatch); the OIE path projects locally and calls `/profile/parse` instead, so its
      // `skill_embedding_metadata` is empty and this loop is a no-op there. That is a fact
      // about where the embeds happen, not a scope decision.
      //
      // ONE EVENT PER EMBED, keyed on each record's own `ai_call_id`: a per-job key would
      // dedupe the whole fan-out down to one row, which is the same collapse that once lost
      // the parse call's spend. Unlike the job-posting side there IS a real `ai_jobs` row
      // here, so these attribute to it. Sequential and awaited to match the sibling calls;
      // `record` never throws and no-ops on an empty list.
      for (const embedMeta of result.skill_embedding_metadata) {
        await this.recordAiCost(
          embedMeta,
          "skill_embedding",
          aiJobId,
          correlationId,
          requestId,
          { workerId, sessionId },
          // 0083: DELIBERATELY UNTRACED, and the only `false` in this file.
          //
          // These embeds happen INSIDE the ai-service, as part of the `/profile/extract` call
          // above, and they do not go through `AIRouter` — `app/ai/embeddings.py` is a separate
          // path with no task span and therefore no `_record_trace_text`. So `embedMeta` carries
          // no `prompt_text` and no `response_text`, and a row here would have both encrypted
          // columns NULL: one per skill label, on the table whose own header warns it will
          // outgrow `ai_jobs`, carrying nothing `ai.cost_recorded` does not already carry.
          //
          // The fix is upstream — the embeddings path would have to populate the same two
          // fields — and until it does, an honest absence beats an empty row.
          false,
        );
      }

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
      this.logger.warn(
        `extraction job ${aiJobId} failed (attempt ${job.attemptsMade + 1}): ${reason}`,
      );
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
  /**
   * THE PHASE 8 SEAM: the deterministic answer map, or the legacy transcript re-parse.
   *
   * WHY BOTH STILL EXIST after a "hard cutover". The cutover is of the INTERVIEW, not of every
   * historical session: an interview finalized before this deployed has no answer map in its
   * `conversation_state`, and its extraction job may still be sitting in the queue. Re-parsing
   * its transcript is exactly what should happen to it. There is no flag and no per-trade lever
   * here — the branch is a property of the DATA, so it drains to zero on its own within one
   * queue's lifetime and needs no cleanup.
   *
   * THE NEW PATH IS FAIL-CLOSED BY CONSTRUCTION. Every failure of the parse call — unreachable,
   * blocked, mis-shaped, or every field rejected by the gates — produces the SAME thing: a
   * profile projected from the answer map alone. The worker is never left without one because
   * a model was unavailable.
   */
  private async extractOrParse(
    job: {
      workerId: string;
      sessionId: string | null;
      aiJobId: string;
      correlationId?: string | null;
      requestId?: string | null;
    },
    messages: readonly ConversationMessage[],
    transcript: string,
  ): Promise<{
    result: ProfileExtractionOutput;
    pin: OccupationPin | null;
    attributes: readonly ProjectedAttribute[];
    pack: { packId: string | null; packVersion: number | null };
    /**
     * The `/profile/parse` call's usage, when this path made one. SEPARATE FROM
     * `result.ai_metadata` on purpose — see the note at the OIE branch's `return`: that field
     * feeds the `profile_extraction` cost event, and merging the two would double-count the
     * interview's spend under the wrong task type.
     */
    parseMeta: AICallMetadata | null;
    /**
     * Why the MODEL leg is degraded, when it is transiently degraded — or null when the
     * call was healthy, was never attempted as a matter of posture, or failed for a
     * reason that will not heal on a timer.
     *
     * SEPARATE FROM "the profile is empty", which is the conflation this whole change
     * exists to undo: a quiet worker and a rate-limited provider both produce an empty
     * overlay, and only one of them is worth retrying.
     */
    outageCode: string | null;
    /**
     * Did Phase C's `/profiling/extract` return usable values on this attempt?
     *
     * THE RETRY'S PREMISE, MADE CHECKABLE. `outageCode` was the whole test for "should this
     * job be thrown away and tried again", and it only ever describes the PARSE leg. With
     * Phase C there are two model calls with independent fates, and the live failure was the
     * combination nobody had: parse blew its deadline, the interview extract SUCCEEDED — and
     * the successful, already-billed overlay was discarded along with the failed parse,
     * three times, at 5- and 10-minute intervals, for a worker who never got a profile.
     *
     * Measured on session `38f9fde8`: two `profile_extraction` calls at Rs 0.226 each,
     * `real_call=true`, both producing a complete nine-key object with two `experiences[]`
     * entries — and no `worker_profiles` row, because every attempt threw before the write.
     */
    interviewLanded: boolean;
  }> {
    // NO SESSION, NO ANSWER MAP. An extraction can be triggered without one (the app's
    // "make the profile anyway" escape hatch); there is no interview record to read.
    const state = job.sessionId === null ? null : await this.conversationState(job.sessionId);
    const answerMap = state === null ? [] : narrowAnswerRecords(state.answer_map);
    if (answerMap.length === 0) {
      // No deterministic record: a pre-cutover session, or an interview that collected nothing.
      // The legacy route is unchanged and still live.
      //
      // OIE O2 (owner ruling 2026-08-20) — THE ONE PLACE THE S3-C SWITCH CAN BE POPULATED
      // TODAY, and the whole reason it is only partial coverage.
      //
      // `/profile/extract` is the only route that canonicalizes, and it is called from here
      // alone. The OIE branch below has the worker's confirmed trade but calls `/profile/parse`,
      // which deliberately invents no canonical ids. So the path that HAS a domain does not
      // canonicalize, and the path that canonicalizes has no domain — a structural split, not a
      // wiring gap, and O1 (moving the pass out of its branch) is the eventual fix.
      //
      // The seam between them is this branch's own reachability: `answerMap.length === 0` is
      // true for a NON-NULL session too — "an interview that collected nothing" — so a session
      // that pinned an occupation and then collected no answers lands here WITH a pin in
      // `state`, which this branch used to discard. That is the fraction O2 covers.
      //
      // MEASURABLE, WHICH IS WHY O2 WAS CHOSEN OVER O3. `db:report:oie-canonicalize-coverage`
      // reads exactly this predicate off production and reports the fraction, so "how much of
      // the OIE path canonicalizes under Path A" stops being an assumption. If it turns out to
      // cover most traffic, O1 is routine cleanup; if it covers little, O1 is the priority —
      // and O2 is what tells you which.
      const legacyPin = readOccupationPin(state?.occupation);
      const canonicalScope = await this.canonicalScopeForPin(legacyPin, job.aiJobId);
      const legacyRequest = {
        worker_ref: job.workerId,
        transcript,
        messages: [...messages],
        // OMITTED, never `undefined`-with-intent: `job_domain_id` absent leaves the pass on
        // Path B under the configured slug, byte-identical to every extraction to date. One
        // key appears, or the request is exactly what it always was.
        ...(canonicalScope === null ? {} : { job_domain_id: canonicalScope }),
      };
      const legacy = await this.ai.extractProfile(legacyRequest, {
        requestId: job.requestId,
        correlationId: job.correlationId,
      });
      return {
        result: legacy,
        pin: null,
        // A pre-cutover session has no answer map, so it has no attributes and never had any.
        // Empty here is the honest value, not a degradation.
        attributes: [],
        pack: { packId: null, packVersion: null },
        // The legacy route's spend rides on `result.ai_metadata` (the extraction call), which
        // `markCompleted` already persists. No parse happened, so there is nothing extra to carry.
        parseMeta: null,
        // THE PATH WITH NO SAFETY NET. This branch has no answer map to project from, so a
        // GENUINE provider incident (`legacy.error_code` is one of `LLM_OUTAGE_CODES` — the
        // ai-service was reached and its own call failed) is worth the wait: a profile from
        // nothing is strictly worse than one delayed a few minutes. `outageCodeOf` narrows
        // away `"extract_service_unreachable"` the same as everywhere else, though: the
        // ai-service being flatly unreachable is not an incident this branch's 5/10-minute
        // backoff can do anything about either, and the OIE branch's `outageCode` above
        // mirrors this narrowing for its own `"parse_service_unreachable"` for the same reason
        // — see that comment for the measured hang this kept them inconsistent about.
        outageCode: outageCodeOf(legacy.error_code),
        // Phase C never runs on this branch — there is no interview to read. `false` keeps the
        // retry exactly as it is here, which is what the note above argues for.
        interviewLanded: false,
      };
    }

    // INDEXED BEFORE FILTERING, and the order matters. `evidence.message_index` on a parsed
    // field points into THIS array, so it has to be the same array the gates check against —
    // and `system` lines have no place in either, since a value can only be sourced from a
    // worker's own words (gate 2).
    const lines = messages
      .map((m, i) => ({ i, role: m.role, text: m.text }))
      .filter(
        (m): m is { i: number; role: "worker" | "assistant"; text: string } =>
          m.role === "worker" || m.role === "assistant",
      );
    // DISCLOSE THE CLOSED SET THE GATE ALREADY ENFORCES. This was `enum: null` on every field,
    // which made `parse_prompt.py`'s `if target.enum: "one of ..."` branch dead code and left the
    // model guessing a vocabulary gate 3 would then reject it for missing. See `PARSE_ENUM_VALUES`
    // for the live repro. `?? null` keeps every non-enum field byte-identical to before.
    const targets = PARSE_TARGET_FIELDS.map((f) => {
      // Copied, not aliased: the wire DTO wants a mutable `string[]`, and handing it the frozen
      // module constant would let a serializer or a future caller mutate the gate's own vocabulary.
      const values = PARSE_ENUM_VALUES[f.field_id];
      return { ...f, enum: values ? [...values] : null };
    });

    const occupation = readOccupationPin(state?.occupation);
    // Hoisted so the 0083 trace can record WHAT WAS ASKED, not only what came back.
    const parseRequest = {
      schema_version: "oie.v1" as const,
      // PSEUDONYMOUS. The worker's real id is the correlation key on our side of the wire and
      // never crosses it — the same discipline `/profile/extract` already used.
      worker_ref: job.workerId,
      occupation,
      answer_map: answerMap,
      transcript: lines,
      target_fields: targets,
    };
    const parsed = await this.ai.parseProfile(parseRequest, {
      requestId: job.requestId,
      correlationId: job.correlationId,
    });

    // THE INTERVIEW'S ENTIRE MODEL SPEND, LEDGERED — for the first time.
    //
    // The cutover's economic case is "~12 capable calls per interview became 1". That one call is
    // this one, and until now it produced no cost record at all: `/profile/parse` returned no
    // metadata, so there was nothing to record even if something had tried to. Every figure the
    // ledger could show described the OLD architecture.
    //
    // Emitted here rather than beside the extraction record because this is where the call
    // happened, and it is not the same call: two billable requests can occur under one
    // `ai_job`, with different models, different token counts and different outcomes.
    //
    // `null` metadata is the degraded path (deadline, mock posture, spend cap) and records
    // nothing — a zero-cost row would be indistinguishable from a real call that was free.
    await this.recordAiCost(
      parsed?.ai_metadata ?? null,
      "profile_parse",
      job.aiJobId,
      job.correlationId ?? "",
      job.requestId ?? "",
      { workerId: job.workerId, sessionId: job.sessionId },
      // 0083. TRACED — the most valuable trace in the system after the interview turns
      // themselves: the OIE cutover collapsed ~12 capable calls into THIS one, so "the profile
      // came out wrong" is now a question about exactly this request and exactly this reply.
      true,
    );

    // ── THE SECOND WALL ────────────────────────────────────────────────────────────────
    //
    // The ai-service already ran all six gates before this response left it. Running them
    // AGAIN here is the same double-wall discipline the domain match already uses, and it is
    // not paranoia about our own code: the two walls fail independently. A version-skewed
    // ai-service, a proxy that rewrote a body, a mock left enabled in an environment — each
    // produces a response the far wall vouched for and this one does not.
    const gated =
      parsed === null
        ? { accepted: {}, rejections: [], disagreements: [] }
        : applyParseGates(
            parsed,
            { answer_map: answerMap, transcript: lines, target_fields: targets },
            // PII RE-CERTIFICATION (gate 6) is the ai-service's to run — it owns the
            // pseudonymizer. Here it is a pass-through, and saying so explicitly is better than
            // a second, weaker regex pretending to be the same check.
            (value) => ({ blocked: false, text: value }),
          );

    if (parsed === null) {
      this.logger.warn(
        `parse call produced nothing for job ${job.aiJobId}; projecting the profile from the ` +
          `answer map alone (parse_status=deterministic_only)`,
      );
    }
    const acceptedCount = Object.keys(gated.accepted).length;
    if (gated.rejections.length > 0) {
      // Gate ids and counts, never the rejected values — a value that failed a gate is by
      // definition not vouched for, so it is not known to be PII-free.
      this.logger.warn(
        `parse gates rejected ${gated.rejections.length} field(s) for job ${job.aiJobId}: ` +
          JSON.stringify(countByGate(gated.rejections)),
      );
    }
    await this.recordGateRejections(job, gated.rejections, acceptedCount);
    await this.recordDisagreements(job, gated.disagreements, acceptedCount);

    // ── PHASE C: THE CONVERSATION ITSELF, READ ONCE ───────────────────────────────────
    //
    // A SECOND CALL, AND DELIBERATELY SO. `/profile/parse` types a deterministic answer map
    // against a closed field list — it is told "the answer for salary_expected was `pandrah
    // hazaar`" and returns a typed value with a cited span. It cannot produce `experiences[]`,
    // because there is no answer-map entry to type: a pack asks its fixed question once, and a
    // worker with three jobs has three different answers to "what did you do". That list only
    // exists in the conversation, so something has to read the conversation.
    //
    // AFTER THE GATES AND BEFORE THE PROJECTION, so an outage here costs the OVERLAY and never
    // the profile. Null is the whole degraded set — down, 429, deadline, mock posture, blocked,
    // malformed — and the profile that comes out is exactly the one the answer map alone
    // produces, which is already a usable profile.
    const interview = await this.interviewOverlay(
      job,
      lines,
      occupation,
    );

    const projection = projectProfile(answerMap, gated.accepted, { split: splitToolsEquipment });
    this.logger.log(
      `profile projected for job ${job.aiJobId} status=${projection.parseStatus} ` +
        `fields=${Object.keys(projection.draft).length} overlay=${projection.overlayFields.length}`,
    );
    return {
      result: toExtractionOutput(projection, interview),
      pin: occupation,
      // THE LINE THAT WAS MISSING. `projectProfile` has computed this array on every interview
      // since V2 shipped; `toExtractionOutput` reads `projection.draft` and nothing else, so the
      // attributes were computed and dropped on the floor. A live 13-turn welding interview
      // produced 10 typed answers and ZERO rows in `worker_attributes` — the original 77% defect,
      // moved one layer later and no less total.
      attributes: projection.attributes,
      pack: {
        packId: typeof state?.pack_id === "string" ? state.pack_id : null,
        packVersion: typeof state?.pack_version === "number" ? state.pack_version : null,
      },
      // THE INTERVIEW'S ONLY MODEL SPEND, CARRIED OUT TO THE JOB ROW.
      //
      // `toExtractionOutput` hardcodes `ai_metadata: null` — correctly, since no `/profile/extract`
      // call happens on this path — so `markCompleted` was persisting nothing and every cost
      // surface that reads `ai_jobs` (the ops routes, `chat-cli.ps1`, any dashboard) reported Rs 0
      // for interviews that really did spend. The `ai.cost_recorded` EVENT was already correct;
      // the ROW was not, and the two disagreed silently.
      //
      // Deliberately a SEPARATE field rather than stuffing it into `result.ai_metadata`: that
      // value also feeds `recordAiCost(..., "profile_extraction", ...)` and `recordSpendCap`, and
      // conflating them would emit the parse's usage a second time under the wrong task type —
      // double-counting the interview's spend in the very ledger this is fixing.
      parseMeta: parsed?.ai_metadata ?? null,
      // TWO WAYS THE MODEL LEG CAN BE TRANSIENTLY DOWN on this path, both read out of a
      // healthy 200's `notes` / `ai_metadata` — the route degrades rather than erroring, by
      // design. `parsed === null` is deliberately NOT a third: it means `AiService.post`
      // never got a body back at all — `/profile/parse` returned non-OK, or our own 25 s
      // abort fired — which collapses "the ai-service is up but this one call misbehaved"
      // and "the ai-service process was never reachable in the first place" into one signal
      // this side cannot tell apart (see `AiService.post`'s catch block).
      //
      // THAT IS WHY IT MUST NOT JOIN `LLM_OUTAGE_CODES`, and doing so was the bug: this used
      // to hand the literal `"parse_service_unreachable"` straight to `outageCode`, which
      // skips `outageCodeOf`'s set-membership check — `outageCode !== null` below is a loose
      // gate, not a set test, so ANY non-null string retries. A transport failure isn't the
      // provider-cooldown/rate-limit incident `EXTRACTION_JOB_OPTS`'s 5 min / 10 min backoff
      // is sized for ("THIS IS NOT WHAT BOUNDS THE STORM" — its own docstring); waiting on it
      // when the far side has no listener at all buys nothing. Measured: an ai-service with
      // literally nothing on the port (CI's e2e job, by design — see its "AI service is
      // intentionally NOT started" comment) held a `profile_extraction` job in `running` for
      // the full 5-then-10-minute ladder before the third attempt finally wrote the profile —
      // for a worker whose interview had completed in under fifteen seconds.
      //
      // NULL, matching the legacy `extract_service_unreachable` leg two branches up, which
      // already narrows the identical "the request never came back" signal to null via
      // `outageCodeOf` — the two routes now treat the same failure the same way. The `parsed
      // === null` case is still logged on its own line below ("parse call produced nothing"),
      // so nothing about WHY the fallback fired is lost — only the pointless 15-minute wait.
      outageCode:
        parsed === null
          ? null
          : (parsed.notes.find((note) => PARSE_OUTAGE_NOTES.has(note)) ??
            outageCodeOf(parsed.ai_metadata?.error_code)),
      // Taken from the OVERLAY'S CONTENT, not merely from its presence.
      //
      // A NON-NULL OVERLAY IS NOT EVIDENCE THAT ANYTHING LANDED. `interviewOverlay` returns
      // null for unreachable and for `blocked`, but the ai-service converts THREE of its own
      // degrades into a healthy 200 carrying an EMPTY object — `InterviewExtractOutput(
      // is_mock=True)`, whose `blocked` defaults to FALSE (`routers/profiling.py`):
      //
      //   - the Phase C deadline breach — the case this change raises the deadline for, so
      //     precisely the one in play;
      //   - `not meta.real_call`, i.e. every mocked environment (TD81: staging runs mocked);
      //   - "interview extract output failed the contract", i.e. the model returned garbage.
      //
      // Read as presence, all three say "landed" while holding nothing, and the veto below
      // would then suppress the retry in exactly the situation the retry exists for: no
      // overlay, no parse, nothing to write but the answer map. That is this bug's mirror
      // image — the first version of this fix traded discarding a good overlay for keeping a
      // worthless one.
      //
      // The premise is "we are holding model-derived values", so the test is whether we hold
      // any. `experiences[]` is the one nothing else on this path can produce, but a short
      // interview that yields only a domain label or a couple of skills is still worth more
      // than a re-run — hence "any field", not "experiences".
      interviewLanded: overlayCarriesValues(interview),
    };
  }

  /**
   * `chat_sessions.conversation_state`, narrowed to the two OIE fields this needs.
   *
   * READ FROM POSTGRES, NOT REDIS, and that is forced rather than chosen: the transcript buffer
   * is dropped the moment the flush transaction commits, and this job runs minutes later. The
   * flush writes the envelope's projection into `conversation_state` precisely so this read has
   * something to find.
   */
  private async conversationState(sessionId: string): Promise<{
    answer_map: unknown;
    occupation: unknown;
    pack_id: unknown;
    pack_version: unknown;
  } | null> {
    try {
      const session = await this.chat.findSession(sessionId);
      const state = session?.conversationState;
      if (typeof state !== "object" || state === null) return null;
      // `pack_id` / `pack_version` come along because every attribute row PINS the interview it
      // was collected under. Pack contents are immutable per version, so that pair is the only
      // thing that makes a stored value re-readable a year later — "did `safety_gear` mean the
      // same question in v1 as in v3" is otherwise unanswerable.
      return state as {
        answer_map: unknown;
        occupation: unknown;
        pack_id: unknown;
        pack_version: unknown;
      };
    } catch (err) {
      // A read failure must not fail the extraction — it degrades to the legacy path, which is
      // exactly what a pre-cutover session would have taken anyway.
      this.logger.warn(
        `could not read conversation_state for session ${sessionId}; falling back to the ` +
          `transcript re-parse: ${err instanceof Error ? err.name : "UnknownError"}`,
      );
      return null;
    }
  }

  /**
   * Emit `profile.parse_gates_rejected` — how much the six-gate wall threw away, per gate.
   *
   * THE GATES ALWAYS WORKED; THE RATE IS THE SIGNAL. A rejected field never reaches a profile,
   * so nothing is broken when this fires — but `provenance` climbing means the model started
   * inventing spans, `role` climbing means it started reading our own question text back to us,
   * and `pii` climbing means the pseudonymizer and the parser have drifted apart on what a name
   * is. A log line can answer "did this job reject anything"; only an event answers "is this
   * getting worse", and grepping logs for that discovers it after it ships.
   *
   * NOT EMITTED WHEN NOTHING WAS REJECTED, because the healthy case is the overwhelming majority
   * and one row per extraction to say "zero" is the write amplification risk #9 warns about.
   * `accepted_count` on the rows that DO fire carries the denominator.
   *
   * GUARDED: an observability emit must never fail an extraction that produced a real profile.
   */
  private async recordGateRejections(
    job: {
      workerId: string;
      aiJobId: string;
      correlationId?: string | null;
      requestId?: string | null;
    },
    rejections: readonly Rejection[],
    acceptedCount: number,
  ): Promise<void> {
    if (rejections.length === 0) return;
    try {
      await this.events.emit({
        event_name: "profile.parse_gates_rejected",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: job.aiJobId },
        payload: {
          worker_id: job.workerId,
          ai_job_id: job.aiJobId,
          rejected_count: rejections.length,
          accepted_count: acceptedCount,
          // COUNTS ONLY, no field ids — see the payload's own note. A value that failed
          // `provenance` or `pii` is unverified model output, and so is the field id it came
          // attached to.
          by_gate: countByGate(rejections),
        },
        idempotencyKey: `profile.parse_gates_rejected:${job.aiJobId}`,
        correlationId: job.correlationId ?? undefined,
        requestId: job.requestId ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `parse-gate-rejection emit failed for job ${job.aiJobId} (the profile stands): ` +
          `${err instanceof Error ? err.name : "UnknownError"}`,
      );
    }
  }

  /**
   * Emit `profile.parse_disagreement` when the model contradicted the deterministic record.
   *
   * THE EVENT IS THE PROOF THAT GATE 4 IS LOAD-BEARING. The gate already discarded the model's
   * value — it cannot override the worker, only reformat them — but a gate that silently
   * discards is a gate nobody can watch degrade. A disagreement rate climbing from 0.3% to 12%
   * is a prompt regression, a lexicon regression, or a model swap, and all three are worth
   * knowing about before a quarter of profiles are being quietly corrected.
   *
   * GUARDED: an observability emit must never fail an extraction that produced a real profile.
   */
  private async recordDisagreements(
    job: {
      workerId: string;
      aiJobId: string;
      correlationId?: string | null;
      requestId?: string | null;
    },
    disagreements: readonly string[],
    acceptedCount: number,
  ): Promise<void> {
    if (disagreements.length === 0) return;
    try {
      await this.events.emit({
        event_name: "profile.parse_disagreement",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: job.aiJobId },
        payload: {
          worker_id: job.workerId,
          ai_job_id: job.aiJobId,
          // FIELD IDS AND COUNTS ONLY. Both values are worker data: one is what they said, the
          // other what the model claimed they said.
          field_ids: [...disagreements].sort().slice(0, 64),
          disagreement_count: disagreements.length,
          agreement_count: acceptedCount,
        },
        idempotencyKey: `profile.parse_disagreement:${job.aiJobId}`,
        correlationId: job.correlationId ?? undefined,
        requestId: job.requestId ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `parse-disagreement emit failed for job ${job.aiJobId} (the profile stands): ` +
          `${err instanceof Error ? err.name : "UnknownError"}`,
      );
    }
  }

  /**
   * The interview's pinned occupation → the `worker_profiles` columns.
   *
   * A SIBLING OF `resolveJobDomain`, NOT A BRANCH INSIDE IT, because the two answer
   * different questions. That one asks "did a classifier produce something writable"; this
   * one asks "is the worker's own confirmed trade still in the catalogue". They share
   * exactly one thing — `isSelectableDomain`, the last hallucination wall — and merging
   * them would mean a conditional in every line of both.
   */
  /**
   * OIE O2 — the canonical `jd_*` scope for this extraction's canonicalization pass, or null.
   *
   * WHAT SENDING IT DOES, STATED PLAINLY. `job_domain_id` is not a flag, it IS the S3-C read
   * switch for this caller: supplying it moves the TAX-4 canonicalization pass from Path B
   * (`skill_alias.domain_id`, the configured legacy slug) to Path A (`job_domain_skill`).
   * Omitting it leaves that pass exactly as it has always been.
   *
   * WHAT IT DOES TODAY: nothing. The pass sits behind `skill_canonicalize_enabled`, which is
   * `False` by default and OFF in production, so the field rides the request and is never read.
   * This arms the switch; the taxonomy flag is still what activates it, and that flag is
   * deliberately untouched.
   *
   * THREE REFUSALS, all failing to "no scope" — which is the pre-existing behaviour, so every
   * refusal is a no-op rather than a degradation:
   *
   *   1. No pin, or an unmatched one. Five of the seven `OccupationPin` statuses are
   *      `unmatched_*` and the schema DEFAULTS to one of them, so a present pin is not a
   *      confirmed trade. See `occupationPinScopesCanonicalization`.
   *   2. The domain is no longer selectable. The catalogue moves between the interview and this
   *      job; scoping to a deprecated domain would narrow retrieval to a set with no active
   *      edges, and every label would come back unresolved — a SILENT recall loss, which is
   *      worse than the honest Path B answer. Same `isSelectableDomain` wall
   *      `resolvePinnedDomain` uses, applied one step earlier because this one is on the wire.
   *   3. The validation query itself failed. Identical posture to `resolvePinnedDomain`: this
   *      method exists to improve an extraction, so it must never be a way to break one.
   *
   * Never throws.
   */
  private async canonicalScopeForPin(
    pin: OccupationPin | null,
    aiJobId: string,
  ): Promise<string | null> {
    if (!occupationPinScopesCanonicalization(pin)) return null;
    try {
      if (!(await this.skills.isSelectableDomain(pin!.job_domain_id))) {
        this.logger.warn(
          `extraction job ${aiJobId} carried a pinned job_domain that is no longer selectable; ` +
            `canonicalizing on the LEGACY scope rather than a domain with no active edges`,
        );
        return null;
      }
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      this.logger.warn(
        `extraction job ${aiJobId} could not validate the pinned job_domain (${cls}); ` +
          `canonicalizing on the LEGACY scope (a scope is never worth the extraction)`,
      );
      return null;
    }
    // Opaque ids only, never transcript or PII (no-PII-in-logs). This line is how an operator
    // sees the switch fire on a specific job; the FRACTION comes from
    // `db:report:oie-canonicalize-coverage`, which reads the same predicate off the database.
    this.logger.log(
      `extraction job ${aiJobId} canonicalizing under the CANONICAL scope ` +
        `${pin!.job_domain_id} (${pin!.match_status}) — Path A`,
    );
    return pin!.job_domain_id;
  }

  private async resolvePinnedDomain(
    pin: OccupationPin,
    aiJobId: string,
  ): Promise<Partial<NewWorkerProfile>> {
    const base = {
      jobDomainMatchStatus: pin.match_status,
      jobDomainMatchedAt: new Date(),
    } satisfies Partial<NewWorkerProfile>;

    try {
      if (!(await this.skills.isSelectableDomain(pin.job_domain_id))) {
        // The catalogue moved between the interview and this job: the occupation was
        // deprecated or made non-selectable. Recording UNMATCHED beats writing an id the
        // feed would then fail to describe — and beats failing the extraction outright.
        this.logger.warn(
          `extraction job ${aiJobId} carried a pinned job_domain that is no longer ` +
            `selectable; recording the profile UNMATCHED rather than failing the insert`,
        );
        return { ...base, jobDomainMatchStatus: "unmatched_llm_declined" };
      }
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      this.logger.warn(
        `extraction job ${aiJobId} could not validate the pinned job_domain (${cls}); ` +
          `recording the profile UNMATCHED (the label is never worth the extraction)`,
      );
      return { ...base, jobDomainMatchStatus: "unmatched_degraded" };
    }

    return {
      ...base,
      jobDomainId: pin.job_domain_id,
      jobDomainMatchScore: pin.match_score,
      // THE COLUMN MIGRATION 0072 ADDED, and the reason it is stored rather than logged:
      // the plan's L0+L1 ≥ 45% / L2 ≥ 30% / L3 ≤ 25% gate is a distribution over ten
      // thousand workers, which no log line can answer.
      jobDomainMatchLayer: pin.match_layer,
    };
  }

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
   * Phase C — read the whole conversation once, for what the answer map cannot hold.
   *
   * BEHIND THE SAME FLAG AS THE INTERVIEW. Off, and this returns null before touching the
   * network: the OIE cutover's economics are "twelve capable calls became one", and turning that
   * one into two is a trade that belongs to the LLM-led interview, not to every worker.
   *
   * IT RUNS EVEN WHEN PHASE A FELL BACK, and that is not an oversight. The transcript is still a
   * conversation, `experiences[]` still has no other source, and an interview that lost the model
   * halfway is exactly the one whose answer map is thinnest.
   *
   * NEVER THROWS AND NEVER BLOCKS THE PROFILE. Every failure is the same null, and the caller
   * projects from the answer map alone — the fail-closed property the whole extraction path is
   * built on (§3). Spend is ledgered on its own `ai_call_id`, so this call is visible in the cost
   * spine rather than folded into the parse it sits beside.
   */
  private async interviewOverlay(
    job: {
      workerId: string;
      // Carried for cost attribution only — this method's caller already passes its own `job`,
      // which has it. Null on the "make the profile anyway" escape hatch, where there is no
      // interview record at all.
      sessionId: string | null;
      aiJobId: string;
      correlationId?: string | null;
      requestId?: string | null;
    },
    transcript: readonly TranscriptLine[],
    occupation: OccupationPin | null,
  ): Promise<InterviewExtractOutput | null> {
    if (this.config.CHAT_LLM_INTERVIEW_ENABLED !== true) return null;
    // NOTHING SAID, NOTHING TO READ. A transcript-less extraction (the app's "make the profile
    // anyway" escape hatch) would spend a capable call to be told the conversation was empty.
    if (transcript.length === 0) return null;

    const extractRequest = {
      schema_version: "oie.v1" as const,
      // PSEUDONYMOUS on the far side; the id is our correlation key and carries no identity.
      worker_ref: job.workerId,
      transcript: [...transcript],
      occupation,
    };
    const out = await this.ai.extractInterview(extractRequest, {
      requestId: job.requestId,
      correlationId: job.correlationId,
    });

    // ATTRIBUTED TO `profile_extraction`, WHICH IS WHAT THE AI-SERVICE ITSELF STAMPS on this
    // route's metadata. Passing anything else here would make our event disagree with the
    // metadata it was built from. It does mean the ledger cannot yet tell this call apart from
    // the legacy `/profile/extract` one — they differ by `ai_call_id`, not by task type — and a
    // dedicated type is a joint change with `model_config.TaskType`, not a rename on this side.
    await this.recordAiCost(
      out?.ai_metadata ?? null,
      "profile_extraction",
      job.aiJobId,
      job.correlationId ?? "",
      job.requestId ?? "",
      { workerId: job.workerId, sessionId: job.sessionId },
      // 0083. TRACED — the transcript that went in and the experiences that came out, the pair a
      // "these are not the jobs I described" report cannot be investigated without.
      true,
    );

    if (out === null || out.blocked) {
      this.logger.warn(
        `interview extraction produced nothing for job ${job.aiJobId} ` +
          `(${out === null ? "unreachable" : "blocked"}); the profile is projected from the ` +
          `answer map alone and carries no experiences[]`,
      );
      return null;
    }
    this.logger.log(
      `interview extraction for job ${job.aiJobId}: ${out.experiences.length} experience ` +
        `entr${out.experiences.length === 1 ? "y" : "ies"}, ${out.skills.length} skill(s)`,
    );
    return out;
  }

  /**
   * Ledger ONE AI call's spend. A thin delegate to {@link AiCostRecorder.record}, which owns
   * the whole contract — the `null`-metadata no-op, the `ai_call_id` idempotency key, the
   * never-throws rule and the savepointed totals accrual. (The duplicate copy of that contract
   * that used to sit here was left dangling above `interviewOverlay` by an earlier extraction;
   * one description, on the method that implements it.)
   *
   * @param attribution Whose spend this is. REQUIRED here, unlike on the recorder itself,
   * because every call this processor makes has both a worker and (except on the escape-hatch
   * path, where it is genuinely null) a session in scope. An optional parameter would let a
   * future call site quietly omit the one thing that makes the cost attributable — and this is
   * the class where attribution used to work, by joining `ai_jobs.input_ref`. Now it travels
   * on the event too, so the extraction path and the four surfaces with no `ai_jobs` row are
   * read the SAME way, rather than one dashboard query per surface.
   *
   * @param trace whether this call gets a row in `ai_call_traces` (migration 0083). REQUIRED,
   * and not defaulted, on purpose: this processor has four call sites and a default would let a
   * fifth arrive untraced without anyone having decided that — the same argument the paragraph
   * above makes for `attribution`. An explicit `false` is a decision a reader can see; an
   * omitted argument is not.
   *
   * IT IS A BOOLEAN AND NOT A TEXT SUPPLIER, and the change is a privacy fix rather than a
   * simplification. The recorder used to take the strings from HERE — the request objects this
   * processor assembles — which are on the near side of the pseudonymization hop and therefore
   * hold the worker's raw words. The text now comes off `AICallMetadata`, already masked by the
   * ai-service. All this flag decides is whether a row is written at all.
   *
   * ONE DELEGATE FOR BOTH RECORDS, rather than a second `this.aiTraces.capture(...)` beside each
   * of the four. The cost row and the trace describe the SAME provider call and take the same
   * metadata, job id and attribution, so emitting them from one place is what stops a future
   * call site wiring one and forgetting the other — which is precisely how `stt_transcription`
   * shipped unledgered in the first place.
   */
  private async recordAiCost(
    meta: AICallMetadata | null,
    taskType: AiCostTaskType,
    aiJobId: string,
    correlationId: string,
    requestId: string,
    attribution: { workerId: string; sessionId: string | null },
    trace: boolean,
  ): Promise<void> {
    // The body moved to `AiCostRecorder` unchanged (#738). Kept as a one-line delegate rather
    // than inlined at both call sites so this class's two callers, and the tests that drive
    // them, stay exactly as they were — the change is WHO ELSE can emit, not what this emits.
    await this.aiCost.record(meta, taskType, aiJobId, correlationId, requestId, attribution);
    // 0083. Never throws, opens no transaction, and drops the row outright when there is no
    // worker — so it cannot fail an extraction that has already succeeded.
    if (trace) {
      await this.aiTraces.capture(meta, taskType, aiJobId, correlationId, attribution);
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
 * `tools_equipment` → `machines[]` and `controllers[]`.
 *
 * THE CROSSWALK NAMES THIS SPLITTER AND SOMEONE HAS TO BE IT. One phrase carries a VMC and a
 * Fanuc for a machinist, an overlock for a tailor, a tandoor for a cook — so the routing is by
 * VOCABULARY, never by trade, and there is no per-trade code anywhere in it.
 *
 * A TOKEN THAT MATCHES NOTHING IS A MACHINE, not dropped. Machines are open-ended by nature (the
 * corpus cannot enumerate every press in India); CNC controllers are a small, closed, and
 * genuinely recognisable family. Defaulting the other way would silently discard equipment the
 * worker named.
 */
const CONTROLLER_TOKENS = [
  "fanuc",
  "siemens",
  "mitsubishi",
  "haas",
  "mazak",
  "mazatrol",
  "heidenhain",
  "fagor",
  "syntec",
  "delta",
];

function splitToolsEquipment(value: unknown): Record<string, unknown> {
  const tokens = (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  const machines: string[] = [];
  const controllers: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (CONTROLLER_TOKENS.some((c) => lower.includes(c))) controllers.push(token);
    else machines.push(token);
  }
  return { machines, controllers };
}

/**
 * A projection → the `ProfileExtractionOutput` the rest of this processor already knows how to
 * persist.
 *
 * AN ADAPTER, DELIBERATELY, RATHER THAN A SECOND PERSISTENCE PATH. Everything downstream of
 * this — `decideProfileStatus`, `profiles.create`, the match rebuild, the completion event —
 * is unchanged and untouched by the cutover. Duplicating it for the new shape would mean two
 * places that decide what a profile IS, and they would diverge on the first schema change.
 *
 * `is_mock: false` and `ai_metadata: null` are both honest: no mock was consulted, and the
 * usage/cost of the parse call belongs to the ai-service's own ledger, not to a synthesised
 * record here.
 */
/**
 * ── MODEL-WINS, AND WHY THIS REVERSED ─────────────────────────────────────────────────
 *
 * This was `firstOf(deterministic, model)` — first-write-wins, the same rule `mayCommit`
 * enforces during capture, on the reasoning that a value the worker gave to a question that was
 * actually asked went through a typed normalizer and the negation veto while a value read back
 * out of a conversation did not.
 *
 * REVERSED ON AN EXPLICIT OWNER DECISION (2026-08-12, Divyanshu), recorded here because it is a
 * documented invariant being overridden and not a refactor. The requirement is that the stored
 * profile equal the model's Phase C object as traced in Langfuse: the two disagreed on four of
 * nine keys and nothing on the path said so. Precedence is now the model's wherever it spoke.
 *
 * WHAT THIS COSTS, STATED PLAINLY so the next reader is not surprised by it: a salary or city the
 * worker typed into a pack question can now be overwritten by the same value re-read out of the
 * conversation, normalizer and negation veto bypassed. `null`/absent still yields to the
 * deterministic value, so the model can only ever REPLACE, never ERASE.
 */
function preferModel<T>(
  model: T | null | undefined,
  deterministic: T | null | undefined,
): T | null {
  return model ?? deterministic ?? null;
}

/**
 * The model's list when it produced one, the deterministic list when it did not.
 *
 * WAS `union(deterministic, model)`, which appended the model's entries after the answer map's
 * and made the stored array a superset in a different order — the array was never the traced one.
 * Same owner decision as `preferModel`.
 *
 * AN EMPTY MODEL LIST IS NOT AN ANSWER, it is the shape of every degraded Phase C response, so it
 * yields rather than wiping skills the worker really confirmed — the same reasoning
 * `overlayCarriesValues` applies one layer up. Entries are trimmed and deduped
 * case-insensitively, which is the one way the result can still differ from the trace: a model
 * that emits "Welding" and "welding" gets one of them.
 */
function preferModelList(
  model: readonly string[] | undefined,
  deterministic: readonly string[],
): string[] {
  const source = model && model.length > 0 ? model : deterministic;
  const out: string[] = [];
  for (const candidate of source) {
    const trimmed = candidate.trim();
    if (trimmed && !out.some((held) => held.toLowerCase() === trimmed.toLowerCase())) {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * The model's `availability` vocabulary is NOT this schema's, and passing it through raw throws.
 *
 * `extract_system_prompt` asks for `"immediate" | "15_days" | "1_month" | "unknown" | null`;
 * `AvailabilitySchema.status` is `"immediate" | "notice_period" | "not_looking" | "unknown"`.
 * `15_days` and `1_month` are in neither set the other accepts, so a straight assignment makes
 * `DraftProfileSchema.parse` throw INSIDE the extraction job — the worker gets no profile at all
 * rather than a slightly wrong one. The two enums were written for different readers and only
 * ever met here.
 *
 * The notice lengths are preserved rather than flattened, so "1 month" survives as
 * `notice_period` + 30 days instead of collapsing to a bare status. Anything unrecognised —
 * including `unknown`, `null`, and whatever a model invents, since the wire type is a bare
 * `str | None` with no Literal to constrain it — yields to the deterministic value.
 */
const MODEL_AVAILABILITY: Readonly<Record<string, DraftProfile["availability"]>> = {
  immediate: { status: "immediate", notice_period_days: null },
  "15_days": { status: "notice_period", notice_period_days: 15 },
  "1_month": { status: "notice_period", notice_period_days: 30 },
  notice_period: { status: "notice_period", notice_period_days: null },
  not_looking: { status: "not_looking", notice_period_days: null },
};

function availabilityOf(
  model: string | null | undefined,
  deterministic: DraftProfile["availability"]["status"],
): DraftProfile["availability"] {
  const mapped = model ? MODEL_AVAILABILITY[model.trim().toLowerCase()] : undefined;
  return mapped ?? { status: deterministic, notice_period_days: null };
}

function toExtractionOutput(
  projection: ProjectionResult,
  interview: InterviewExtractOutput | null = null,
): ProfileExtractionOutput {
  const at = <T>(field: string): T | undefined => projection.draft[field]?.value as T | undefined;
  const arr = (field: string): string[] => {
    const value = projection.draft[field]?.value;
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return typeof value === "string" && value.length > 0 ? [value] : [];
  };

  const draft = WorkerProfileDraftSchema.parse({
    primary_role: at<string>("primary_role") ?? null,
    machines: arr("machines"),
    controllers: arr("controllers"),
    skills: arr("skills"),
    experience_years: at<number>("experience_years") ?? null,
    current_city: at<string>("current_city") ?? null,
    preferred_locations: arr("preferred_locations"),
    relocation_willingness: at<boolean>("relocation_willingness") ?? null,
    current_salary: at<number>("current_salary") ?? null,
    expected_salary: at<number>("expected_salary") ?? null,
    availability: at<string>("availability") ?? "unknown",
    certifications: arr("certifications"),
    education_level: at<string>("education_level") ?? null,
    education_field: at<string>("education_field") ?? null,
  });

  const profile = DraftProfileSchema.parse({
    // CANONICAL IDS ARE NOT INVENTED HERE. Skill/role canonicalization is the taxonomy's job
    // and runs on its own path; writing a guess into these columns would put an unvalidated id
    // in the one place the match engine trusts absolutely.
    canonical_trade_id: null,
    canonical_role_id: null,
    skills: [],
    // THE MODEL'S LIST WHEN IT PRODUCED ONE. Was a union with the answer map's skills, which
    // made this a superset in a different order and never the traced array. See `preferModelList`.
    skill_labels: preferModelList(interview?.skills, draft.skills),
    machines: draft.machines,
    education: draft.education,
    certifications: draft.certifications,
    education_level: draft.education_level,
    education_field: draft.education_field,
    experience: draft.experience_years === null ? {} : { total_years: draft.experience_years },
    // THE NARRATIVE, which `experience.total_years` above is not and does not replace. The
    // aggregate is what matching and ranking read; this is what an employer reads. Only the
    // interview call can produce it — a pack asks its fixed question once, and a worker with
    // three jobs has three different answers to "what did you do".
    //
    // NO EMPLOYER NAMES: `ExperienceEntrySchema` is `.strict()`, so a model that emits one fails
    // at the boundary rather than in a column (CLAUDE.md §2).
    experiences: interview?.experiences ?? [],
    // ── THE THREE KEYS THAT USED TO HAVE NO READER ────────────────────────────────────
    //
    // `domain_label`, `role_label` and `shift` were referenced ZERO times in this file. The
    // extract prompt names all three, the model fills them, the contract validates them, the
    // wire carries them — and the merge never looked. Together with `availability` below, that
    // was four of the model's nine data keys silently discarded, which is most of the gap
    // between the Langfuse assistant response and the stored profile.
    //
    // No deterministic counterpart exists for any of them: the answer map has no domain or shift
    // question, and `primary_role` lives on the RICH draft, which the résumé never reads.
    domain_label: interview?.domain_label ?? null,
    role_label: interview?.role_label ?? null,
    shift: interview?.shift ?? null,
    salary_expectation:
      preferModel(interview?.expected_salary, draft.expected_salary) === null
        ? {}
        : { amount_min: preferModel(interview?.expected_salary, draft.expected_salary) },
    location_preference: {
      // THE MODEL WINS WHEREVER IT SPOKE (owner decision — see `preferModel`). This was
      // deterministic-wins, so a city the model read out of the conversation was discarded
      // whenever the answer map held one, and the trace and the row disagreed.
      //
      // `current_city` WAS BEING DROPPED ENTIRELY on this path — the field exists on the schema
      // (#423 split it from `preferred_cities` precisely so "I live in Pune" stops becoming "I
      // want to work in Pune"), and this projection never wrote it, so every OIE-path profile
      // left it null and every consumer fell through to `preferred_cities[0]`.
      current_city: preferModel(interview?.current_city, draft.current_city),
      preferred_cities: preferModelList(interview?.preferred_locations, draft.preferred_locations),
    },
    // MAPPED, NOT ASSIGNED. The model's vocabulary and this schema's do not overlap on two of
    // five values, and a raw assignment throws inside the job. See `availabilityOf`.
    availability: availabilityOf(interview?.availability, draft.availability),
    // ── THE RÉSUMÉ CONTAINER — THE PHASE C OBJECT, UNTOUCHED ──────────────────────────
    //
    // Everything above this line reassembles the model's nine flat keys into the legacy
    // storage shape: scattered across `salary_expectation{}` / `location_preference{}` /
    // `availability{}`, unioned, outranked, enum-mapped. Each of those steps is a place a
    // value can change, and the résumé could never be diffed against the trace as a result.
    //
    // THIS IS THE SAME DATA WITH NONE OF THAT DONE TO IT, and it is what the résumé reads.
    // No merge, no precedence, no derivation — `preferModel` and `availabilityOf` deliberately
    // do NOT run here. The two shapes are two records of one interview written for two
    // readers: this one for the worker's résumé, the fields above for matching and ranking.
    //
    // NULL WHEN THERE WAS NO INTERVIEW, never an empty object. A deterministic-only extraction
    // has no Phase C response, and inventing a hollow container would make "the model said
    // nothing" indistinguishable from "the model was never asked" — the renderer reads null as
    // "fall back to the old path", which is what keeps pre-existing profiles rendering exactly
    // as they do today.
    //
    // WHICH IS WHY THE TEST IS CONTENT, NOT PRESENCE — `interview !== null` was exactly the
    // hollow container this comment forbids. `interviewOverlay` returns null for unreachable
    // and for `blocked`, but the ai-service converts four more of its own degrades into a
    // healthy 200 carrying an EMPTY `InterviewExtractOutput` whose `blocked` is FALSE, and
    // `not meta.real_call` — every mocked environment, staging included (TD81) — is one of
    // them. Stored, that container is truthy, so the résumé took this path, discarded the
    // answer-map profile it is supposed to fall back to, and rendered nothing but the worker's
    // name. `overlayCarriesValues` is the same predicate `interviewLanded` already uses one
    // layer up, for the same reason: a non-null overlay is not evidence that anything landed.
    //
    // THE FIELDS ABOVE ARE UNAFFECTED and deliberately still read `interview?.` — `preferModel`,
    // `preferModelList` and `availabilityOf` all treat undefined exactly as null, so an empty
    // overlay yields to the deterministic value there whether it is nulled here or not.
    resume_profile: overlayCarriesValues(interview)
      ? {
          domain_label: interview.domain_label,
          role_label: interview.role_label,
          skills: interview.skills,
          experiences: interview.experiences,
          shift: interview.shift,
          current_city: interview.current_city,
          preferred_locations: interview.preferred_locations,
          availability: interview.availability,
          expected_salary: interview.expected_salary,
        }
      : null,
  });

  return ProfileExtractionOutputSchema.parse({
    profile,
    blocked: false,
    is_mock: false,
    extraction_status: "completed",
    worker_profile_draft: draft,
    ai_metadata: null,
    // NULL, AND NOT BECAUSE NOTHING MATCHED. The pinned occupation is carried back to the
    // caller separately, because `JobDomainMatch` is the CLASSIFIER's contract — frozen at
    // its own five statuses, with no `match_layer` — and squeezing a pin through it would
    // mean either lying about the status or losing the layer the Phase 9 gate is measured
    // from. See `resolvePinnedDomain`.
    job_domain_match: null,
  });
}
