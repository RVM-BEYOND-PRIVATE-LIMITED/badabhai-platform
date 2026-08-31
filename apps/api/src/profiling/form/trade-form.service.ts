import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import type { AnswerRecord, QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { ChatRepository } from "../../chat/chat.repository";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { projectProfile } from "../answer-map-projector";
import { packAnswerRowFor } from "../pack-answer-row";
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
    // THE SECOND DESTINATION, and the one the SHEET actually reads. See `answer()`.
    private readonly attributes: WorkerAttributesRepository,
  ) {}

  /**
   * The whole form, with everything the worker has already said filled in.
   *
   * ONE ROUND TRIP. A form is not an interview: there is no next-question decision to make, so
   * serving it a screen at a time would spend a request per screen for no gain and would make the
   * offline case — a worker on 2G in a shop floor basement — impossible rather than merely slow.
   */
  async schema(workerId: string): Promise<TradeFormSchemaResponse> {
    const { kind } = await this.contextFor(workerId);
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
    const ctx = await this.contextFor(workerId);
    const pack = await this.packFor(ctx.kind);
    const item = pack.items.find((candidate) => candidate.question_key === dto.question_key);
    // A KEY THIS PACK DOES NOT DEFINE IS A 400, NOT A DROP. Dropping is the silent-truncation
    // shape: the worker taps, the client shows it saved, and the sheet never mentions it. A named
    // rejection lets a version-skewed client say so.
    if (!item) {
      throw new BadRequestException(`question_key ${dto.question_key} is not in ${pack.pack_id}`);
    }

    // ── ONE ANSWER, TWO DESTINATIONS, ONE NORMALISATION ────────────────────────────────
    //
    // THE DEFECT THIS CLOSES. The capability rows on the trade sheet are read from
    // `worker_attributes` (`loadTradeSheet`), and the ONLY writer of those from an interview is
    // the extraction processor: `projectProfile(answerMap)` -> `projection.attributes` ->
    // `upsertMany`. The trade-form handover deliberately switches extraction OFF (a two-turn
    // transcript yields a container that outranks the answer map and blanks the sheet), which
    // also cut the only path that FILLS the capability zone. A worker could complete every
    // question in this form and their sheet would print an empty capability section.
    //
    // ONE NORMALISATION, NOT TWO. The value is resolved once, here, exactly as
    // `answer-capture.matchOptions` resolves it for the interview, and then handed to the SAME
    // two builders the interview uses -- `packAnswerRowFor` and `projectProfile`. That is what
    // makes a form answer and an interview answer to the same question produce byte-identical
    // rows in both tables. Hand-shaping the columns here, as the first version of this file did,
    // silently stored option KEYS where the interview stores option VALUES and put a
    // single-select in `answer_option_keys` where the interview puts it in `answer_text` -- two
    // shapes for one question type in one column, which happened to work only because this
    // pack's keys and values are spelled the same.
    const record = this.recordFor(item, dto);
    const row = packAnswerRowFor({
      workerId,
      sessionId: ctx.sessionId,
      packId: pack.pack_id,
      packVersion: pack.version,
      record,
      source: "form",
    });
    // `packAnswerRowFor` returns null only for a record that is neither answered nor declined,
    // and `recordFor` produces exactly those two. Asserted rather than assumed: a silent skip
    // here is an answer the worker watched save and that never existed.
    if (row === null) {
      throw new BadRequestException(`${item.question_key} produced no storable answer`);
    }
    await this.answers.upsertAnswer(row);

    // THE SHEET'S OWN SOURCE. `projectProfile` is the interview's projector, run over this one
    // record: same crosswalk, same typing, same `attributeKey`, so the sheet cannot tell which
    // surface an answer arrived through. An attribute-less question (target_kind: none) simply
    // yields nothing and writes nothing.
    const { attributes } = projectProfile([record]);
    if (attributes.length > 0) {
      await this.attributes.upsertMany(
        attributes.map((attribute) => ({
          workerId,
          attributeKey: attribute.attributeKey,
          valueKind: attribute.valueKind,
          valueBool: attribute.valueKind === "boolean" ? (attribute.value as boolean) : null,
          valueNumber: attribute.valueKind === "number" ? String(attribute.value as number) : null,
          valueText: attribute.valueKind === "text" ? (attribute.value as string) : null,
          valueTextList:
            attribute.valueKind === "text_list"
              ? [...(attribute.value as readonly string[])]
              : null,
          source: attribute.source,
          questionKey: attribute.attributeKey,
          packId: pack.pack_id,
          packVersion: pack.version,
          sessionId: ctx.sessionId,
        })),
      );
    }

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
  private async contextFor(workerId: string): Promise<{ kind: TradeFormKind; sessionId: string }> {
    const session = await this.chat.findLatestSessionByWorker(workerId);
    const state = (session?.conversationState ?? null) as { form_kind?: unknown } | null;
    const stored = state?.form_kind;
    const kind = TRADE_FORM_KINDS.find((candidate) => candidate === stored);
    if (!kind || !session) {
      // NOT AN EMPTY FORM. A worker who reaches this URL without a handover has either never
      // interviewed or is not on a trade that has a form, and serving them a CNC turner's
      // eighteen questions would be worse than telling them there is nothing here.
      throw new NotFoundException("this worker has not been handed a trade form");
    }
    // THE INTERVIEW THAT HANDED THEM HERE, carried onto every row this form writes. Honest
    // provenance rather than a null: `worker_pack_answer.chat_session_id` and
    // `worker_attributes.session_id` both mean "which conversation produced this", and for a
    // form answer the truthful answer is the interview that routed the worker to the form.
    return { kind, sessionId: session.id };
  }

  private async packFor(kind: TradeFormKind): Promise<QuestionPack> {
    const familyId = familyForTradeForm(kind);
    const pack = await this.packs.loadForFamily(familyId, Date.now());
    if (!pack) {
      // A SERVER FAULT, AND IT MUST NOT BE REPORTED AS THE WORKER'S EMPTY FORM.
      //
      // This threw 404 until it bit for real: a worker who HAD been handed a form tapped the CTA
      // and got "aapke liye koi form taiyaar nahi kiya gaya hai" — because the client maps 404 to
      // exactly that screen, which is the right reading of 404 on this route and a lie in this
      // case. The pack is missing from the DATABASE, not from the worker's entitlement, and the
      // two must not share a status code.
      //
      // HOW IT HAPPENS, because it will happen again to the next pack. Seeding is manual, like
      // migrations: `db:seed:packs --apply` runs in the e2e job against an ephemeral Postgres,
      // and the deploy job seeds nothing. So a new pack ships in the image, passes every test,
      // deploys green, and is simply absent from the database it is read from — announced by a
      // log line nobody was watching and a calm screen the worker was.
      //
      // 503 rather than 500: the fix is to run the seed, not to change code, so it is transient
      // in the only sense that matters and the client is right to offer a retry.
      this.logger.error(
        `trade form ${kind} has no active pack for family ${familyId} — run ` +
          `\`pnpm --filter @badabhai/db db:seed:packs --apply\` against this database`,
      );
      throw new ServiceUnavailableException(`no active question pack for ${kind}`);
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
              // BACK THROUGH THE OPTION TABLE, not read straight off the column. What is stored
              // is the NORMALISED VALUE (`option.value`), because that is what the interview
              // stores and what the resume map is keyed by; what the client needs to pre-select
              // a chip is the option KEY. They are spelled the same in this pack and are not
              // required to be, so the round trip is done properly rather than by coincidence.
              option_keys: selectedKeys(item, saved),
              text: saved.answerText,
              number: saved.answerNumber,
              bool: saved.answerBool,
            }
          : null,
    };
  }

  /**
   * One answer as an {@link AnswerRecord} — the interview's own currency.
   *
   * THE QUESTION DECIDES ITS TYPE, NOT THE CLIENT. A client that sent chips for a boolean, or
   * text for a multi-select, would otherwise write a row that violates `wpa_answer_shape_chk`
   * at the database — a 500 where a 400 belongs — or, worse, one that satisfies it while
   * meaning something no reader expects.
   *
   * OPTIONS RESOLVE TO `option.value ?? option.label_text`, which is exactly what
   * `answer-capture.matchOptions` stores for the same tap in an interview. The resume map is
   * keyed by that value, so storing the option KEY instead would leave every chip the worker
   * picked unrenderable on the sheet the moment a pack spells its keys and values differently.
   *
   * A SINGLE-SELECT IS A SCALAR, a multi-select is an array. `typedAnswerColumns` then puts the
   * first in `answer_text` and the second in `answer_option_keys`, which is the shape the
   * interview already writes — one question type, one column, one meaning.
   */
  private recordFor(item: QuestionPackItem, dto: TradeFormAnswerDto): AnswerRecord {
    const base = {
      question_key: item.question_key,
      target_field: item.target_field,
      value_raw: null,
      evidence: null,
      // A FORM HAS NO TURNS. Zero is the honest value, not a fabricated ordinal.
      turn: 0,
      history: [],
    };
    const declined: AnswerRecord = { ...base, value_normalized: null, status: "declined" };

    if (dto.answer.kind === "declined") return declined;

    if (dto.answer.kind === "chips") {
      if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") {
        throw new BadRequestException(`${item.question_key} does not take option keys`);
      }
      const byKey = new Map(item.options.map((option) => [option.option_key, option]));
      const unknown = dto.answer.option_keys.filter((key) => !byKey.has(key));
      if (unknown.length > 0) {
        throw new BadRequestException(`unknown option keys: ${unknown.join(", ")}`);
      }
      if (item.answer_type === "single_select" && dto.answer.option_keys.length > 1) {
        throw new BadRequestException(`${item.question_key} takes one option`);
      }
      const keys = [...new Set(dto.answer.option_keys)];
      // NOTHING TICKED IS A DECLINATION, not an empty answer. The worker looked at the list and
      // none of it applied, which settles the question — an empty array would violate the
      // biconditional the table enforces between `answered` and having a value.
      if (keys.length === 0) return declined;
      const values = keys.map((key) => optionValue(byKey.get(key)!));
      return {
        ...base,
        value_normalized: item.answer_type === "single_select" ? values[0]! : values,
        status: "answered",
      };
    }

    if (dto.answer.kind === "boolean") {
      if (item.answer_type !== "boolean") {
        throw new BadRequestException(`${item.question_key} is not a yes/no question`);
      }
      return { ...base, value_normalized: dto.answer.value, status: "answered" };
    }

    if (item.answer_type === "number") {
      const parsed = Number(dto.answer.text.replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(parsed)) {
        throw new BadRequestException(`${item.question_key} takes a number`);
      }
      return { ...base, value_normalized: parsed, status: "answered" };
    }
    if (item.answer_type !== "text") {
      throw new BadRequestException(`${item.question_key} does not take free text`);
    }
    return { ...base, value_normalized: dto.answer.text, status: "answered" };
  }
}

/** What an interview stores for a tapped chip — see `answer-capture.matchOptions`. */
function optionValue(option: QuestionPackItem["options"][number]): string {
  return typeof option.value === "string" && option.value.length > 0
    ? option.value
    : option.label_text;
}

/**
 * The option KEYS a stored answer corresponds to, for pre-selecting chips on a resumed form.
 *
 * Matched on the stored VALUE, which is what both columns actually hold: `answer_text` for a
 * single-select and `answer_option_keys` for a multi-select (the column name predates the
 * distinction and is a misnomer — it holds values).
 */
function selectedKeys(item: QuestionPackItem, saved: WorkerPackAnswer): string[] {
  const stored = new Set<string>([
    ...(saved.answerOptionKeys ?? []),
    ...(typeof saved.answerText === "string" ? [saved.answerText] : []),
  ]);
  if (stored.size === 0) return [];
  return item.options
    .filter((option) => stored.has(optionValue(option)))
    .map((option) => option.option_key);
}
