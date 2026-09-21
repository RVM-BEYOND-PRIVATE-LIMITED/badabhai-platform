import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AnswerRecord, QuestionPackItem } from "@badabhai/ai-contracts";

import { SERVER_CONFIG } from "../../config/config.module";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { packAnswerRowFor } from "../pack-answer-row";
import { projectProfile } from "../answer-map-projector";
import { PackRegistryService } from "../pack-registry.service";
import { ResumeSuggestionReader } from "../resume-import/resume-suggestion-reader";
import { familyForTradeForm, TRADE_FORM_KINDS, type TradeFormKind } from "../trade-form-router";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { TradeFormRepository } from "./trade-form.repository";

/**
 * Apply staged résumé option mappings as the worker's form answers (RI-autofill,
 * owner override B, 2026-09-20, of ruling D2).
 *
 * WHAT THIS IS AND WHAT IT IS NOT. After the worker's identity "haan", the closed
 * option ids the mapping call staged are written as his answers — WITHOUT
 * per-fact confirmation. That is the override: D2's "a suggestion becomes an answer
 * only when he confirms it" is satisfied once, by the identity answer, for the whole
 * mapping. Everything else about D2 still holds: nothing is written before the
 * "haan", a "nahi" writes nothing, and every applied row carries `source: 'resume'`
 * (migration 0119) so a later audit can tell a tapped chip from a matched one.
 *
 * ONE TRANSACTION PER IMPORT, NOT PER QUESTION. Either the whole mapping lands or
 * none of it does — a half-applied mapping is a form that claims fewer capabilities
 * than the résumé supported, with no record of which half is missing.
 *
 * A STORED ANSWER ALWAYS WINS (ruling D7). A question the worker already answered —
 * by tap, by interview, by an earlier autofill — is skipped, never overwritten. The
 * Haan confirms the résumé is his; it does not revoke answers he already gave.
 *
 * FAIL-OPEN AT THE CALLER'S DISCRETION. This method never throws for data or model
 * reasons: no staged mappings, an unresolvable pack, or a write the database
 * refused all return zero counts and log. The Haan turn that called it still hands
 * over to the form — an autofill that failed must cost the worker prefill, never
 * the journey. Only the kill switch (`RESUME_AUTOFILL_ENABLED`, default off)
 * returns early without even reading: off means D2-unchanged behaviour.
 */
@Injectable()
export class ResumeAutofillService {
  private readonly logger = new Logger(ResumeAutofillService.name);

  constructor(
    private readonly suggestions: ResumeSuggestionReader,
    private readonly packs: PackRegistryService,
    private readonly answers: TradeFormRepository,
    private readonly attributes: WorkerAttributesRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "RESUME_AUTOFILL_ENABLED">,
  ) {}

  /**
   * Write the import's staged mappings as this worker's answers for its form kind.
   *
   * Idempotent per import: applied rows upsert on `(worker_id, pack_id,
   * question_key)`, so a retried Haan converges rather than duplicates — and the
   * event carries `profile.resume_autofill_applied:<importId>` for the same reason.
   */
  async applyOnHaan(
    workerId: string,
    importId: string,
    ctx: RequestContext,
  ): Promise<AutofillResult> {
    const zero: AutofillResult = { mapped: 0, applied: 0, skippedAnswered: 0 };
    if (!this.config.RESUME_AUTOFILL_ENABLED) return zero;

    const routed = await this.suggestions.routeForImport(workerId, importId);
    const formKind = narrowFormKind(routed?.formKind ?? null);
    if (routed?.route !== "form" || formKind === null) return zero;

    const staged = await this.suggestions.mappedOptionsForImport(workerId, importId);
    if (staged.length === 0) return zero;

    let pack;
    try {
      pack = await this.packs.loadForFamily(familyForTradeForm(formKind), Date.now());
    } catch (error) {
      // DEGRADES, NEVER FAILS. A pack registry that cannot load costs the worker his
      // prefill, never his handover — the Haan turn continues to the form regardless.
      this.logger.warn(
        `résumé autofill skipped for worker ${workerId.slice(0, 8)}…: pack unavailable ` +
          `(${(error as Error).message})`,
      );
      return zero;
    }
    if (!pack) return zero;

    const byKey = new Map(pack.items.map((item) => [item.question_key, item]));
    const saved = await this.answers.listAnswers(workerId, pack.pack_id);
    const answered = new Set(
      saved.filter((row) => row.status === "answered").map((row) => row.questionKey),
    );

    const records: AnswerRecord[] = [];
    let skippedAnswered = 0;
    for (const mapping of staged) {
      const item = byKey.get(mapping.questionKey);
      if (!item) continue;
      // A STORED ANSWER ALWAYS WINS (ruling D7). The Haan claims the résumé; it does
      // not revoke what the worker already said.
      if (answered.has(item.question_key)) {
        skippedAnswered += 1;
        continue;
      }
      const record = recordFromKeys(item, mapping.optionKeys);
      if (record) records.push(record);
    }
    if (records.length === 0) {
      // NOTHING APPLIABLE — but still counted. A Haan that mapped one and applied zero
      // (everything already answered, or every mapping aimed at a retired question) is
      // funnel signal, not silence: `applied` minus `mapped` is the gap this event exists
      // to measure.
      await this.emitAutofill(workerId, importId, formKind, staged.length, 0, skippedAnswered, ctx);
      return { mapped: staged.length, applied: 0, skippedAnswered };
    }

    // ONE NORMALISATION, NOT TWO — the same rule `answer()` documents: the value is
    // resolved once per question here, then handed to the SAME two builders the form
    // uses (`packAnswerRowFor` + `projectProfile`), so an autofilled answer and a
    // tapped answer to the same question produce byte-identical rows in both tables.
    const rows = records
      .map((record) =>
        packAnswerRowFor({
          workerId,
          // Null session: honest provenance ("from a résumé, not from a conversation"),
          // the same null `contextFor` writes for résumé-routed forms. Both tables
          // accept null here.
          sessionId: null,
          packId: pack.pack_id,
          packVersion: pack.version,
          record,
          source: "resume",
        }),
      )
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length === 0) {
      // Records built but none representable — counted, same as the path above: the gap
      // between "mapped" and "applied" is what tells a pack-options drift apart.
      await this.emitAutofill(workerId, importId, formKind, staged.length, 0, skippedAnswered, ctx);
      return { mapped: staged.length, applied: 0, skippedAnswered };
    }

    const { attributes } = projectProfile(records);
    await this.answers.withTransaction(async (tx) => {
      for (const row of rows) {
        await this.answers.upsertAnswer(row, tx);
      }
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
            sessionId: null,
          })),
          tx,
        );
      }
    });

    await this.emitAutofill(
      workerId,
      importId,
      formKind,
      staged.length,
      rows.length,
      skippedAnswered,
      ctx,
    );

    this.logger.log(
      `résumé autofill for worker ${workerId.slice(0, 8)}…: ` +
        `${rows.length} applied, ${skippedAnswered} already answered, form=${formKind}`,
    );
    return { mapped: staged.length, applied: rows.length, skippedAnswered };
  }

  /**
   * Count the Haan's outcome — best-effort, like every other funnel emit here.
   *
   * COUNTS AND SLUGS ONLY. Never an answer, never a label — the identical discipline
   * `profile.form_completed` keeps: the answers are what the model matched about a
   * specific worker.
   */
  private async emitAutofill(
    workerId: string,
    importId: string,
    formKind: TradeFormKind,
    mapped: number,
    applied: number,
    skippedAnswered: number,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "profile.resume_autofill_applied",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          import_id: importId,
          form_kind: formKind,
          mapped,
          applied,
          skipped_answered: skippedAnswered,
        },
        // ONCE PER IMPORT. The Haan is settled once by envelope state, and a retried
        // turn re-settles settled state without reaching here — but the key makes a
        // second application of the same document a no-count rather than a double.
        idempotencyKey: `profile.resume_autofill_applied:${importId}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `the résumé autofill for import ${importId} was not recorded; the answers ` +
          `stand but RI-7 cannot see them: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * The staged mapping → the interview's own currency, resolved exactly as
 * `recordFor` resolves a chips tap in `answer()`: option keys to
 * `option.value ?? label_text`, single-select scalar, multi-select array.
 *
 * Null when the keys resolve to nothing storable — a question whose options changed
 * under a staged mapping degrades to unapplied, never to a row that violates
 * `wpa_answer_shape_chk`.
 */
function recordFromKeys(
  item: QuestionPackItem,
  optionKeys: readonly string[],
): AnswerRecord | null {
  if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") return null;
  const byKey = new Map(item.options.map((option) => [option.option_key, option]));
  const keys = [...new Set(optionKeys)].filter((key) => byKey.has(key));
  if (keys.length === 0) return null;
  if (item.answer_type === "single_select" && keys.length > 1) return null;
  const values = keys.map((key) => optionValue(byKey.get(key)!));
  return {
    question_key: item.question_key,
    target_field: item.target_field,
    value_raw: null,
    // A FORM HAS NO TURNS. Zero is the honest value — the same zero `recordFor` writes.
    value_normalized: item.answer_type === "single_select" ? values[0]! : values,
    status: "answered",
    evidence: null,
    turn: 0,
    history: [],
  };
}

/**
 * NARROWED RATHER THAN A BARE `??` — the same three shapes `recordFor` documents:
 * the value lands in a typed column, so anything unrepresentable falls back to the
 * label rather than reaching the database as a value no reader expects.
 */
function optionValue(option: QuestionPackItem["options"][number]): string | number | boolean {
  const value = option.value;
  if (typeof value === "string") return value.length > 0 ? value : option.label_text;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return option.label_text;
}

/**
 * The stored form kind, narrowed to the closed enabled set — or null.
 *
 * A MEMBERSHIP TEST, NOT A CAST: whatever is not in the set is a kind with no form
 * behind it, and handing over to it would serve a worker eighteen questions that do
 * not exist. Null reads as "no form", and the caller falls through to the interview.
 */
function narrowFormKind(kind: string | null): TradeFormKind | null {
  return (TRADE_FORM_KINDS as readonly string[]).includes(kind ?? "")
    ? (kind as TradeFormKind)
    : null;
}

export interface AutofillResult {
  readonly mapped: number;
  readonly applied: number;
  readonly skippedAnswered: number;
}
