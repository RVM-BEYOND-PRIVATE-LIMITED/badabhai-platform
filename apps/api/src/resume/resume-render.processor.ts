import { WorkHistoryPolishService } from "./work-history-polish.service";
import { toResumeDocument } from "./resume-document";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { WorkerEmploymentRepository } from "../profiles/worker-employment.repository";
import { WorkerTranscriptRepository } from "../profiles/worker-transcript.repository";
import { StorageService } from "../storage/storage.service";
import { ResumeRepository } from "./resume.repository";
import { FontResolutionError } from "../common/pdf/font-resolution";
import { ResumeRenderer } from "./resume-renderer.service";
import { buildResumeRenderInput, type TradeSheetContext } from "./resume-render-input";
import { buildResumeQrDataUri } from "./resume-qr";
import { buildSheetFooterMeta, RESUME_PROFILE_ORIGIN, resumeRefCode } from "./resume-sheet-footer";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";

/**
 * Renders a resume PDF off the request path (NODE-ONLY render, see ADR).
 *
 * SECURITY: the worker's real name is decrypted SERVER-SIDE here (same degrade-
 * on-failure discipline as ResumeService), placed onto the PDF, and uploaded.
 * It is NEVER logged, NEVER put into an event, and NEVER enqueued. No event is
 * emitted on render completion — only the row's render_status flips.
 *
 * Render is degrade-to-null: renderer returns null when the kill-switch is off
 * or WeasyPrint is missing/failed. We only flip the row to 'failed' on the FINAL
 * BullMQ attempt (mirrors the voice processor's terminal-failure handling), so
 * transient issues get retried while the row stays 'pending'.
 */
@Processor(RESUME_RENDER_QUEUE)
export class ResumeRenderProcessor extends WorkerHost {
  private readonly logger = new Logger(ResumeRenderProcessor.name);

  constructor(
    private readonly resumes: ResumeRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly renderer: ResumeRenderer,
    private readonly storage: StorageService,
    private readonly attributes: WorkerAttributesRepository,
    private readonly employments: WorkerEmploymentRepository,
    private readonly transcript: WorkerTranscriptRepository,
    // #1350 — the one field on this sheet the model may compose. Off by two independent
    // locks by default; see `WORK_HISTORY_POLISH_ENABLED`.
    private readonly polish: WorkHistoryPolishService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  async process(job: Job<ResumeRenderJobData>): Promise<{ rendered: boolean }> {
    const { resumeId, workerId } = job.data;

    const resume = await this.resumes.findById(resumeId);
    if (!resume) {
      // Nothing to render (deleted?). Don't fail the job — just no-op.
      this.logger.warn(`resume ${resumeId} not found; skipping render`);
      return { rendered: false };
    }

    // Idempotency: a prior attempt may have already produced the PDF.
    //
    // ADR-0032 / TD77: `force` overrides this for a PRESENTATION-only re-render
    // (photo added/replaced/removed, or the show_photo pref flipped after the
    // first render). Without the override the photo could never reach an
    // already-rendered PDF. A forced run re-renders in place — same version, same
    // object key — so no new version is minted and the old PDF stays downloadable
    // until the fresh one overwrites it.
    const wasRendered = resume.renderStatus === "rendered";
    if (wasRendered && !job.data.force) {
      this.logger.log(`resume ${resumeId} already rendered; skipping`);
      return { rendered: true };
    }

    // Decrypt the worker's real name SERVER-SIDE. Degrade to a name-less render on
    // any failure (rotated key / tampered token) — same as ResumeService. Never log
    // the token, the error detail, or the name.
    let displayName: string | null = null;
    const worker = await this.workers.findById(workerId);
    if (worker?.fullName) {
      try {
        displayName = this.pii.decrypt(worker.fullName);
      } catch {
        this.logger.warn(
          `could not decrypt full_name for worker ${workerId}; rendering a name-less resume`,
        );
      }
    }

    // ADR-0032 — the worker's profile photo, embedded ONLY on the worker's OWN
    // resume and ONLY when the worker's show_photo pref is on. Fetched as bytes
    // (WeasyPrint renders from stdin with no network — a data: URI is the only
    // hermetic embed). Degrade photo-less on ANY failure: the photo must never
    // cost the worker their PDF. Never log the key or the bytes.
    let photoDataUri: string | null = null;
    const photoBucket = this.config.WORKER_PHOTOS_BUCKET;
    if (photoBucket && worker?.resumeShowPhoto && worker.photoStorageKey) {
      try {
        const bytes = await this.storage.downloadObject(worker.photoStorageKey, photoBucket);
        if (bytes && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024) {
          // MAGIC-BYTE check (bb-security-review L-2): the stored content-type is
          // client-declared at PUT, so verify the actual bytes are a real JPEG
          // (FF D8 FF) or PNG (89 50 4E 47) and SKIP the embed otherwise — arbitrary
          // bytes must never reach WeasyPrint as an "image".
          const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
          const isPng =
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
          if (isJpeg || isPng) {
            const mime = isPng ? "image/png" : "image/jpeg";
            photoDataUri = `data:${mime};base64,${bytes.toString("base64")}`;
          }
        }
      } catch {
        this.logger.warn(
          `could not fetch profile photo for worker ${workerId}; rendering photo-less`,
        );
      }
    }

    // THE SHEET CONTEXT. Built in FOUR independent steps, each degrading on its own.
    //
    // IT USED TO BE ONE `try` AROUND ALL OF THEM, and that was a real defect rather than a
    // tidiness point. `loadTradeSheet` throwing left `tradeSheet` null, and a null context takes
    // down the PHONE (owner-ruled onto both copies), the QR (the acquisition loop Part 12.2
    // measures the whole free-résumé investment by), the ref code and the footer — none of which
    // reads a single trade attribute. The comment on the employments load below already stated
    // the rule this violated one level up: a failure must cost its own section and nothing else.
    // Found by asserting the QR across all fourteen content shapes; the sheet rendered perfectly
    // without it, which is why nothing had noticed.
    const renderedAt = new Date();

    // THE NUMBER, DECRYPTED SERVER-SIDE, on the same degrade as the name and the photo above: a
    // rotated or tampered token costs the worker the phone line, never the whole PDF. Owner
    // ruling 2026-08-28 puts it on both copies; the payer only ever receives one post-unlock.
    let phone: string | null = null;
    if (worker?.phoneE164) {
      try {
        phone = this.pii.decrypt(worker.phoneE164);
      } catch {
        this.logger.warn(`could not decrypt phone for worker ${workerId}; rendering without it`);
      }
    }

    // POINTS AT THE SITE ROOT FOR NOW — owner ruling 2026-08-28. The per-worker `/w/<code>` page
    // is Phase 3, and a QR that resolves to a 404 is worse on a printed page than a QR that
    // resolves to the homepage: the sheet outlives the render, and paper cannot be re-issued once
    // it is in an employer's stack.
    //
    // NOT INSIDE ANY OF THE LOADS BELOW. It depends on a module constant and nothing else, so
    // there is no failure it can legitimately share.
    const qrDataUri = await buildResumeQrDataUri(RESUME_PROFILE_ORIGIN);

    // THE TRADE CAPABILITY BLOCK — the `bb_trade` sheet's first and most-scanned section.
    //
    // DEGRADES TO ABSENCE, NEVER TO A FAILED RENDER. A worker whose interview predates the role
    // packs, or whose trade has no map yet, simply has no rows and the section collapses; a query
    // that throws must not cost them the whole PDF, exactly as the photo fetch above must not.
    let loaded: TradeSheetContext | null = null;
    try {
      loaded = await this.attributes.loadTradeSheet(workerId);
    } catch {
      this.logger.warn(`could not load trade attributes for worker ${workerId}; rendering without`);
    }

    // ZONE 4 — the two-level work history. EMPTY FOR EVERY WORKER TODAY: nothing writes
    // `worker_employment` yet, so the mapper falls back to the tag-derived role + duration line
    // every existing résumé already renders. Reading it here is what lets the capture surface,
    // whenever it lands, flip workers over one at a time with no cutover.
    let employments: Awaited<ReturnType<WorkerEmploymentRepository["loadForResume"]>> = [];
    try {
      employments = await this.employments.loadForResume(workerId);
    } catch {
      this.logger.warn(
        `could not load work history for worker ${workerId}; rendering the fallback history`,
      );
    }

    // #1350 — REPHRASE ANY DESCRIPTION THAT HAS NOT BEEN REPHRASED YET.
    //
    // HERE RATHER THAN AT CAPTURE, because capture is the worker's request path on a phone
    // and this render is already a queue job. One model call per stint EVER — the result is
    // written back, and only null-polish stints are visited — so a re-render of an unchanged
    // history spends nothing while an edited description arrives as a fresh row and is
    // re-polished for free.
    //
    // NEVER THROWS INTO THE RENDER. Every degrade leaves the polish null and the sheet prints
    // the worker's own words, which is what it printed before the ruling. A resume that fails
    // to render is strictly worse than one that renders in Hinglish.
    try {
      employments = [
        ...(await this.polish.polish(
          workerId,
          employments,
          { correlationId: job.data.correlationId, requestId: job.data.requestId },
          this.config,
        )),
      ];
    } catch (err) {
      this.logger.warn(
        `work-history polish failed for worker ${workerId}; rendering the worker's own words ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }

    // THE WORKER'S OWN TURNS — a FIFTH independent load, on the same degrade as the four above.
    // It feeds two rules and neither is worth a failed render: without it the quote block
    // collapses (a sheet with one less section, which is what every sheet has today) and the
    // veto withdraws nothing (a sheet exactly as honest as the chips the worker ticked).
    //
    // NEVER LOGGED. The rows are raw worker text; the catch below names the worker id and the
    // failure, and nothing from the body ever reaches a log line, an event or a prompt.
    let workerSaid: string[] = [];
    try {
      workerSaid = await this.transcript.loadWorkerTurns(workerId);
    } catch {
      this.logger.warn(
        `could not load the transcript for worker ${workerId}; rendering without quotes or veto`,
      );
    }

    // ALWAYS A CONTEXT, never null. `packId`/`attributes` carry the empty defaults so a failed
    // attribute load collapses the capability section and costs exactly that.
    const tradeSheet: TradeSheetContext = {
      packId: null,
      attributes: {},
      ...(loaded ?? {}),
      employments,
      workerSaid,
      // ONE CLOCK PER RENDER, shared with the footer below, so a sheet generated at midnight
      // cannot date its footer one day and compute a current job's tenure against the next.
      asOf: renderedAt,
      phone,
      // Devanagari is not transliterated yet; the slot stays null rather than printing the
      // Latin name twice. `nameDevanagari` is audience-gated inside the mapper regardless.
      nameDevanagari: null,
      // No verification tier exists in the schema yet, so the masthead's right slot collapses.
      // The unverified state must read as neutral, never as a warning.
      trustBadge: null,
      qrDataUri,
      qrCaption: "Scan to open this worker's live profile",
      shortLink: RESUME_PROFILE_ORIGIN.replace(/^https?:\/\//, ""),
      footerMeta: buildSheetFooterMeta({
        generatedAt: renderedAt,
        trustBadge: null,
        refCode: resumeRefCode(resumeId),
      }),
    };

    const input = buildResumeRenderInput(
      resume.sourceProfileSnapshot,
      displayName,
      resume.templateId,
      photoDataUri,
      // #947 — the worker's OWN "Night shift ke liye taiyaar" answer. Off the worker row
      // already loaded above for the name and the photo, so this costs no extra query.
      //
      // FROM THE WORKER ROW, NOT THE SNAPSHOT, AND THAT IS THE POINT. The snapshot only ever
      // held the model's guess at a shift; this is the toggle the worker set themselves on the
      // Edit-Resume screen, and it lives on `workers` precisely so it survives every profile
      // regeneration and re-extraction. Reading it here is what finally puts their own answer
      // on their own PDF.
      //
      // A MISSING ROW DEGRADES TO `false` — i.e. to saying nothing, never to printing "No".
      // The same degrade the name and the photo take three lines up, and for the same reason:
      // an infrastructure miss must not put a claim on the résumé.
      worker?.resumeNightShiftReady ?? false,
      // The worker's OWN copy — real name, their photo, and their expected salary. The
      // payer-facing disclosure passes "employer" and gets none of the three.
      "worker",
      tradeSheet,
    );

    // EVERY WITHDRAWN CLAIM IS AUDITABLE, and this is the only place it is recorded. A veto
    // removes something a worker ticked, so "which claim, and on the strength of which sentence"
    // has to survive the render — a count alone would make a wrong gazetteer term undiagnosable.
    //
    // THE SLUG AND THE ATTRIBUTE KEY ONLY. The triggering phrase is raw transcript and does not
    // go to a log; it rides the render input for a human reading the artifact, never a log sink.
    for (const veto of input.transcriptVetoes ?? []) {
      this.logger.log(`resume ${resumeId}: transcript veto on ${veto.attributeKey}=${veto.slug}`);
    }

    let pdf: Buffer | null = null;
    try {
      pdf = await this.renderer.renderPdf(input);
    } catch (err) {
      if (err instanceof FontResolutionError) {
        // NOT a per-resume fault: the image cannot resolve the sheet's fonts, so every
        // resume it renders would be wrong in the same way. Logged at error level
        // because the correct response is to fix the image, and because the symptom it
        // replaces — a sheet in the wrong font — produces no log line at all.
        // `err.message` is constants only (contract name + PostScript face names).
        this.logger.error(`resume render refused: ${err.message}`);
      } else {
        // The renderer is designed to degrade to null, but guard anyway. Never log
        // the input/name — only a generic reason.
        this.logger.warn(
          `resume ${resumeId} render threw (${err instanceof Error ? err.message : "unknown"}); treating as no-PDF`,
        );
      }
      pdf = null;
    }

    if (!pdf) {
      // No PDF this run (kill-switch off, binary missing, or render failed). Only
      // mark the row 'failed' on the FINAL attempt so retries can still succeed.
      if (this.isFinalAttempt(job) && wasRendered && job.data.failClosed) {
        // TD77 REMOVE direction: the existing PDF embeds the face the worker asked us
        // to erase, so keeping it in service would keep serving erased PII (§2/DPDP).
        // Take it out of service — a 409 beats serving a removed face.
        //
        // THIS MUST BE TESTED BEFORE THE KILL-SWITCH BRANCH BELOW. Erasure outranks the
        // kill-switch: when RESUME_RENDER_ENABLED is off there is no way to re-render the
        // face OFF the PDF, which makes it MORE important to stop serving it, not less.
        // Ordering this after the kill-switch check silently shadowed `failClosed` and
        // left the row 'rendered' (i.e. still serving the erased face) — and it never
        // self-heals, because a later DELETE /workers/me/photo skips the re-render once
        // show_photo is already off. Gated on `wasRendered`: with no PDF on file there is
        // no face to erase, so a not-yet-rendered row belongs to the branches below.
        await this.resumes.markRenderFailed(resumeId);
        this.logger.warn(
          `resume ${resumeId} fail-closed re-render produced no PDF; marked failed rather than serve erased PII`,
        );
      } else if (this.isFinalAttempt(job) && wasRendered) {
        // TD77: a FORCED re-render over an ALREADY-GOOD PDF failed. That PDF is
        // still in storage and still valid, so the row must STAY 'rendered' —
        // marking it 'failed' would 409 a resume the worker could download a second
        // ago (i.e. changing their photo would cost them their resume). Degrade
        // silently: keep serving the existing PDF; the photo just isn't on it yet.
        // (The REMOVE direction never reaches here — it is handled above.)
        this.logger.warn(
          `resume ${resumeId} forced re-render produced no PDF; keeping the existing rendered PDF`,
        );
      } else if (this.isFinalAttempt(job) && !this.config.RESUME_RENDER_ENABLED) {
        // Kill-switch off is an expected steady state, not a failure: leave the row
        // 'pending' so it renders once rendering is enabled, rather than marking it failed.
        this.logger.log(
          `resume ${resumeId} not rendered (render disabled); leaving status pending`,
        );
      } else if (this.isFinalAttempt(job)) {
        await this.resumes.markRenderFailed(resumeId);
        this.logger.warn(`resume ${resumeId} render failed after final attempt; marked failed`);
      }
      return { rendered: false };
    }

    // Object key: opaque UUIDs only (worker + resume + version) — no PII in the
    // path. The key is NOT the security boundary (UUIDs are guessable in theory);
    // a PRIVATE bucket + short-TTL signed URL is. The name lives in the PDF bytes only.
    const objectKey = `resumes/${workerId}/${resumeId}/v${resume.version}.pdf`;
    try {
      await this.storage.uploadPdf(objectKey, pdf);
      // THE SAME INPUT THE TEMPLATE JUST CONSUMED, projected for a client that draws the
      // resume rather than printing it. Built here rather than on read because assembling it
      // needs the five loads above, and a second assembly is a second answer.
      await this.resumes.markRendered(
        resumeId,
        objectKey,
        toResumeDocument(input, loaded?.packId ?? null),
      );
    } catch (err) {
      // The PDF rendered but upload/persist failed. Let BullMQ retry; only on the
      // FINAL attempt flip the row to 'failed' so it doesn't sit 'pending' forever.
      this.logger.warn(
        `resume ${resumeId} upload/persist failed (${err instanceof Error ? err.message : "unknown"})`,
      );
      if (this.isFinalAttempt(job)) {
        // TD77: same rule as the no-PDF path — NEVER downgrade a resume that already
        // had a good PDF. A failed upload leaves the previous object intact (the key
        // is unchanged), so the row stays 'rendered' and the old PDF keeps serving.
        // In the REMOVE direction we still fail CLOSED: that stale PDF carries the
        // face the worker erased, so a 409 beats serving it.
        if (!wasRendered || job.data.failClosed) await this.resumes.markRenderFailed(resumeId);
        return { rendered: false };
      }
      throw err;
    }
    this.logger.log(`resume ${resumeId} rendered + uploaded (v${resume.version})`);
    return { rendered: true };
  }

  /** True on the last BullMQ attempt — so terminal failures are marked only once. */
  private isFinalAttempt(job: Job<ResumeRenderJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade + 1 >= maxAttempts;
  }
}
