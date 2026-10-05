import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database, WorkerProfile } from "@badabhai/db";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { CompanionV2EditSection, CompanionV2Outcome } from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { DATABASE } from "../../database/database.module";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import type { RequestContext } from "../../common/request-context";
import { hasActiveConsent } from "../../consent/consent-active";
// VALUE import: Nest resolves the constructor parameter by this class token (see NewResumeHandler).
import { ConsentRepository } from "../../consent/consent.repository";
import { EventsService } from "../../events/events.service";
import { ProfilesRepository } from "../../profiles/profiles.repository";
import { WorkerEmploymentService } from "../../profiles/worker-employment.service";
import { WorkerLanguagesService } from "../../profiles/worker-languages.service";
import { WorkerQualificationsService } from "../../profiles/worker-qualifications.service";
import { WorkerOccupationsService } from "../../profiles/worker-occupations.service";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import { WorkerSkillsService } from "../../match/worker-skills.service";
import { containsHardIdentifier } from "../../profiling/resume-import/resume-parse-gates";
import { ResumeService } from "../../resume/resume.service";
import { ResumeRerenderService } from "../../resume/resume-rerender.service";
import type { ChatEditRegeneration } from "../../resume/resume.dto";
import {
  EDIT_CARD_ROWS_MAX,
  type CompanionTurn,
  type EditProposal,
  type EditProposalRow,
} from "../chat-companion.dto";
import {
  V2_EDIT_CANCELLED,
  V2_EDIT_CARD_INTRO,
  V2_EDIT_DONE,
  V2_EDIT_DONE_CAPPED,
  V2_EDIT_IDENTITY,
  V2_EDIT_NONE,
  V2_EDIT_PLACEHOLDER,
  V2_EDIT_STALE,
  V2_EDIT_UNAVAILABLE,
  FALLBACK,
} from "../companion-replies";
import { EditProposalStore, type StoredEditProposal, type StoredEditProposalRow } from "./edit-proposal.store";
import {
  buildEditableFields,
  cardFieldLabel,
  catalogueEntry,
  displayValue,
  hasControlChars,
  hasPlaceholderToken,
  normaliseValue,
  opAllowed,
  SECTION_LABELS,
  wholeEntryDelete,
  type WholeEntryKind,
} from "./edit-catalogue";
import { identityAskIn } from "./edit-identity";
import { dedupeRows, isNoopAdd, planSection, type SectionPlan } from "./edit-plan";
import {
  isStale,
  rowCarriesField,
  sectionReadable,
  snapshotRows,
  trimSnapshot,
  type EditState,
  type SnapshotRow,
} from "./edit-snapshot";
import { sectionsOf, taskChips, v2CopyTurn, v2EditCardTurn } from "./companion-v2-compose";

/**
 * The edit-parse contract's own bounds — `CompanionEditParseInputSchema`'s `snapshot.max(64)` and
 * `max_rows.max(10)` (`packages/ai-contracts/src/companion.ts`), which that package keeps
 * private. Restated so the API never SENDS a body the AI service must 422 (a 422 reads as "no
 * rows" and serves the clarify line forever); `companion-edit.contract.test.ts` pins both against
 * the schema itself, so a contract change fails there rather than in production.
 */
export const EDIT_PARSE_SNAPSHOT_MAX = 64;
export const EDIT_PARSE_MAX_ROWS_MAX = 10;

/**
 * The sections the résumé render reads LIVE on every render (`ResumeRenderProcessor`: employment,
 * credentials + languages, secondary occupations, and the preference attributes) — so a re-render
 * alone puts an edit to them on the PDF. Skills are absent: the render prints the skills stored
 * with the résumé, which only a regeneration replaces.
 */
const RENDERED_LIVE: ReadonlySet<CompanionV2EditSection> = new Set([
  "employment",
  "languages",
  "qualifications",
  "occupations",
  "preferences",
]);

export type ConfirmResult =
  | {
      readonly kind: "applied";
      readonly turn: CompanionTurn;
      readonly proposalId: string;
      readonly appliedCount: number;
      readonly sections: CompanionV2EditSection[];
      readonly resumeRegen: ChatEditRegeneration;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale"; readonly turn: CompanionTurn }
  /** Nothing was written; the turn carries the SAME card so the worker may tap Haan again. */
  | { readonly kind: "failed"; readonly turn: CompanionTurn };

export type CancelResult =
  | { readonly kind: "cancelled"; readonly turn: CompanionTurn; readonly proposalId: string }
  | { readonly kind: "not_found" };

/** What `propose` delivered — the turn plus the closed outcome the v2 event records. */
export interface ProposeResult {
  readonly turn: CompanionTurn;
  readonly outcome: CompanionV2Outcome;
}

/**
 * Why a model row was dropped — a closed set. `placeholder` and `whole_entry_delete` are the drops
 * rephrasing cannot fix (a masked value; a whole job, certificate, education or training — which
 * "Never from chat" leaves to the Profile screen), so they point the worker there when nothing else
 * survives. The delete's entry kind rides the verdict so the counts-only log line can name it.
 */
type DropReason =
  | { readonly kind: "invalid" }
  | { readonly kind: "placeholder" }
  | { readonly kind: "whole_entry_delete"; readonly entry: WholeEntryKind };

/** One model row through the gates: kept as a card row, or dropped for a closed reason. */
type RowVerdict =
  | { readonly kind: "kept"; readonly row: StoredEditProposalRow }
  | { readonly kind: "dropped"; readonly reason: DropReason };


/**
 * THE EDIT PATH (ADR-0046 O4/O5/O6): propose → the worker taps Haan → apply in ONE transaction.
 *
 * THE MODEL NEVER WRITES. `propose` reads every section once (`EditState`), sends the message
 * plus this catalogue and a snapshot of the worker's current values — cut to the contract's cap —
 * to `AiService.companionEditParse`, validates every returned row deterministically (whole-job
 * delete, catalogue, op, ref, value, placeholder token, hard identifier, no-op, duplicate, and the
 * section writer's REAL schema) and stores a card of at most `min(EDIT_MAX_ROWS, 3)` rows.
 * `confirm` CLAIMS the card (at most one apply per card), refuses a ticked whole-job delete,
 * re-reads the state, refuses a stale card, applies every selected row through the section
 * writers on ONE transaction, and only then runs the post-commit side effects and QUEUES the
 * résumé regeneration (a new history entry, trigger `chat_edit`, the daily cap charged up front)
 * — when the worker's consent names `resume_generation`. When none is queued, the LLM-free
 * re-render the form path would have run puts the live-printed edits on the PDF.
 *
 * FAIL CLOSED, EVERYWHERE. No parse, no rows or a store failure means no card and no claim; a
 * claim Redis refuses, an unreadable section or a writer failure writes nothing, and the card is
 * served again so the worker may retry until its TTL; a stale card writes nothing and is deleted.
 *
 * PRIVACY. The message and every current value are masked by the AI service before the model —
 * unless `AI_RAW_PII_ENABLED` is on, when both reach it raw and the placeholder-token gate simply
 * finds nothing to drop, so the hard-identifier gate beside it (ADR-0047 G1) is what keeps an
 * echoed phone off a card; the proposal lives in Redis for its TTL and never in a log; every
 * event carries ids, counts and closed enums only.
 */
@Injectable()
export class CompanionEditService {
  private readonly logger = new Logger(CompanionEditService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly ai: AiService,
    private readonly proposals: EditProposalStore,
    private readonly profiles: ProfilesRepository,
    private readonly employment: WorkerEmploymentService,
    private readonly languages: WorkerLanguagesService,
    private readonly qualifications: WorkerQualificationsService,
    private readonly occupations: WorkerOccupationsService,
    private readonly preferences: WorkerPreferencesService,
    private readonly workerSkills: WorkerSkillsService,
    private readonly resumes: ResumeService,
    private readonly events: EventsService,
    private readonly cost: AiCostRecorder,
    // Read (never written) for the regeneration's fail-closed `resume_generation` gate.
    private readonly consents: ConsentRepository,
    // The LLM-free re-render when no regeneration was queued (see `confirm`).
    private readonly rerender: ResumeRerenderService,
  ) {}

  // ── propose ───────────────────────────────────────────────────────────────────────────────

  /** One message to a card (or a fixed line). Never throws; never writes anything. */
  async propose(
    workerId: string,
    profile: WorkerProfile,
    text: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<ProposeResult> {
    const state = await this.readState(workerId, profile);
    const snapshot = snapshotRows(state);
    const sent = trimSnapshot(snapshot, text, EDIT_PARSE_SNAPSHOT_MAX);
    if (sent.length < snapshot.length) {
      // BUG-SNAPSHOT-CAP: counts and a closed reason only, never a value.
      this.logger.warn(
        `companion edit snapshot trimmed for worker ${workerId}: ${sent.length} of ${snapshot.length} rows sent (reason=snapshot_cap)`,
      );
    }
    const cardRowsMax = this.cardRowsMax();
    const parsed = await this.ai.companionEditParse(
      {
        text,
        catalogue: buildEditableFields(),
        snapshot: sent.map((row) => ({ ref: row.ref, section: row.section, fields: row.fields })),
        max_rows: cardRowsMax,
      },
      ctx,
    );

    // THE SPEND IS RECORDED BEFORE ANY BRANCH BELOW CAN RETURN — a call that happened was
    // billed whatever its content turned out to be, and `record` no-ops on a null meta (the
    // blocked path, an unreachable service). ADR-0046 O12: watched, never capped.
    await this.cost.record(
      parsed?.ai_metadata ?? null,
      "companion_edit_parse",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId },
    );

    const unsupported = parsed?.unsupported ?? [];
    if (parsed === null) return this.noCard(text, unsupported, false);

    // Only the refs the model was SHOWN can be addressed: a trimmed row is not guessable.
    const byRef = new Map(sent.map((row) => [row.ref, row]));
    const effectiveUnsupported = new Set(unsupported);
    let placeholderDropped = false;
    const wholeEntryDeletes: WholeEntryKind[] = [];
    const valid: StoredEditProposalRow[] = [];
    for (const row of parsed.rows) {
      const verdict = this.validateRow(row, byRef);
      if (verdict.kind === "kept") {
        valid.push(verdict.row);
        continue;
      }
      if (verdict.reason.kind === "placeholder") placeholderDropped = true;
      if (verdict.reason.kind === "whole_entry_delete") {
        wholeEntryDeletes.push(verdict.reason.entry);
      }
      // Belt and braces: the AI service already drops a row aimed outside the six sections, so
      // on real traffic `identityAskIn` (in `noCard`) is what serves the identity line. Widened
      // to `string` because the model's output is UNTRUSTED — its type says one of six.
      const section: string = row.section;
      if (section === "identity" || section === "contact") {
        effectiveUnsupported.add(section as "identity" | "contact");
      }
    }
    if (wholeEntryDeletes.length > 0) {
      // "Never from chat": counts and a closed reason only, never a value (the snapshot_cap rule).
      // ONE line, and employment keeps its published `job_delete_from_chat` reason byte-for-byte;
      // a qualification delete gets its own reason, so the two are never confused in a log read.
      const jobs = wholeEntryDeletes.filter((entry) => entry === "employment").length;
      const reasons = [
        ...(jobs > 0 ? ["job_delete_from_chat"] : []),
        ...(wholeEntryDeletes.length - jobs > 0 ? ["qualification_delete_from_chat"] : []),
      ].join(",");
      this.logger.warn(
        `companion edit dropped ${wholeEntryDeletes.length} of ${parsed.rows.length} rows for worker ${workerId}: a whole-entry delete is never carded (reason=${reasons})`,
      );
    }

    // Duplicates and no-op adds off, then every row the writer's own schema would refuse, then
    // the card's row cap (O5) — the API's, whatever the model returned.
    const kept = this.acceptedByWriters(
      state,
      dedupeRows(valid).filter((row) => !isNoopAdd(row, snapshot)),
    ).slice(0, cardRowsMax);
    const dropped = parsed.rows.length - kept.length;

    if (kept.length === 0) {
      const profileScreenOnly = placeholderDropped || wholeEntryDeletes.length > 0;
      return this.noCard(text, [...effectiveUnsupported], profileScreenOnly);
    }

    const proposalId = randomUUID();
    const expiresAt = new Date(
      now.getTime() + this.config.CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS * 1_000,
    ).toISOString();
    const proposal: StoredEditProposal = {
      proposal_id: proposalId,
      expires_at: expiresAt,
      rows: kept,
    };
    if (!(await this.proposals.save(workerId, proposal))) {
      // Contracts §7: no card is offered, and nothing is claimed to have happened.
      return { turn: v2CopyTurn(V2_EDIT_UNAVAILABLE), outcome: "fallback" };
    }

    await this.emit(workerId, ctx, "chat.companion_edit_proposed", {
      proposal_id: proposalId,
      row_count: kept.length,
      sections: sectionsOf(kept),
      dropped_count: dropped,
      unsupported: [...effectiveUnsupported],
    });

    return {
      turn: v2EditCardTurn(V2_EDIT_CARD_INTRO, this.toWireProposal(proposal)),
      outcome: "proposed",
    };
  }

  /**
   * The rows a card may carry: `CHAT_COMPANION_V2_EDIT_MAX_ROWS`, never more than one confirm
   * may tick, never more than the edit-parse contract accepts (CON-2.2b).
   */
  private cardRowsMax(): number {
    return Math.min(
      this.config.CHAT_COMPANION_V2_EDIT_MAX_ROWS,
      EDIT_CARD_ROWS_MAX,
      EDIT_PARSE_MAX_ROWS_MAX,
    );
  }

  /**
   * No card. In order: identity/contact — named by the model OR by the worker's own words — is
   * steered to the Profile screen (O3). A change chat cannot make is pointed at the Profile screen
   * too, because rephrasing cannot help: a row dropped for a masked value (O17) or as a whole-entry
   * delete ("Never from chat": a job, 2026-10-01; a certificate, education or training, TD151(1)
   * 2026-10-05) — `profileScreenOnly` — or anything the model itself filed as `other`
   * (contracts §2.2: asked, but not editable here). Else the clarify line.
   */
  private noCard(
    text: string,
    unsupported: readonly string[],
    profileScreenOnly: boolean,
  ): ProposeResult {
    const identity =
      unsupported.includes("identity") ||
      unsupported.includes("contact") ||
      identityAskIn(text) !== null;
    if (identity) return { turn: v2CopyTurn(V2_EDIT_IDENTITY, taskChips(this.config)), outcome: "served" };
    if (profileScreenOnly || unsupported.includes("other")) {
      return { turn: v2CopyTurn(V2_EDIT_PLACEHOLDER, taskChips(this.config)), outcome: "served" };
    }
    return { turn: v2CopyTurn(V2_EDIT_NONE, taskChips(this.config)), outcome: "clarify" };
  }

  /**
   * One model row through every per-row gate (spec §Edit step 3).
   *
   * The gates, in order: a whole-entry delete — a job (owner 2026-10-01) or a certificate,
   * education or training (TD151(1), provisional 2026-10-05) — is dropped as `whole_entry_delete`
   * ("Never from chat", named BEFORE the catalogue gate, which would drop it as `invalid`, so
   * `propose` can count it and point the worker at the Profile screen); the catalogue names the
   * pair; the op is legal for it; edit/delete address a row this snapshot actually minted AND
   * showed, whose
   * entry has that field (a certificate field on a certificate, a scalar preference on `pref`);
   * add carries no ref; add/edit carry a value that passes the field's own normalisation; a
   * placeholder token drops the row (O17); a hard identifier drops it too (ADR-0047 G1); and an
   * edit identical to the current value is a no-op. That comparison is on the NORMALISED value, the
   * string the writer would store: "tata motors" over a stored "Tata Motors" is a no-op, because
   * the writer cases an employer name before it stores it (#1940). The row-SET gates — duplicates,
   * adds of what is already there, the writer's own schema — run after, in `propose`.
   *
   * THE HARD-IDENTIFIER DROP READS NO FLAG, and it is the placeholder drop's twin. A confirmed
   * employer name or `work_done` is printed on both résumé PDFs, and neither the employment DTO
   * nor the row renderer screens it. Off, a phone the worker typed reached the model as
   * `[PHONE_1]` and the placeholder gate caught the row; with `AI_RAW_PII_ENABLED` on no token is
   * minted, and this is the catch. The AI service drops the same row first (`parse_edit_rows`);
   * this is the API's own wall, as every gate here is. Its verdict is `invalid`, not
   * `placeholder`: `V2_EDIT_PLACEHOLDER` says rephrasing cannot help, which is only true of a
   * masked token — a worker who drops the phone from the line gets a card.
   */
  private validateRow(
    row: {
      op: string;
      section: string;
      ref: string | null;
      field: string | null;
      value: string | null;
    },
    byRef: ReadonlyMap<string, SnapshotRow>,
  ): RowVerdict {
    const invalid: RowVerdict = { kind: "dropped", reason: { kind: "invalid" } };
    const wholeEntry = wholeEntryDelete(row);
    if (wholeEntry !== null) {
      return { kind: "dropped", reason: { kind: "whole_entry_delete", entry: wholeEntry } };
    }
    const entry = catalogueEntry(row.section, row.field ?? "");
    if (entry === undefined || !opAllowed(entry, row.op as never)) return invalid;

    let target: Record<string, string | number> | null = null;
    let before: string | null = null;
    if (row.op !== "add") {
      if (row.ref === null) return invalid;
      const source = byRef.get(row.ref);
      if (source === undefined || source.section !== entry.section) return invalid;
      // EDIT-ROW-KIND: the field must belong to the entry the ref names — an education anchored
      // on `certificate_name` would be deleted under a card that says "certificate".
      if (!rowCarriesField(source, entry.field)) return invalid;
      target = source.target;
      before = source.fields[entry.field] ?? null;
    } else if (row.ref !== null) {
      return invalid;
    }

    let value: string | null = null;
    if (row.op !== "delete") {
      if (row.value === null) return invalid;
      value = normaliseValue(entry.section, entry.field, row.value);
      if (value === null) return invalid;
      // #1943's twin: a C0/C1 control is Common script and passes every field bound, so a
      // model-proposed value could split a suffix or an identifier past the doors beside it.
      if (hasControlChars(value)) return invalid;
      if (hasPlaceholderToken(value)) return { kind: "dropped", reason: { kind: "placeholder" } };
      if (containsHardIdentifier(value) !== null) return invalid;
      if (row.op === "edit" && value === before) return invalid;
    }

    return {
      kind: "kept",
      row: {
        row_id: randomUUID(),
        section: entry.section,
        op: row.op as StoredEditProposalRow["op"],
        field: entry.field,
        value,
        before,
        section_label: SECTION_LABELS[entry.section],
        target,
      },
    };
  }

  /**
   * P1-EDIT-DROP-DTO: the rows whose section plan the writer's REAL schema accepts, in order.
   * Each row is tried together with the rows already accepted for its section, so two rows that
   * pass alone but not together (an end month before the new start month) keep only the first.
   */
  private acceptedByWriters(
    state: EditState,
    rows: readonly StoredEditProposalRow[],
  ): StoredEditProposalRow[] {
    const accepted: StoredEditProposalRow[] = [];
    for (const row of rows) {
      const trial = [...accepted.filter((other) => other.section === row.section), row];
      try {
        planSection(row.section, state, trial);
        accepted.push(row);
      } catch {
        // The writer would refuse this row on Haan; a card must never show it.
      }
    }
    return accepted;
  }

  /**
   * The card as the app receives it. `before`/`after` are the stored tokens, unchanged for the
   * shipped app; `field_label` and `before_display`/`after_display` (BUG-CARD-LABELS) are derived
   * HERE, at wire time, from the stored row's section, field and values — so they are never
   * stored, and a card saved before they existed is served labelled on a retry.
   */
  private toWireProposal(proposal: StoredEditProposal): EditProposal {
    return {
      proposal_id: proposal.proposal_id,
      expires_at: proposal.expires_at,
      rows: proposal.rows.map((row): EditProposalRow => {
        const fieldLabel = cardFieldLabel(row.section, row.field, row.op, row.target);
        return {
          row_id: row.row_id,
          section_label: row.section_label,
          ...(fieldLabel === null ? {} : { field_label: fieldLabel }),
          op: row.op,
          before: row.before,
          after: row.value,
          before_display: displayValue(row.section, row.field, row.before),
          after_display: displayValue(row.section, row.field, row.value),
        };
      }),
    };
  }

  // ── confirm ───────────────────────────────────────────────────────────────────────────────

  /** Haan: claim the card, apply the ticked rows in one transaction, then regenerate. */
  async confirm(
    workerId: string,
    profile: WorkerProfile,
    proposalId: string,
    rowIds: readonly string[],
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<ConfirmResult> {
    const proposal = await this.proposals.load(workerId);
    if (proposal === null || proposal.proposal_id !== proposalId) return { kind: "not_found" };
    if (isExpired(proposal, now)) return this.expired(workerId, proposalId, ctx);
    const selected = proposal.rows.filter((row) => rowIds.includes(row.row_id));
    if (selected.length === 0) return { kind: "not_found" };

    // AT MOST ONCE (BUG-DOUBLE-CONFIRM). A double tap, a retry while this request still works,
    // or a re-confirm after a failed delete finds the card claimed and gets the "already
    // confirmed" 404. Redis refusing the claim means once cannot be promised: nothing is applied.
    const claim = await this.proposals.claim(workerId, proposalId);
    if (claim === "held") return { kind: "not_found" };
    if (claim === "unavailable") return this.failed(proposal);

    // "NEVER FROM CHAT", DEFENCE IN DEPTH. `propose` no longer cards a whole-entry delete — a
    // whole job (owner, 2026-10-01) or a whole certificate/education/training (TD151(1),
    // 2026-10-05) — but a card stored before the ruling lives up to its TTL. A TICKED one is never
    // applied: the card is retired exactly as a stale one is, so nothing is written and the worker
    // is asked again (and is then pointed at the Profile screen). An unticked one is inert.
    const blockedDeletes = selected
      .map((row) => wholeEntryDelete(row))
      .filter((entry): entry is WholeEntryKind => entry !== null);
    if (blockedDeletes.length > 0) {
      const reasons = [
        ...(blockedDeletes.includes("employment") ? ["job_delete_from_chat"] : []),
        ...(blockedDeletes.includes("qualification") ? ["qualification_delete_from_chat"] : []),
      ].join(",");
      this.logger.warn(
        `companion edit confirm for worker ${workerId} refused a stored whole-entry delete; nothing written (reason=${reasons})`,
      );
      return this.retireStale(workerId, proposalId, ctx);
    }

    // THE STATE THE CHECK AND THE APPLY BOTH READ — one read, so the rows that were verified are
    // exactly the rows that get written. A section that cannot be read is not "stale": nothing is
    // known about it, so nothing is written and the card stays for a retry.
    const fresh = await this.readState(workerId, profile);
    if (!sectionsOf(selected).every((section) => sectionReadable(fresh, section))) {
      await this.proposals.release(workerId, proposalId);
      this.logger.warn(
        `companion edit confirm for worker ${workerId} could not re-read a section; nothing written`,
      );
      return this.failed(proposal);
    }

    if (isStale(snapshotRows(fresh), selected)) return this.retireStale(workerId, proposalId, ctx);

    try {
      await this.db.transaction(async (tx) => {
        // A drizzle transaction handle exposes the same query API; the writers accept it typed
        // as `Database` (the codebase's tx convention, see `Database`'s docblock).
        const executor = tx as unknown as Database;
        const bySection = new Map<CompanionV2EditSection, StoredEditProposalRow[]>();
        for (const row of selected) {
          bySection.set(row.section, [...(bySection.get(row.section) ?? []), row]);
        }
        for (const [section, rows] of bySection) {
          await this.write(planSection(section, fresh, rows), workerId, profile, ctx, executor);
        }
      });
    } catch (err) {
      // ROLLED BACK BY CONSTRUCTION. The claim is handed back and the proposal KEPT, and the
      // answer carries the card again, so the worker can tap Haan once more until its TTL.
      await this.proposals.release(workerId, proposalId);
      this.logger.error(
        `companion edit apply failed for worker ${workerId} proposal ${proposalId}; nothing written (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return this.failed(proposal);
    }

    await this.proposals.delete(workerId);

    // Post-commit side effects, in order: the derived night-shift readiness and matching (if
    // their inputs changed), then the résumé, which reads both.
    const shift = selected.find((row) => row.section === "preferences" && row.field === "shift");
    if (shift?.value) {
      // BUG-NIGHT-SEED: the form path's own seed, run where the form runs it — after the write
      // is durable. Best-effort; it never throws.
      await this.preferences.seedNightShiftReadyFromShift(workerId, shift.value);
    }
    if (selected.some((row) => row.section === "occupations")) {
      await this.workerSkills.rebuildQuietly(workerId, ctx);
    }
    const resumeRegen = await this.regenerate(workerId, profile, ctx);
    if (resumeRegen !== "queued" && selected.some((row) => RENDERED_LIVE.has(row.section))) {
      // EDIT-RERENDER: the writers skipped their own forced re-render on the joined transaction
      // because a regeneration was to follow; none will. So the form path's re-render runs here —
      // once, LLM-free, no consent or cap needed (it reprints the stored résumé with the live
      // tables) — and the PDF shows these edits. Best-effort; it never throws.
      await this.rerender.enqueueLatest(workerId, ctx);
    }

    await this.emit(workerId, ctx, "chat.companion_edit_confirmed", {
      proposal_id: proposalId,
      applied_count: selected.length,
      sections: sectionsOf(selected),
      resume_regen: resumeRegen,
    });

    return {
      kind: "applied",
      turn: v2CopyTurn(resumeRegen === "queued" ? V2_EDIT_DONE : V2_EDIT_DONE_CAPPED),
      proposalId,
      appliedCount: selected.length,
      sections: sectionsOf(selected),
      resumeRegen,
    };
  }

  /** Nahi: delete the card and say nothing changed. */
  async cancel(
    workerId: string,
    proposalId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CancelResult> {
    const proposal = await this.proposals.load(workerId);
    if (proposal === null || proposal.proposal_id !== proposalId) return { kind: "not_found" };
    if (isExpired(proposal, now)) return this.expired(workerId, proposalId, ctx);
    // A Nahi racing a Haan: whichever claimed the card first is the answer. A claim Redis
    // refused still cancels — a Nahi writes nothing, so there is nothing to apply twice.
    if ((await this.proposals.claim(workerId, proposalId)) === "held") return { kind: "not_found" };
    await this.proposals.delete(workerId);
    await this.emit(workerId, ctx, "chat.companion_edit_cancelled", {
      proposal_id: proposalId,
      reason: "worker",
    });
    return { kind: "cancelled", turn: v2CopyTurn(V2_EDIT_CANCELLED), proposalId };
  }

  /**
   * A Haan/Nahi on the worker's OWN card after its `expires_at` (CON-4d): the same 404 as ever,
   * and now the funnel's `expired`. The id is proven — it is the card stored under this worker's
   * key, never merely the URL's — and the event dedupes on it, so a second late tap adds nothing.
   * The record is left to lapse on its own: deleting it could race a newer card saved meanwhile.
   */
  private async expired(
    workerId: string,
    proposalId: string,
    ctx: RequestContext,
  ): Promise<{ readonly kind: "not_found" }> {
    await this.emit(workerId, ctx, "chat.companion_edit_cancelled", {
      proposal_id: proposalId,
      reason: "expired",
    });
    return { kind: "not_found" };
  }

  /**
   * A card that must not be applied — the profile moved under it, or it carries a ticked row chat
   * may no longer make: deleted, recorded `cancelled(stale)`, and the stale line served. Nothing
   * was written.
   */
  private async retireStale(
    workerId: string,
    proposalId: string,
    ctx: RequestContext,
  ): Promise<{ readonly kind: "stale"; readonly turn: CompanionTurn }> {
    await this.proposals.delete(workerId);
    await this.emit(workerId, ctx, "chat.companion_edit_cancelled", {
      proposal_id: proposalId,
      reason: "stale",
    });
    return { kind: "stale", turn: v2CopyTurn(V2_EDIT_STALE) };
  }

  /** Nothing was written: the fallback line, carrying the same card so Haan can be tapped again. */
  private failed(proposal: StoredEditProposal): ConfirmResult {
    return { kind: "failed", turn: v2EditCardTurn(FALLBACK, this.toWireProposal(proposal)) };
  }

  /**
   * Ask for the ADR-0043 regeneration with the `chat_edit` trigger (O6) — QUEUED, never run on
   * this request. `ResumeService.queueChatEditRegeneration` charges the daily cap before anything
   * is spent, so `queued` / `capped` is known here and the reply can say which.
   *
   * CONSENT FIRST, FAIL CLOSED. The generation sends the edited profile to a model, so the
   * worker's latest consent must be active AND name `resume_generation` (the P2 new-résumé
   * handler's gate). Anything else asks for nothing — no cap slot, no model call — and records
   * `failed`: the edits ARE written, the résumé is not regenerated (`confirm` re-renders it
   * instead), and the reply says so. The event's closed set has no value of its own for this
   * (contracts §4).
   */
  private async regenerate(
    workerId: string,
    profile: WorkerProfile,
    ctx: RequestContext,
  ): Promise<ChatEditRegeneration> {
    if (!(await hasActiveConsent(this.consents, workerId, "resume_generation"))) {
      this.logger.warn(
        `companion edit regeneration not requested for worker ${workerId}: consent is not active`,
      );
      return "failed";
    }
    try {
      return await this.resumes.queueChatEditRegeneration(workerId, profile.id, ctx);
    } catch (err) {
      // It never throws by contract; a defect in it must still not cost the worker their answer.
      this.logger.warn(
        `companion edit regeneration failed for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return "failed";
    }
  }

  // ── apply (one section, inside the caller's transaction) ─────────────────────────────────

  /** Hand one section's plan to its writer, on the transaction. */
  private async write(
    plan: SectionPlan,
    workerId: string,
    profile: WorkerProfile,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    switch (plan.section) {
      case "employment":
        await this.employment.replaceForWorker(workerId, plan.dto, ctx, { tx });
        return;
      case "skills":
        await this.profiles.setResumeSkillLabels(profile.id, plan.next, tx);
        return;
      case "languages":
        await this.languages.replaceForWorker(workerId, plan.dto, ctx, { tx });
        return;
      case "qualifications":
        await this.qualifications.replaceForWorker(workerId, plan.dto, ctx, { tx });
        return;
      case "occupations":
        await this.occupations.replaceForWorker(workerId, plan.dto, ctx, { tx });
        return;
      case "preferences":
        await this.preferences.setForWorker(workerId, plan.dto, ctx, { tx });
        return;
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────

  /** Every section's current values, each read on its own; a failed read leaves it `undefined`. */
  private async readState(workerId: string, profile: WorkerProfile): Promise<EditState> {
    const [employment, languages, qualifications, occupations, preferences] = await Promise.all([
      this.settle("employment", workerId, () => this.employment.getForWorker(workerId)),
      this.settle("languages", workerId, () => this.languages.getForWorker(workerId)),
      this.settle("qualifications", workerId, () => this.qualifications.getForWorker(workerId)),
      this.settle("occupations", workerId, () => this.occupations.getForWorker(workerId)),
      this.settle("preferences", workerId, () => this.preferences.getForWorker(workerId)),
    ]);
    const draft = await this.settle("skills", workerId, async () =>
      DraftProfileSchema.parse(profile.rawProfile ?? {}),
    );
    return { employment, draft, languages, qualifications, occupations, preferences };
  }

  /** Run one section read; a throw drops that section and is logged with ids only. */
  private async settle<T>(
    what: string,
    workerId: string,
    read: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await read();
    } catch (err) {
      this.logger.warn(
        `companion ${what} snapshot unreadable for worker ${workerId}; section omitted (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return undefined;
    }
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────

  private async emit(
    workerId: string,
    ctx: RequestContext,
    eventName:
      | "chat.companion_edit_proposed"
      | "chat.companion_edit_confirmed"
      | "chat.companion_edit_cancelled",
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: eventName,
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: payload as never,
        idempotencyKey: `${eventName}:${String(payload["proposal_id"])}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      // Best-effort: a failed audit write never costs the worker their card or their answer.
      this.logger.error(
        `${eventName} not recorded for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}

/** Past the card's own `expires_at` — the record may still be in its grace window. */
function isExpired(proposal: StoredEditProposal, now: Date): boolean {
  return Date.parse(proposal.expires_at) <= now.getTime();
}
