import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import type { AnswerRecord, QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerPackAnswer } from "@badabhai/db";
import type { ProfilingTier } from "@badabhai/types";

import { ChatRepository } from "../../chat/chat.repository";
import type { AiRequestContext } from "../../ai/ai.service";
import type { RequestContext } from "../../common/request-context";
import { SERVER_CONFIG } from "../../config/config.module";
import { EventsService } from "../../events/events.service";
import { WorkerSkillsService } from "../../match/worker-skills.service";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../../queue/queue.constants";
import { WorkersRepository } from "../../workers/workers.repository";
import { projectProfile } from "../answer-map-projector";
import { packAnswerRowFor, otherAnswerValue } from "../pack-answer-row";
import { OtherAnswerPolishService } from "../other-answer-polish.service";
import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
import { PackRegistryService } from "../pack-registry.service";
import { familyForTradeForm, TRADE_FORM_KINDS, type TradeFormKind } from "../trade-form-router";
import { descriptorForKind } from "../roles/role-registry";
import { answerMapFromRows, gateKeysOf, isFormQuestionVisible } from "./form-eligibility";
import type { AnswerMap } from "../answer-map";
import {
  ResumeSuggestionReader,
  type ResumeSuggestion,
} from "../resume-import/resume-suggestion-reader";
import { ResumeImportRepository } from "../resume-import/resume-import.repository";
import { isLegacyFormUniversalKey } from "./legacy-universal-answer";
import { parseStrictNumber } from "./strict-number";
import { TradeFormRepository } from "./trade-form.repository";
import { pageRevealFields, pageTierScope, type TieredPage } from "../tiers/profiling-tier.policy";
import {
  ProfilingTierService,
  type FormTierScope,
  type TierFormContext,
} from "../tiers/profiling-tier.service";
import type { ChooseTierResponse, TierStateResponse } from "../tiers/profiling-tier.dto";
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

/**
 * How long the safety-net resume re-render (`refreshResumeAfterCapabilityEdit`) waits before
 * running. Long enough to stay off the onboarding hot path (a walk's own answers and the
 * building screen's generate all land first), short enough that an abandoned walk's Resume
 * tab heals within minutes rather than forever. The job renders the LIVE attributes at run
 * time, so every ordering of this job against the walk's answers and the building generate
 * converges on the freshest state.
 */
const RESUME_REFRESH_DELAY_MS = 60_000;

/**
 * What `recordFor` does with number-field text that is not exactly one number.
 *
 * `reject` — a 400, for a question this form serves: the client can tell the worker to type a
 * number. `decline` — a declined record, for the legacy-key shim only: the screen is one the app
 * should no longer be showing, and a dead end there is worse than an honest "not answered".
 */
type UnparseableNumberPolicy = "reject" | "decline";

/** The one reading of "what this form asks this worker right now", shared by both endpoints. */
interface FormView {
  /** Every `worker_pack_answer` row stored under this form's pack, any version. */
  readonly saved: readonly WorkerPackAnswer[];
  /** Capability-zone questions still asked, in sheet order. */
  readonly ordered: readonly QuestionPackItem[];
  /** Questions the sheet has no row for, still asked — served in the qualifications zone. */
  readonly leftover: readonly QuestionPackItem[];
  /** EXACTLY the question screens `schema()` serves: `ordered` then `leftover`. */
  readonly visibleItems: readonly QuestionPackItem[];
}

@Injectable()
export class TradeFormService {
  private readonly logger = new Logger(TradeFormService.name);

  constructor(
    private readonly chat: ChatRepository,
    private readonly packs: PackRegistryService,
    private readonly answers: TradeFormRepository,
    // THE SECOND DESTINATION, and the one the SHEET actually reads. See `answer()`.
    private readonly attributes: WorkerAttributesRepository,
    // The completion half of the form funnel. See `recordCompletion`.
    private readonly events: EventsService,
    // M1 — the matching layer's rebuild, enqueued when the form completes. READ-ONLY as far as
    // this service is concerned: it hands over a worker id and never learns what was derived.
    private readonly workerSkills: WorkerSkillsService,
    // ADR-0041 RI-4. READ-ONLY, and the only thing this service asks it for is what a résumé
    // suggested — never whether one exists, never its storage key. A form must render
    // identically for a worker who uploaded nothing, which is the invariant the whole feature
    // ships under.
    private readonly resumeSuggestions: ResumeSuggestionReader,
    // ADR-0041 RI-4 fallback. When a worker reaches the form through résumé upload rather than
    // an interview, `chat_sessions` has no `form_kind`. The résumé-import row carries it, and
    // this is the only service that needs to read it — giving it the repository would also
    // hand it the storage key, the mime and the write path, which the form must never have.
    private readonly resumeImports: ResumeImportRepository,
    // "TYPED CUSTOM ANSWER, EVERYWHERE" (round-4 ruling) — reviews a worker's typed "other" text
    // the same way `WorkHistoryPolishService` reviews a stint description. FIRED, NEVER AWAITED
    // INLINE — see `triggerOtherAnswerPolish` below for why and for what that does and does not
    // buy the worker today.
    private readonly otherAnswerPolish: OtherAnswerPolishService,
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "WORK_HISTORY_POLISH_ENABLED">,
    // The safety-net resume refresh below reads the latest resume row. WorkersModule is
    // @Global(), so this adds no module edge (see profiling.module.ts).
    private readonly workers: WorkersRepository,
    // Produce-only: this service enqueues re-renders; the processor lives in ResumeModule.
    // The queue is already registered in THIS module (see profiling.module.ts).
    @InjectQueue(RESUME_RENDER_QUEUE)
    private readonly renderQueue: Queue<ResumeRenderJobData>,
    // TIERED PROFILING. OPTIONAL SO ITS ABSENCE IS TODAY'S FORM: a construction without it (every
    // pre-tier test) serves Hard, exactly as `PROFILING_TIERS_ENABLED` off does.
    @Optional() private readonly tiers?: ProfilingTierService,
  ) {}

  /**
   * The whole form, with everything the worker has already said filled in.
   *
   * ONE ROUND TRIP. A form is not an interview: there is no next-question decision to make, so
   * serving it a screen at a time would spend a request per screen for no gain and would make the
   * offline case — a worker on 2G in a shop floor basement — impossible rather than merely slow.
   */
  async schema(
    workerId: string,
    mode: "full" | "upgrade" = "full",
  ): Promise<TradeFormSchemaResponse> {
    const { kind, sessionId } = await this.contextFor(workerId);
    const pack = await this.packFor(kind);
    // TIERED PROFILING — null while the flag is off, and the form below is then byte-for-byte
    // today's (Hard) form: no screen dropped, no field added to the response.
    const scope = (await this.tiers?.formScope(workerId, pack)) ?? null;
    const view = await this.formView(workerId, kind, pack, scope);
    const byKey = new Map(view.saved.map((row) => [row.questionKey, row]));
    // THE UPGRADE VIEW ("Add more detail"): only questions this tier asks that are still
    // unsettled — an answer already given, or declined, is never asked again. ONLY WHILE TIERS
    // ARE ON: with the flag off `?view=upgrade` is today's full form, so the parameter can never
    // change a flag-off response.
    const upgrade = mode === "upgrade" && scope !== null;
    const unsettled = (item: QuestionPackItem): boolean =>
      !upgrade || (byKey.get(item.question_key)?.status ?? "unanswered") === "unanswered";
    // A page is re-served on an upgrade only if the tier adds fields to it (`pageRevealFields`),
    // and it then names exactly those fields; the client asks only the ones with no saved value.
    const pageServed = (page: TieredPage): boolean =>
      !upgrade || pageRevealFields(page, scope.tier).length > 0;
    const tierScopeOf = (page: TieredPage) =>
      scope
        ? {
            tier_scope: {
              ...pageTierScope(page, scope.tier),
              ...(upgrade ? { reveal_fields: pageRevealFields(page, scope.tier) } : {}),
            },
          }
        : {};

    // FAILS SOFT, DELIBERATELY. A suggestion is a convenience; the form is the worker's actual
    // task. If the import row is unreadable or its payload will not decrypt he gets today's
    // form rather than an error — the same posture ruling D9 sets for every other résumé path.
    //
    // ONLY THE TRADE PACK'S KEYS CAN CARRY ONE NOW (#1503). The universal questions most résumé
    // suggestions target — experience, city, salary, education, availability — are no longer
    // question screens here: those facts belong to the pages that own them (owner ruling
    // 2026-09-15), and until those pages render suggestions a form-routed worker sees none of
    // them. That gap is tracked on #1503/#1504 and recorded in ADR-0041 §9.
    const suggestions = await this.resumeSuggestions.forWorker(workerId);

    const tradeMap = TRADE_RESUME_MAPS.find((map) => map.pack_id === pack.pack_id);
    // The sheet's heading AT THIS TIER, so the form reads like the page it produces.
    const capabilityTitle =
      (scope ? tierSectionTitle(tradeMap, scope.tier) : undefined) ??
      tradeMap?.section_title ??
      "Machines, controllers & capability";

    return {
      kind,
      pack_id: pack.pack_id,
      pack_version: pack.version,
      session_id: sessionId,
      // Present only while tiers are on, so a flag-off response is exactly today's.
      ...(scope ? { profiling_tier: scope.tier } : {}),
      sections: [
        {
          id: "capability",
          title: capabilityTitle,
          // NOTHING BUT THE TRADE PACK'S OWN QUESTIONS IS SERVED (#1503). `f455bb36` appended all
          // eight `qp_universal@2` questions here, and five were facts this same response already
          // hands to a marker page or to the tier question — a worker answered each twice, and the
          // page's write raced the question's. `trade-form-fact-uniqueness.contract.test.ts` holds
          // this against the real universal pack for every enabled role.
          screens: view.ordered
            .filter(unsettled)
            .map((item) => this.questionScreen(item, byKey.get(item.question_key), suggestions)),
        },
        {
          id: "terms",
          title: SECTION_TITLES.terms,
          screens: pageServed("preferences")
            ? [
                {
                  type: "preferences" as const,
                  endpoint: "PUT /workers/me/work-preferences" as const,
                  ...tierScopeOf("preferences"),
                },
              ]
            : [],
        },
        {
          id: "work_history",
          title: SECTION_TITLES.work_history,
          screens: pageServed("employment")
            ? [
                {
                  type: "employment" as const,
                  endpoint: "PUT /workers/me/employment" as const,
                  ...tierScopeOf("employment"),
                },
              ]
            : [],
        },
        {
          id: "qualifications",
          title: SECTION_TITLES.qualifications,
          screens: [
            ...view.leftover
              .filter(unsettled)
              .map((item) => this.questionScreen(item, byKey.get(item.question_key), suggestions)),
            // ZONE 5's CREDENTIALS (migration 0098). A MARKER, like the two above:
            // `PUT /workers/me/qualifications` owns the vocabulary, the caps and the
            // three-state contract, and restating them here would be a second contract for one
            // page.
            //
            // THIS SECTION COULD ALREADY RENDER EMPTY, and that is why it goes here rather than
            // anywhere else. For an EXPERIENCED turner all three leftover items are the
            // fresher-gated ones, so `visible()` removes every screen and the section is a
            // heading with nothing under it — while the Certificates row on their sheet has
            // never had a source at all. A client on an older build drops this marker (it fails
            // soft on an unknown `type`) and sees exactly what it sees today, which is what lets
            // the server land ahead of the app.
            ...(pageServed("qualifications")
              ? [
                  {
                    type: "qualifications" as const,
                    endpoint: "PUT /workers/me/qualifications" as const,
                    // PER-TRADE, AND THIS IS THE ONLY RESPONSE THAT KNOWS THE TRADE. Empty for a
                    // role that declares none — the worker types freely, which is the behaviour
                    // everywhere today. Never a validation list; see the descriptor field.
                    suggested_certificates: [
                      ...(descriptorForKind(kind)?.suggestedCertificates ?? []),
                    ],
                    ...tierScopeOf("qualifications"),
                  },
                ]
              : []),
          ],
        },
      ],
    };
  }

  /**
   * `GET /profiling/form/tiers` — the tier screen's data for the form this worker was handed.
   * Tiers off (or no tier service): `enabled: false`, and the client goes straight to the form.
   */
  async tierState(workerId: string, requestCtx?: RequestContext): Promise<TierStateResponse> {
    const tierCtx = await this.tierContextFor(workerId);
    if (!this.tiers) {
      return {
        enabled: false,
        kind: tierCtx.kind as TradeFormKind,
        needs_choice: false,
        current_tier: null,
        upgradable_to: [],
        tiers: [],
      };
    }
    return this.tiers.state(
      workerId,
      tierCtx,
      this.tiers.enabled ? await this.hasStartedForm(workerId, tierCtx.pack) : false,
      requestCtx,
    );
  }

  /** `POST /profiling/form/tier` — choose or raise the tier. Never lowers it. */
  async chooseTier(
    workerId: string,
    tier: ProfilingTier,
    requestCtx?: RequestContext,
  ): Promise<ChooseTierResponse> {
    if (!this.tiers) throw new NotFoundException("tiered profiling is not enabled");
    const tierCtx = await this.tierContextFor(workerId);
    const result = await this.tiers.choose(
      workerId,
      tierCtx,
      tier,
      this.tiers.enabled ? await this.hasStartedForm(workerId, tierCtx.pack) : false,
      requestCtx,
    );
    // AN UPGRADE CAN LAND ON A TIER THE WORKER HAS ALREADY FINISHED — every question it adds was
    // answered earlier (a résumé autofill, or a form begun before tiers). No answer will ever be
    // posted to fire the completion, so it is recorded here, once, or the funnel would read an
    // upgrade that completed instantly as one that was abandoned.
    if (result.change === "upgraded") {
      const scope = await this.tiers.formScope(workerId, tierCtx.pack);
      if (scope) {
        const view = await this.formView(workerId, tierCtx.kind, tierCtx.pack, scope);
        const answered = this.answeredIn(view);
        if (view.visibleItems.length > 0 && answered >= view.visibleItems.length) {
          await this.tiers.recordCompletion(
            workerId,
            tierCtx,
            scope,
            view.visibleItems.length,
            requestCtx,
          );
        }
      }
    }
    return result;
  }

  private async tierContextFor(workerId: string): Promise<TierFormContext> {
    const { kind, sessionId } = await this.contextFor(workerId);
    return { kind, sessionId, pack: await this.packFor(kind) };
  }

  /**
   * Has this worker already settled any question of this form? A form begun before tiers existed
   * carries on at Hard rather than stopping him mid-way for a choice.
   */
  private async hasStartedForm(workerId: string, pack: QuestionPack): Promise<boolean> {
    const saved = await this.answers.listAnswers(workerId, pack.pack_id);
    return saved.some((row) => row.status !== "unanswered");
  }

  /** Save one answer. */
  async answer(
    workerId: string,
    dto: TradeFormAnswerDto,
    /**
     * OPTIONAL, AND DELIBERATELY SO. The tracing ids only reach the completion event, and a
     * missing correlation id must never be the reason a worker's answer is not saved — the
     * emitter below is best-effort for exactly the same reason. The controller always passes one.
     *
     * NAMED `requestCtx`, not `ctx`, because `ctx` inside this method is already the FORM context
     * — the kind and the session id `contextFor` resolved. Two different things called `ctx` in
     * one method is how the wrong one gets passed.
     */
    requestCtx?: RequestContext,
    _now: Date = new Date(),
  ): Promise<TradeFormAnswerResponse> {
    const ctx = await this.contextFor(workerId);
    const pack = await this.packFor(ctx.kind);
    const scope = (await this.tiers?.formScope(workerId, pack)) ?? null;

    // THE TRADE PACK ONLY (#1503) — the form serves nothing else, so it accepts nothing else.
    const item = pack.items.find((candidate) => candidate.question_key === dto.question_key);

    if (!item) {
      // ONE NARROW EXCEPTION, FOR APPS HOLDING A PRE-#1503 SCHEMA. See `legacy-universal-answer.ts`
      // for why a 400 here would strand a worker mid-form, and why the list is frozen.
      if (isLegacyFormUniversalKey(dto.question_key)) {
        return this.answerLegacyUniversalKey(workerId, ctx, pack, dto);
      }
      // A KEY THIS PACK DOES NOT DEFINE IS A 400, NOT A DROP. Dropping is the silent-truncation
      // shape: the worker taps, the client shows it saved, and the sheet never mentions it. A
      // named rejection lets a version-skewed client say so.
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
    const record = this.recordFor(item, dto, "reject");
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
    // ═══ BOTH ROWS OR NEITHER ═══
    //
    // THE SHEET'S OWN SOURCE. `projectProfile` is the interview's projector, run over this one
    // record: same crosswalk, same typing, same `attributeKey`, so the sheet cannot tell which
    // surface an answer arrived through. An attribute-less question (target_kind: none) simply
    // yields nothing and writes nothing.
    //
    // ONE TRANSACTION, BECAUSE ONE ANSWER IS TWO ROWS. These were two separate autocommits, and
    // the failure mode is silent and unrecoverable: when the attribute write failed, the
    // `worker_pack_answer` row still committed — so `answeredCount` below counted the question,
    // the progress rail advanced, the worker was told it saved, and `worker_attributes` (what the
    // printed sheet and the matcher read) had nothing. Every 18 items in `qp_cnc_turning` are
    // `target_kind: attribute`, so this is the ordinary path, not an edge.
    //
    // RETRYING COULD NOT REPAIR IT. `upsertAnswer` is idempotent and succeeds again on every
    // retry, so the pair never converges — the worker re-taps, sees success, and the capability
    // zone stays empty forever. Fail-closed (§3) says the answer either lands whole or not at
    // all, and a worker who sees an error and re-taps must be able to fix it.
    //
    // `projectProfile` IS PURE AND RUNS OUTSIDE THE TRANSACTION deliberately: it touches no
    // database, and holding a transaction open across work that cannot fail on the database is
    // how a hot path acquires lock time it does not need.
    const { attributes } = projectProfile([record]);
    await this.answers.withTransaction(async (tx) => {
      await this.answers.upsertAnswer(row, tx);
      if (attributes.length > 0) {
        await this.attributes.upsertMany(
          attributes.map((attribute) => ({
            workerId,
            attributeKey: attribute.attributeKey,
            valueKind: attribute.valueKind,
            valueBool: attribute.valueKind === "boolean" ? (attribute.value as boolean) : null,
            valueNumber:
              attribute.valueKind === "number" ? String(attribute.value as number) : null,
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
          tx,
        );
      }
    });

    // THE REVIEW-OR-OMIT PATH FIRES HERE, ONCE THE ANSWER IS DURABLE. See
    // `triggerOtherAnswerPolish` for the fail-open contract and the honest scope note about who
    // reads its output today.
    this.triggerOtherAnswerPolish(workerId, pack.pack_id, item, row.answerOtherText, requestCtx);

    // THE RESUME REFRESH, BEST-EFFORT. A capability answer changes what the sheet prints, and
    // the building-screen regenerate is not guaranteed to run (abandoned walk, failed
    // generate, Resume tab opened straight from the menu). See `refreshResumeAfterCapabilityEdit`.
    await this.refreshResumeAfterCapabilityEdit(workerId, attributes.length > 0, requestCtx);

    // THE SAME VIEW `schema()` SERVES, re-read after the write (#1503). `total` below is therefore
    // exactly the number of question screens the next fetch returns — never a count over a
    // different set that the progress rail cannot reach.
    const view = await this.formView(workerId, ctx.kind, pack, scope);
    const visibleItems = view.visibleItems;
    const answeredCount = this.answeredIn(view);

    // THE FORM IS FINISHED — the other end of the funnel `profile.form_mode_entered` opens.
    //
    // COUNTED AGAINST WHAT IS STILL ASKED, and that is what makes the check reachable at all. A
    // senior turner is never asked the three fresher questions, so "answered === pack.items.length"
    // is a condition they can never satisfy and this event would fire for nobody but a fresher.
    //
    // `>=` RATHER THAN `===` even though the intersection above makes them equivalent today. The
    // fail-safe direction for telemetry is to emit: if `saved` ever carried two rows for one key,
    // `===` would silently never fire and the completion would be lost, while `>=` still reports
    // it. The idempotency key is what makes over-reporting harmless.
    if (visibleItems.length > 0 && answeredCount >= visibleItems.length) {
      await this.recordCompletion(workerId, ctx.kind, pack, requestCtx, {
        answered: answeredCount,
        total: visibleItems.length,
      });
      // TIERED PROFILING — the same completion, counted per tier (duration + question count feed
      // the tier screen's estimates). Only while tiers are on; never throws.
      if (scope && this.tiers) {
        await this.tiers.recordCompletion(
          workerId,
          { kind: ctx.kind, sessionId: ctx.sessionId, pack },
          scope,
          visibleItems.length,
          requestCtx,
        );
      }
    }

    return {
      question_key: item.question_key,
      status: row.status === "answered" ? "answered" : "declined",
      answered: answeredCount,
      // COUNTED OVER WHAT IS STILL ASKED, not over the whole pack. A senior turner is not asked
      // the three fresher questions, and a progress rail whose denominator includes them can
      // never reach its own end — the worker finishes the form at 15/18 and is told they have not.
      //
      // TIERED PROFILING: this is every question the worker's TIER asks, answered or not — also
      // on the upgrade view, which serves only the unanswered ones. So after an Easy → Medium
      // upgrade the rail starts at (Easy's answers)/(Medium's total), not at 0/(new questions):
      // the worker is continuing one profile, not starting a second.
      total: visibleItems.length,
      /**
       * The screen list the client is holding no longer matches the one this server would serve.
       *
       * A FORM IS ONE ROUND TRIP, so answering a gate changes a list the client already has. It
       * cannot know that without being told, and it must not have to re-implement the predicates
       * to work it out. A client that ignores this behaves exactly as it does today — which is
       * what lets the server ship ahead of the app rather than in lockstep with it.
       */
      schema_stale: gateKeysOf(pack.items).has(item.question_key),
    };
  }

  /**
   * Refresh the worker's ALREADY-GENERATED resume after a capability answer — the safety
   * net that closes the Bada Bhai edit loop server-side.
   *
   * THE GAP THIS CLOSES. A section-walk edit (Bada Bhai menu → re-answer → submit) writes
   * fresh `worker_attributes`, and the happy path regenerates through the building screen
   * (`POST /resume/generate` + overlay + render). But that path runs ONLY when the worker
   * finishes inside the app: a walk abandoned mid-way, a generate that 429s, or a Resume
   * tab opened straight from the menu leaves the new attributes in the database with the
   * OLD document + READY pill on screen — forever, because nothing else on this path
   * regenerates or re-renders. The worker's correction is saved and invisible.
   *
   * WHAT IT DOES. Best-effort, fail-open, LLM-free: when THIS answer wrote capability
   * attributes (`wroteAttributes`) and the worker already has a resume, enqueue a FORCED
   * re-render of that resume. Forced (not a generate) because the content change needs no
   * model — the render processor rebuilds the sheet from the LIVE attributes at run time —
   * so this spends no AI budget, mints no version, and never touches the daily generate
   * cap. In place (same row, same object key), exactly like the photo/prefs re-renders.
   *
   * FIRST RUNS ARE EXCLUDED: with no resume row yet there is nothing to refresh, and the
   * building screen's generate (with its overlay) is what mints version 1.
   *
   * DELAYED + DEDUPED, NOT IMMEDIATE. A walk saves ~9 answers; nine immediate renders
   * would serialize behind every onboarding render on the shared queue. The delay pushes
   * the safety work off the hot path, and the worker-scoped jobId collapses one walk's
   * answers into (at most) a slow chain: each job renders the live state at run time, so
   * the last one to run is always the freshest — every ordering converges.
   * `removeOnComplete`/`removeOnFail` free the id so the NEXT walk re-arms; without them
   * the first walk would jam the safety net forever (completed rows are retained by the
   * queue defaults).
   *
   * NEVER THROWS (mirrors `rebuildQuietly`'s contract): the answer above already committed,
   * and a failed refresh must not fail it. Callers await this freely.
   */
  private async refreshResumeAfterCapabilityEdit(
    workerId: string,
    wroteAttributes: boolean,
    requestCtx: RequestContext | undefined,
  ): Promise<void> {
    if (!wroteAttributes) return;
    try {
      const latest = await this.workers.latestResume(workerId);
      // No resume yet → first run through the form; the building screen's generate is what
      // mints version 1 (with the overlay), so there is nothing to refresh.
      if (!latest) return;
      await this.renderQueue.add(
        "render",
        {
          resumeId: latest.id,
          workerId,
          force: true,
          correlationId: requestCtx?.correlationId ?? "trade-form-answer",
          requestId: requestCtx?.requestId ?? "trade-form-answer",
        },
        {
          jobId: `trade-form-rerender:${workerId}`,
          delay: RESUME_REFRESH_DELAY_MS,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      this.logger.warn(
        `trade-form resume refresh skipped for worker ${workerId} (${
          error instanceof Error ? error.message : "unknown"
        }); answers are saved, resume updates on next generate`,
      );
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * ONE FORM VIEW, READ BY BOTH ENDPOINTS (#1503).
   *
   * `schema()` and `answer()` used to each compute "what this worker is asked" on their own, and
   * `f455bb36` proved what that costs: `schema()` grew eight appended questions while `answer()`
   * went on counting the trade pack alone, so the rail said 0/18 while the worker looked at 26
   * screens. Two derivations of one list drift the first time either is edited. This is the only
   * place the list is derived, so `answer().total` equals the served question screens BY
   * CONSTRUCTION rather than by two functions happening to agree.
   *
   * WHAT THE WORKER HAS ALREADY SETTLED DECIDES WHAT ELSE THEY ARE ASKED (#1378). On a first
   * fetch nothing is settled, every gate is unresolved, and `isFormQuestionVisible` shows
   * everything. It narrows on the next fetch, once the tier question has an answer to narrow it
   * with.
   *
   * THIS PACK'S ROWS ONLY. Reading facts settled under other packs is #1504's change, not this one.
   * (THE ONE EXCEPTION is the #1459 tier pre-settle below: it reads `experience_years`, which the
   * CHAT asked and stored under its own pack, so the form can stop asking the duplicate question.)
   */
  private async formView(
    workerId: string,
    kind: TradeFormKind,
    pack: QuestionPack,
    // TIERED PROFILING — null serves every question (Hard, today's form).
    scope: FormTierScope | null,
  ): Promise<FormView> {
    const saved = await this.answers.listAnswers(workerId, pack.pack_id);
    const answers = answerMapFromRows(saved);

    // #1459 — PRE-SETTLE THE PER-TRADE TIER FROM WHAT THE CHAT ALREADY KNOWS (owner ruling
    // 2026-09-21). The pack's `*_experience` gate is the form's first question and the chat has
    // already asked `experience_years`; the derived value resolves every tier gate for THIS fetch
    // and the question itself is not served. See {@link derivedTenureAnswer} for the full rule and
    // for why this is read-time only.
    const derived = await this.derivedTenureAnswer(workerId, kind, pack, answers);
    const eligibility: AnswerMap =
      derived === null ? answers : { ...answers, [derived.questionKey]: derived.record };
    const visible = (items: readonly QuestionPackItem[]): QuestionPackItem[] =>
      items.filter((item) => {
        // OUTSIDE THE WORKER'S PROFILING TIER, NOT ASKED — checked FIRST, and deliberately ahead
        // of "settled shows": an answer the tier does not ask (a résumé autofill, a pre-tier
        // form) stays stored and matchable, but it is not this tier's question to show.
        if (scope?.excluded.has(item.question_key)) return false;
        // A DERIVED TIER IS NEVER ASKED. `isFormQuestionVisible` shows anything settled so the
        // worker can change it, but this value was never his tap on THIS question — there is
        // nothing here for him to change, and the answer it derives from stays editable in the
        // chat. A stored row for the key is a different case and `derivedTenureAnswer` returns
        // null for it, so the question keeps its normal visibility.
        if (derived !== null && item.question_key === derived.questionKey) return false;
        return isFormQuestionVisible(item, eligibility);
      });

    const sheet = this.orderBySheet(pack, kind);
    const ordered = visible(sheet.ordered);
    const leftover = visible(sheet.leftover);
    return { saved, ordered, leftover, visibleItems: [...ordered, ...leftover] };
  }

  /**
   * #1459 — THE PER-TRADE TIER, PRE-SETTLED FROM THE CHAT'S `experience_years`.
   *
   * THE DEFECT. The form's FIRST question is the pack's `*_experience` tier gate
   * (`turning_experience`, `coating_experience`, …), and the worker has ALREADY answered
   * `experience_years` in the chat. It is asked twice.
   *
   * WHY IT CANNOT SIMPLY BE DELETED, OR RE-POINTED. It is the gate for 10 of the pack's 18
   * questions; deleting it leaves every gate unresolved forever and the form shows all 18 to
   * everyone, including the three FRESHER items a veteran must never see — verbatim #1378.
   * Re-pointing the gates at `experience_years` cannot work either: the form's answer map is
   * PACK-SCOPED (`listAnswers(workerId, pack.pack_id)`), so a universal key is permanently
   * unresolved there. Hence the owner ruling of 2026-09-21: DERIVE the tier from what the chat
   * knows, and stop asking the question.
   *
   * FIRST-WRITE-WINS. A settled row for the tenure key — answered or declined — means the
   * worker's own tap stands, the question keeps its normal visibility so he can change it, and
   * this returns null. The derivation only fires when the pack has no settled tenure answer.
   *
   * READ-TIME ONLY, NEVER STORED. The derived value gates the form for this fetch and is never
   * written to `worker_pack_answer`: a value the worker did not give is not recorded as his
   * answer. The source is his own chat answer, and `experience_years` remains the record.
   *
   * DECLINES AND NON-NUMBERS DERIVE NOTHING. "Pata nahi" settles the question and tells us
   * nothing about the tier, so the tenure question stays visible and its gates stay unresolved —
   * the form's own fail direction.
   */
  private async derivedTenureAnswer(
    workerId: string,
    kind: TradeFormKind,
    pack: QuestionPack,
    answers: AnswerMap,
  ): Promise<{ questionKey: string; record: AnswerRecord } | null> {
    const tenureKey = descriptorForKind(kind)?.tenureQuestionKey;
    if (tenureKey === undefined || tenureKey.length === 0) return null;
    if (!pack.items.some((item) => item.question_key === tenureKey)) return null;

    const stored = answers[tenureKey];
    if (stored !== undefined && stored.status !== "unanswered") return null;

    const source = await this.answers.findLatestAnswerByQuestionKey(workerId, "experience_years");
    if (
      source === undefined ||
      source.status !== "answered" ||
      typeof source.answerNumber !== "number" ||
      !Number.isFinite(source.answerNumber)
    ) {
      return null;
    }

    return {
      questionKey: tenureKey,
      record: {
        question_key: tenureKey,
        target_field: tenureKey,
        status: "answered",
        value_raw: null,
        value_normalized: source.answerNumber,
        // NO EVIDENCE SPAN: the value is derived from another answer, not quoted from the
        // transcript, and inventing a span the provenance gate would verify is worse than
        // admitting there is nothing to cite. Same posture `settleFromLlmDraft` takes.
        evidence: null,
        turn: 0,
        history: [],
      },
    };
  }

  /**
   * SETTLED **AND STILL ASKED** — the intersection, not every row stored for this pack.
   *
   * THE DEFECT THIS CLOSES, which predates the completion event and reaches the progress rail.
   * `total` has always been the VISIBLE count while `answered` counted every settled row, and the
   * two range over different sets — so the numerator could exceed its own denominator. Nothing
   * failed, because nothing compared them.
   *
   * A GATED-AWAY ANSWER IS NOT THE CAUSE, and assuming it was is the easy mistake here:
   * `isFormQuestionVisible` returns true for anything already settled, precisely so a worker can
   * still change an answer the tier gate would otherwise hide, which means such a question is
   * counted in BOTH numbers and stays consistent.
   *
   * A RETIRED KEY IS. Answers are listed by `pack_id` and never by version, so a question dropped
   * in v2 leaves its v1 `worker_pack_answer` row behind forever. That row is in `saved` and in no
   * version of `pack.items` — counted in the numerator alone, and the rail reads 3/2. So is a row
   * the legacy-key shim wrote, and so is every universal-key row `f455bb36` wrote under a trade
   * pack: served by no question screen, counted in neither number.
   *
   * COUNTING IT IN NEITHER IS THE HONEST ANSWER: the worker did answer it, but it is not a question
   * this form asks any more, so it belongs to neither side of "how far through are you". It also
   * makes the completion check an equality the worker can actually reach, rather than one they
   * satisfy through a row they cannot see and cannot remove.
   */
  private answeredIn(view: FormView): number {
    const visibleKeys = new Set(view.visibleItems.map((candidate) => candidate.question_key));
    return view.saved.filter(
      (candidate) => candidate.status !== "unanswered" && visibleKeys.has(candidate.questionKey),
    ).length;
  }

  /**
   * An answer to one of the eight universal keys `f455bb36` served, from an app still holding
   * that schema (#1503). See `legacy-universal-answer.ts` for why this is a 200 and not a 400.
   *
   * WHAT IT DOES, and each line is a decision rather than a default:
   *
   *   - STORED EXACTLY WHERE THAT DEPLOY STORED IT: under the TRADE pack's id and version,
   *     `source: 'form'`, the form's session id. Inventing a `qp_universal` location would create
   *     a row shape nothing on main writes and nothing reads (the chat stores universal answers
   *     under its occupation pin), and a future cross-pack reader would have to arbitrate it.
   *   - NO `worker_attributes` WRITE. The preferences page owns shift and preferred cities, and a
   *     stale screen writing `shift_preference` a few seconds before (or after) that page is
   *     exactly the overwrite race #1503 reported.
   *   - NO COMPLETION EVALUATION. This is not a question the form asks, so it cannot be the answer
   *     that finishes the form — and firing `profile.form_completed` off a screen the worker should
   *     not have been shown would put a false step in the funnel.
   *   - `schema_stale: true`, so the app re-fetches, the stale screens vanish, and its forward scan
   *     lands on the next real question or page. A build that ignores the flag simply advances.
   *   - COUNT-ONLY LOG. The key slug is what measures remaining skew; the value is what a specific
   *     worker said about himself and never reaches a log.
   *
   * FAILS CLOSED WHEN THE UNIVERSAL PACK CANNOT NAME THE KEY. Without the item there is no type to
   * validate the answer against, and guessing one is how an unrepresentable row gets written.
   */
  private async answerLegacyUniversalKey(
    workerId: string,
    ctx: { kind: TradeFormKind; sessionId: string | null },
    pack: QuestionPack,
    dto: TradeFormAnswerDto,
  ): Promise<TradeFormAnswerResponse> {
    const universal = await this.packs.loadUniversal(Date.now());
    const item = universal?.items.find((candidate) => candidate.question_key === dto.question_key);
    if (!item) {
      this.logger.warn(
        `legacy universal form key ${dto.question_key} rejected: the universal pack ` +
          `${universal ? "no longer defines it" : "did not load"}`,
      );
      throw new BadRequestException(`question_key ${dto.question_key} is not in ${pack.pack_id}`);
    }

    const record = this.recordFor(item, dto, "decline");
    const row = packAnswerRowFor({
      workerId,
      sessionId: ctx.sessionId,
      packId: pack.pack_id,
      packVersion: pack.version,
      record,
      source: "form",
    });
    if (row === null) {
      throw new BadRequestException(`${item.question_key} produced no storable answer`);
    }
    await this.answers.upsertAnswer(row);
    // Same review-or-omit trigger as the current path — a legacy client can still type an "other"
    // answer against a single/multi-select universal question.
    this.triggerOtherAnswerPolish(workerId, pack.pack_id, item, row.answerOtherText, undefined);

    const scope = (await this.tiers?.formScope(workerId, pack)) ?? null;
    const view = await this.formView(workerId, ctx.kind, pack, scope);
    const answered = this.answeredIn(view);
    const total = view.visibleItems.length;
    const status = row.status === "answered" ? "answered" : "declined";
    this.logger.log(
      `legacy universal form key accepted: key=${item.question_key} pack=${pack.pack_id} ` +
        `status=${status} answered=${answered} total=${total}`,
    );
    return { question_key: item.question_key, status, answered, total, schema_stale: true };
  }

  /**
   * The form is finished — the countable half of that fact (#0.6).
   *
   * ═══ WHY IT NEEDED AN EVENT AT ALL ═══
   *
   * `POST /profiling/form/answer` emitted NOTHING. `profile.form_mode_entered` records that a
   * worker was sent to a form and nothing recorded whether they ever came out of one, so the only
   * measurable fact about the entire form-first funnel was its first step. Abandonment at question
   * fourteen of a badly ordered pack and completion in one sitting produce identical telemetry —
   * and the platform is about to have twenty-one of these funnels, each with its own pack whose
   * ordering is exactly what this number would judge.
   *
   * ═══ SWALLOWS ITS OWN FAILURE, LIKE `recordFormHandoff` ═══
   *
   * The worker's answer is already durably written by the time this runs. Throwing here would
   * fail a request whose work succeeded, and the client would retry an answer that is already
   * saved — trading a stored answer for a telemetry row. The log line is the fallback record.
   *
   * ═══ ONCE PER (WORKER, PACK) ═══
   *
   * The completion condition is true for EVERY subsequent answer too: a worker who finishes and
   * then corrects one chip satisfies it again. Without the key, a worker who edits their form five
   * times reports five completions and the funnel's numerator exceeds its denominator. The pack
   * VERSION is deliberately not in the key — a v2 of the same pack is the same worker finishing
   * the same form, and `pack_version` in the payload is what tells the two apart on read.
   */
  private async recordCompletion(
    workerId: string,
    formKind: TradeFormKind,
    pack: QuestionPack,
    requestCtx: RequestContext | undefined,
    counts: { answered: number; total: number },
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "profile.form_completed",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        // COUNTS AND SLUGS ONLY. Never an answer, never a label — the identical discipline
        // `profile.form_mode_entered` keeps, and for the identical reason: the answers are what a
        // specific worker said about themselves.
        payload: {
          worker_id: workerId,
          form_kind: formKind,
          pack_id: pack.pack_id,
          pack_version: pack.version,
          answered: counts.answered,
          total: counts.total,
        },
        idempotencyKey: `profile.form_completed:${workerId}:${pack.pack_id}`,
        correlationId: requestCtx?.correlationId,
        requestId: requestCtx?.requestId,
      });
    } catch (error) {
      this.logger.error(
        `the ${formKind} form completion for worker ${workerId} was not recorded; their answers ` +
          `are saved but the funnel will read as an abandonment: ` +
          `${(error as Error).message}`,
      );
    }

    // M1 — CLOSE THE SUPPLY CHAIN HERE, ON THE SERVER.
    //
    // The form has just written this worker's last `worker_attributes` row. Until now nothing
    // server-side turned those into `worker_skill`, so a completed form produced a worker who was
    // invisible to every posting: the employer-push materializer runs on publish and reads
    // `worker_skill`, which stayed empty. The chain was being closed client-side, by the Flutter
    // resume screen happening to hit an endpoint that rebuilt — a worker who completed the form
    // and closed the app never got there.
    //
    // OUTSIDE THE try/catch ABOVE, DELIBERATELY. The event and the rebuild are independent: a
    // failed emit must not also cost the worker their skills. `rebuildQuietly` is contractually
    // never-throwing (worker-skills.service.ts) and logs its own failures, so this cannot fail
    // the answer the worker just saved.
    //
    // NOT A CHANGE TO THE FORM. No question, no answer, no extraction setting is touched — this
    // reads what the form already stored and hands a worker id to the matching layer.
    await this.workerSkills.rebuildQuietly(workerId, requestCtx);
  }

  /**
   * Which form this worker was handed, from the durable record the handover wrote.
   *
   * READ OFF `chat_sessions.conversation_state`, not re-derived. The envelope lives in Redis and
   * is dropped the moment the interview flushes, so the session row is the only thing that still
   * knows — and re-running the router here would make the answer depend on labels this service
   * does not have.
   *
   * FALLBACK: When a worker reaches the form through résumé upload (ADR-0041 RI-4) rather than
   * an interview, `chat_sessions` has no `form_kind` — the résumé-import path writes it to
   * `worker_resume_import.form_kind` instead. This fallback reads the most recent routed import
   * and uses its `form_kind`. The `sessionId` is null because no interview produced this handover;
   * both `worker_pack_answer.chat_session_id` and `worker_attributes.session_id` are nullable
   * columns that accept null as honest provenance ("from a résumé, not from a conversation").
   */
  private async contextFor(
    workerId: string,
  ): Promise<{ kind: TradeFormKind; sessionId: string | null }> {
    // PRIMARY: read from the interview handover (existing path, unchanged).
    const session = await this.chat.findLatestSessionByWorker(workerId);
    const state = (session?.conversationState ?? null) as { form_kind?: unknown } | null;
    const stored = state?.form_kind;
    const kind = TRADE_FORM_KINDS.find((candidate) => candidate === stored);
    if (kind && session) {
      return { kind, sessionId: session.id };
    }

    // FALLBACK: read from the most recent résumé import routed to a form. A worker who uploaded
    // a résumé and was routed to a form has no chat session yet — the form IS the next step.
    const importRow = await this.resumeImports.findLatestForWorker(workerId);
    if (importRow && importRow.route === "form" && importRow.formKind) {
      const importKind = TRADE_FORM_KINDS.find((candidate) => candidate === importRow.formKind);
      if (importKind) {
        // Null sessionId: honest provenance. Both tables accept null.
        return { kind: importKind, sessionId: null };
      }
    }

    // NEITHER PATH PRODUCED A FORM. A worker who reaches this URL without a handover has either
    // never interviewed or is not on a trade that has a form, and serving them a CNC turner's
    // eighteen questions would be worse than telling them there is nothing here.
    throw new NotFoundException("this worker has not been handed a trade form");
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
  private orderBySheet(
    pack: QuestionPack,
    kind: TradeFormKind,
  ): {
    ordered: QuestionPackItem[];
    leftover: QuestionPackItem[];
  } {
    const map = TRADE_RESUME_MAPS.find((candidate) => candidate.pack_id === pack.pack_id);
    const byKey = new Map(pack.items.map((item) => [item.question_key, item]));
    const ordered: QuestionPackItem[] = [];

    // EVERY MANDATORY ITEM LEADS, in the pack's own order (#1377, #1378).
    //
    // A mandatory item has no capability row by nature — the sheet prints tenure in the Verdict
    // Line, and CAM's CAM-vs-MDI split not at all — so `orderBySheet` files anything the résumé
    // map has no row for under "ask it last", which put these BEHIND the questions they exist to
    // gate. Each pack's own `_depth` note says the opposite in as many words: "THE TIER GATE IS
    // turning_experience, and it is asked FIRST." A gate asked after the questions it gates is
    // not a gate.
    //
    // THIS USED TO HOIST EXACTLY ONE KEY, `descriptor.tenureQuestionKey`, and that was right
    // only while every pack had exactly one mandatory item. `qp_cam_programming` has two:
    // `programming_mode` at display_order 0 decides whether the worker programs in CAM software
    // or by manual data input at the machine, and its own `_first_question` note calls an
    // unanswered split a fail-closed condition because it "decides how every later answer should
    // be read". Hoisting only the tenure gate served it ELEVENTH, under the "Qualification,
    // documents & languages" heading, after all ten capability questions whose reading it
    // governs. Generalising to `is_mandatory` is behaviour-identical for the four packs whose
    // only mandatory item IS the tenure gate at order 0, and correct for CAM.
    //
    // The tenure key is unioned in rather than assumed mandatory: the descriptor names the gate
    // the ordering guarantee is owed to, and that guarantee must not depend on a pack author
    // remembering a flag.
    const tenureKey = descriptorForKind(kind)?.tenureQuestionKey;
    for (const item of pack.items) {
      if (!item.is_mandatory && item.question_key !== tenureKey) continue;
      if (!byKey.has(item.question_key)) continue;
      ordered.push(item);
      byKey.delete(item.question_key);
    }

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

  private questionScreen(
    item: QuestionPackItem,
    saved: WorkerPackAnswer | undefined,
    suggestions: ReadonlyMap<string, ResumeSuggestion>,
  ) {
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
              // `?? null`, not a bare read: this column is new (migration 0106) and a row read
              // before that migration's deploy — or a test fixture built before this change —
              // carries `undefined` for it, which the wire contract must never see.
              other_text: saved.answerOtherText ?? null,
            }
          : null,
      // RULING D7 IN ONE LINE: a stored answer always wins, and this does not touch it. The
      // suggestion is served WHETHER OR NOT the question is already answered — the worker sees
      // what his résumé said beside what he told us, and decides. Suppressing it when an answer
      // exists would quietly hide a disagreement he is the only one able to settle.
      suggestion: suggestions.get(item.question_key) ?? null,
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
   *
   * A NUMBER IS EXACTLY ONE NUMBER (#1503) — see `strict-number.ts` for the four false facts the
   * old digit-strip wrote. What happens to text that is not one is `onUnparseableNumber`'s call.
   */
  private recordFor(
    item: QuestionPackItem,
    dto: TradeFormAnswerDto,
    onUnparseableNumber: UnparseableNumberPolicy,
  ): AnswerRecord {
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
      const parsed = parseStrictNumber(dto.answer.text);
      if (parsed === null) {
        if (onUnparseableNumber === "decline") return declined;
        throw new BadRequestException(`${item.question_key} takes a number`);
      }
      return { ...base, value_normalized: parsed, status: "answered" };
    }
    if (item.answer_type === "single_select" || item.answer_type === "multi_select") {
      // "TYPED CUSTOM ANSWER, EVERYWHERE" (owner ruling, round 4). A worker who does not see
      // his own answer among the chips is not asking to be turned away — the 400 this branch
      // used to throw was exactly the silent-drop this ruling forbids in spirit: the worker
      // typed a real answer and the form told him it did not take one.
      //
      // NEVER WRITTEN TO A TYPED COLUMN. `otherAnswerValue` marks this as unreviewed free text
      // against a closed vocabulary; `packAnswerRowFor` routes a marked value to
      // `answer_other_text` and nowhere else, so it can never decide a tier gate, never become a
      // `worker_attributes` row, and never print unreviewed on any sheet — see
      // `OtherAnswerValue`'s docblock. This method's caller (`answer()`) hands the saved text to
      // `OtherAnswerPolishService` (`triggerOtherAnswerPolish`), which computes and stores the
      // reviewed rewrite; it is NEVER printed raw the moment a reader exists. HONEST STATE
      // TODAY: no reader exists yet — `questionScreen` below and `ProfilingSessionService
      // .displayValueOf` both deliberately echo the worker's raw typed words, by design, on the
      // edit/review screens they serve. See `triggerOtherAnswerPolish`'s docblock.
      const other = otherAnswerValue(dto.answer.text);
      if (other === null) return declined;
      return { ...base, value_normalized: other, status: "answered" };
    }
    if (item.answer_type !== "text") {
      throw new BadRequestException(`${item.question_key} does not take free text`);
    }
    return { ...base, value_normalized: dto.answer.text, status: "answered" };
  }

  /**
   * Hand a just-saved "other" answer to {@link OtherAnswerPolishService}, if `recordFor` marked
   * one — never inline in the response.
   *
   * WHY OFF THE RESPONSE, on the exact reasoning `WorkHistoryPolishService`'s own docblock states
   * for a stint description: this is the worker's live request path, often on 2G, and a model
   * round trip in the middle of it makes him wait on a rewrite that today has no reader at all
   * (see below). Unlike the work-history precedent there is no render job to hang the call off —
   * `answer()` has no off-request queue of its own — so this fires the call FROM the request,
   * NEVER AWAITED, and lets the response return the instant the DB write is durable.
   * `OtherAnswerPolishService.review` is contractually never-throwing (its own try/catch around
   * both the model call and the write-back), which is what makes a bare `void` safe here — the
   * same contract `PackRegistryService.onModuleInit` relies on for the identical idiom.
   *
   * ═══ HONEST SCOPE — WHAT THIS DOES AND DOES NOT DELIVER TODAY ═══
   *
   * This closes the "dead code" finding: `OtherAnswerPolishService.review` now has a real,
   * reachable caller, and `answer_other_text_polished` is actually computed and persisted for
   * every typed "other" answer once `WORK_HISTORY_POLISH_ENABLED` is on. It does NOT put the
   * rewrite in front of a worker — nothing in this codebase reads
   * `answer_other_text_polished` for display. `questionScreen`'s `other_text` and
   * `ProfilingSessionService.displayValueOf` both deliberately serve the RAW typed text on the
   * two screens that exist today (the resumed-form edit surface and the interview review
   * screen), by their own documented design — showing the rewrite there instead would be a
   * reversal of an already-shipped, already-tested decision this task did not ask for and is not
   * this engineer's call to make alone. The column is written for the first worker-facing "here
   * is what we understood" surface that is actually built to read it; until one exists, a
   * worker's typed "other" answer is computed-and-stored but not yet SHOWN reviewed anywhere,
   * which is a materially different claim from "wired end to end" and is recorded here rather
   * than left implicit.
   */
  private triggerOtherAnswerPolish(
    workerId: string,
    packId: string,
    item: QuestionPackItem,
    ownText: string | null | undefined,
    requestCtx: RequestContext | undefined,
  ): void {
    if (!ownText) return;
    const ctx: AiRequestContext = {
      correlationId: requestCtx?.correlationId,
      requestId: requestCtx?.requestId,
    };
    void this.otherAnswerPolish.review(
      workerId,
      packId,
      item.question_key,
      ownText,
      item.prompt_text,
      ctx,
      this.config,
      // A FRESH TRIGGER, ALWAYS. `TradeFormRepository.upsertAnswer` NULLs
      // `answer_other_text_polished` / clears the decline flag on EVERY write to this row
      // (including a correction), so "no prior polish, not declined" is the correct state to
      // hand in on every call this method ever makes — there is no earlier read to race.
      { polished: null, declined: false },
    );
  }
}

/**
 * What an interview stores for a tapped chip — `answer-capture.matchOptions`, and it must stay
 * EXPRESSION-FOR-EXPRESSION identical to it.
 *
 * IT USED TO READ `typeof option.value === "string" ? option.value : option.label_text`, and that
 * one clause made every tier gate in every pack inert. A tier-gate rung carries `value_number`
 * and NOTHING else — deliberately, and `role-corpus-parity.guard.test.ts` enforces exactly that,
 * because a rung carrying `value_text` is the #776 trap. So `option.value` on a gate is a NUMBER,
 * the `typeof` test failed, and the form fell through to `label_text` and stored the Hindi chip
 * caption: `turning_experience = "1 se 3 saal"`.
 *
 * Downstream, `{"op":"gte","left":{"field":"turning_experience"},"right":{"const":2}}` then
 * compared a string to a number, `compare()` returned null, the predicate was UNRESOLVED, and
 * `isFormQuestionVisible` answers "show it" for anything unresolved — so the failure surfaced as
 * the form appearing to work while serving 100% of every pack to every worker. An eight-year
 * turner was asked the ITI-workshop and trade-test questions, answered them, and had all three
 * silently dropped at render; a fresher was served tier-3 depth he has no honest answer to. That
 * is #1378 reopened on the form's own answer path, having been fixed only for the chat engine.
 *
 * The interview never had the bug: `matchOptions` is `option.value ?? option.label_text` and
 * keeps the integer. The two paths write the SAME column for the same tap again.
 *
 * `typedAnswerColumns` already routes a number to `answer_number` and a boolean to `answer_bool`,
 * so widening the return type is all that was needed on the write side.
 *
 * NARROWED RATHER THAN A BARE `??`. The contract types `option.value` as `z.unknown().nullable()`,
 * so `value ?? label_text` is `{}` and does not typecheck — and the cast that would silence it is
 * exactly the wrong move, because this value is written straight into a typed column. The three
 * branches below are the three shapes `typedAnswerColumns` can actually place; anything else
 * (an object a pack author nested by mistake) falls back to the label rather than reaching the
 * database as an unrepresentable value that gets dropped later with no error. Empty strings and
 * non-finite numbers fall back for the same reason — both would be stored as "an answer" that
 * says nothing.
 */
/** The capability heading a tier prints, when the role's map declares one for it. */
function tierSectionTitle(
  map: (typeof TRADE_RESUME_MAPS)[number] | undefined,
  tier: ProfilingTier,
): string | undefined {
  return tier === "hard" ? undefined : map?.tier_section_titles?.[tier];
}

function optionValue(option: QuestionPackItem["options"][number]): string | number | boolean {
  const value = option.value;
  if (typeof value === "string") return value.length > 0 ? value : option.label_text;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return option.label_text;
}

/**
 * The option KEYS a stored answer corresponds to, for pre-selecting chips on a resumed form.
 *
 * Matched on the stored VALUE, which is what the columns actually hold: `answer_text`,
 * `answer_number` or `answer_bool` for a single-select and `answer_option_keys` for a
 * multi-select (that column name predates the distinction and is a misnomer — it holds values).
 *
 * ALL FOUR COLUMNS ARE READ, not just the two text-shaped ones. A tier gate now stores its rung
 * in `answer_number`, so reading only `answer_text` would leave the gate chip UNSELECTED every
 * time a worker resumed a part-finished form — they would see their own answer blank and, worse,
 * re-tapping a different rung would silently re-tier the rest of the interview. Values are
 * compared by their string form because that is the only representation the four columns share.
 */
export function selectedKeys(item: QuestionPackItem, saved: WorkerPackAnswer): string[] {
  const stored = new Set<string>([
    ...(saved.answerOptionKeys ?? []),
    ...(typeof saved.answerText === "string" ? [saved.answerText] : []),
    ...(typeof saved.answerNumber === "number" ? [String(saved.answerNumber)] : []),
    ...(typeof saved.answerBool === "boolean" ? [String(saved.answerBool)] : []),
  ]);
  if (stored.size === 0) return [];
  return item.options
    .filter((option) => stored.has(String(optionValue(option))))
    .map((option) => option.option_key);
}
