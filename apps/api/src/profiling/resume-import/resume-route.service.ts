import { Injectable, Logger } from "@nestjs/common";
import type { ParsedField, QuestionPackItem } from "@badabhai/ai-contracts";
import { ProfileResumeParsedPayload } from "@badabhai/event-schema";
import type { ResumeImportRouteName } from "@badabhai/types";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { OccupationService } from "../../occupation/occupation.service";
import { PackRegistryService } from "../pack-registry.service";
import { familyForTradeForm, routeToTradeForm, type TradeFormKind } from "../trade-form-router";
import { ResumeImportRepository } from "./resume-import.repository";
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

    const decision = await this.decide(workerId, draft);

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
    });

    const settled = await this.imports.withTransaction(async (tx) => {
      const wrote = await this.imports.settleParsed(
        draft.importId,
        {
          extractionMethod: draft.extractionMethod,
          pageCount: draft.pageCount,
          ocrConfidence: draft.ocrConfidence,
        },
        {
          route: decision.route,
          formKind: decision.formKind,
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

    let items: QuestionPackItem[];
    try {
      items = await this.packItems(familyId);
    } catch (error) {
      // THE CLASS NAME ONLY. A pack error message can quote a pack path or a question key, and
      // this line sits next to a worker id; the class is enough to find the outage.
      this.logger.error(
        `question packs unavailable during résumé routing; degrading to chat ` +
          `(${error instanceof Error ? error.constructor.name : typeof error})`,
      );
      return { route: "chat", formKind: null, suggestionsEnc: null, suggestionsOffered: 0 };
    }

    const route: ResumeImportRouteName = formKind === null ? "chat" : "form";
    const suggestions = this.stage(workerId, draft.fields, items);

    return {
      route,
      formKind,
      suggestionsEnc:
        suggestions.size > 0
          ? // ONE TOKEN OVER THE WHOLE PAYLOAD, never per leaf. The schema docblock records why:
            // a walker that encrypts leaves is the shape that rots, and `parse_masking.py` has a
            // measured bug of exactly that kind where employer names nested in an array crossed
            // a boundary nobody thought they could reach. One column cannot be partially covered.
            this.crypto.encrypt(JSON.stringify(Object.fromEntries(suggestions)))
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
  private async packItems(familyId: string | null): Promise<QuestionPackItem[]> {
    const now = Date.now();
    const packs = [
      await this.packs.loadUniversal(now),
      familyId === null ? null : await this.packs.loadForFamily(familyId, now),
    ];
    return packs.flatMap((pack) => (pack === null ? [] : pack.items));
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
  suggestionsEnc: string | null;
  suggestionsOffered: number;
}

/** A parsed value, but only when it is a usable string. Gate 3 has already typed it. */
function stringValue(field: ParsedField | undefined): string | null {
  if (field === undefined) return null;
  const { value } = field;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
