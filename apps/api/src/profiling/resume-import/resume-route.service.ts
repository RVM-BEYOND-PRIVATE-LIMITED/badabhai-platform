import { Injectable, Logger } from "@nestjs/common";
import type { ParsedField, QuestionPackItem } from "@badabhai/ai-contracts";
import { ProfileResumeParsedPayload } from "@badabhai/event-schema";
import type { ResumeImportRouteName, TradeFormKindName } from "@badabhai/types";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { buildResumeEmploymentSuggestions } from "../../profiles/employment-suggestions";
import { OccupationService } from "../../occupation/occupation.service";
import { PackRegistryService } from "../pack-registry.service";
import { familyForTradeForm, routeToTradeForm, type TradeFormKind } from "../trade-form-router";
import { ResumeImportRepository } from "./resume-import.repository";
import { ResumeOptionMapService, type MappedOption } from "./resume-option-map.service";
import type { ParsedDraft } from "./resume-parse.service";
import { buildSuggestions, type ResumeSuggestion } from "./resume-suggestions";

/**
 * What the worker is offered, and where he is sent (ADR-0041, phase RI-4).
 *
 * ── THE MODEL CONTRIBUTES TWO LABELS; CODE DECIDES ───────────────────────────────────────
 *
 * This is the phase the whole feature was shaped around, and it needed NO new decision logic
 * and NO new AI authority. `routeToTradeForm` is deterministic, pure and model-free, and it
 * already takes exactly what a résumé parse produces: two free-text labels plus a pinned
 * occupation. So "is this worker form-based or chat-based" is answered by the same function
 * that answers it for the interview, on the same inputs, with the same conflict-term vetoes.
 *
 * A résumé reading "CNC Turner cum VMC Operator" hits the existing conflict veto and correctly
 * falls through to the chat — not because anything here knows what a VMC is, but because the
 * routing table already did.
 *
 * ── TASK 1 B2: THE MODEL NOW ALSO CLASSIFIES, AND THE ROUTE STILL DOES NOT LISTEN ─────────
 *
 * The parse carries `associationKind` — the model's judgment against the closed 21-kind
 * list. It is RECORDED (settled onto the import row, exposed on the read route) and NOT
 * acted on: `route` below still comes from `routeToTradeForm` alone. Wiring the
 * classification in as a recall path (term-match misses, classification hits, vetoes
 * still apply) waits on the handover-policy ruling — that change alters which road
 * workers take, and it lands as its own small commit, not smuggled inside plumbing.
 *
 * ── THE SUGGESTIONS ARE STAGED, NEVER WRITTEN AS ANSWERS ─────────────────────────────────
 *
 * Ruling D2. Nothing in this class touches `worker_pack_answer` or `worker_attributes`; it
 * writes one encrypted blob onto the import row and stops. An import abandoned here leaves
 * zero claims behind, which is the property that lets a parse be wrong without costing the
 * worker anything.
 *
 * ── DEGRADES, NEVER FAILS (ruling D9) ────────────────────────────────────────────────────
 *
 * Every OUTAGE on the way to a route ends with a worker who can carry on. An occupation index
 * that is down, a pack registry that cannot load, a document with no role in it — all of them
 * produce the CHAT route, which is today's behaviour byte for byte. The chat route is the
 * DEFAULT rather than the fallback: only 9 of 21 declared roles have a form at all.
 *
 * A FAULT IS NOT AN OUTAGE (amended 2026-09-15). A suggestion payload that cannot be built or
 * encrypted is not degraded to chat — it throws, nothing is settled, and the worker's client
 * falls through to the chat on its own (D9 served by the client, as the processor docblock
 * says). Degrading there would mean writing a route that describes a decision this service
 * failed to finish. CLAUDE.md §3: fail closed.
 */
@Injectable()
export class ResumeRouteService {
  private readonly logger = new Logger(ResumeRouteService.name);

  constructor(
    private readonly imports: ResumeImportRepository,
    private readonly occupations: OccupationService,
    private readonly packs: PackRegistryService,
    private readonly crypto: PiiCryptoService,
    private readonly events: EventsService,
    private readonly optionMap: ResumeOptionMapService,
  ) {}

  /**
   * Decide, stage, and SETTLE the import — the parse's outcome and the route in one statement.
   *
   * ── ONE WRITE, ONE EVENT, OR NEITHER (amended 2026-09-15) ──────────────────────────────
   *
   * `settleParsed` writes `status = 'parsed'` together with the route, the form kind, the
   * staged token and the extraction facts, guarded `WHERE status = 'parsing'`. The event is
   * emitted on the same transaction, keyed `profile.resume_parsed:<importId>`. Before this, the
   * parse service wrote `parsed` first and this service wrote the route second; a client that
   * polled in between saw a terminal status with a null route and sent a form-routed worker to
   * the chat.
   *
   * THE PAYLOAD IS VALIDATED BEFORE THE TRANSACTION OPENS. `emit` would refuse an invalid event
   * anyway, but inside the transaction; checking first keeps a schema bug from ever holding a
   * row lock, and makes the order of failure obvious to the next reader.
   *
   * `null` MEANS "THIS CALL SETTLED NOTHING": the draft was not a parse (the parse service has
   * already recorded the failure), or the guard found the row no longer `parsing` — a
   * redelivery, or a row erased mid-flight. In both cases nothing is emitted, because nothing
   * this call did is a transition worth counting.
   *
   * WHAT THROWS, AND WHY IT IS ALLOWED TO. `buildSuggestions` and `crypto.encrypt` are not
   * caught: a staged payload that could not be built or sealed is not a degraded route, it is a
   * privacy or correctness fault, and CLAUDE.md §3 says stop. The transaction never opened, the
   * row stays `parsing`, and a redelivery finds it past `uploaded` and does NOT read the
   * document a second time — the parse is never billed twice. The cost is a row that stays
   * `parsing` until something sweeps it; that is the fail-closed trade, recorded in ADR-0041 §7.
   */
  async route(
    workerId: string,
    draft: ParsedDraft,
    ctx: RequestContext,
  ): Promise<RoutedImport | null> {
    if (draft.status !== "parsed") {
      // A parse that produced nothing cannot route, and must not pretend to. The import row
      // already carries its own failure reason and `profile.resume_parse_failed` has already
      // been emitted by the parse service — emitting `resume_parsed` here as well would
      // double-count the funnel's middle step, which is the one number the four separate
      // events exist to keep answerable.
      return null;
    }

    const decision = await this.decide(workerId, draft, ctx);

    const payload = ProfileResumeParsedPayload.parse({
      worker_id: workerId,
      import_id: draft.importId,
      extraction_method: draft.extractionMethod,
      route: decision.route,
      form_kind: decision.formKind,
      // TWO NUMBERS, NOT ONE. They differ by everything that mapped nowhere, and a widening
      // gap is the earliest signal the prompt has drifted or a pack has moved a target field.
      fields_extracted: Object.keys(draft.fields).length,
      suggestions_offered: decision.suggestionsOffered,
      // #1656 - WHY the two numbers above may be zero, when the document was not at fault.
      // ALWAYS WRITTEN, `null` included: the key's absence is reserved for events emitted
      // before this field existed, so an explicit null is what lets a consumer read "we
      // looked and this parse was healthy" as a fact rather than as silence.
      degraded_posture: draft.degradedPosture,
    });

    const settled = await this.imports.withTransaction(async (tx) => {
      const wrote = await this.imports.settleParsed(
        draft.importId,
        {
          extractionMethod: draft.extractionMethod,
          pageCount: draft.pageCount,
          ocrConfidence: draft.ocrConfidence,
          // #1660 - THE SAME EXPRESSION the payload above uses, read off the same
          // `payload` object rather than recomputed, so the row and the event cannot
          // disagree about one import. Recomputing `Object.keys(draft.fields).length`
          // here would be a second source that drifts the first time either moves.
          fieldsExtracted: payload.fields_extracted,
          // #1656 - read off the SAME validated `payload` for the same reason. `?? null`
          // narrows the schema's `.optional()` (which exists for events emitted before this
          // field, not for this emit site) and is a no-op here: the key above is always set.
          degradedPosture: payload.degraded_posture ?? null,
        },
        {
          route: decision.route,
          formKind: decision.formKind,
          associationKind: decision.associationKind,
          suggestionsEnc: decision.suggestionsEnc,
        },
        tx,
      );
      // THE BOOLEAN IS THE ENTITLEMENT TO EMIT. A redelivery that reached here found the row
      // already settled; emitting anyway would count one document twice.
      if (!wrote) return false;
      await this.events.emit({
        event_name: "profile.resume_parsed",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        idempotencyKey: `profile.resume_parsed:${draft.importId}`,
        tx,
      });
      return true;
    });
    if (!settled) return null;

    return {
      route: decision.route,
      formKind: decision.formKind,
      fieldsExtracted: payload.fields_extracted,
      suggestionsOffered: decision.suggestionsOffered,
    };
  }

  /**
   * The route, the form kind and the sealed suggestion token — everything the settle writes
   * that is not an extraction fact. Reads only; writes nothing.
   */
  private async decide(
    workerId: string,
    draft: Extract<ParsedDraft, { status: "parsed" }>,
    ctx: RequestContext,
  ): Promise<RoutingDecision> {
    const roleLabel = stringValue(draft.fields.role_label);
    const domainLabel = stringValue(draft.fields.domain_label);

    // (1) THE LABELS ARE PINNED TO THE TAXONOMY BY CODE, NOT BY THE MODEL. The parse returns
    //     free text on purpose — an LLM must never produce, choose or approve a canonical id —
    //     and `OccupationService.resolve` is the ladder that turns a phrase into one.
    const pinned = await this.resolveOccupation(roleLabel ?? domainLabel);

    // (2) THE DETERMINISTIC ROUTER, used exactly as the interview uses it.
    //
    //     `workerText` IS DELIBERATELY NOT PASSED, and the first draft of this call did pass it
    //     — the two labels, joined. A mutation proved that argument dead: the veto haystack is
    //     built from those same labels already, so handing them over a second time changed
    //     nothing, and the test that claimed to cover it was passing for another reason.
    //
    //     The parameter exists for text the router may read ONLY to withhold a handover, and
    //     the tempting candidate here is the résumé's own lines. That would be wrong: a
    //     document listing a VMC under a previous employer's machines would veto the turning
    //     form a worker genuinely belongs on, and the veto cannot be argued with. The two
    //     labels are what the model actually concluded he DOES, and they are already in.
    const formKind = routeToTradeForm({
      draft: { domain_label: domainLabel, role_label: roleLabel, skills: [], experiences: [] },
      occupationFamilyId: pinned.familyId,
      occupationLabel: pinned.label,
    });

    // (3) THE PACKS — AND THE ONE FAILURE HERE THAT DEGRADES RATHER THAN STOPS (D9).
    //
    //     A pack registry that cannot load costs the worker his suggestions AND his form: a
    //     form-routed worker with no pack behind the form would be handed screens nothing can
    //     serve, so the honest degrade is the chat route with nothing staged — today's journey,
    //     byte for byte. The catch is NARROW ON PURPOSE: it wraps the two pack LOADS and
    //     nothing else. `buildSuggestions` and `crypto.encrypt` below are faults, not outages,
    //     and catching them would turn a privacy failure into a quiet chat route.
    //
    //     `familyForTradeForm` IS RESOLVED OUTSIDE THE TRY, AND THAT PLACEMENT IS THE POINT.
    //     It is not an I/O call — it is a registry-coherence ASSERTION that throws when a kind
    //     the router can still return has lost its descriptor. Inside the try it would have
    //     been read as an outage and every worker of that kind quietly re-routed to the chat,
    //     which is the exact opposite of what an assertion meant to fail loudly is for.
    const familyId = formKind === null ? null : familyForTradeForm(formKind);

    let packs: { all: QuestionPackItem[]; trade: QuestionPackItem[] };
    try {
      packs = await this.packItems(familyId);
    } catch (error) {
      // THE CLASS NAME ONLY. A pack error message can quote a pack path or a question key, and
      // this line sits next to a worker id; the class is enough to find the outage.
      this.logger.error(
        `question packs unavailable during résumé routing; degrading to chat ` +
          `(${error instanceof Error ? error.constructor.name : typeof error})`,
      );
      return {
        route: "chat",
        formKind: null,
        associationKind: null,
        suggestionsEnc: null,
        suggestionsOffered: 0,
      };
    }
    const items = packs.all;

    const route: ResumeImportRouteName = formKind === null ? "chat" : "form";
    const suggestions = this.stage(workerId, draft.fields, items);
    // (`filterEmployments` in `resume-parse.service.ts`) since RI-3 shipped, and until now
    // nothing downstream ever read it — `ResumeParseService`'s own docblock only ever promised
    // `fields`/`extractionMethod`/`pageCount`/`ocrConfidence` onward, so a parsed résumé's job
    // history was computed and then silently dropped on every import. `buildResumeEmployment
    // Suggestions` is the same "staged, not written" discipline `stage()` above already applies
    // to pack answers, aimed at `worker-employment`'s own suggestion shape instead of a pack
    // question's.
    const employmentSuggestions = buildResumeEmploymentSuggestions(draft.employments);

    // RI-AUTOFILL (owner override B): on the form route only, map the document onto
    // the TRADE pack's closed options — the third LLM call. Best-effort beside the
    // route: a mapping that never comes back stages nothing and the Haan hands over
    // to an unfilled form. The trade pack only, never universal: the form serves one
    // pack, and mappings for questions no form screen renders are spend with no reader.
    const mappedOptions: MappedOption[] =
      route === "form"
        ? await this.optionMap.map(
            workerId,
            draft.storageKey,
            draft.mime,
            mapQuestions(packs.trade),
            ctx,
          )
        : [];

    return {
      route,
      formKind,
      // Task 1 B2 — the model's classification, recorded and NOT acted on (see the
      // class docblock): the route above is still `routeToTradeForm` alone.
      associationKind: draft.associationKind,
      suggestionsEnc:
        suggestions.size > 0 || employmentSuggestions.length > 0 || mappedOptions.length > 0
          ? // ONE TOKEN OVER THE WHOLE PAYLOAD, never per leaf. The schema docblock records why:
            // a walker that encrypts leaves is the shape that rots, and `parse_masking.py` has a
            // measured bug of exactly that kind where employer names nested in an array crossed
            // a boundary nobody thought they could reach. One column cannot be partially covered.
            //
            // `{ answers, employments, option_map }`, NOT THE OLD FLAT MAP, because a résumé
            // now stages three different shapes under one column.
            // `ResumeSuggestionReader.decodeEnvelope` reads a legacy row (no `answers` key)
            // — and any row predating the mapping (no `option_map` key) — exactly as before:
            // this is additive, not a migration.
            this.crypto.encrypt(
              JSON.stringify({
                answers: Object.fromEntries(suggestions),
                employments: employmentSuggestions,
                option_map: mappedOptions.map((m) => ({
                  question_key: m.questionKey,
                  option_keys: [...m.optionKeys],
                })),
              }),
            )
          : null,
      suggestionsOffered: suggestions.size,
    };
  }

  /**
   * Parsed fields → the suggestions that will sit beside the worker's questions.
   *
   * THE PACK IS LOADED BECAUSE THE MAPPING IS BY `target_field`, NOT BY QUESTION KEY. A
   * question key is a pack slug; the target field is the thing the answer is ABOUT, and it is
   * what survives a pack renaming its questions. Loading it here also means a field targeting a
   * question this worker is never asked is a counted miss rather than a suggestion attached to
   * a screen he will not see.
   */
  private stage(
    workerId: string,
    fields: Readonly<Record<string, ParsedField>>,
    items: readonly QuestionPackItem[],
  ): Map<string, ResumeSuggestion> {
    const built = buildSuggestions(fields, items as QuestionPackItem[]);

    if (built.misses.size > 0) {
      // COUNTS AND FIELD IDS, never values. A missed suggestion is otherwise invisible — no
      // suggestion looks exactly like a résumé that did not mention the thing — and RI-7 needs
      // this line to measure per-field coverage before any worker-facing claim is made.
      this.logger.log(
        `résumé suggestions for worker ${workerId.slice(0, 8)}…: ` +
          `${built.byQuestionKey.size} offered, ${built.misses.size} unmapped ` +
          `(${[...built.misses.entries()].map(([id, why]) => `${id}:${why}`).join(", ")})`,
      );
    }
    return new Map(built.byQuestionKey);
  }

  /**
   * Every question this worker could be asked, across BOTH packs he may meet.
   *
   * THE UNIVERSAL PACK IS ALWAYS INCLUDED, AND IT IS WHERE NEARLY ALL THE YIELD IS. Trade,
   * experience, city, salary, education and availability are universal keys; the trade pack is
   * fifteen-eighteenths closed-option CAPABILITY claims a résumé rarely carries, which the
   * approved plan measured before this phase was written.
   *
   * A CONSEQUENCE WORTH STATING, BECAUSE IT LIMITS WHAT RI-4 CAN SHOW TODAY.
   * `GET /profiling/form` serves ONE pack — `loadForFamily` returns the trade pack alone, and
   * the universal questions are the interview's tail rather than form screens. So on the FORM
   * route the suggestions that appear beside questions are the trade-pack subset, while the
   * universal ones are STAGED and wait for a surface that can show them: the `preferences`
   * marker screen (`PUT /workers/me/work-preferences`, which has a vocabulary of its own and is
   * a bridge this phase deliberately does not build) and RI-5's batch-confirm turn.
   *
   * They are staged rather than dropped ON PURPOSE. The alternative — only ever staging what
   * today's form can render — would make the stored payload depend on the client's current
   * capabilities, and every later surface would have to re-parse the document to catch up.
   *
   * TAKES THE FAMILY ID, NOT THE FORM KIND. The kind → family lookup is an assertion about the
   * registry and its caller resolves it before the degrade catch opens; see `decide` step (3).
   * Everything left in here is I/O, which is what that catch is allowed to swallow.
   */
  private async packItems(
    familyId: string | null,
  ): Promise<{ all: QuestionPackItem[]; trade: QuestionPackItem[] }> {
    const now = Date.now();
    const universal = await this.packs.loadUniversal(now);
    const trade = familyId === null ? null : await this.packs.loadForFamily(familyId, now);
    return {
      // Universal first, trade second — the order `flatMap` produced before this split,
      // preserved so the batch-confirm bubble reads exactly as it always has.
      all: [...(universal?.items ?? []), ...(trade?.items ?? [])],
      // The trade pack ALONE, in pack order: the form serves one pack, so the option
      // mapping is asked against exactly the questions a form screen can render.
      trade: [...(trade?.items ?? [])],
    };
  }

  private async resolveOccupation(
    text: string | null,
  ): Promise<{ familyId: string | null; label: string | null }> {
    if (text === null || text.trim().length === 0) return { familyId: null, label: null };
    try {
      const result = await this.occupations.resolve(text);
      return { familyId: result.pinned?.familyId ?? null, label: result.pinned?.label ?? null };
    } catch (error) {
      // DEGRADES (D9). An unavailable index costs the CORROBORATION half of the route — the
      // term match still stands on the model's own labels — and never costs the worker his
      // journey. Logged WITHOUT the text, which is a line from his résumé.
      this.logger.warn(
        `occupation resolve unavailable during résumé routing: ${(error as Error).message}`,
      );
      return { familyId: null, label: null };
    }
  }
}

export interface RoutedImport {
  route: ResumeImportRouteName;
  formKind: TradeFormKind | null;
  fieldsExtracted: number;
  suggestionsOffered: number;
}

/** What `decide` hands the settle. `suggestionsEnc` is already sealed — never a payload. */
interface RoutingDecision {
  route: ResumeImportRouteName;
  formKind: TradeFormKind | null;
  /**
   * Task 1 B2 — the model's closed-list judgment, settled beside the route for
   * observability (RI-7) and the future recall path. Never read by the router.
   */
  associationKind: TradeFormKindName | null;
  suggestionsEnc: string | null;
  suggestionsOffered: number;
}

/**
 * Trade-pack items → the option-mapping call's closed questions.
 *
 * ONLY single/multi-select questions WITH options are asked: text/number/boolean
 * answers are the worker's own words or measures, never a closed id the document
 * could support, and asking the model about them would buy citations for values
 * the apply step could never tick. Pure, so the Haan-time re-derivation and this
 * call site can never disagree about what was asked.
 */
function mapQuestions(items: readonly QuestionPackItem[]) {
  return items
    .filter(
      (item) =>
        (item.answer_type === "single_select" || item.answer_type === "multi_select") &&
        item.options.length > 0,
    )
    .map((item) => ({
      question_key: item.question_key,
      answer_type: item.answer_type as "single_select" | "multi_select",
      options: item.options.map((o) => ({ option_key: o.option_key, label_text: o.label_text })),
    }));
}

/** A parsed value, but only when it is a usable string. Gate 3 has already typed it. */
function stringValue(field: ParsedField | undefined): string | null {
  if (field === undefined) return null;
  const { value } = field;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
