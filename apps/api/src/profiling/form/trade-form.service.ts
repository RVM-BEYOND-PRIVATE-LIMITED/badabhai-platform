import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { ChatRepository } from "../../chat/chat.repository";
import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
import { PackRegistryService } from "../pack-registry.service";
import { familyForTradeForm, TRADE_FORM_KINDS, type TradeFormKind } from "../trade-form-router";
import { TradeFormRepository } from "./trade-form.repository";
import type {
  TradeFormAnswerDto,
  TradeFormAnswerResponse,
  TradeFormSchemaResponse,
} from "./trade-form.dto";

/**
 * A question with more options than this gets a search box on the client.
 *
 * COMPUTED, NOT AUTHORED. Twenty-three materials need a search field and four tolerance bands do
 * not, and which of those a question is depends on the pack's data rather than on the trade. An
 * authored flag would drift the first time a pack version gained options and nobody flipped it;
 * a threshold cannot. Twelve is roughly one phone screen of chips at the app's tap target.
 */
export const SEARCHABLE_OPTION_THRESHOLD = 12;

/** The zone headings the ratified sheet prints, so the form reads like the thing it produces. */
const SECTION_TITLES = {
  terms: "Availability & terms",
  work_history: "Work history",
  qualifications: "Qualification, documents & languages",
} as const;

@Injectable()
export class TradeFormService {
  private readonly logger = new Logger(TradeFormService.name);

  constructor(
    private readonly chat: ChatRepository,
    private readonly packs: PackRegistryService,
    private readonly answers: TradeFormRepository,
  ) {}

  /**
   * The whole form, with everything the worker has already said filled in.
   *
   * ONE ROUND TRIP. A form is not an interview: there is no next-question decision to make, so
   * serving it a screen at a time would spend a request per screen for no gain and would make the
   * offline case — a worker on 2G in a shop floor basement — impossible rather than merely slow.
   */
  async schema(workerId: string): Promise<TradeFormSchemaResponse> {
    const kind = await this.formKindFor(workerId);
    const pack = await this.packFor(kind);
    const saved = await this.answers.listAnswers(workerId, pack.pack_id);
    const byKey = new Map(saved.map((row) => [row.questionKey, row]));

    const { ordered, leftover } = this.orderBySheet(pack);
    const capabilityTitle =
      TRADE_RESUME_MAPS.find((map) => map.pack_id === pack.pack_id)?.section_title ??
      "Machines, controllers & capability";

    return {
      kind,
      pack_id: pack.pack_id,
      pack_version: pack.version,
      sections: [
        {
          id: "capability",
          title: capabilityTitle,
          screens: ordered.map((item) => this.questionScreen(item, byKey.get(item.question_key))),
        },
        {
          id: "terms",
          title: SECTION_TITLES.terms,
          screens: [{ type: "preferences", endpoint: "PUT /workers/me/work-preferences" }],
        },
        {
          id: "work_history",
          title: SECTION_TITLES.work_history,
          screens: [{ type: "employment", endpoint: "PUT /workers/me/employment" }],
        },
        {
          id: "qualifications",
          title: SECTION_TITLES.qualifications,
          screens: [
            ...leftover.map((item) => this.questionScreen(item, byKey.get(item.question_key))),
            { type: "preferences", endpoint: "PUT /workers/me/work-preferences" },
          ],
        },
      ],
    };
  }

  /** Save one answer. */
  async answer(
    workerId: string,
    dto: TradeFormAnswerDto,
    _now: Date = new Date(),
  ): Promise<TradeFormAnswerResponse> {
    const kind = await this.formKindFor(workerId);
    const pack = await this.packFor(kind);
    const item = pack.items.find((candidate) => candidate.question_key === dto.question_key);
    // A KEY THIS PACK DOES NOT DEFINE IS A 400, NOT A DROP. Dropping is the silent-truncation
    // shape: the worker taps, the client shows it saved, and the sheet never mentions it. A named
    // rejection lets a version-skewed client say so.
    if (!item) {
      throw new BadRequestException(`question_key ${dto.question_key} is not in ${pack.pack_id}`);
    }

    const row = this.rowFor(workerId, pack, item, dto);
    await this.answers.upsertAnswer(row);

    const saved = await this.answers.listAnswers(workerId, pack.pack_id);
    return {
      question_key: item.question_key,
      status: row.status === "answered" ? "answered" : "declined",
      answered: saved.filter((candidate) => candidate.status !== "unanswered").length,
      total: pack.items.length,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Which form this worker was handed, from the durable record the handover wrote.
   *
   * READ OFF `chat_sessions.conversation_state`, not re-derived. The envelope lives in Redis and
   * is dropped the moment the interview flushes, so the session row is the only thing that still
   * knows — and re-running the router here would make the answer depend on labels this service
   * does not have.
   */
  private async formKindFor(workerId: string): Promise<TradeFormKind> {
    const session = await this.chat.findLatestSessionByWorker(workerId);
    const state = (session?.conversationState ?? null) as { form_kind?: unknown } | null;
    const stored = state?.form_kind;
    const kind = TRADE_FORM_KINDS.find((candidate) => candidate === stored);
    if (!kind) {
      // NOT AN EMPTY FORM. A worker who reaches this URL without a handover has either never
      // interviewed or is not on a trade that has a form, and serving them a CNC turner's
      // eighteen questions would be worse than telling them there is nothing here.
      throw new NotFoundException("this worker has not been handed a trade form");
    }
    return kind;
  }

  private async packFor(kind: TradeFormKind): Promise<QuestionPack> {
    const familyId = familyForTradeForm(kind);
    const pack = await this.packs.loadForFamily(familyId, Date.now());
    if (!pack) {
      // Fails closed and LOUDLY. A form kind whose pack is missing is a corpus/deploy fault, not
      // a worker fault, and an empty form would look like a working one.
      this.logger.error(`trade form ${kind} has no active pack for family ${familyId}`);
      throw new NotFoundException(`no active question pack for ${kind}`);
    }
    return pack;
  }

  /**
   * Pack items in the order the SHEET prints them, with anything the sheet does not print after.
   *
   * THE ARRAY ORDER OF THE RESUME MAP, NOT ITS `rank`. `rank` decides what gets DROPPED when the
   * page overflows; the array order is the locked field order the ratified sample fixes and that
   * §7.1 says may never vary. Ordering the form by rank would ask the worker for their capability
   * in an order their own sheet contradicts.
   *
   * ONE ORDERING, SHARED. Asking in sheet order is not a nicety: a form authored with its own
   * sequence is a second definition of "what matters about this trade", free to drift from the
   * one that actually prints.
   */
  private orderBySheet(pack: QuestionPack): {
    ordered: QuestionPackItem[];
    leftover: QuestionPackItem[];
  } {
    const map = TRADE_RESUME_MAPS.find((candidate) => candidate.pack_id === pack.pack_id);
    const byKey = new Map(pack.items.map((item) => [item.question_key, item]));
    const ordered: QuestionPackItem[] = [];
    for (const row of map?.capability ?? []) {
      const item = byKey.get(row.from);
      // A map row whose question the pack no longer defines is skipped rather than fatal: the two
      // are versioned separately and a stale dictionary row must not take the whole form down.
      if (item) {
        ordered.push(item);
        byKey.delete(row.from);
      }
    }
    // Whatever the sheet has no row for still gets asked — it feeds matching even when it does
    // not print — but it goes last, after everything the worker will actually see on the page.
    return { ordered, leftover: [...byKey.values()] };
  }

  private questionScreen(item: QuestionPackItem, saved: WorkerPackAnswer | undefined) {
    return {
      type: "question" as const,
      question: {
        question_key: item.question_key,
        prompt_text: item.prompt_text,
        why_text: item.why_text,
        answer_type: item.answer_type,
        options: item.options.map((option) => ({
          option_key: option.option_key,
          label_text: option.label_text,
          is_none_of_above: option.is_none_of_above,
        })),
      },
      ui: { searchable: item.options.length > SEARCHABLE_OPTION_THRESHOLD },
      answer:
        saved && saved.status !== "unanswered"
          ? {
              status: saved.status,
              option_keys: saved.answerOptionKeys ?? [],
              text: saved.answerText,
              number: saved.answerNumber,
              bool: saved.answerBool,
            }
          : null,
    };
  }

  /**
   * One answer, typed against the question's DECLARED type.
   *
   * THE QUESTION DECIDES, NOT THE CLIENT. A client that sent chips for a boolean, or text for a
   * multi-select, would otherwise write a row that violates `wpa_answer_shape_chk` at the
   * database — a 500 where a 400 belongs — or, worse, one that satisfies it while meaning
   * something no reader expects.
   */
  private rowFor(
    workerId: string,
    pack: QuestionPack,
    item: QuestionPackItem,
    dto: TradeFormAnswerDto,
  ) {
    const base = {
      workerId,
      // NULL. A form answer has no interview behind it, and `chat_session_id` is provenance
      // rather than ownership — the column is nullable precisely so an answer can outlive, or
      // never have had, a session.
      chatSessionId: null,
      packId: pack.pack_id,
      packVersion: pack.version,
      questionKey: item.question_key,
      source: "form" as const,
    };
    const declined = {
      ...base,
      status: "declined" as const,
      answerText: null,
      answerNumber: null,
      answerBool: null,
      answerOptionKeys: null,
    };

    if (dto.answer.kind === "declined") return declined;

    if (dto.answer.kind === "chips") {
      if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") {
        throw new BadRequestException(`${item.question_key} does not take option keys`);
      }
      const valid = new Set(item.options.map((option) => option.option_key));
      const unknown = dto.answer.option_keys.filter((key) => !valid.has(key));
      if (unknown.length > 0) {
        throw new BadRequestException(`unknown option keys: ${unknown.join(", ")}`);
      }
      if (item.answer_type === "single_select" && dto.answer.option_keys.length > 1) {
        throw new BadRequestException(`${item.question_key} takes one option`);
      }
      // NOTHING TICKED IS A DECLINATION, not an empty answer. The worker looked at the list and
      // none of it applied, which settles the question — an empty array would violate the
      // biconditional the table enforces between `answered` and having a value.
      const keys = [...new Set(dto.answer.option_keys)];
      if (keys.length === 0) return declined;
      return { ...declined, status: "answered" as const, answerOptionKeys: keys };
    }

    if (dto.answer.kind === "boolean") {
      if (item.answer_type !== "boolean") {
        throw new BadRequestException(`${item.question_key} is not a yes/no question`);
      }
      return { ...declined, status: "answered" as const, answerBool: dto.answer.value };
    }

    if (item.answer_type === "number") {
      const parsed = Number(dto.answer.text.replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(parsed)) {
        throw new BadRequestException(`${item.question_key} takes a number`);
      }
      return { ...declined, status: "answered" as const, answerNumber: parsed };
    }
    if (item.answer_type !== "text") {
      throw new BadRequestException(`${item.question_key} does not take free text`);
    }
    return { ...declined, status: "answered" as const, answerText: dto.answer.text };
  }
}
