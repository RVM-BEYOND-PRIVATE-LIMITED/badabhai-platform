import { InjectQueue } from "@nestjs/bullmq";
import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import type {
  DescriptionSource,
  EmploymentView,
  MyEmploymentResponse,
  SetDescriptionSourceDto,
  SetMyEmploymentDto,
} from "./worker-employment.dto";
import {
  EmploymentCountMismatchError,
  WorkerEmploymentRepository,
  readEmployerName,
} from "./worker-employment.repository";

/**
 * Which text prints for one stint (#1354): a refusal wins over a rewrite, and no rewrite is `null`.
 * The same precedence the renderer applies, restated as the one fact the edit page shows.
 */
function descriptionSourceOf(declined: boolean, hasPolish: boolean): DescriptionSource | null {
  if (declined) return "own_words";
  return hasPolish ? "polished" : null;
}

/**
 * Records the worker's own work history from the post-interview form (R4 Q1).
 *
 * THE EMPLOYER NAME NEVER PASSES THROUGH THE AI SERVICE. It is typed by the worker, encrypted
 * here, and written straight to Postgres — the owner ruling behind `worker_employment`. The
 * pseudonymisation gateway's employer mask is unchanged and unaffected: nothing on this path
 * builds a prompt.
 *
 * ENCRYPT BEFORE THE DB TOUCH, exactly as `WorkersService.setFullName` does. The repository
 * takes ciphertext and cannot encrypt, so there is no path on which a plaintext employer name
 * reaches a column.
 */
@Injectable()
export class WorkerEmploymentService {
  private readonly logger = new Logger(WorkerEmploymentService.name);

  constructor(
    private readonly employment: WorkerEmploymentRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async replaceForWorker(
    workerId: string,
    dto: SetMyEmploymentDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; employer_count: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // EVERY CLIP MUST BE THIS WORKER'S, PROVED BEFORE ANYTHING IS WRITTEN (§3 fail closed).
    //
    // The foreign key proves only that the note exists. `voice_notes.worker_id` lives on the
    // other row, so ownership is unexpressible as a constraint and has to be checked here — a
    // worker who replayed someone else's note id would otherwise store a description whose
    // provenance points at another person's audio.
    //
    // 404, NOT 403, and never naming the id: telling an attacker "that note exists but is not
    // yours" is the oracle the rest of this codebase refuses to be. Same shape as the ownership
    // check on the voice read route.
    const claimedNoteIds = dto.employments.flatMap((e) =>
      e.roles !== undefined
        ? e.roles.flatMap((r) => (r.work_done_voice_note_id ? [r.work_done_voice_note_id] : []))
        : e.work_done_voice_note_id
          ? [e.work_done_voice_note_id]
          : [],
    );
    if (claimedNoteIds.length > 0) {
      const owned = await this.employment.findOwnedVoiceNoteIds(workerId, claimedNoteIds);
      if (claimedNoteIds.some((id) => !owned.has(id))) {
        throw new NotFoundException("voice note not found");
      }
    }

    const rows = dto.employments.map((e) => ({
      employerNameEnc: this.pii.encrypt(e.employer_name),
      employerCity: e.employer_city,
      employerState: e.employer_state,
      startYm: e.start_ym,
      endYm: e.end_ym,
      // §11 #3, AND IT IS DERIVED RATHER THAN ASKED. "Kuch saal" has no start month, and the
      // sheet must print the literal "duration not stated" instead of estimating one. The
      // schema's `we_duration_stated_chk` refuses `true` without a start, so deriving it from
      // the presence of a start month is the only value that can be both honest and legal.
      durationStated: e.start_ym !== null,
      // THE LINE v1 SAID WOULD BE THE ONLY ONE TO CHANGE, changing (#1328).
      //
      // The shorthand still produces exactly what it produced before — one role whose dates ARE
      // the employment's — so a client that predates promotion capture renders byte-identically.
      // `roles` is taken in the order the worker gave it, which is display order, most recent
      // first; deriving it from the dates would reshuffle stints between renders and make every
      // regenerated PDF a false diff, exactly as the employment `sortOrder` comment says.
      roles:
        e.roles !== undefined
          ? e.roles.map((r) => ({
              roleLabel: r.role_label,
              startYm: r.start_ym,
              endYm: r.end_ym,
              workDone: r.work_done,
              workDoneVoiceNoteId: r.work_done_voice_note_id,
            }))
          : [
              {
                roleLabel: e.role_label as string,
                startYm: e.start_ym,
                endYm: e.end_ym,
                workDone: e.work_done,
                workDoneVoiceNoteId: e.work_done_voice_note_id,
              },
            ],
    }));

    // #1504 — `expected_existing_count` is BOTH the stale-prefill guard and the new-build signal.
    // Absent means an old build, whose `[]` over a stored history is a tap-through, not an answer
    // (owner ruling 2026-09-15); present means `[]` clears, as it always has.
    let outcome: Awaited<ReturnType<WorkerEmploymentRepository["replaceForWorker"]>>;
    try {
      outcome = await this.employment.replaceForWorker(workerId, rows, {
        expectedExistingCount: dto.expected_existing_count,
        preserveWhenEmpty: dto.expected_existing_count === undefined,
      });
    } catch (err) {
      // 409, NOTHING WRITTEN, NO EVENT. The mismatch was detected inside the transaction before its
      // delete, so there is nothing to roll back — and the client's remedy is to re-read.
      if (err instanceof EmploymentCountMismatchError) {
        this.logger.warn(
          `employment replace refused for worker ${workerId}: expected ${err.expected} stored row(s), found ${err.actual}`,
        );
        throw new ConflictException("work history changed since it was loaded; reload and retry");
      }
      throw err;
    }

    if (outcome.skipped === true) {
      // NO EVENT, NO RE-RENDER: nothing changed. Counts only.
      this.logger.log(
        `old-build empty employment save ignored for worker ${workerId}: ${outcome.existingCount} stored row(s) kept`,
      );
      return { worker_id: workerId, employer_count: outcome.existingCount };
    }
    const { replacedExisting } = outcome;

    await this.events.emit({
      event_name: "worker.employment_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // PII-FREE: shape only. The employer name is the feature and is exactly what may not
      // travel; the city does not travel either, because a city plus a worker id plus a date
      // range narrows a person and the spine needs none of it.
      payload: {
        worker_id: workerId,
        employer_count: rows.length,
        durations_stated: rows.filter((r) => r.durationStated).length,
        replaced_existing: replacedExisting,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts only — never an employer name, a city or a date.
    this.logger.log(
      `employment recorded for worker ${workerId}: ${rows.length} employer(s), ` +
        `${rows.filter((r) => r.durationStated).length} dated`,
    );

    // Zone 4 is baked into the PDF at render time, so an EDIT must re-render in place or the
    // worker keeps downloading a sheet with his old history on it — the same reason a name
    // change re-renders. failClosed:false: adding history is not a REMOVAL, so a failed render
    // leaves the previous PDF in service rather than 409-ing a résumé he had a second ago.
    await this.enqueueRerender(workerId, ctx);

    return { worker_id: workerId, employer_count: rows.length };
  }

  /**
   * The caller's own work history, employer names decrypted, for their edit page (#1504).
   *
   * OWN-SESSION EGRESS, ON THE `getResumeFields` PRECEDENT (§2 ruling 2026-07-14). The worker typed
   * these names; returning them to the same worker's session over TLS is not a cross-actor leak.
   * What keeps it that narrow is everything this method does NOT do: the plaintext enters no event,
   * no log line, no queue payload and no prompt, and the controller marks the response `no-store`.
   *
   * A ROW THAT WILL NOT DECRYPT IS WITHHELD AND COUNTED, NEVER THROWN. A rotated or corrupt token
   * must not 500 the page, and it must not surface as a blank employer the PUT would refuse. The
   * count is what lets the client send an honest `expected_existing_count`, and the replace carries
   * such rows across rather than deleting them — see `readEmployerName`, the one predicate both use.
   *
   * THE EDIT READ, NOT THE RÉSUMÉ READ. `loadForResume` drops unreadable rows and never selects the
   * voice-note id, so a prefill from it would erase both on save.
   *
   * NO EVENT — a read changes nothing.
   */
  async getForWorker(workerId: string): Promise<MyEmploymentResponse> {
    const stored = await this.employment.loadForWorkerEdit(workerId);

    const employments: EmploymentView[] = [];
    let unreadable = 0;
    for (const e of stored) {
      const employerName = readEmployerName(this.pii, e.employerNameEnc);
      if (employerName === null) {
        unreadable += 1;
        continue;
      }
      employments.push({
        employment_id: e.id,
        employer_name: employerName,
        employer_city: e.employerCity,
        employer_state: e.employerState,
        start_ym: e.startYm,
        end_ym: e.endYm,
        roles: e.roles.map((r) => ({
          role_label: r.roleLabel,
          start_ym: r.startYm,
          end_ym: r.endYm,
          work_done: r.workDone,
          work_done_voice_note_id: r.workDoneVoiceNoteId,
          description_source: descriptionSourceOf(r.workDonePolishDeclined, r.hasPolish),
        })),
      });
    }

    // Counts only — never an employer name, a city, a date or a token.
    this.logger.log(
      `employment read for worker ${workerId}: ${employments.length} readable, ${unreadable} unreadable`,
    );
    return { employments, unreadable_count: unreadable };
  }

  /**
   * Record which text prints as one employment's work line (#1354).
   *
   * 404 ON ZERO ROWS, and it is not laziness about the status code. The employment id comes
   * from the client; a 403 would confirm that somebody else's id EXISTS, which is an existence
   * oracle over another worker's history. Not-found is the honest answer to "you have no such
   * employment" whether the row belongs to someone else or to nobody.
   *
   * RE-RENDERS, because the choice only means anything once it reaches the PDF the worker hands
   * over. Best-effort on the same terms as an edit: a queue that is down must not fail the
   * decision, and the previous PDF keeps serving until the next render picks it up.
   */
  async setDescriptionSource(
    workerId: string,
    employmentId: string,
    dto: SetDescriptionSourceDto,
    ctx: RequestContext,
  ): Promise<{ stints_updated: number }> {
    const declined = dto.source === "own_words";
    const updated = await this.employment.setPolishDeclined(workerId, employmentId, declined);
    if (updated === 0) {
      throw new NotFoundException(`Employment ${employmentId} not found`);
    }

    await this.events.emit({
      event_name: "worker.employment_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // PII-FREE, and deliberately the SHAPE of the existing employment event rather than a new
      // one: what happened is that this worker's history changed in a way the sheet renders.
      // The counts say how much; nothing says which employer or what either text said.
      payload: {
        worker_id: workerId,
        employer_count: 1,
        durations_stated: 0,
        replaced_existing: true,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts and the choice only — never the employer, never either version of the text.
    this.logger.log(
      `description source set to ${dto.source} for worker ${workerId}: ${updated} stint(s)`,
    );
    await this.enqueueRerender(workerId, ctx);
    return { stints_updated: updated };
  }

  /** Best-effort: a queue that is down must not fail the write the worker just made. */
  private async enqueueRerender(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      // No résumé yet - the common case, since the form comes straight after the interview and
      // before the first generate. Nothing to re-render; the first render picks the history up.
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
