import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { templateIdForPack } from "./resume-document";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { GeneratedResume } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { AiService } from "../ai/ai.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../ai/ai-trace-recorder.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { StorageService } from "../storage/storage.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { ResumeRepository } from "./resume.repository";
import { ResumeRateLimit } from "./resume-rate-limit.service";
import type { GenerateResumeInput, ShareResumeDto } from "./resume.dto";

@Injectable()
export class ResumeService {
  private readonly logger = new Logger(ResumeService.name);

  /**
   * THE WORKER'S OWN RESUME, AS STRUCTURED DATA — what the app draws its resume screen from.
   *
   * `document: null` IS A REAL AND ORDINARY ANSWER, not an error. Every row rendered before
   * the column shipped has none, and so does every row still pending its first render. The
   * client falls back to `resume_text` on null; treating it as an empty resume would blank a
   * screen that has perfectly good content behind it.
   *
   * NO OWNERSHIP CHECK BEYOND THE TOKEN, because there is no id in the request: the worker is
   * taken from the bearer token and the query is scoped to them. There is nothing to
   * enumerate, which is the strongest form of the ownership guarantee rather than a missing
   * one.
   */
  async myDocument(
    workerId: string,
  ): Promise<{ resume_id: string; version: number; document: unknown | null }> {
    const latest = await this.workers.latestResume(workerId);
    if (!latest) throw new NotFoundException("no resume yet");
    return {
      resume_id: latest.id,
      version: latest.version,
      document: latest.resumeDocument ?? null,
    };
  }

  constructor(
    private readonly resumes: ResumeRepository,
    private readonly profiles: ProfilesRepository,
    private readonly workers: WorkersRepository,
    // WHICH ROLE PACK ANSWERED THIS WORKER'S TRADE QUESTIONS — the one fact that decides which
    // layout their resume renders through. Already exported by ProfilesModule and already used
    // by the render worker for the capability rows; read here so the row RECORDS the template
    // it will actually be drawn with, rather than claiming one and rendering another.
    private readonly attributes: WorkerAttributesRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
    private readonly aiCost: AiCostRecorder,
    // 0083 — the prompt/completion sibling of `aiCost`. See the call site in `generate`.
    private readonly aiTraces: AiTraceRecorder,
    private readonly pii: PiiCryptoService,
    private readonly rateLimit: ResumeRateLimit,
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @InjectQueue(RESUME_RENDER_QUEUE)
    private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async generate(
    dto: GenerateResumeInput,
    ctx: RequestContext,
    opts: { systemInitiated?: boolean; forceNewVersion?: boolean } = {},
  ) {
    // Enforce the daily cap BEFORE any paid AI/render work; fails closed (429) if
    // Redis is down. The system-initiated auto-generate (on profile.confirmed) is
    // one-per-worker + idempotent, so it skips the per-worker abuse cap but still
    // counts against the GLOBAL spend backstop.
    await this.rateLimit.assertWithinDailyCap(dto.worker_id, {
      perWorker: !opts.systemInitiated,
    });

    const profile = await this.profiles.findById(dto.profile_id);
    // OWNERSHIP gate (TD70 item 5): with `worker_id` session-derived in the
    // controller this is the real authz check, not a consistency check —
    // not-found and not-owner are indistinguishable (404, no existence oracle),
    // aligned with download(). The queue processor passes its own job's ids.
    if (!profile || profile.workerId !== dto.worker_id) {
      throw new NotFoundException(`Profile ${dto.profile_id} not found`);
    }

    // Only a CONFIRMED profile may generate a resume (worker-reviewed content →
    // AI spend + TD21 name injection). No oracle needed here: the caller already
    // owns the profile after the check above. The system-initiated path
    // (resume-generate.processor, enqueued ON profile.confirmed) is by definition
    // post-confirm, so it skips the re-read — no ordering hazard if the status
    // write and the queued job ever race.
    if (!opts.systemInitiated && profile.profileStatus !== "confirmed") {
      throw new BadRequestException("profile is not confirmed");
    }

    // The stored rawProfile is the structured DraftProfile; re-validate its shape.
    const draft = DraftProfileSchema.parse(profile.rawProfile);

    // The AI service receives ONLY the structured profile (no name/phone).
    const result = await this.ai.generateResume({ profile: draft }, ctx);

    // THE COST RECORD, EMITTED BEFORE ANY OF THE WRITES BELOW (#745) — the same ordering
    // #738 chose for STT, for the same reason: the rupees are already spent by this line, so
    // a failure in the name decrypt, the row insert, or the render enqueue must not be able
    // to lose the record of them. `record` never throws and no-ops on null metadata (the
    // pseudonymize-blocked and service-unreachable paths), so this cannot turn a résumé into
    // a failure and cannot invent spend that did not happen.
    //
    // `aiJobId` is null BY CONSTRUCTION: résumé generation runs inline here, and the BullMQ
    // path (`ResumeGenerateProcessor`) is a queue job with no `ai_jobs` row either. The
    // subject the spend belongs to is on the payload's `ai_call_id`, not a job row.
    //
    // ATTRIBUTED TO THE WORKER, WITH NO SESSION. `dto.worker_id` is the ownership-checked id
    // this method already gated on above (the controller derives it from the session; the
    // queue processor passes its own job's), so this is the same authority the write uses —
    // not a second, weaker one. There is deliberately no `sessionId`: a résumé is generated
    // from a CONFIRMED PROFILE, which may be days and several interviews later, so naming one
    // interview as the buyer of this call would be a guess dressed as a fact.
    await this.aiCost.record(
      result.ai_metadata ?? null,
      "resume_generation",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId: dto.worker_id },
    );

    // AND THE TRACE (0083). "The résumé came out wrong" is unanswerable without the structured
    // profile that went in and the copy that came back, and neither has ever been stored: the
    // generated PDF is the artefact, not the model's output.
    //
    // NO SESSION, for exactly the reason the cost record above gives: a résumé is generated from
    // a CONFIRMED PROFILE, possibly days and several interviews later, so naming one interview
    // would be a guess dressed as a fact. The worker id is the same ownership-checked one the
    // write uses.
    //
    // ⚠ THE PROMPT HERE CARRIES NO NAME, ON TWO INDEPENDENT COUNTS. TD21 injects the worker's
    // real name AFTER this call (see below), precisely so it never reaches the LLM — so the
    // ai-service only ever rendered a name-free payload — and the text this row stores is the
    // ai-service's own masked copy of that prompt, not anything assembled on this side. Both
    // properties are load-bearing; the TD21 ordering must not be moved.
    await this.aiTraces.capture(
      result.ai_metadata ?? null,
      "resume_generation",
      null,
      ctx.correlationId,
      { workerId: dto.worker_id },
    );

    // TD21: put the worker's real name on the resume — decrypted SERVER-SIDE and
    // injected AFTER the AI call, so the name never reaches the LLM (the AI service
    // only ever saw the structured profile above). The name is absent if not set yet.
    const worker = await this.workers.findById(dto.worker_id);
    let fullName: string | null = null;
    if (worker?.fullName) {
      try {
        fullName = this.pii.decrypt(worker.fullName);
      } catch {
        // A malformed / rotated-key / tampered token must NOT 500 resume generation
        // (e.g. after a key rotation it would break every existing worker at once).
        // Degrade to a name-less resume — same as no name set. Never log the token/error.
        this.logger.warn(
          `could not decrypt full_name for worker ${dto.worker_id}; generating a name-less resume`,
        );
      }
    }
    const resumeText = fullName ? `${fullName}\n${result.resume_text}` : result.resume_text;
    const resumeJson = fullName ? { ...result.resume_json, name: fullName } : result.resume_json;

    // Resolve the target row. The INITIAL resume (version 1) is idempotent + race-safe
    // via createInitial (partial unique index `generated_resumes_initial_uq`): the
    // auto-generate on profile.confirmed and a manual POST /resume/generate converge on
    // ONE row, even though the worker's name can be recorded AFTER confirm. An explicit
    // regenerate (forceNewVersion) creates the next version instead.
    // THE LAYOUT, CHOSEN FROM THE WORKER'S TRADE.
    //
    // `bb_trade` has been shipped, tested and immutable for sixteen packets and NOTHING HAS
    // EVER SELECTED IT: both branches below hardcoded "classic", so the trade sheet — the
    // zoned one-page layout the whole role-pack track exists to fill — has been dark code.
    //
    // GATED ON THE PACK HAVING A RESUME MAP, which is the same condition the capability rows
    // already use, so a worker whose trade has no map keeps `classic` and renders
    // byte-identically to yesterday. Workers flip over one at a time as their trade is
    // authored — no cutover, no backfill — exactly how the work-history reader was staged.
    //
    // DEGRADES TO `classic`, NEVER TO A FAILED GENERATE. A trade lookup that throws must not
    // cost a worker their resume; the wrong-but-working layout is the correct failure here.
    let templateId = "classic";
    try {
      const { packId } = await this.attributes.loadTradeSheet(dto.worker_id);
      templateId = templateIdForPack(packId);
    } catch (err) {
      this.logger.warn(
        `could not resolve the trade layout for worker ${dto.worker_id}; using classic ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }

    let saved: GeneratedResume;
    let previousVersion: number | null = null;
    if (opts.forceNewVersion) {
      const previous = await this.workers.latestResume(dto.worker_id);
      previousVersion = previous?.version ?? null;
      saved = await this.resumes.create({
        workerId: dto.worker_id,
        profileId: dto.profile_id,
        resumeJson,
        resumeText,
        version: (previous?.version ?? 0) + 1,
        templateId,
        // NAME-FREE structured draft, so a future renderer can re-render from the
        // snapshot. The name lives only in resume_json/resume_text (TD21), never here.
        sourceProfileSnapshot: draft,
      });
    } else {
      // Manual generate is authoritative (overwrite content — e.g. a name added after
      // the auto-generate ran); the system auto-generate only fills if absent, so it
      // never clobbers a manual resume.
      saved = await this.resumes.createInitial(
        {
          workerId: dto.worker_id,
          profileId: dto.profile_id,
          resumeJson,
          resumeText,
          version: 1,
          templateId,
          sourceProfileSnapshot: draft,
        },
        { overwrite: !opts.systemInitiated },
      );
    }

    // A first/initial resume emits `resume.generated`; a regenerate (version > 1) emits
    // `resume.regenerated`. Both payloads are IDs + enums; idempotencyKey dedupes re-emits.
    if (saved.version > 1) {
      await this.events.emit({
        event_name: "resume.regenerated",
        actor: { actor_type: "system" },
        subject: { subject_type: "resume", subject_id: saved.id },
        payload: {
          worker_id: dto.worker_id,
          profile_id: dto.profile_id,
          resume_id: saved.id,
          version: saved.version,
          previous_version: previousVersion,
          format: result.format,
        },
        idempotencyKey: `resume.regenerated:${saved.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } else {
      await this.events.emit({
        event_name: "resume.generated",
        actor: { actor_type: "system" },
        subject: { subject_type: "resume", subject_id: saved.id },
        payload: {
          worker_id: dto.worker_id,
          profile_id: dto.profile_id,
          resume_id: saved.id,
          version: saved.version,
          format: result.format,
        },
        idempotencyKey: `resume.generated:${saved.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    await this.enqueueRender(saved.id, dto.worker_id, ctx);

    return {
      resume_id: saved.id,
      version: saved.version,
      format: result.format,
      is_mock: result.is_mock,
      resume_text: saved.resumeText,
    };
  }

  /**
   * Enqueue the async PDF render (refs only, no PII). A queue failure must not
   * fail generation — log a warning and leave render_status 'pending' (a later
   * regenerate/retry can re-enqueue).
   */
  private async enqueueRender(
    resumeId: string,
    workerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      await this.renderQueue.add("render", {
        resumeId,
        workerId,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume render for ${resumeId}; leaving render_status pending (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  /** Ops read view of a single resume (404 if missing). The body carries the
   * worker's OWN name by design (TD21); the phone never appears. */
  async getById(resumeId: string) {
    const resume = await this.resumes.findById(resumeId);
    if (!resume) throw new NotFoundException(`Resume ${resumeId} not found`);
    return {
      resume_id: resume.id,
      worker_id: resume.workerId,
      profile_id: resume.profileId,
      version: resume.version,
      resume_text: resume.resumeText,
      resume_json: resume.resumeJson,
      render_status: resume.renderStatus,
      generated_at: resume.generatedAt,
    };
  }

  /** Re-run generation for an existing resume (bumps the version). 404 if missing. */
  async regenerate(resumeId: string, ctx: RequestContext) {
    const existing = await this.resumes.findById(resumeId);
    if (!existing) throw new NotFoundException(`Resume ${resumeId} not found`);
    return this.generate({ worker_id: existing.workerId, profile_id: existing.profileId }, ctx, {
      forceNewVersion: true,
    });
  }

  /**
   * Mint a short-lived signed download URL for a rendered resume PDF and emit
   * `resume.downloaded`. Worker-authenticated + ownership-checked: both not-found
   * AND not-owner return 404 (no existence oracle). 409 while still rendering /
   * if it failed. The signed URL is NOT logged or emitted (it embeds a token).
   */
  async download(
    workerId: string,
    resumeId: string,
    ctx: RequestContext,
  ): Promise<{ url: string; expires_in: number }> {
    const resume = await this.resumes.findById(resumeId);
    if (!resume || resume.workerId !== workerId) {
      throw new NotFoundException(`Resume ${resumeId} not found`);
    }

    if (resume.renderStatus !== "rendered" || !resume.pdfStorageKey) {
      if (resume.renderStatus === "pending") {
        throw new ConflictException("Resume PDF is still being rendered; please retry shortly");
      }
      throw new ConflictException("Resume PDF is not available for download");
    }

    const ttl = this.config.RESUME_SIGNED_URL_TTL_SECONDS;
    const url = await this.storage.createSignedUrl(resume.pdfStorageKey, ttl);

    await this.events.emit({
      event_name: "resume.downloaded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "resume", subject_id: resume.id },
      payload: {
        worker_id: workerId,
        resume_id: resume.id,
        version: resume.version,
        format: "pdf",
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { url, expires_in: ttl };
  }

  /**
   * Record that a worker shared a resume. `channel` is a closed enum, so no link
   * or PII enters the `resume.shared` event.
   *
   * OWNERSHIP CHECKED, AND 404 FOR BOTH CASES (R16 §5.1). This took only a resume id and
   * attributed the event to whatever row it found — safe while the route was internal-only and
   * a forgery hole the moment it took a worker session, because the actor and the payload's
   * `worker_id` are both read off the looked-up row. Not-found and not-owner return the SAME
   * 404, exactly as `download` does: distinguishing them is an existence oracle over other
   * workers' resume ids.
   */
  async recordShare(workerId: string, resumeId: string, dto: ShareResumeDto, ctx: RequestContext) {
    const resume = await this.resumes.findById(resumeId);
    if (!resume || resume.workerId !== workerId) {
      throw new NotFoundException(`Resume ${resumeId} not found`);
    }

    await this.events.emit({
      event_name: "resume.shared",
      actor: { actor_type: "worker", actor_id: resume.workerId },
      subject: { subject_type: "resume", subject_id: resume.id },
      payload: {
        worker_id: resume.workerId,
        resume_id: resume.id,
        version: resume.version,
        channel: dto.channel,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true };
  }
}
