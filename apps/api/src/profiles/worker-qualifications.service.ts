import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import {
  SetMyQualificationsSchema,
  type CertificateEntryDto,
  type EducationEntryDto,
  type MyQualificationsResponse,
  type SetMyQualificationsDto,
} from "./worker-qualifications.dto";
import { WorkerQualificationsRepository } from "./worker-qualifications.repository";

/**
 * Records the worker's own credentials from the finishing form's qualifications page.
 *
 * ═══ WHAT THIS FINALLY GIVES THE SHEET ═══
 *
 * The Certificates row has never had a writer. It prints from `draft.certifications`, which only
 * the LLM extraction path fills — and the trade-form handover deliberately switches extraction
 * OFF, because a two-turn transcript yields a container that outranks the answer map and blanks
 * the sheet. So for every form-first worker that row had no source, could never appear, and
 * `resume-degradation.ts` carried a ladder step to shed it anyway. Both RVM student reference
 * sheets lead with a certificate.
 *
 * ═══ NOTHING HERE TOUCHES A MODEL ═══
 *
 * Two closed-vocabulary slugs, two years, and three strings the worker typed off their own
 * certificates. No prompt is built, no pseudonymisation boundary is in the path, and the values
 * reach the PDF through `resume-qualification-rows.ts`, which is pure composition. This is the
 * same argument that puts the preferences form outside the AI boundary, and it holds for the same
 * reason: there is nothing to parse.
 *
 * ═══ NO ENCRYPTION, AND IT IS A RULING RATHER THAN AN OVERSIGHT ═══
 *
 * `WorkerEmploymentService` encrypts before the database touch because an employer plus a date
 * range is an employment record. `institute` and `issuer` follow the OTHER precedent —
 * `education_institute`, in clear on `worker_attributes` since R9 §3 — because they are the same
 * field, in the same zone, on the same page. The uncomfortable case is real and named in
 * migration 0098's header: an issuer CAN be an employer. That is the argument FOR encrypting
 * these and it is the security gate's to rule on; encrypting later needs a backfill, and that
 * cost was accepted deliberately over shipping a zone whose two halves disagree about their own
 * threat model.
 */
@Injectable()
export class WorkerQualificationsService {
  private readonly logger = new Logger(WorkerQualificationsService.name);

  constructor(
    private readonly qualifications: WorkerQualificationsRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async replaceForWorker(
    workerId: string,
    dto: SetMyQualificationsDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; certificate_count: number; education_count: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // `undefined` IS FORWARDED AS `undefined`, deliberately. Normalising to `[]` here would be
    // the one-line bug that wipes a worker's certificates the first time a client saves only
    // their education — see the repository's three-state contract.
    const { certificatesWritten, educationsWritten, replacedExisting } =
      await this.qualifications.replaceForWorker(workerId, {
        certificates: dto.certificates?.map((c) => ({
          name: c.name,
          issuer: c.issuer,
          year: c.year,
        })),
        educations: dto.educations?.map((e) => ({
          credential: e.credential,
          field: e.field,
          council: e.council,
          year: e.year,
          institute: e.institute,
        })),
      });

    await this.events.emit({
      event_name: "worker.qualifications_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // COUNTS, NEVER THE CREDENTIALS. A council slug alone would be harmless; the SET is not —
      // an institute plus a year plus a worker id narrows a person considerably, and the spine
      // needs to know the page was answered rather than what it said. The same discipline
      // `worker.employment_recorded` keeps for the employer name.
      payload: {
        worker_id: workerId,
        certificate_count: certificatesWritten,
        education_count: educationsWritten,
        replaced_existing: replacedExisting,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts only — never a certificate name, an issuer or an institute.
    this.logger.log(
      `qualifications recorded for worker ${workerId}: ${certificatesWritten} certificate(s), ` +
        `${educationsWritten} education(s)`,
    );

    await this.enqueueRerender(workerId, ctx);

    return {
      worker_id: workerId,
      certificate_count: certificatesWritten,
      education_count: educationsWritten,
    };
  }

  /**
   * The caller's stored credentials, in the PUT's entry shapes (#1504).
   *
   * THE RÉSUMÉ READ IS THE RIGHT READ HERE, unlike for work history: it is plaintext, decrypts
   * nothing and drops nothing, so a prefill built from it cannot silently omit a row. Each row is
   * still passed through the PUT schema — see {@link MyQualificationsResponse} for why one that
   * fails is withheld and counted rather than returned.
   *
   * NO EVENT (a read changes nothing) and a counts-only log line: an institute or an issuer the
   * worker typed is exactly what the write path already refuses to log.
   */
  async getForWorker(workerId: string): Promise<MyQualificationsResponse> {
    const stored = await this.qualifications.loadForResume(workerId);

    const certificates: CertificateEntryDto[] = [];
    const educations: EducationEntryDto[] = [];
    let droppedCertificates = 0;
    let droppedEducations = 0;
    for (const row of stored.certificates) {
      const parsed = SetMyQualificationsSchema.safeParse({ certificates: [row] });
      if (parsed.success && parsed.data.certificates)
        certificates.push(parsed.data.certificates[0]!);
      else droppedCertificates += 1;
    }
    for (const row of stored.educations) {
      const parsed = SetMyQualificationsSchema.safeParse({ educations: [row] });
      if (parsed.success && parsed.data.educations) educations.push(parsed.data.educations[0]!);
      else droppedEducations += 1;
    }

    const partial: ("certificates" | "educations")[] = [];
    if (droppedCertificates > 0) partial.push("certificates");
    if (droppedEducations > 0) partial.push("educations");
    const droppedCount = droppedCertificates + droppedEducations;

    this.logger.log(
      `qualifications read for worker ${workerId}: ${certificates.length} certificate(s), ` +
        `${educations.length} education(s), ${droppedCount} withheld`,
    );
    return { certificates, educations, partial, dropped_count: droppedCount };
  }

  /**
   * Best-effort: a queue that is down must not fail the write the worker just made.
   *
   * Zone 5 is baked into the PDF at render time, so an EDIT must re-render in place or the worker
   * keeps handing over a sheet with no certificates on it. `failClosed: false` because ADDING a
   * credential is not a REMOVAL — a failed render leaves the previous PDF in service rather than
   * 409-ing a résumé the worker had a second ago. The same call, on the same terms, as the
   * work-history and preferences writers.
   */
  private async enqueueRerender(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      // No résumé yet is the ordinary case — the form runs straight after the interview and
      // before the first generate, and that render picks these rows up on its own.
      if (!latest) return;
      await this.renderQueue.add("render", {
        resumeId: latest.id,
        workerId,
        force: true,
        failClosed: false,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume re-render for worker ${workerId} (${
          err instanceof Error ? err.message : "unknown"
        })`,
      );
    }
  }
}
