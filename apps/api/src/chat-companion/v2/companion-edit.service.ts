import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database, WorkerProfile } from "@badabhai/db";
import { DraftProfileSchema, resumeProfileCarriesValues } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import type { CompanionV2EditSection } from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { DATABASE } from "../../database/database.module";
import { AiService } from "../../ai/ai.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { ProfilesRepository } from "../../profiles/profiles.repository";
import { WorkerEmploymentService } from "../../profiles/worker-employment.service";
import { projectEmploymentForPut, SetMyEmploymentSchema } from "../../profiles/worker-employment.dto";
import { WorkerLanguagesService } from "../../profiles/worker-languages.service";
import { SetMyLanguagesSchema } from "../../profiles/worker-languages.dto";
import { WorkerQualificationsService } from "../../profiles/worker-qualifications.service";
import { SetMyQualificationsSchema } from "../../profiles/worker-qualifications.dto";
import { WorkerOccupationsService } from "../../profiles/worker-occupations.service";
import { SetMyOccupationsSchema } from "../../profiles/worker-occupations.dto";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import { SetMyPreferencesSchema } from "../../profiles/worker-preferences.dto";
import { WorkerSkillsService } from "../../match/worker-skills.service";
import { ResumeService } from "../../resume/resume.service";
import type { CompanionTurn, EditProposal, EditProposalRow } from "../chat-companion.dto";
import {
  V2_EDIT_CANCELLED,
  V2_EDIT_CARD_INTRO,
  V2_EDIT_DONE,
  V2_EDIT_DONE_CAPPED,
  V2_EDIT_IDENTITY,
  V2_EDIT_NONE,
  V2_EDIT_STALE,
  V2_EDIT_UNAVAILABLE,
  FALLBACK,
} from "../companion-replies";
import { EditProposalStore, type StoredEditProposal, type StoredEditProposalRow } from "./edit-proposal.store";
import {
  buildEditableFields,
  catalogueEntry,
  hasPlaceholderToken,
  normaliseValue,
  opAllowed,
  SECTION_LABELS,
} from "./edit-catalogue";
import { sectionsOf, taskChips, v2CopyTurn, v2EditCardTurn } from "./companion-v2-compose";

/** One current row, server-side: what the model sees plus the identity the writer needs. */
interface SnapshotRow {
  readonly ref: string;
  readonly section: CompanionV2EditSection;
  readonly fields: Record<string, string | null>;
  readonly target: Record<string, string | number> | null;
}

export type ConfirmResult =
  | {
      readonly kind: "applied";
      readonly turn: CompanionTurn;
      readonly proposalId: string;
      readonly appliedCount: number;
      readonly sections: CompanionV2EditSection[];
      readonly resumeRegen: "queued" | "capped" | "failed";
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale"; readonly turn: CompanionTurn }
  | { readonly kind: "failed"; readonly turn: CompanionTurn };

export type CancelResult =
  | { readonly kind: "cancelled"; readonly turn: CompanionTurn; readonly proposalId: string }
  | { readonly kind: "not_found" };

/**
 * THE EDIT PATH (ADR-0046 O4/O5/O6): propose → the worker taps Haan → apply in ONE transaction.
 *
 * THE MODEL NEVER WRITES. `propose` sends the message plus this catalogue and a snapshot of the
 * worker's current values to `AiService.companionEditParse`, validates every returned row
 * deterministically (catalogue, op, ref, value, placeholder token, no-op) and stores a card.
 * `confirm` re-reads the proposal under the WORKER'S key, refuses a stale card, applies every
 * selected row through the section writers on ONE transaction, and only then regenerates the
 * résumé (trigger `chat_edit`, the daily cap applies).
 *
 * FAIL CLOSED, EVERYWHERE. No parse, no rows or a store failure means no card and no claim; a
 * writer failure rolls the whole transaction back and keeps the proposal so the worker may
 * retry; a stale card writes nothing and is deleted.
 *
 * PRIVACY. The message and every current value are masked by the AI service before the model;
 * the proposal lives in Redis for its TTL and never in a log; every event carries ids, counts
 * and closed enums only.
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
  ) {}

  // ── propose ───────────────────────────────────────────────────────────────────────────────

  /** One message to a card (or a fixed line). Never throws; never writes anything. */
  async propose(
    workerId: string,
    profile: WorkerProfile,
    text: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn> {
    const snapshot = await this.snapshot(workerId, profile);
    const parsed = await this.ai.companionEditParse(
      {
        text,
        catalogue: buildEditableFields(),
        snapshot: snapshot.map((row) => ({ ref: row.ref, section: row.section, fields: row.fields })),
        max_rows: this.config.CHAT_COMPANION_V2_EDIT_MAX_ROWS,
      },
      ctx,
    );

    const unsupported = parsed?.unsupported ?? [];
    if (parsed === null) return this.noCard(unsupported);

    const byRef = new Map(snapshot.map((row) => [row.ref, row]));
    const kept: StoredEditProposalRow[] = [];
    const effectiveUnsupported = new Set(unsupported);
    let dropped = 0;
    for (const row of parsed.rows) {
      const validated = this.validateRow(row, byRef);
      if (validated === null) {
        dropped += 1;
        // A row the model aimed at identity/contact is the same fact as an `unsupported` hint:
        // the worker asked for something this surface does not edit (O3). Inferred here so the
        // right line is served even when the model forgot the hint. Widened to `string` because
        // the model's output is UNTRUSTED — its type says the section is always one of six.
        const section: string = row.section;
        if (section === "identity" || section === "contact") {
          effectiveUnsupported.add(section as "identity" | "contact");
        }
        continue;
      }
      kept.push(validated);
    }

    if (kept.length === 0) {
      return this.noCard([...effectiveUnsupported], dropped);
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
      return v2CopyTurn(V2_EDIT_UNAVAILABLE);
    }

    await this.emit(workerId, ctx, "chat.companion_edit_proposed", {
      proposal_id: proposalId,
      row_count: kept.length,
      sections: sectionsOf(kept),
      dropped_count: dropped,
      unsupported: [...effectiveUnsupported],
    });

    return v2EditCardTurn(V2_EDIT_CARD_INTRO, this.toWireProposal(proposal));
  }

  /** No card: identity/contact steered to the Profile screen, else the clarify line. */
  private noCard(unsupported: readonly string[], _dropped = 0): CompanionTurn {
    const pair = unsupported.includes("identity") || unsupported.includes("contact")
      ? V2_EDIT_IDENTITY
      : V2_EDIT_NONE;
    return v2CopyTurn(pair, taskChips(this.config));
  }

  /**
   * One model row through every deterministic gate (spec §Edit step 3). Null = drop it.
   *
   * The gates, in order: the catalogue names the pair; the op is legal for it; edit/delete
   * address a row this snapshot actually minted; add carries no ref; add/edit carry a value that
   * passes the field's own validation; a placeholder token drops the row (O17); and a value
   * identical to the current one is a no-op and is dropped rather than shown as a change.
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
  ): StoredEditProposalRow | null {
    const entry = catalogueEntry(row.section, row.field ?? "");
    if (entry === undefined || !opAllowed(entry, row.op as never)) return null;

    let target: Record<string, string | number> | null = null;
    let before: string | null = null;
    if (row.op !== "add") {
      if (row.ref === null) return null;
      const source = byRef.get(row.ref);
      if (source === undefined || source.section !== entry.section) return null;
      target = source.target;
      before = source.fields[entry.field] ?? null;
    } else if (row.ref !== null) {
      return null;
    }

    let value: string | null = null;
    if (row.op !== "delete") {
      if (row.value === null) return null;
      value = normaliseValue(entry.section, entry.field, row.value);
      if (value === null) return null;
      if (hasPlaceholderToken(value)) return null;
      if (row.op === "edit" && value === before) return null;
    }

    return {
      row_id: randomUUID(),
      section: entry.section,
      op: row.op as StoredEditProposalRow["op"],
      field: entry.field,
      value,
      before,
      section_label: SECTION_LABELS[entry.section],
      target,
    };
  }

  private toWireProposal(proposal: StoredEditProposal): EditProposal {
    return {
      proposal_id: proposal.proposal_id,
      expires_at: proposal.expires_at,
      rows: proposal.rows.map(
        (row): EditProposalRow => ({
          row_id: row.row_id,
          section_label: row.section_label,
          op: row.op,
          before: row.before,
          after: row.value,
        }),
      ),
    };
  }

  // ── confirm ───────────────────────────────────────────────────────────────────────────────

  /** Haan: apply the ticked rows in one transaction, then regenerate. */
  async confirm(
    workerId: string,
    profile: WorkerProfile,
    proposalId: string,
    rowIds: readonly string[],
    ctx: RequestContext,
  ): Promise<ConfirmResult> {
    const proposal = await this.proposals.load(workerId);
    if (proposal === null || proposal.proposal_id !== proposalId) return { kind: "not_found" };
    const selected = proposal.rows.filter((row) => rowIds.includes(row.row_id));
    if (selected.length === 0) return { kind: "not_found" };

    if (await this.isStale(workerId, profile, selected)) {
      await this.proposals.delete(workerId);
      await this.emit(workerId, ctx, "chat.companion_edit_cancelled", {
        proposal_id: proposalId,
        reason: "stale",
      });
      return { kind: "stale", turn: v2CopyTurn(V2_EDIT_STALE) };
    }

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
          await this.applySection(section, rows, workerId, profile, ctx, executor);
        }
      });
    } catch (err) {
      // ROLLED BACK BY CONSTRUCTION. The proposal is KEPT so the worker can retry until its TTL.
      this.logger.error(
        `companion edit apply failed for worker ${workerId} proposal ${proposalId}; nothing written (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return { kind: "failed", turn: v2CopyTurn(FALLBACK) };
    }

    await this.proposals.delete(workerId);

    // Post-commit side effects, in order: matching (if occupations changed) then the résumé.
    if (selected.some((row) => row.section === "occupations")) {
      await this.workerSkills.rebuildQuietly(workerId, ctx);
    }
    const resumeRegen = await this.regenerate(workerId, profile, ctx);

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
  ): Promise<CancelResult> {
    const proposal = await this.proposals.load(workerId);
    if (proposal === null || proposal.proposal_id !== proposalId) return { kind: "not_found" };
    await this.proposals.delete(workerId);
    await this.emit(workerId, ctx, "chat.companion_edit_cancelled", {
      proposal_id: proposalId,
      reason: "worker",
    });
    return { kind: "cancelled", turn: v2CopyTurn(V2_EDIT_CANCELLED), proposalId };
  }

  /** A card whose captured values no longer match the profile cannot be applied. */
  private async isStale(
    workerId: string,
    profile: WorkerProfile,
    rows: readonly StoredEditProposalRow[],
  ): Promise<boolean> {
    const fresh = await this.snapshot(workerId, profile);
    for (const row of rows) {
      if (row.op === "add") continue;
      const match = fresh.find(
        (candidate) =>
          candidate.section === row.section &&
          JSON.stringify(candidate.target) === JSON.stringify(row.target),
      );
      if (match === undefined) return true;
      if ((match.fields[row.field ?? ""] ?? null) !== row.before) return true;
    }
    return false;
  }

  /** Queue the ADR-0043 regeneration with the `chat_edit` trigger; the daily cap applies. */
  private async regenerate(
    workerId: string,
    profile: WorkerProfile,
    ctx: RequestContext,
  ): Promise<"queued" | "capped" | "failed"> {
    try {
      await this.resumes.generate(
        { worker_id: workerId, profile_id: profile.id },
        ctx,
        { systemInitiated: true, trigger: "chat_edit" },
      );
      return "queued";
    } catch (err) {
      const capped = (err as { status?: number }).status === 429;
      this.logger.warn(
        `companion edit regeneration ${capped ? "capped" : "failed"} for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return capped ? "capped" : "failed";
    }
  }

  // ── apply (one section, inside the caller's transaction) ─────────────────────────────────

  private async applySection(
    section: CompanionV2EditSection,
    rows: readonly StoredEditProposalRow[],
    workerId: string,
    profile: WorkerProfile,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    switch (section) {
      case "employment":
        return this.applyEmployment(workerId, rows, ctx, tx);
      case "skills":
        return this.applySkills(profile, rows, tx);
      case "languages":
        return this.applyLanguages(workerId, rows, ctx, tx);
      case "qualifications":
        return this.applyQualifications(workerId, rows, ctx, tx);
      case "occupations":
        return this.applyOccupations(workerId, rows, ctx, tx);
      case "preferences":
        return this.applyPreferences(workerId, rows, ctx, tx);
    }
  }

  private async applyEmployment(
    workerId: string,
    rows: readonly StoredEditProposalRow[],
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    const current = await this.employment.getForWorker(workerId);
    let views = current.employments.map((view) => ({
      ...view,
      roles: view.roles.map((role) => ({ ...role })),
    }));
    for (const row of rows) {
      const id = row.target?.["employment_id"];
      if (typeof id !== "string") throw new Error("employment row without a target");
      const at = views.findIndex((view) => view.employment_id === id);
      if (at === -1) throw new Error("employment row vanished under the card");
      if (row.op === "delete") {
        views = views.filter((_, index) => index !== at);
        continue;
      }
      const view = views[at]!;
      const field = row.field ?? "";
      if (field === "employer_name") view.employer_name = row.value!;
      else if (field === "employer_city") view.employer_city = row.value;
      else if (field === "employer_state") view.employer_state = row.value;
      else if (field === "start_ym") view.start_ym = row.value;
      else if (field === "end_ym") view.end_ym = row.value;
      else if (field === "role_label") view.roles[0]!.role_label = row.value!;
      else if (field === "work_done") view.roles[0]!.work_done = row.value;
      else throw new Error(`unmapped employment field ${field}`);
    }

    const dto = SetMyEmploymentSchema.parse({
      employments: views.map(projectEmploymentForPut),
      expected_existing_count: current.employments.length + current.unreadable_count,
    });
    await this.employment.replaceForWorker(workerId, dto, ctx, { tx });
  }

  private async applySkills(
    profile: WorkerProfile,
    rows: readonly StoredEditProposalRow[],
    tx: Database,
  ): Promise<void> {
    const draft = DraftProfileSchema.parse(profile.rawProfile ?? {});
    const adds = rows.filter((row) => row.op === "add").map((row) => row.value!);
    const deletes = new Set(
      rows.filter((row) => row.op === "delete").map((row) => String(row.target?.["skill_label"] ?? "")),
    );

    const container = draft.resume_profile;
    if (resumeProfileCarriesValues(container) && container !== null) {
      const kept = container.skills.filter((label) => !deletes.has(label));
      await this.profiles.setResumeSkillLabels(
        profile.id,
        { resumeProfileSkills: [...kept, ...adds] },
        tx,
      );
      return;
    }

    const keptLabels = draft.skill_labels.filter((label) => !deletes.has(label));
    const keptIds = draft.skills.filter((id) => !deletes.has(labelForTaxonomyId(id)));
    await this.profiles.setResumeSkillLabels(
      profile.id,
      { skills: keptIds, skillLabels: [...keptLabels, ...adds] },
      tx,
    );
  }

  private async applyLanguages(
    workerId: string,
    rows: readonly StoredEditProposalRow[],
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    const current = await this.languages.getForWorker(workerId);
    let entries = current.languages.map((entry) => ({ ...entry }));
    for (const row of rows) {
      if (row.op === "delete") {
        const language = String(row.target?.["language"] ?? "");
        entries = entries.filter((entry) => entry.language !== language);
      } else if (row.op === "add") {
        if (entries.some((entry) => entry.language === row.value)) continue;
        // A newly added language needs at least one ability (the writer's own rule): speaking is
        // the only honest default — the worker said they know it, not that they read or write it.
        entries.push({ language: row.value!, can_speak: true, can_read: false, can_write: false });
      }
    }
    const dto = SetMyLanguagesSchema.parse({
      languages: entries.map((entry) => ({
        language: entry.language,
        can_speak: entry.can_speak,
        can_read: entry.can_read,
        can_write: entry.can_write,
      })),
    });
    await this.languages.replaceForWorker(workerId, dto, ctx, { tx });
  }

  private async applyQualifications(
    workerId: string,
    rows: readonly StoredEditProposalRow[],
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    const current = await this.qualifications.getForWorker(workerId);
    const lists = {
      certificates: current.certificates.map((entry) => ({ ...entry })),
      educations: current.educations.map((entry) => ({ ...entry })),
      trainings: current.trainings.map((entry) => ({ ...entry })),
    } as Record<string, Record<string, unknown>[]>;

    // Deletes first (descending index) so later indexes stay valid; then edits.
    for (const row of rows.filter((r) => r.op === "delete").sort((a, b) => indexOf(b) - indexOf(a))) {
      lists[String(row.target?.["list"] ?? "")]!.splice(indexOf(row), 1);
    }
    for (const row of rows.filter((r) => r.op === "edit")) {
      const list = lists[String(row.target?.["list"] ?? "")];
      const entry = list?.[indexOf(row)];
      if (entry === undefined) throw new Error("qualification row vanished under the card");
      entry[qualificationKey(row.field ?? "")] = numericQualificationField(row.field ?? "")
        ? Number(row.value)
        : row.value;
    }

    const dto = SetMyQualificationsSchema.parse({
      certificates: lists.certificates,
      educations: lists.educations,
      trainings: lists.trainings,
    });
    await this.qualifications.replaceForWorker(workerId, dto, ctx, { tx });
  }

  private async applyOccupations(
    workerId: string,
    rows: readonly StoredEditProposalRow[],
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    const current = await this.occupations.getForWorker(workerId);
    let ids = current.occupations.map((entry) => entry.role_id as string);
    for (const row of rows) {
      if (row.op === "delete") {
        ids = ids.filter((id) => id !== String(row.target?.["role_id"] ?? ""));
      } else if (row.op === "add" && !ids.includes(row.value!)) {
        ids.push(row.value!);
      }
    }
    const dto = SetMyOccupationsSchema.parse({
      occupations: ids.map((role_id) => ({ role_id })),
    });
    await this.occupations.replaceForWorker(workerId, dto, ctx, { tx });
  }

  private async applyPreferences(
    workerId: string,
    rows: readonly StoredEditProposalRow[],
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    const current = await this.preferences.getForWorker(workerId);
    const values = current.values;
    const touched: Record<string, unknown> = {};
    const availability = { ...(values.availability ?? {}) };

    for (const row of rows) {
      const field = row.field ?? "";
      if (field === "expected_salary") {
        touched.salary_expected_max = Number(row.value);
        touched.salary_expected_min = null;
      } else if (field === "willing_to_travel" || field === "willing_to_relocate" || field === "accommodation_needed") {
        touched[field] = row.value === "true";
      } else if (field === "availability_status") {
        availability.status = row.value as never;
        touched.availability = availability;
      } else if (field === "availability_available_from") {
        availability.available_from = row.value;
        touched.availability = availability;
      } else if (field === "availability_notice_period_days") {
        availability.notice_period_days = Number(row.value);
        touched.availability = availability;
      } else if (field === "preferred_cities" || field === "work_types" || field === "documents_ready") {
        touched[field] = applyToList(values[field] ?? [], row);
      } else {
        touched[field] = row.value;
      }
    }

    const dto = SetMyPreferencesSchema.parse(touched);
    await this.preferences.setForWorker(workerId, dto, ctx, { tx });
  }

  // ── snapshot ──────────────────────────────────────────────────────────────────────────────

  /** The worker's current values, refs minted per row. Each section fails soft on its own. */
  private async snapshot(workerId: string, profile: WorkerProfile): Promise<SnapshotRow[]> {
    const rows: SnapshotRow[] = [];
    await this.settle("employment snapshot", workerId, async () => {
      const current = await this.employment.getForWorker(workerId);
      current.employments.forEach((view, index) => {
        const role = view.roles[0];
        rows.push({
          ref: `e${index + 1}`,
          section: "employment",
          fields: {
            employer_name: view.employer_name,
            employer_city: view.employer_city,
            employer_state: view.employer_state,
            start_ym: view.start_ym,
            end_ym: view.end_ym,
            role_label: role?.role_label ?? null,
            work_done: role?.work_done ?? null,
          },
          target: { employment_id: view.employment_id },
        });
      });
    });
    await this.settle("skills snapshot", workerId, async () => {
      const draft = DraftProfileSchema.safeParse(profile.rawProfile ?? {});
      if (!draft.success) return;
      const container = draft.data.resume_profile;
      const labels = resumeProfileCarriesValues(container) && container !== null
        ? container.skills
        : [...draft.data.skills.map(labelForTaxonomyId), ...draft.data.skill_labels.map(labelForTaxonomyId)];
      let index = 0;
      for (const label of new Set(labels)) {
        index += 1;
        rows.push({
          ref: `s${index}`,
          section: "skills",
          fields: { skill: label },
          target: { skill_label: label },
        });
      }
    });
    await this.settle("languages snapshot", workerId, async () => {
      const current = await this.languages.getForWorker(workerId);
      current.languages.forEach((entry, index) => {
        rows.push({
          ref: `l${index + 1}`,
          section: "languages",
          fields: { language: entry.language },
          target: { language: entry.language },
        });
      });
    });
    await this.settle("qualifications snapshot", workerId, async () => {
      const current = await this.qualifications.getForWorker(workerId);
      pushQualificationRows(rows, "certificates", "c", current.certificates);
      pushQualificationRows(rows, "educations", "q", current.educations);
      pushQualificationRows(rows, "trainings", "t", current.trainings);
    });
    await this.settle("occupations snapshot", workerId, async () => {
      const current = await this.occupations.getForWorker(workerId);
      current.occupations.forEach((entry, index) => {
        rows.push({
          ref: `o${index + 1}`,
          section: "occupations",
          fields: { role_id: entry.role_id },
          target: { role_id: entry.role_id },
        });
      });
    });
    await this.settle("preferences snapshot", workerId, async () => {
      const current = await this.preferences.getForWorker(workerId);
      const values = current.values;
      rows.push({
        ref: "pref",
        section: "preferences",
        fields: {
          shift: values.shift,
          job_type: values.job_type,
          willing_to_travel: boolText(values.willing_to_travel),
          willing_to_relocate: boolText(values.willing_to_relocate),
          accommodation_needed: boolText(values.accommodation_needed),
          expected_salary: values.salary_expected_max === null ? null : String(values.salary_expected_max),
          availability_status: values.availability?.status ?? null,
          availability_available_from: values.availability?.available_from ?? null,
          availability_notice_period_days:
            values.availability?.notice_period_days == null
              ? null
              : String(values.availability.notice_period_days),
        },
        target: null,
      });
      for (const [field, prefix] of [
        ["preferred_cities", "pc"],
        ["work_types", "wt"],
        ["documents_ready", "dr"],
      ] as const) {
        (values[field] ?? []).forEach((member, index) => {
          rows.push({
            ref: `${prefix}${index + 1}`,
            section: "preferences",
            fields: { [field]: member },
            target: { member },
          });
        });
      }
    });
    return rows;
  }

  /** Run one snapshot read; a throw drops that section and is logged with ids only. */
  private async settle(what: string, workerId: string, read: () => Promise<void>): Promise<void> {
    try {
      await read();
    } catch (err) {
      this.logger.warn(
        `companion ${what} unreadable for worker ${workerId}; section omitted (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
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

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

function boolText(value: boolean | null | undefined): string | null {
  return value === null || value === undefined ? null : value ? "true" : "false";
}

function indexOf(row: StoredEditProposalRow): number {
  return Number(row.target?.["index"] ?? -1);
}

function qualificationKey(field: string): string {
  return field.replace(/^(certificate|education|training)_/, "");
}

function numericQualificationField(field: string): boolean {
  return field.endsWith("_year");
}

function applyToList(list: readonly string[], row: StoredEditProposalRow): string[] {
  if (row.op === "delete") {
    const member = String(row.target?.["member"] ?? "");
    return list.filter((value) => value !== member);
  }
  return list.includes(row.value!) ? [...list] : [...list, row.value!];
}

function pushQualificationRows(
  rows: SnapshotRow[],
  list: "certificates" | "educations" | "trainings",
  prefix: string,
  entries: readonly Record<string, unknown>[],
): void {
  entries.forEach((entry, index) => {
    const fields: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === "licence_number" || key === "licence_expiry") continue; // never carded (O3-adjacent)
      fields[`${list === "certificates" ? "certificate" : list === "educations" ? "education" : "training"}_${key}`] =
        value === null || value === undefined ? null : String(value);
    }
    rows.push({
      ref: `${prefix}${index + 1}`,
      section: "qualifications",
      fields,
      target: { list, index },
    });
  });
}
