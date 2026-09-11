import { Injectable, Logger } from "@nestjs/common";
import type { ParsedField, QuestionPackItem } from "@badabhai/ai-contracts";
import type { ResumeExtractionMethodName, ResumeImportRouteName } from "@badabhai/types";

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
 * Every path through {@link route} ends with a worker who can carry on. A failed parse, an
 * occupation index that is down, a document with no role in it — all of them produce the CHAT
 * route, which is today's behaviour byte for byte. There is no branch here that leaves a
 * worker with nothing to do, and the chat route is the DEFAULT rather than the fallback:
 * only 9 of 21 declared roles have a form at all.
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

  async route(workerId: string, draft: ParsedDraft, ctx: RequestContext): Promise<RoutedImport> {
    if (draft.status !== "parsed") {
      // A parse that produced nothing cannot route, and must not pretend to. The import row
      // already carries its own failure reason and `profile.resume_parse_failed` has already
      // been emitted by the parse service — emitting `resume_parsed` here as well would
      // double-count the funnel's middle step, which is the one number the four separate
      // events exist to keep answerable.
      return { route: "chat", formKind: null, fieldsExtracted: 0, suggestionsOffered: 0 };
    }

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

    const route: ResumeImportRouteName = formKind === null ? "chat" : "form";
    const suggestions = await this.stage(workerId, draft.fields, formKind);

    await this.imports.markRouted(draft.importId, {
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
    });

    await this.events.emit({
      event_name: "profile.resume_parsed",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        import_id: draft.importId,
        extraction_method: draft.extractionMethod as ResumeExtractionMethodName,
        route,
        form_kind: formKind,
        // TWO NUMBERS, NOT ONE. They differ by everything that mapped nowhere, and a widening
        // gap is the earliest signal the prompt has drifted or a pack has moved a target field.
        fields_extracted: Object.keys(draft.fields).length,
        suggestions_offered: suggestions.size,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      route,
      formKind,
      fieldsExtracted: Object.keys(draft.fields).length,
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
  private async stage(
    workerId: string,
    fields: Readonly<Record<string, ParsedField>>,
    formKind: TradeFormKind | null,
  ): Promise<Map<string, ResumeSuggestion>> {
    const items = await this.packItems(formKind);
    const built = buildSuggestions(fields, items);

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
   */
  private async packItems(formKind: TradeFormKind | null): Promise<QuestionPackItem[]> {
    const now = Date.now();
    const packs = [
      await this.packs.loadUniversal(now),
      formKind === null ? null : await this.packs.loadForFamily(familyForTradeForm(formKind), now),
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

/** A parsed value, but only when it is a usable string. Gate 3 has already typed it. */
function stringValue(field: ParsedField | undefined): string | null {
  if (field === undefined) return null;
  const { value } = field;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
