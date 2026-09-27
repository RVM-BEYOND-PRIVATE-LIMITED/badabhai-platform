import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";

import type { NewWorkerAttribute } from "@badabhai/db";
import type {
  GeneralFormAnswerStatus,
  GeneralFormQuestionKey,
  WorkHistoryState,
} from "@badabhai/types";

import { ChatRepository } from "../../chat/chat.repository";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { WorkerEmploymentRepository } from "../../profiles/worker-employment.repository";
import { PREFERENCE_WIRE_KEYS } from "../../profiles/worker-preferences.dto";
import { EDUCATION_QUALIFICATIONS } from "../../profiles/worker-preferences.vocabulary";
import { WorkerQualificationsRepository } from "../../profiles/worker-qualifications.repository";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../../queue/queue.constants";
import { WorkersRepository } from "../../workers/workers.repository";
import {
  readGeneralFormCompletedAt,
  readGeneralRoadStamp,
  type GeneralRoadStamp,
} from "../conversation-state";
import { briefLength, readStoredBrief, screenBrief, type StoredBrief } from "./general-form-brief";
import {
  BRIEF_REFUSAL_CODES,
  GENERAL_FORM_TERMS_FIELDS,
  type GeneralFormAnswerDto,
  type GeneralFormAnswerError,
  type GeneralFormAnswerResponse,
  type GeneralFormQuestionScreen,
  type GeneralFormSavedAnswer,
  type GeneralFormSchemaResponse,
} from "./general-form.dto";

/**
 * The section headings, in the worker's language where the ADR gave one (R4, §3.3). The first
 * four name the sheet zones they fill, as the trade form's do, so the form reads like the page it
 * produces; the brief's is the heading of the line it writes.
 */
export const GENERAL_FORM_SECTION_TITLES = {
  terms: "Availability & terms",
  work_history: "Work history",
  education: "Education",
  certifications: "Certificates & training",
  brief: "Aapke baare mein",
} as const;

/**
 * The form's two OWN questions, as the app renders them.
 *
 * `has_work_history` IS A BOOLEAN WITH NO OPTIONS, which is how the trade form serves every
 * boolean pack question (`options` defaults to `[]` in the pack schema): the app draws Haan / Nahi
 * itself (`trade_form_question_body.dart`, "boolean's Haan / Nahi are client-owned"). Serving two
 * option chips here would render as a SINGLE-select the app then submits as chips — which this
 * question refuses.
 *
 * NO `why_text` ON IT, deliberately: the ADR gives none, and the copy is not this layer's to
 * invent. The brief's `why_text` is the ADR's (R6, §3.4 — it prints under the headline).
 */
export const GENERAL_FORM_QUESTIONS = {
  has_work_history: {
    question_key: "has_work_history",
    prompt_text: "Kya aapne pehle kahin kaam kiya hai?",
    why_text: null,
    answer_type: "boolean",
    options: [],
  },
  profile_brief: {
    question_key: "profile_brief",
    prompt_text: "Apne kaam ke baare mein 1-2 line batayein",
    why_text: "Ye aapke resume mein sabse upar dikhega.",
    answer_type: "text",
    options: [],
  },
} as const satisfies {
  readonly [K in GeneralFormQuestionKey]: Omit<
    GeneralFormQuestionScreen["question"],
    "question_key" | "options"
  > & { readonly question_key: K; readonly options: readonly never[] };
};

/**
 * The STORAGE keys behind the terms fields, derived from the preferences page's own storage→wire
 * table rather than restated — so the storage key of a terms field (e.g. `preferred_cities` is
 * stored as `preferred_locations`, `shift` as `shift_preference`) has one definition, and a key
 * the page renames moves here with it. The completion event counts these (`terms_keys`).
 */
export const GENERAL_FORM_TERMS_STORAGE_KEYS: readonly string[] = Object.entries(
  PREFERENCE_WIRE_KEYS,
)
  .filter(([, wire]) => (GENERAL_FORM_TERMS_FIELDS as readonly string[]).includes(wire))
  .map(([storage]) => storage);

/** The form's own two attribute keys — the same strings as the question keys, by design. */
const OWN_KEYS: readonly GeneralFormQuestionKey[] = ["has_work_history", "profile_brief"];

// The brief's stored shape (`StoredBriefSchema`) lives in `general-form-brief.ts` beside the walls,
// because the résumé reads the same row — see `readStoredBrief`.

type StoredRow = Awaited<ReturnType<WorkerAttributesRepository["loadKeys"]>>[number];

/** The handover this form belongs to. */
interface FormContext {
  readonly sessionId: string;
  readonly stamp: GeneralRoadStamp;
  /**
   * THIS handover is finished: its session carries the completion mark. Per handover, never
   * derived from the brief row, which is per WORKER and outlives a chat redo — a second handover
   * would otherwise start out "complete" and nothing would ever mark it (or stop its card).
   */
  readonly completed: boolean;
}

/** The form's two answers as stored, narrowed. `undefined` = no readable row. */
interface OwnAnswers {
  readonly hasWorkHistory: boolean | undefined;
  readonly brief: StoredBrief | undefined;
}

/**
 * THE GENERAL FORM (ADR-0045 §3.3) — the offline half of the general road.
 *
 * NO MODEL CALL ANYWHERE IN THIS FILE, and none may be added (R4, R6). Four of the form's five
 * sections are the existing pages, served as markers; the service's own work is two questions,
 * their storage, their events and the completion signal.
 *
 * THE FORM BELONGS TO A HANDOVER. It is found through the newest chat session whose durable stamp
 * says `handed_over` — never through a session id from the request (there is none on this
 * surface) — and every row it writes carries that session as provenance. A worker who was never
 * handed the form gets a 404, which the app reads as "nothing to fill".
 *
 * NOTHING HERE LOGS WORKER TEXT. The brief is screened, stored, measured and counted; the log
 * lines carry worker and session ids and closed codes only.
 */
@Injectable()
export class GeneralFormService {
  private readonly logger = new Logger(GeneralFormService.name);

  constructor(
    // The handover read, and the completion mark the chat reads back.
    private readonly chat: ChatRepository,
    // The form's own two answers, as PACK-LESS rows — see `formRow`.
    private readonly attributes: WorkerAttributesRepository,
    // READ-ONLY here: the completion counts. The pages own every write to these tables.
    private readonly employment: WorkerEmploymentRepository,
    private readonly qualifications: WorkerQualificationsRepository,
    private readonly events: EventsService,
    // The completion re-render reads the latest résumé row, and the brief's name wall reads the
    // worker's own name. WorkersModule is @Global.
    private readonly workers: WorkersRepository,
    // Decrypts that name for the name wall only. CryptoModule is @Global.
    private readonly pii: PiiCryptoService,
    // Produce-only; the processor lives in ResumeModule. Registered in ProfilingModule already.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  /**
   * `GET /profiling/general-form` — the whole form, with the form's own answers replayed.
   *
   * THE PAGE MARKERS CARRY NO VALUES. Each page has its own `GET /workers/me/...` prefill, which
   * already knows how to hand back a stored value safely (partial lists, unreadable rows); this
   * response says only WHERE each page sits in the worker's journey and what it asks.
   */
  async schema(workerId: string): Promise<GeneralFormSchemaResponse> {
    const ctx = await this.contextFor(workerId);
    const own = await this.loadOwnAnswers(workerId);

    return {
      session_id: ctx.sessionId,
      role_label: ctx.stamp.role_label,
      complete: ctx.completed,
      sections: [
        {
          id: "terms",
          title: GENERAL_FORM_SECTION_TITLES.terms,
          screens: [
            {
              type: "preferences",
              endpoint: "PUT /workers/me/work-preferences",
              // ASK-ONLY: every other stored preference must round-trip — see the marker schema.
              fields: [...GENERAL_FORM_TERMS_FIELDS],
            },
          ],
        },
        {
          id: "work_history",
          title: GENERAL_FORM_SECTION_TITLES.work_history,
          screens: [
            this.questionScreen("has_work_history", savedBoolean(own.hasWorkHistory)),
            // HIDDEN ONLY ON AN EXPLICIT "NAHI". Unanswered shows the page: a worker who skips
            // the question and fills in his jobs is the ordinary case, and hiding the page on a
            // missing answer would make R5's only source of experience unreachable.
            //
            // "NAHI" DOES NOT CLEAR A STORED HISTORY. The answer decides whether the page is
            // SHOWN; "Fresher" on the sheet is decided by whether any employment is STORED
            // (§3.4). Deleting jobs because of a tap on a yes/no would be a destructive side
            // effect of a question that does not say it has one.
            ...(own.hasWorkHistory === false
              ? []
              : [
                  {
                    type: "employment" as const,
                    endpoint: "PUT /workers/me/employment" as const,
                    require_start_ym: true as const,
                  },
                ]),
          ],
        },
        {
          id: "education",
          title: GENERAL_FORM_SECTION_TITLES.education,
          screens: [
            {
              type: "qualifications",
              endpoint: "PUT /workers/me/qualifications",
              suggested_certificates: [],
              lists: ["educations"],
              // THE WHOLE VOCABULARY — `postgraduate` and `doctorate` included (ADR-0045 §6). The
              // trade forms' six come from the options endpoint; these eight are this form's own.
              education_options: Object.entries(EDUCATION_QUALIFICATIONS).map(([key, label]) => ({
                key,
                label,
              })),
            },
          ],
        },
        {
          id: "certifications",
          title: GENERAL_FORM_SECTION_TITLES.certifications,
          screens: [
            {
              type: "qualifications",
              endpoint: "PUT /workers/me/qualifications",
              suggested_certificates: [],
              lists: ["certificates", "trainings"],
            },
          ],
        },
        {
          id: "brief",
          title: GENERAL_FORM_SECTION_TITLES.brief,
          screens: [this.questionScreen("profile_brief", savedBrief(own.brief))],
        },
      ],
    };
  }

  /**
   * `POST /profiling/general-form/answer` — save one of the form's own two answers.
   *
   * IDEMPOTENT PER QUESTION: `wa_worker_key_uq` makes a re-answer an overwrite, so a retry on a
   * flaky link cannot duplicate anything, and the completion signal below is once-per-key.
   */
  async answer(
    workerId: string,
    dto: GeneralFormAnswerDto,
    requestCtx?: RequestContext,
    now: Date = new Date(),
  ): Promise<GeneralFormAnswerResponse> {
    const ctx = await this.contextFor(workerId);

    if (dto.question_key === "has_work_history") {
      // BOOLEAN ONLY. `profile.general_form_answered` records a yes/no for this key and cannot
      // express a declined one (its refine: `value` is set iff the key is `has_work_history`),
      // so a decline here would be an answer the audit trail cannot hold.
      if (dto.answer.kind !== "boolean") {
        throw this.refusal("answer_kind_not_allowed", dto.question_key);
      }
      const value = dto.answer.value;
      // Read BEFORE the write: `schema_stale` compares the page's visibility across it.
      const before = await this.loadOwnAnswers(workerId);
      await this.attributes.upsertMany([
        this.formRow(workerId, ctx.sessionId, "has_work_history", { valueBool: value }),
      ]);
      await this.recordAnswered(
        workerId,
        ctx.sessionId,
        {
          question_key: "has_work_history",
          status: "answered",
          value: value ? "yes" : "no",
          chars: null,
        },
        requestCtx,
      );
      return {
        question_key: "has_work_history",
        status: "answered",
        complete: ctx.completed,
        // THE PAGE'S VISIBILITY, not the value, is what the client's screen list depends on:
        // unanswered and "Haan" both show the work-history page, only "Nahi" hides it.
        schema_stale: (before.hasWorkHistory === false) !== (value === false),
      };
    }

    // profile_brief — typed text or a decline, never a boolean.
    if (dto.answer.kind === "boolean") {
      throw this.refusal("answer_kind_not_allowed", dto.question_key);
    }
    let brief: StoredBrief;
    if (dto.answer.kind === "text") {
      const screened = screenBrief(dto.answer.text, await this.knownName(workerId));
      // REFUSED WHOLE, NAMED BY ITS REASON, NEVER QUOTED — not in the 400, not in a log line.
      if (!screened.ok) throw this.refusal(BRIEF_REFUSAL_CODES[screened.reason], dto.question_key);
      brief = { status: "answered", text: screened.text };
    } else {
      brief = { status: "declined" };
    }
    await this.attributes.upsertMany([
      this.formRow(workerId, ctx.sessionId, "profile_brief", { valueJson: brief }),
    ]);
    await this.recordAnswered(
      workerId,
      ctx.sessionId,
      {
        question_key: "profile_brief",
        status: brief.status,
        value: null,
        chars: brief.status === "answered" ? briefLength(brief.text) : null,
      },
      requestCtx,
    );

    // THE BRIEF IS THE FORM'S LAST QUESTION, so settling it — answered OR declined — is the
    // form's finish line (the completed event's own definition). Evaluated on every brief write:
    // the event is once-per-key and the mark write-once, so a re-submitted brief re-runs them as
    // no-ops, which is also what heals a completion whose first attempt failed.
    await this.complete(workerId, ctx.sessionId, brief.status, requestCtx, now);

    return {
      question_key: "profile_brief",
      status: brief.status,
      complete: true,
      schema_stale: false,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * The handover this worker was given, from the durable record the chat wrote.
   *
   * THE HANDOVER SESSION, NOT THE LATEST ONE — see `findLatestGeneralHandoverSession`. The stamp
   * is then parsed with the one strict reader every consumer uses, and anything short of a
   * readable stamp that says `handed_over` is a 404: no form was handed over that this build can
   * read. The owner check is defence in depth; the query is already scoped to the worker.
   */
  private async contextFor(workerId: string): Promise<FormContext> {
    const session = await this.chat.findLatestGeneralHandoverSession(workerId);
    const stamp = session ? readGeneralRoadStamp(session.conversationState) : null;
    if (!session || session.workerId !== workerId || stamp?.handed_over !== true) {
      throw new NotFoundException("this worker has not been handed the general form");
    }
    return {
      sessionId: session.id,
      stamp,
      completed: readGeneralFormCompletedAt(session.conversationState) !== null,
    };
  }

  /**
   * The worker's OWN name, decrypted, for the brief's name wall — or `null` when none is stored.
   *
   * FAILS CLOSED, the opposite of `redactKnownName`'s callers: there a failed decrypt costs a
   * redaction behind a gate that still runs; here the brief goes verbatim onto the employer copy,
   * which prints only the name's initials. A name that exists but cannot be read is a wall that
   * did not run, so the brief is refused as `unscreenable`. The plaintext is used for the match
   * only — never logged, evented or stored.
   */
  private async knownName(workerId: string): Promise<string | null> {
    const worker = await this.workers.findById(workerId);
    if (!worker?.fullName) return null;
    try {
      return this.pii.decrypt(worker.fullName);
    } catch {
      this.logger.warn(
        `general-form brief for worker ${workerId} refused: the stored name could not be decrypted`,
      );
      throw this.refusal(BRIEF_REFUSAL_CODES.unscreenable, "profile_brief");
    }
  }

  /** The form's own two rows, narrowed. A row of the wrong kind or shape reads as unanswered. */
  private async loadOwnAnswers(workerId: string): Promise<OwnAnswers> {
    const rows = await this.attributes.loadKeys(workerId, OWN_KEYS);
    const byKey = new Map(rows.map((row) => [row.attributeKey, row]));
    return {
      hasWorkHistory: storedBoolean(byKey.get("has_work_history")),
      brief: storedBrief(byKey.get("profile_brief")),
    };
  }

  /**
   * One PACK-LESS `worker_attributes` row — `WorkerPreferencesService.row`'s shape, plus the
   * handover session as provenance.
   *
   * PACK-LESS IS THE SAFETY PROPERTY (§3.3): the sheet's trade is elected only from rows WITH a
   * pack (`loadTradeSheet`), so a fresh `updated_at` here can never re-pick the trade the whole
   * sheet renders as; matching skips null-pack rows too (R7). `packId`/`packVersion` are null
   * TOGETHER, which `wa_pack_pin_chk` requires. `source: "answer_map"` because that column's axis
   * is "did a model contribute", and nothing did.
   */
  private formRow(
    workerId: string,
    sessionId: string,
    key: GeneralFormQuestionKey,
    value: { readonly valueBool: boolean } | { readonly valueJson: StoredBrief },
  ): NewWorkerAttribute {
    const isBool = "valueBool" in value;
    return {
      workerId,
      attributeKey: key,
      valueKind: isBool ? "boolean" : "json",
      valueBool: isBool ? value.valueBool : null,
      valueNumber: null,
      valueText: null,
      valueTextList: null,
      valueJson: isBool ? null : { ...value.valueJson },
      source: "answer_map",
      questionKey: key,
      packId: null,
      packVersion: null,
      sessionId,
    };
  }

  /** A question screen in the trade form's exact shape (`TradeFormService.questionScreen`). */
  private questionScreen(
    key: GeneralFormQuestionKey,
    answer: GeneralFormSavedAnswer | null,
  ): GeneralFormQuestionScreen {
    const question = GENERAL_FORM_QUESTIONS[key];
    return {
      type: "question",
      question: { ...question, options: [] },
      ui: { searchable: false },
      answer,
      suggestion: null,
    };
  }

  /**
   * A 400 with a CLOSED code and a neutral message. Built here so no call site can put the
   * worker's text in it by accident: the only inputs are a code and a question key, both closed.
   */
  private refusal(
    code: GeneralFormAnswerError["code"],
    questionKey: GeneralFormQuestionKey,
  ): BadRequestException {
    const body: GeneralFormAnswerError = {
      code,
      message: `the ${questionKey} answer was not saved (${code})`,
    };
    return new BadRequestException(body);
  }

  /**
   * `profile.general_form_answered` — one per write. SWALLOWS ITS OWN FAILURE, like the trade
   * form's completion: the answer is already durable, and failing the request would have the
   * client retry a write that succeeded. The log line is the fallback record, and it carries ids
   * and the key only.
   */
  private async recordAnswered(
    workerId: string,
    sessionId: string,
    fields: {
      readonly question_key: GeneralFormQuestionKey;
      readonly status: GeneralFormAnswerStatus;
      readonly value: "yes" | "no" | null;
      readonly chars: number | null;
    },
    requestCtx: RequestContext | undefined,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "profile.general_form_answered",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, session_id: sessionId, ...fields },
        correlationId: requestCtx?.correlationId,
        requestId: requestCtx?.requestId,
      });
    } catch (error) {
      // The payload carries ids, closed states and a LENGTH — never the brief — so neither the
      // validator's message nor the database's can echo the worker's words into this line.
      this.logger.error(
        `general-form ${fields.question_key} answer for worker ${workerId} was saved but not ` +
          `recorded as an event: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  /**
   * The form is FINISHED: the event, the chat's completion mark, and a résumé refresh.
   *
   * THREE INDEPENDENT STEPS, EACH BEST-EFFORT. The brief is already durable, so none may fail the
   * request, and none may cost the others: a failed count read must not keep the chat offering a
   * finished form, and a failed mark must not lose the audit event.
   */
  private async complete(
    workerId: string,
    sessionId: string,
    brief: GeneralFormAnswerStatus,
    requestCtx: RequestContext | undefined,
    now: Date,
  ): Promise<void> {
    await this.recordCompleted(workerId, sessionId, brief, requestCtx);

    // The chat stops re-serving the card for this handover (`durableGeneralFormOffer`).
    try {
      await this.chat.markGeneralFormCompleted(sessionId, workerId, now);
    } catch (error) {
      this.logger.error(
        `general-form completion mark for worker ${workerId} session ${sessionId} not written; ` +
          `the chat will keep offering the form until the brief is saved again: ` +
          `${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    await this.enqueueRerender(workerId, requestCtx);
  }

  /**
   * `profile.general_form_completed` — ONCE PER (WORKER, HANDOVER SESSION), by idempotency key: a
   * worker who re-saves the brief satisfies the finish line again, and without the key every edit
   * would count as another completion.
   *
   * THE COUNTS ARE WHAT THE RÉSUMÉ WILL CARRY, read from the tables the pages wrote. Employment is
   * read through `loadForResume` — the résumé's own read, which drops a row whose employer name
   * will not decrypt — so `employments` is the number of jobs that will actually print, and
   * `employments_dated` the ones R5's total can count.
   */
  private async recordCompleted(
    workerId: string,
    sessionId: string,
    brief: GeneralFormAnswerStatus,
    requestCtx: RequestContext | undefined,
  ): Promise<void> {
    try {
      const [jobs, credentials, stored] = await Promise.all([
        this.employment.loadForResume(workerId),
        this.qualifications.loadForResume(workerId),
        this.attributes.loadKeys(workerId, [
          ...GENERAL_FORM_TERMS_STORAGE_KEYS,
          "has_work_history",
        ]),
      ]);
      const terms = new Set(GENERAL_FORM_TERMS_STORAGE_KEYS);
      const hasWorkHistory = storedBoolean(
        stored.find((r) => r.attributeKey === "has_work_history"),
      );
      const workHistory: WorkHistoryState =
        hasWorkHistory === undefined ? "unanswered" : hasWorkHistory ? "yes" : "no";

      await this.events.emit({
        event_name: "profile.general_form_completed",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        // COUNTS AND CLOSED STATES ONLY — never an employer, a credential or the brief.
        payload: {
          worker_id: workerId,
          session_id: sessionId,
          brief,
          has_work_history: workHistory,
          employments: jobs.length,
          employments_dated: jobs.filter((job) => job.startYm !== null).length,
          educations: credentials.educations.length,
          certificates: credentials.certificates.length,
          trainings: credentials.trainings.length,
          terms_keys: stored.filter((row) => terms.has(row.attributeKey)).length,
        },
        idempotencyKey: `profile.general_form_completed:${workerId}:${sessionId}`,
        correlationId: requestCtx?.correlationId,
        requestId: requestCtx?.requestId,
      });
    } catch (error) {
      this.logger.error(
        `general-form completion for worker ${workerId} session ${sessionId} was not recorded; ` +
          `the answers are saved but the funnel will read as an abandonment: ` +
          `${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  /**
   * A FORCED re-render of an EXISTING résumé — `WorkerPreferencesService.enqueueRerender`'s call,
   * for its reasons: LLM-free (the render reads the live attributes and tables at run time), in
   * place (same row and object key), and `failClosed: false` because adding a brief removes
   * nothing a stale PDF could leak.
   *
   * NO RÉSUMÉ, NO JOB: the ordinary case. After the form the app runs extract → confirm →
   * generate (§3.4), and that generate mints version 1 from what the form stored.
   *
   * NO `jobId`, like the preferences page: BullMQ refuses a custom id containing ":", and the
   * trade form's safety net shipped a colon-bearing id that failed every enqueue in silence.
   *
   * NEVER THROWS: the brief is saved; a queue that is down costs a refresh, not the answer.
   */
  private async enqueueRerender(
    workerId: string,
    requestCtx: RequestContext | undefined,
  ): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      if (!latest) return;
      await this.renderQueue.add("render", {
        resumeId: latest.id,
        workerId,
        force: true,
        failClosed: false,
        correlationId: requestCtx?.correlationId ?? "general-form-complete",
        requestId: requestCtx?.requestId ?? "general-form-complete",
      });
    } catch (error) {
      this.logger.warn(
        `general-form resume refresh skipped for worker ${workerId} (${
          error instanceof Error ? error.message : "unknown"
        }); the brief is saved, the resume updates on the next generate`,
      );
    }
  }
}

// ── pure narrowers ────────────────────────────────────────────────────────────

function storedBoolean(row: StoredRow | undefined): boolean | undefined {
  if (!row || row.valueKind !== "boolean" || typeof row.valueBool !== "boolean") return undefined;
  return row.valueBool;
}

function storedBrief(row: StoredRow | undefined): StoredBrief | undefined {
  if (!row || row.valueKind !== "json") return undefined;
  return readStoredBrief(row.valueJson);
}

/** The trade form's saved-answer shape for a yes/no. */
function savedBoolean(value: boolean | undefined): GeneralFormSavedAnswer | null {
  if (value === undefined) return null;
  return {
    status: "answered",
    option_keys: [],
    text: null,
    number: null,
    bool: value,
    other_text: null,
  };
}

/** The trade form's saved-answer shape for the brief: the text as stored, or a decline. */
function savedBrief(brief: StoredBrief | undefined): GeneralFormSavedAnswer | null {
  if (brief === undefined) return null;
  return {
    status: brief.status,
    option_keys: [],
    text: brief.status === "answered" ? brief.text : null,
    number: null,
    bool: null,
    other_text: null,
  };
}
