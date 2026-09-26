import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { TradeFormRepository } from "../profiling/form/trade-form.repository";
import { overlayFreshCapabilityLines } from "./resume-draft-overlay";
import { readResumeGlance, templateIdForPack } from "./resume-document";
import { resumeRefCode } from "./resume-sheet-footer";
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
import type { GeneratedResume, NewGeneratedResume } from "@badabhai/db";
import type { ResumeGenerationTrigger } from "@badabhai/types";
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
import { pendingUpdateFrom } from "./resume-pending-update";
import { resolveResumeSource } from "./resume-source";
import type {
  GenerateResumeInput,
  MyResumeDocumentResponse,
  ResumeHistoryResponse,
  ShareResumeDto,
  SystemResumeTrigger,
} from "./resume.dto";

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
   * WHICH IS PRECISELY WHY THE ENVELOPE CARRIES `render_status` AND `rendered_at` (#1397). The
   * two nulls above are indistinguishable to a reader — "the render job has not landed yet,
   * ask again" and "there is nothing here and never will be" arrived as the same byte — so the
   * app answered with a blind 6×2s retry that both under-waits a slow render and over-waits a
   * legacy row. Both fields are read off the row already loaded here; see
   * {@link MyResumeDocumentResponse} for what each value actually promises, and for why
   * `render_status` alone would still leave the forced-re-render path guessing.
   *
   * NOTHING NEW IS EXPOSED. `render_status` already ships to this same worker, under the same
   * guards and the same `no-store`, on `GET /workers/me/profile`; `rendered_at` is a server
   * timestamp for the worker's own row. No PII, no storage key, no event — this is a read.
   *
   * NO OWNERSHIP CHECK BEYOND THE TOKEN, because there is no id in the request: the worker is
   * taken from the bearer token and the query is scoped to them. There is nothing to
   * enumerate, which is the strongest form of the ownership guarantee rather than a missing
   * one.
   */
  async myDocument(workerId: string): Promise<MyResumeDocumentResponse> {
    const latest = await this.workers.latestResume(workerId);
    if (!latest) throw new NotFoundException("no resume yet");
    return {
      resume_id: latest.id,
      version: latest.version,
      document: latest.resumeDocument ?? null,
      render_status: latest.renderStatus,
      // `renderedAt` is a Drizzle `timestamp with timezone`, i.e. a Date. Serialized HERE, so
      // the declared contract is what the client actually receives, and so a client comparing
      // "the value I held before my write" against this one is comparing two strings produced
      // the same way rather than trusting the JSON layer to be stable.
      rendered_at: latest.renderedAt ? latest.renderedAt.toISOString() : null,
    };
  }

  /**
   * THE WORKER'S RÉSUMÉ HISTORY — the newest `RESUME_HISTORY_VISIBLE_LIMIT` résumés, each with the
   * flow it was made from, plus the state of an update they accepted in chat (ADR-0043).
   *
   * KEEP ALL, SHOW THREE (ruling R4). The window is a display rule: older rows stay on file and
   * stay downloadable by id through the existing `GET /resume/:id/download`, which already checks
   * ownership per id. `is_current` marks the one every other résumé read treats as current, by
   * the same shared order, so the Resume tab and this list cannot disagree about it.
   *
   * `version` IS DELIBERATELY ABSENT. It is a per-worker counter, not a history ordinal — a new
   * profile's first résumé is its own v1 — so a client that displayed it would label the newest
   * entry "v1" beneath an older "v3".
   *
   * NO OWNERSHIP CHECK BEYOND THE TOKEN, for `myDocument`'s reason: there is no id in the
   * request, the worker is the token's, and every read below is scoped to them.
   *
   * THE CARD'S FACTS (#1714) ARE READ ONLY OFF A 'rendered' ROW. They ride the stored document,
   * and on any other row that document may belong to an EARLIER generation: the manual-generate
   * overwrite and the converge write both reset the row to 'pending' and deliberately leave the
   * previous document in place, and a failed re-render keeps it too. Showing it would label a
   * new résumé with the facts of the one it replaced. A 'rendered' row's document was written in
   * the same UPDATE as its PDF key — see `ResumeGlance` for the one fault that can leave it a
   * render behind the file.
   */
  async history(workerId: string, now: Date = new Date()): Promise<ResumeHistoryResponse> {
    const rows = await this.resumes.listHistory(workerId, this.config.RESUME_HISTORY_VISIBLE_LIMIT);
    const facts = await this.resumes.pendingChatUpdate(workerId);
    return {
      items: rows.map((row, index) => {
        const glance =
          row.renderStatus === "rendered" ? readResumeGlance(row.resumeDocument) : null;
        return {
          resume_id: row.id,
          profile_id: row.profileId,
          source: row.generationSource ?? null,
          trigger: row.generationTrigger ?? null,
          generated_at: row.generatedAt.toISOString(),
          render_status: row.renderStatus,
          rendered_at: row.renderedAt ? row.renderedAt.toISOString() : null,
          is_current: index === 0,
          display_ref: resumeRefCode(row.id),
          trade_label: glance?.role ?? null,
          experience_years: glance?.experienceYears ?? null,
          machines: glance ? [...glance.machines] : null,
          axes: glance ? [...glance.axes] : null,
          city: glance?.city ?? null,
          page_count: glance?.pageCount ?? null,
        };
      }),
      pending_update: pendingUpdateFrom(
        facts,
        now,
        this.config.RESUME_UPDATE_PENDING_TIMEOUT_SECONDS * 1000,
      ),
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
    // `worker_pack_answer` reads for the generate-time capability overlay below. A SECOND
    // instance of the profiling module's repository (DATABASE-only, so no module edge — the
    // same pattern ProfilesModule uses for its duplicated readers), used READ-ONLY
    // (`listAnswers`): this service never writes answers.
    private readonly packAnswers: TradeFormRepository,
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
    opts: {
      systemInitiated?: boolean;
      forceNewVersion?: boolean;
      /**
       * WHICH SYSTEM EVENT started a system-initiated generation (ADR-0043). Ignored otherwise:
       * a worker's call is always `manual` and an ops regenerate always `ops_regenerate`, decided
       * here rather than trusted from the caller. Defaults to `profile_confirmed`.
       */
      trigger?: SystemResumeTrigger;
      /**
       * A QUEUE RETRY of a system generation that already charged the worker's daily cap on its
       * first attempt. Only meaningful for `chat_update_accepted`, the one metered system trigger:
       * a model outage must not spend three of the worker's five daily generations on one "Haan".
       */
      retry?: boolean;
    } = {},
  ) {
    // Enforce the daily cap BEFORE any paid AI/render work; fails closed (429) if
    // Redis is down. The system-initiated auto-generate (on profile.confirmed) is
    // one-per-worker + idempotent, so it skips the per-worker abuse cap but still
    // counts against the GLOBAL spend backstop.
    //
    // AN ACCEPTED CHAT UPDATE IS NOT EXEMPT (ADR-0043). It runs on the system path, but the
    // worker asked for it — one "Haan" per finished interview — so it is metered like the
    // worker's own regenerate. The exemption exists for the ONE auto-generate per worker, not for
    // a generation a worker can repeat.
    await this.rateLimit.assertWithinDailyCap(dto.worker_id, {
      perWorker:
        !opts.systemInitiated || (opts.trigger === "chat_update_accepted" && opts.retry !== true),
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
    const stored = DraftProfileSchema.parse(profile.rawProfile);

    // FRESH PACK ANSWERS OVER A FROZEN EXTRACTION. Trade-form answers written
    // after profiling (a section-walk edit, a later form visit) land in
    // `worker_pack_answer` + `worker_attributes` and never reach the draft, so
    // a regenerate would reprint the OLD Machines/Skills and the Resume tab
    // would reuse them forever. The overlay rebuilds those two lines from the
    // live capability rows when answers postdate the profile — every other
    // generate is byte-identical to today (see resume-draft-overlay.ts).
    // FAIL-OPEN: any read here that throws skips the overlay, never the resume.
    let draft = stored;
    try {
      const sheet = await this.attributes.loadTradeSheet(dto.worker_id);
      if (sheet.packId !== null) {
        const rows = await this.packAnswers.listAnswers(dto.worker_id, sheet.packId);
        const overlaid = overlayFreshCapabilityLines({
          draft: stored,
          packAnswers: rows,
          profileCreatedAt: profile.createdAt,
          packId: sheet.packId,
          attributes: sheet.attributes,
        });
        if (overlaid.overlaidMachines || overlaid.overlaidSkills) {
          this.logger.log(
            `resume overlay worker=${dto.worker_id} ` +
              `machines=${overlaid.overlaidMachines} skills=${overlaid.overlaidSkills}`,
          );
          draft = overlaid.draft;
        }
      }
    } catch (err) {
      this.logger.warn(
        `resume capability overlay skipped worker=${dto.worker_id} ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }

    // THE MOMENT THIS GENERATION STARTED — before the model call, on the DATABASE's clock (the one
    // `generated_at` is stamped with). A row this profile gained after it was written DURING this
    // call, i.e. it is the same generation racing us (see `convergeOnto`), never an earlier entry
    // the worker already has. Only the worker's own call converges, so only it pays the read.
    const startedAt =
      opts.systemInitiated || opts.forceNewVersion ? null : await this.resumes.now();

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

    // THE LAYOUT, CHOSEN FROM THE WORKER'S PACK — `bb_trade` for the 21 predefined roles,
    // `bb_general` for everyone else, a pack-less profile included. `templateIdForPack` owns it.
    //
    // CHOSEN HERE, AT GENERATION, AND NOWHERE ELSE. The id is stored on the row and every
    // re-render and employer disclosure reuses it (bar `renderTemplateId`'s one upgrade), so a
    // worker's existing résumés keep the layout they were issued with — no cutover, no backfill.
    //
    // DEGRADES TO THE GENERAL SHEET, NEVER TO A FAILED GENERATE. A trade lookup that throws must
    // not cost a worker their resume. `bb_general` is what "pack unknown" means, and it heals: if
    // the render worker's own lookup then finds a role pack, `renderTemplateId` prints `bb_trade`.
    let templateId = templateIdForPack(null);
    try {
      const { packId } = await this.attributes.loadTradeSheet(dto.worker_id);
      templateId = templateIdForPack(packId);
    } catch (err) {
      this.logger.warn(
        `could not resolve the trade layout for worker ${dto.worker_id}; using ${templateId} ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }

    // ── WHICH HISTORY ENTRY THIS GENERATION IS (ADR-0043) ─────────────────────────────────
    //
    // The INITIAL résumé (version 1) of a profile is idempotent + race-safe via createInitial
    // (partial unique index `generated_resumes_initial_uq`): the auto-generate on
    // profile.confirmed and a manual POST /resume/generate converge on ONE row, even though the
    // worker's name can be recorded AFTER confirm.
    //
    // EVERY AI GENERATION IS ITS OWN ENTRY (owner ruling R2) — the worker's history lists the
    // newest three, and a regenerate that overwrote the previous résumé in place, which is what
    // the manual path used to do, destroyed the entry the worker had. What remains of "overwrite"
    // is CONVERGENCE: two requests for the same generation must still land on one row.
    //
    //   ops regenerate             a new entry, numbered after the worker's highest version.
    //   system (auto / chat Haan)  the profile's INITIAL row, insert-if-absent — idempotent under
    //                              queue retries and the app's own POST racing the job.
    //   manual, profile has none   the same initial row, authoritative (today's behaviour).
    //   manual, newest still       converge onto it: it is the same generation — the worker has
    //     pending, or written      not seen it finish (a double-tap, a timeout retry), or it was
    //     during this call         written while this call was at the model (the first-time
    //                              auto-generate racing the app's POST). The guard is IN the
    //                              update — an entry finished before this call started is left
    //                              alone.
    //   manual, anything else      a new entry. This is the trade-form "done" rebuild and every
    //                              worker-initiated regenerate: today's app sends it as a plain
    //                              POST, so no client change is needed for it to be recorded.
    //
    // `version` is a per-worker counter from `maxVersion`, NOT a history ordinal — a new profile's
    // first résumé is its own v1 — and nothing orders by it any more (see `NEWEST_RESUME_FIRST`).
    const trigger: ResumeGenerationTrigger = opts.forceNewVersion
      ? "ops_regenerate"
      : opts.systemInitiated
        ? (opts.trigger ?? "profile_confirmed")
        : "manual";
    const generationSource = resolveResumeSource({
      source: profile.source ?? null,
      seededFromImportId: profile.seededFromImportId ?? null,
    });
    const initial: NewGeneratedResume = {
      workerId: dto.worker_id,
      profileId: dto.profile_id,
      resumeJson,
      resumeText,
      version: 1,
      templateId,
      // NAME-FREE structured draft, so a future renderer can re-render from the
      // snapshot. The name lives only in resume_json/resume_text (TD21), never here.
      sourceProfileSnapshot: draft,
      generationSource,
      generationTrigger: trigger,
    };

    let saved: GeneratedResume;
    let previousVersion: number | null = null;
    // A converged row may have a render in flight for its PREVIOUS content; forcing the render
    // enqueued below is what stops that stale job's "already rendered" from winning.
    let forceRender = false;
    const newEntry = async (): Promise<GeneratedResume> => {
      const highest = await this.resumes.maxVersion(dto.worker_id);
      previousVersion = highest > 0 ? highest : null;
      return this.resumes.create({ ...initial, version: highest + 1 });
    };

    if (opts.forceNewVersion) {
      saved = await newEntry();
    } else if (opts.systemInitiated) {
      // The system auto-generate only fills if absent, so it never clobbers a manual résumé.
      saved = await this.resumes.createInitial(initial, { overwrite: false });
    } else {
      const newest = await this.resumes.newestForProfile(dto.profile_id);
      if (!newest) {
        // Manual generate is authoritative (overwrite content — e.g. a name added after the
        // auto-generate ran) on the profile's initial row. The render job is enqueued exactly as
        // it always was: the overwrite resets the row to 'pending', which the processor renders.
        saved = await this.resumes.createInitial(initial, { overwrite: true });
      } else {
        const since = startedAt ?? new Date();
        const sameGeneration = newest.renderStatus === "pending" || newest.generatedAt >= since;
        const converged = sameGeneration
          ? await this.resumes.convergeOnto(newest.id, initial, since)
          : undefined;
        if (converged) {
          saved = converged;
          forceRender = true;
        } else {
          saved = await newEntry();
        }
      }
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
          // ADR-0043 — read off the SAVED row, so the event and the history card cannot disagree.
          resume_source: saved.generationSource ?? null,
          trigger: saved.generationTrigger ?? null,
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
          // Task 1 — the road of the profile this résumé renders (pre-0107
          // rows carry NULL → unknown).
          profile_source: profile.source ?? null,
          // ADR-0043 — read off the SAVED row, so the event and the history card cannot disagree.
          resume_source: saved.generationSource ?? null,
          trigger: saved.generationTrigger ?? null,
        },
        idempotencyKey: `resume.generated:${saved.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    await this.enqueueRender(saved.id, dto.worker_id, ctx, forceRender);

    return {
      resume_id: saved.id,
      version: saved.version,
      format: result.format,
      is_mock: result.is_mock,
      resume_text: saved.resumeText,
    };
  }

  /**
   * Enqueue the async PDF render (refs only, no PII). A queue failure must not fail
   * generation — the resume TEXT is already written and already paid for, and losing it over an
   * unreachable Redis would be the worse outcome.
   *
   * #1399 — BUT IT NO LONGER LEAVES THE ROW 'pending'. It used to, on the reasoning that "a
   * later regenerate/retry can re-enqueue"; there is no such retry. When `add` throws, NO JOB
   * EXISTS, so nothing will ever move that row: it reports `pending` to `GET /resume/document`
   * and 409s "still being rendered; please retry shortly" from `download`, both for a render
   * that was never scheduled. 'pending' there is not a state, it is a lie the row tells forever.
   *
   * So mark it 'failed' — the honest terminal value, and the one that lets a client stop
   * waiting. An ops regenerate is the recovery path, exactly as it is for a render that failed.
   *
   * ONLY IF THE ROW IS STILL 'pending', THOUGH. `saved` is not always the row this call just
   * inserted: on the system auto-generate path `createInitial({overwrite:false})` returns the
   * PRE-EXISTING row from its conflict branch, which may already be 'rendered' with a live PDF.
   * Downgrading that would 409 a resume the worker could download a second ago — the TD77
   * degrade-open rule — from the one path that never reaches the processor's guards. The
   * predicate lives in the UPDATE (`markRenderFailedIfPending`) rather than a read here, because
   * a read-then-write races a render that lands between the two.
   */
  private async enqueueRender(
    resumeId: string,
    workerId: string,
    ctx: RequestContext,
    force = false,
  ): Promise<void> {
    try {
      await this.renderQueue.add("render", {
        resumeId,
        workerId,
        // Only on a CONVERGED row (ADR-0043): its content was just rewritten, and a render job
        // for the previous content may already be in flight. Absent everywhere else, so every
        // other generate enqueues exactly the job it always did.
        ...(force ? { force: true } : {}),
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume render for ${resumeId}; marking render_status failed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      // ITS OWN try/catch, because the whole point of this method is that generation survives.
      // Redis being down does not imply Postgres is, but if both are, the caller must still get
      // their resume back rather than a 500 from the bookkeeping about it.
      try {
        await this.resumes.markRenderFailedIfPending(resumeId);
      } catch (markErr) {
        this.logger.error(
          `could not mark resume ${resumeId} failed after an enqueue failure; it will sit at pending (reason: ${
            markErr instanceof Error ? markErr.message : String(markErr)
          })`,
        );
      }
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
