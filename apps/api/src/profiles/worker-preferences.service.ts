import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { NewWorkerAttribute } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import { WorkerAttributesRepository } from "./worker-attributes.repository";
import type { SetMyPreferencesDto } from "./worker-preferences.dto";
import { PREFERENCE_KEYS, type PreferenceKey } from "./worker-preferences.vocabulary";

/**
 * The post-interview finishing form's closed-set page (R6 §4).
 *
 * NOTHING HERE TOUCHES A MODEL, AND THAT IS THE WHOLE ARGUMENT FOR THE SURFACE. Every value is a
 * slug from a closed dictionary or a city resolved through the shared gazetteer, so there is no
 * text to parse, no prompt to build, and no pseudonymisation boundary in the path. R6 §4: these
 * answers recover most of the §9.1 points the interview cannot reach, without spending one ask.
 *
 * IT WRITES `worker_attributes`, NOT A NEW TABLE. Two of the keys already exist there —
 * `shift_preference` is `qp_universal`'s, `relocation_willingness` was v1's before v2 dropped the
 * ask — and `wa_worker_key_uq` gives one live value per attribute per worker. So the form is an
 * ANSWER to the same question the interview asks, upserting over it, rather than a second and
 * competing store the résumé mapper would have to arbitrate. It also means the résumé reader
 * (`loadTradeSheet`) already returns these values with no change.
 *
 * `source: "answer_map"`, DELIBERATELY, and it is worth stating because it looks like a lie at
 * first reading. That column's axis is "did a model contribute", not "which surface asked" —
 * `answer_map` versus `llm_parse`, per its own definition in `packages/types`. The form is
 * deterministic worker input, exactly like a chip in the interview, so `answer_map` is the
 * accurate value. WHICH surface asked is already recorded and queryable without widening the
 * enum: a form write carries `packId: null` and `sessionId: null`, and nothing else on that
 * source does.
 */
@Injectable()
export class WorkerPreferencesService {
  private readonly logger = new Logger(WorkerPreferencesService.name);

  constructor(
    private readonly attributes: WorkerAttributesRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async setForWorker(
    workerId: string,
    dto: SetMyPreferencesDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; keys_written: number; keys_cleared: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const rows: NewWorkerAttribute[] = [];
    const cleared: PreferenceKey[] = [];

    // THREE STATES, NOT TWO, and the whole submit path turns on keeping them apart. An ABSENT
    // key means the worker did not reach that page and the stored value must survive; an
    // explicitly NULL scalar means he un-ticked it, which has to remove the row (see
    // `deleteKeys` — the value-present check makes absence the only representation of "no
    // answer"); an EMPTY list means "none of these", which is a real answer and clears the row
    // for the same reason.
    const list = (key: PreferenceKey, values: readonly string[] | undefined) => {
      if (values === undefined) return;
      if (values.length === 0) cleared.push(key);
      else rows.push(this.row(workerId, key, { valueTextList: [...values] }));
    };
    const scalar = (key: PreferenceKey, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) cleared.push(key);
      else rows.push(this.row(workerId, key, { valueText: value }));
    };
    const flag = (key: PreferenceKey, value: boolean | null | undefined) => {
      if (value === undefined) return;
      if (value === null) cleared.push(key);
      else rows.push(this.row(workerId, key, { valueBool: value }));
    };
    // A `numeric` column, so the value is written as a STRING. `worker-attributes.repository.ts`
    // reads it back through `Number()` for the same reason pg returns it as text: a 14,4 numeric
    // must not lose precision on the way out, and every consumer compares it as a JS number.
    const number = (key: PreferenceKey, value: number | null | undefined) => {
      if (value === undefined) return;
      if (value === null) cleared.push(key);
      else rows.push(this.row(workerId, key, { valueNumber: String(value) }));
    };

    list("languages", dto.languages);
    list("documents_ready", dto.documents_ready);
    list("preferred_locations", dto.preferred_cities);
    scalar("job_type", dto.job_type);
    scalar("shift_preference", dto.shift);
    flag("relocation_willingness", dto.willing_to_relocate);
    flag("accommodation_needed", dto.accommodation_needed);
    // R9 §3 — the credential's three missing components. Same three-state contract as everything
    // above: absent leaves the stored value alone, null clears the row.
    number("salary_expected_max", dto.salary_expected_max);
    // R11 §3.1 — which credential the merged `iti_diploma` option covers. Written BESIDE
    // `education_level`, never over it: the level is the interview's answer and stays exactly as
    // the worker gave it.
    scalar("education_credential", dto.education_credential);
    scalar("education_council", dto.education_council);
    number("education_year", dto.education_year);
    scalar("education_institute", dto.education_institute);

    await this.attributes.upsertMany(rows);
    await this.attributes.deleteKeys(workerId, cleared);

    await this.events.emit({
      event_name: "worker.preferences_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // COUNTS, NEVER THE ANSWERS. The individual values are closed-vocabulary labels and would
      // each be harmless, but the SET is not: languages plus preferred cities plus a worker id
      // narrows a person considerably, and an audit trail needs to know the form was answered.
      payload: {
        worker_id: workerId,
        keys_written: rows.length,
        keys_cleared: cleared.length,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts only — never a language, a city or a document name.
    this.logger.log(
      `preferences recorded for worker ${workerId}: ${rows.length} set, ${cleared.length} cleared`,
    );

    await this.enqueueRerender(workerId, ctx);

    return { worker_id: workerId, keys_written: rows.length, keys_cleared: cleared.length };
  }

  /** One attribute row, with the storage kind taken from the vocabulary rather than the caller. */
  private row(
    workerId: string,
    key: PreferenceKey,
    value: Partial<
      Pick<NewWorkerAttribute, "valueText" | "valueTextList" | "valueBool" | "valueNumber">
    >,
  ): NewWorkerAttribute {
    return {
      workerId,
      attributeKey: key,
      // FROM THE VOCABULARY, NOT FROM THE SHAPE OF `value`. `wa_value_present_chk` rejects a row
      // whose `value_kind` disagrees with the column that is populated, so deriving the kind from
      // the one declaration both the DTO and the renderer read is what makes the two impossible
      // to get out of step.
      valueKind: PREFERENCE_KEYS[key],
      valueBool: value.valueBool ?? null,
      valueNumber: value.valueNumber ?? null,
      valueText: value.valueText ?? null,
      valueTextList: value.valueTextList ?? null,
      source: "answer_map",
      questionKey: key,
      // NULL BOTH, and this pair IS the provenance. See the class docstring: a form write is the
      // only `answer_map` row with no pack and no session behind it, which is how "the worker
      // said this on the finishing form" stays queryable without widening `wa_source_chk`.
      packId: null,
      packVersion: null,
      sessionId: null,
    };
  }

  /** Best-effort: a queue that is down must not fail the write the worker just made. */
  private async enqueueRerender(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      // No résumé yet is the ordinary case — the form runs straight after the interview and
      // before the first generate, and that render picks these answers up on its own.
      if (!latest) return;
      await this.renderQueue.add("render", {
        resumeId: latest.id,
        workerId,
        force: true,
        // ADDING a row is not a REMOVAL, so a failed render leaves the previous PDF in service
        // rather than 409-ing a résumé the worker had a second ago. Same call the work-history
        // writer makes, and for the same reason.
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
