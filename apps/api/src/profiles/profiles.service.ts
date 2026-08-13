import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ChatRepository } from "../chat/chat.repository";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import {
  PROFILE_EXTRACTION_QUEUE,
  REFERRAL_BONUS_QUEUE,
  RESUME_GENERATE_QUEUE,
  type ProfileExtractionJobData,
  type ReferralBonusJobData,
  type ResumeGenerateJobData,
} from "../queue/queue.constants";
import type { ExtractProfileInput, ConfirmProfileInput } from "./profiles.dto";
import { hasExtractedContent } from "./profile-content";

/**
 * How long a `queued`/`running` extraction job is believed to be genuinely in
 * flight. Older than this it is treated as a zombie and a fresh extraction is
 * allowed (issue #420 review).
 *
 * MUST STAY LONGER THAN THE FULL RETRY LADDER, and that is now the binding
 * constraint. This was 10 minutes, justified as "~20x the longest legitimate
 * lifecycle" because a healthy job reached a terminal status in under a minute:
 * an 8s AI timeout and 3 BullMQ attempts at 1s exponential backoff.
 *
 * `EXTRACTION_JOB_OPTS` changes that arithmetic deliberately. An LLM outage now
 * retries at 5 and 10 minutes, so a job that is genuinely, correctly waiting for
 * a rate limit to clear is ~15 minutes old before its final attempt — well past
 * the old window. Leaving it at 10 would have made the zombie rule fire on
 * healthy jobs and mint a duplicate extraction for every one of them, which is
 * the exact double-enqueue #420 closed, reintroduced through the back door.
 *
 * 30 minutes keeps the original property (comfortably longer than any real run,
 * short enough that a genuinely stranded session self-heals on a later tap).
 * Nothing reaps stuck ai_jobs, and `extract` INSERTs `queued` before enqueueing —
 * a crash in that window strands a row no processor will ever touch.
 */
export const EXTRACTION_IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Retry policy for the extraction job, overriding the queue-wide default.
 *
 * THE QUEUE-WIDE DEFAULT IS WRONG FOR THIS FAILURE MODE. `queue.module.ts` sets
 * `attempts: 3` with a 1s exponential backoff — 1s and 2s — which is tuned for a
 * transient database or network blip. The failure this job actually suffers is a
 * provider rate limit, and retrying one after 1s is indistinguishable from not
 * backing off at all: the window has not moved, so the retry is simply another
 * rejected request charged against the same exhausted bucket.
 *
 * 5 min then 10 min is sized to the thing being waited on — a per-minute cap
 * clears in 60s, and a per-day one will not clear at all, which is what the third
 * attempt's terminal behaviour is for (the processor writes the profile from the
 * answer map rather than leaving the worker with nothing).
 *
 * THIS IS NOT WHAT BOUNDS THE STORM. It bounds ONE job's attempts. The four
 * independent triggers each mint a NEW job, and those are bounded by
 * `EXTRACTION_ATTEMPT_CAP` below plus the ai-service's provider cooldown, which
 * makes each attempt cost a Redis GET instead of an LLM call.
 */
export const EXTRACTION_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5 * 60 * 1000 },
};

/**
 * Max extraction jobs mintable for one (worker, session) per UTC hour.
 *
 * THE ACTUAL LOOP BREAKER, and the one guard that sees all four triggers. Per-job
 * `attempts` bounds a single job; it cannot bound how many jobs get created, and
 * creation is where the storm lived: the transcript-flush auto-trigger, the app's
 * unconditional `POST /profile/extract` on the preview screen,
 * `rebuildAfterCorrection`, and the worker tapping "Try again" each create their
 * own. Every dedupe guard in front of them keys on "did this produce content",
 * and during an outage the answer is always no — so all four re-fired, forever.
 *
 * 6 is deliberately generous: a healthy interview needs ONE, and the documented
 * posture is that leaving a worker unprofiled is worse than a double spend. This
 * is an abuse/incident backstop, not a metering primitive — it should never be
 * reached by a worker having a normal day.
 */
export const EXTRACTION_ATTEMPT_CAP = 6;

/**
 * Minimal typed view of the Redis commands the attempt cap needs. BullMQ's
 * `IRedisClient` declares only the subset BullMQ itself uses (no INCRBY/EXPIRE),
 * but the runtime client is ioredis, which has them. Narrowed to an interface
 * rather than `any` so the call sites stay type-checked — the same shape
 * `SubjectRateLimit` and `ChatTranscriptBuffer` already use.
 */
interface RedisCounter {
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** UTC hour stamp `YYYYMMDDHH` — the attempt cap's key namespace. */
function utcHourStamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  return `${y}${m}${d}${h}`;
}

/** Seconds remaining until the end of the current UTC hour (+1 to round up). */
function secondsUntilEndOfUtcHour(now: Date = new Date()): number {
  const endOfHour = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((endOfHour - now.getTime()) / 1000));
}

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly workers: WorkersRepository,
    // Issue #435 — resolves the body-supplied session so extract() can verify the
    // caller OWNS it. ProfilesModule already imports ChatModule (forwardRef) for this
    // very repository (the processor reads transcripts through it), so this introduces
    // no new module edge and no new cycle.
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
    @InjectQueue(PROFILE_EXTRACTION_QUEUE)
    private readonly extractionQueue: Queue<ProfileExtractionJobData>,
    @InjectQueue(RESUME_GENERATE_QUEUE)
    private readonly resumeGenerateQueue: Queue<ResumeGenerateJobData>,
    // §X.6 — leg 1 of the activation-bonus rule completes here. Injected as a QUEUE, not as
    // ReferralBonusService, so this module gains no dependency on `referrals`.
    @InjectQueue(REFERRAL_BONUS_QUEUE)
    private readonly referralBonusQueue: Queue<ReferralBonusJobData>,
  ) {}

  /**
   * Enqueue an async profile-extraction job (BullMQ/Redis). Returns immediately
   * with the ai_job_id; the client polls `GET /ai-jobs/:id` until completed,
   * then reads `output_ref.profile_id`. The work itself runs in
   * ProfileExtractionProcessor (which emits extraction_completed/failed).
   *
   * Session-scoped idempotency (issue #420): two independent triggers fire for
   * the same interview — the server auto-trigger in ChatService on the
   * `extraction_ready` flip, and the worker app's unconditional
   * `POST /profile/extract` on the profile-preview screen. Without a guard that
   * is 2 ai_jobs + up to 2 worker_profiles per normal completion.
   *
   * A prior job for the same (worker, session) suppresses a new one ONLY when it
   * is genuinely redundant. Every other case must still create, because being
   * wrong in that direction leaves a worker with no profile at all — strictly
   * worse than the double spend this guards:
   *  - `failed` → never dedupes; retry stays possible.
   *  - stale `queued`/`running` (older than EXTRACTION_IN_FLIGHT_WINDOW_MS) →
   *    never dedupes; treated as a zombie, since nothing reaps stuck ai_jobs.
   *  - `completed` but with an EMPTY profile (the AI-down fallback persists one
   *    with status "extracted") → never dedupes; see `hasExtractedContent`.
   *  - a worker with NO chat session at all → create-always. There is genuinely
   *    no session to scope to (the voice-form path), so this degrades to exactly
   *    the pre-#828 behaviour.
   */
  async extract(input: ExtractProfileInput, ctx: RequestContext) {
    const worker = await this.workers.findById(input.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${input.worker_id} not found`);

    const suppliedSessionId = input.session_id ?? null;
    if (suppliedSessionId) {
      // OWNERSHIP (issue #435). `session_id` arrives from the REQUEST BODY, so without
      // this a worker could pass someone else's session id: the job is created with
      // `input_ref = { worker_id: caller, session_id: victim's }`, and
      // ProfileExtractionProcessor.buildTranscript then reads the VICTIM's chat
      // transcript and extracts it into the CALLER's worker_profiles row. Their trade,
      // machines, experience, salary and location become the caller's profile, and
      // because both the job and the profile are attributable to the caller nothing
      // downstream flags it.
      //
      // 404 (not 403), matching ChatService.postMessage exactly, so a session id is
      // never an existence oracle for another worker's session — a miss and a
      // not-owned are byte-identical.
      //
      // Checked BEFORE the dedupe lookup below so a foreign id cannot be probed
      // through dedupe behaviour either.
      const session = await this.chat.findSession(suppliedSessionId);
      if (!session || session.workerId !== input.worker_id) {
        throw new NotFoundException(`Session ${suppliedSessionId} not found`);
      }
    }

    // ── #828: A BODY WITH NO SESSION IS NOT A REQUEST FOR A SESSION-LESS EXTRACTION ──
    //
    // It was treated as one, and that produced blank résumés in production. The chain,
    // start to finish:
    //
    //   1. the worker's last chat turn flushes the transcript, and the flush ends with
    //      `ChatService.autoTriggerExtraction` → a job scoped to that session (job A);
    //   2. the SAME response carries `session_ended: true`, and the app answers it by
    //      calling `clearChatSession()` (chat_repository_impl.dart) — by design, so the
    //      next visit to chat opens a fresh thread rather than posting into a dead one;
    //   3. the app then opens the profile-preview screen, which unconditionally calls
    //      `POST /profile/extract` — and the session id it would have sent is now gone,
    //      so the body carries none (job B);
    //   4. `session_id: null` reached `ProfileExtractionProcessor.buildMessages`, whose
    //      FIRST line is `if (!sessionId) return []`. Job B therefore extracted
    //      "(no conversation captured)" and persisted a fully-null `draft` profile —
    //      NEWER than job A's real one;
    //   5. the app polls ITS OWN job (`awaitProfileId`) and confirms the id job B
    //      reported, so the empty profile is what the résumé is rendered from.
    //
    // A session-less extraction is STRUCTURALLY INCAPABLE of producing content — step 4
    // is not a degraded path, it is the only path — so honouring the omission could
    // never do anything but overwrite a good profile with an empty one. Resolving the
    // worker's own latest session is what makes the call mean what the app intends:
    // "extract the interview this worker just finished".
    //
    // SAFE BY CONSTRUCTION, and strictly safer than the body id above: this is queried
    // BY the authenticated worker, so it cannot name another worker's session and needs
    // no ownership check. `findLatestSessionByWorker` orders by `last_message_at DESC
    // NULLS LAST`, so it picks the session the worker actually conversed in and parks
    // the empties — the same session job A was scoped to.
    //
    // A worker with no chat session at all still resolves to null and still takes the
    // create-always path, so the voice-form route is untouched.
    const sessionId = suppliedSessionId ?? (await this.resolveLatestSession(input.worker_id));
    if (sessionId) {
      if (!suppliedSessionId) {
        this.logger.log(
          `extract resolved session=${sessionId} worker=${input.worker_id} from the worker's ` +
            `latest chat session (the request carried none)`,
        );
      }

      const existing = await this.aiJobs.findExtractionDedupeCandidate({
        sessionId,
        workerId: input.worker_id,
        inFlightSince: new Date(Date.now() - EXTRACTION_IN_FLIGHT_WINDOW_MS),
      });
      // A completed job only counts if it actually produced something. An empty
      // profile from the AI-down fallback must NOT pin the session forever.
      const usable =
        existing !== undefined &&
        (existing.status !== "completed" || hasExtractedContent(existing.profile));

      if (existing && usable) {
        // No second `profile.extraction_requested`: one event per extraction
        // actually requested of the AI, otherwise the event spine over-reports
        // spend. The skip itself is logged (opaque UUIDs only, no PII).
        this.logger.log(
          `extract deduped session=${sessionId} worker=${input.worker_id} ` +
            `existing_ai_job=${existing.id} status=${existing.status}`,
        );
        return { ai_job_id: existing.id, status: existing.status };
      }
      if (existing) {
        this.logger.log(
          `extract re-running session=${sessionId} worker=${input.worker_id}: prior ai_job ` +
            `${existing.id} completed with an empty profile`,
        );
      }

      // THE BACKSTOP ON RE-RUNNING. Every guard above asks "is a prior job usable?", and
      // during an LLM outage the honest answer is no every single time — which is correct
      // (the profile really is a placeholder) and is precisely why the loop ran: four
      // triggers, each minting a fresh job, each getting a fresh empty profile.
      //
      // Session-scoped and hourly, so it bounds the incident without touching the normal
      // case: a healthy interview mints one job, and the self-heal that #420 deliberately
      // left open still works — it just cannot run unboundedly.
      //
      // AFTER the dedupe checks, so a request that would have been DEDUPED (the common,
      // healthy double-trigger) never spends cap. Only a request about to create real work
      // is charged.
      if (!(await this.withinAttemptCap(input.worker_id, sessionId))) {
        this.logger.warn(
          `extract capped session=${sessionId} worker=${input.worker_id}: ` +
            `${EXTRACTION_ATTEMPT_CAP} extraction jobs already created this hour; ` +
            `refusing to mint another (the model leg is almost certainly still degraded)`,
        );
        throw new ServiceUnavailableException(
          "Profile generation is temporarily unavailable; please try again later",
        );
      }
    }

    // `sessionId`, NOT `input.session_id`, from here down — the RESOLVED session is the
    // one this job will actually read, so it is the one `input_ref`, the event payload
    // and the queue payload must all name. Recording the body's null instead would make
    // the audit trail describe a different job than the one that ran, and would hand the
    // processor the very null that makes extraction impossible.
    const job = await this.aiJobs.create({
      jobType: "profile_extraction",
      status: "queued",
      inputRef: { worker_id: input.worker_id, session_id: sessionId },
    });

    await this.events.emit({
      event_name: "profile.extraction_requested",
      actor: { actor_type: "worker", actor_id: input.worker_id },
      subject: { subject_type: "ai_job", subject_id: job.id },
      payload: {
        worker_id: input.worker_id,
        session_id: sessionId,
        ai_job_id: job.id,
      },
      idempotencyKey: `profile.extraction_requested:${job.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // If enqueue fails (e.g. Redis down), give the job a terminal state so it is
    // not orphaned in "queued" and the requested event is balanced by a failed.
    try {
      await this.extractionQueue.add(
        "extract",
        {
          workerId: input.worker_id,
          sessionId,
          aiJobId: job.id,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        },
        // Per-job, NOT queue-wide: the queue's 1s exponential backoff is right for the
        // database blips every other queue suffers and useless against a rate limit,
        // which does not clear in 1s. See `EXTRACTION_JOB_OPTS`.
        EXTRACTION_JOB_OPTS,
      );
    } catch (err) {
      const reason = `enqueue failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`;
      await this.aiJobs.markFailed(job.id, reason);
      await this.events.emit({
        event_name: "profile.extraction_failed",
        actor: { actor_type: "system" },
        subject: { subject_type: "ai_job", subject_id: job.id },
        payload: {
          worker_id: input.worker_id,
          session_id: sessionId,
          ai_job_id: job.id,
          reason,
        },
        // One terminal failure per job. Shares the key namespace with the
        // processor's terminal-failure emit: a job fails EITHER at enqueue here OR
        // in the processor, never both, so at most one row is ever written.
        idempotencyKey: `profile.extraction_failed:${job.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      throw new ServiceUnavailableException("Could not enqueue extraction job; please retry");
    }

    return { ai_job_id: job.id, status: "queued" as const };
  }

  /**
   * The worker's own latest chat session, or null when they have never started one.
   *
   * The ONLY caller is the `session_id`-less branch of {@link extract}, and it exists so
   * that branch scopes to a real interview instead of extracting nothing — see the long
   * note there for why a session-less extraction cannot produce content.
   *
   * NO OWNERSHIP CHECK, deliberately, and that is not an omission: the session is looked
   * up BY `workerId`, so ownership is a property of the query rather than something to
   * verify afterwards. The body-supplied path keeps its 404 check precisely because it
   * has no such guarantee.
   *
   * NOT WRAPPED IN A try/catch. If this read fails the database is unreachable, and the
   * very next statement (`aiJobs.create`) would fail too — swallowing it here would only
   * convert a clean 500 into a job that is guaranteed to extract nothing.
   */
  private async resolveLatestSession(workerId: string): Promise<string | null> {
    const session = await this.chat.findLatestSessionByWorker(workerId);
    return session?.id ?? null;
  }

  /**
   * THE FOURTH TRIGGER: rebuild the profile because a settled answer CHANGED (#700).
   *
   * Owner ruling 2026-08-08. The other three fire on the same fact — "this session finished" — and
   * are guarded against each other by session-scoped dedupe. That guarding is what closed #420,
   * where two triggers fired on UNCHANGED data and double-spent. This one is the opposite case: it
   * must fire precisely because the data is no longer what was built.
   *
   * SO IT IS KEYED ON THE DATA, NOT THE SESSION, and that is structural rather than stylistic.
   * `answer_set_hash` fingerprints the answer map itself, so:
   *
   *   - a rebuild for an answer set that was already built is the SAME key → deduped, no spend;
   *   - a rebuild for a CHANGED answer set is a different key, and there is no way to express it
   *     as a re-fire on unchanged data — which is what #420's race was.
   *
   * The two can therefore never collide, because the key space says so and not because the two
   * call sites happen to stay apart.
   *
   * IT DELIBERATELY DOES NOT CALL `findExtractionDedupeCandidate`. That guard asks "has this
   * session been extracted?" and after a correction the answer is yes — which is the reason a
   * rebuild is needed, not a reason to skip it.
   *
   * THE NEW ROW SUPERSEDES THE OLD THROUGH `CURRENT_PROFILE_ORDER` and nothing else. That order
   * (non-draft first, then `created_at desc`, then `id desc`) is the one definition of "which row
   * is the profile", established by #678 after seven readers each answered it differently. A
   * fresh extraction writes a newer non-draft row through the same `ProfilesRepository.create`, so
   * it wins by the existing rule. No second definition, no update-in-place, no delete.
   *
   * NEVER THROWS. A correction is already durable in both stores by the time this runs; failing
   * the worker's HTTP call because a rebuild could not be QUEUED would report the correction as
   * lost when it is not. Loud in the log, invisible to them — the same posture as
   * `autoTriggerExtraction`.
   */
  async rebuildAfterCorrection(
    input: { worker_id: string; session_id: string; answer_set_hash: string },
    ctx: RequestContext,
  ): Promise<{ ai_job_id: string; status: string } | null> {
    try {
      const already = await this.aiJobs.findCorrectionRebuildJob({
        sessionId: input.session_id,
        workerId: input.worker_id,
        answerSetHash: input.answer_set_hash,
      });
      if (already) {
        this.logger.log(
          `correction rebuild deduped session=${input.session_id} ` +
            `hash=${input.answer_set_hash.slice(0, 12)} existing_ai_job=${already.id}`,
        );
        return { ai_job_id: already.id, status: already.status };
      }

      const job = await this.aiJobs.create({
        jobType: "profile_extraction",
        status: "queued",
        // `answer_set_hash` is what makes this row findable by the dedupe above, and what makes
        // the trigger distinguishable from the ordinary three in the audit trail.
        inputRef: {
          worker_id: input.worker_id,
          session_id: input.session_id,
          answer_set_hash: input.answer_set_hash,
          trigger: "correction",
        },
      });

      await this.events.emit({
        event_name: "profile.extraction_requested",
        actor: { actor_type: "worker", actor_id: input.worker_id },
        subject: { subject_type: "ai_job", subject_id: job.id },
        payload: {
          worker_id: input.worker_id,
          session_id: input.session_id,
          ai_job_id: job.id,
        },
        idempotencyKey: `profile.extraction_requested:${job.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });

      await this.extractionQueue.add(
        "extract",
        {
          workerId: input.worker_id,
          sessionId: input.session_id,
          aiJobId: job.id,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        },
        // The SAME retry policy as `extract`. A correction rebuild runs the identical
        // processor against the identical provider, so it suffers the identical rate
        // limit; giving the two paths different backoffs would mean one of them is wrong.
        EXTRACTION_JOB_OPTS,
      );

      this.logger.log(
        `correction rebuild queued session=${input.session_id} ` +
          `hash=${input.answer_set_hash.slice(0, 12)} ai_job=${job.id}`,
      );
      return { ai_job_id: job.id, status: "queued" };
    } catch (err) {
      this.logger.error(
        `correction rebuild could not be queued session=${input.session_id}; the CORRECTION is ` +
          `durable and the built profile is now stale: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Charge one unit against this (worker, session)'s hourly extraction budget.
   * `false` means the cap is spent and no new job should be created.
   *
   * FIXED UTC HOUR BUCKET, not a sliding window — the same trade `SubjectRateLimit`
   * documents and for the same reason: one INCRBY per call, and a true sliding window
   * needs a sorted set per subject. A caller can therefore spend the full cap at :59 and
   * the full cap again at :00. Acceptable for an incident backstop.
   *
   * OPAQUE UUIDs, NOT HASHED. `IpRateLimit` HMACs its input because an IP is PII; a
   * worker id and a session id are internal uuids that appear in this service's logs
   * already, so hashing would buy nothing and make the key unreadable in an incident —
   * the split `SubjectRateLimit` states explicitly.
   *
   * FAILS OPEN, and this is the deliberate opposite of `SubjectRateLimit`. That one
   * guards writes into the audit spine, where an uncapped path during an incident is the
   * worse outcome. This one guards a worker getting a profile at all: if Redis is
   * unreachable we cannot know the count, and refusing would deny extraction to every
   * worker on the platform over a cache outage. Erring toward "let it through" is the
   * direction this file already documents — "being wrong in that direction leaves a
   * worker with no profile at all — strictly worse than the double spend this guards" —
   * and the provider cooldown in the ai-service still keeps a degraded attempt cheap.
   */
  private async withinAttemptCap(workerId: string, sessionId: string): Promise<boolean> {
    const hour = utcHourStamp();
    const key = `extract_cap:${workerId}:${sessionId}:${hour}`;
    try {
      const redis = (await this.extractionQueue.client) as unknown as RedisCounter;
      const count = await redis.incrby(key, 1);
      // Re-assert the TTL on EVERY hit, not only the first. A `if (count === 1)` guard
      // leaves a TTL-less key whenever the process dies between INCRBY and EXPIRE — and
      // because the key is hour-stamped that does not cap the worker forever (the next
      // hour is a different key); it leaks a key that never expires, one per session per
      // affected hour, in the Redis that also runs BullMQ. EXPIRE is idempotent and cheap.
      await redis.expire(key, secondsUntilEndOfUtcHour());
      return count <= EXTRACTION_ATTEMPT_CAP;
    } catch (err) {
      this.logger.warn(
        `extraction attempt cap unavailable session=${sessionId}; allowing the job ` +
          `(fail-open: an unprofiled worker is worse than a double spend) — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  async confirm(input: ConfirmProfileInput, ctx: RequestContext) {
    const profile = await this.profiles.findById(input.profile_id);
    // Ownership: a worker may only confirm their OWN profile. 404 for both
    // not-found and not-owner (no existence oracle for another worker's profile).
    if (!profile || profile.workerId !== input.worker_id) {
      throw new NotFoundException(`Profile ${input.profile_id} not found`);
    }

    const confirmedAt = new Date();
    await this.profiles.confirm(input.profile_id, confirmedAt);

    await this.events.emit({
      event_name: "profile.confirmed",
      actor: { actor_type: "worker", actor_id: input.worker_id },
      subject: { subject_type: "profile", subject_id: input.profile_id },
      payload: {
        worker_id: input.worker_id,
        profile_id: input.profile_id,
        confirmed_at: confirmedAt.toISOString(),
      },
      idempotencyKey: `profile.confirmed:${input.profile_id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Kick off async resume generation (refs only, no PII). A queue failure must
    // NEVER break confirmation — the worker can still trigger generation manually
    // via POST /resume/generate. Log a warning and move on.
    try {
      await this.resumeGenerateQueue.add("generate", {
        workerId: input.worker_id,
        profileId: input.profile_id,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume generation for profile ${input.profile_id} (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    // §X.6 — a confirmed profile is LEG 1 of the ₹20 activation-bonus rule. Enqueue an
    // evaluation; the processor re-checks BOTH legs (the worker also needs a granted
    // unlock), so this is usually a no-op and never accrues on its own. Same posture as
    // the resume enqueue above: off the request path, and a queue failure is logged and
    // swallowed — a missed accrual is recoverable (the rule is idempotent and the ops
    // re-evaluate endpoint exists), a broken confirmation is not.
    try {
      await this.referralBonusQueue.add("evaluate", {
        invitedWorkerId: input.worker_id,
        trigger: "profile_confirmed",
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue referral-bonus evaluation (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    // TD64 — emit interview_kit.ready_for_worker when the worker's confirmed trade
    // has a renderable kit. Guarded: if canonicalTradeId is null (edge case, not
    // expected after extraction) the event is silently skipped — the kit is still
    // accessible from the interview-kit screen without the notification.
    const tradeKey = profile.canonicalTradeId;
    if (tradeKey) {
      const contentVersion = 1; // matches INTERVIEW_KIT_CONTENT_VERSION default
      const kitId = `${tradeKey}:v${contentVersion}`;
      await this.events.emit({
        event_name: "interview_kit.ready_for_worker",
        actor: { actor_type: "system" },
        subject: { subject_type: "worker", subject_id: input.worker_id },
        payload: {
          worker_id: input.worker_id,
          trade_key: tradeKey,
          content_version: contentVersion,
          kit_id: kitId,
        },
        idempotencyKey: `interview_kit.ready_for_worker:${input.worker_id}:${tradeKey}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    return {
      profile_id: input.profile_id,
      profile_status: "confirmed",
      confirmed_at: confirmedAt.toISOString(),
    };
  }
}
