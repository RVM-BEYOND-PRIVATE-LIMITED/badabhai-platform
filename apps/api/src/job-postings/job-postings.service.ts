import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { bandForCount } from "@badabhai/validators";
import type { JobPosting } from "@badabhai/db";
import type { JobPostingVerificationStatus } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { AiService } from "../ai/ai.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { PublishReachService } from "../match/publish-reach.service";
import {
  JobPostingsRepository,
  type JobPostingApi,
  type JobPostingUpdate,
} from "./job-postings.repository";
import type {
  CreateJobPostingDto,
  ListJobPostingsQueryDto,
  PayerCreateJobPostingDto,
  UpdateJobPostingDto,
} from "./job-postings.dto";

/** The acting identity on a job_posting.* event — ops (the creator) or a payer (the owner). */
type JobPostingActor = { actor_type: "ops" | "payer"; actor_id: string };

type JobPostingEventName =
  | "job_posting.created"
  | "job_posting.updated"
  | "job_posting.closed"
  | "job_posting.paused"
  | "job_posting.resumed"
  | "job_posting.verification_updated";

/** The validated PATCH the service derived from an edit DTO (column patch + changed KEYS). */
interface PreparedUpdate {
  patch: JobPostingUpdate;
  changedFields: PayloadInputOf<"job_posting.updated">["changed_fields"];
  bandChanged: boolean;
}

/**
 * Ops-created, vacancy-banded, stored-only job postings (ADR-0012), plus the payer
 * self-serve surface (ADR-0019 / ADR-0022 module 9). Each write emits a
 * registry-validated `job_posting.*` event whose payload carries ONLY ids, enums,
 * booleans, and changed-field KEYS — never the free-text values (org_label /
 * role_title / location_label / description). The free text lives only on the
 * job_postings row; the events record the FACT, not the value.
 *
 * TWO SURFACES OVER ONE CHOKEPOINT (one principal per route):
 *   - OPS path (`create`/`list`/`getOne`/`update`/`close`) — no ops auth in alpha;
 *     `created_by` arrives on the DTO as an opaque ops-actor uuid, `payer_id` stays
 *     NULL, and the events carry the OPS actor. Behaviour is unchanged.
 *   - PAYER path (`*ForPayer`) — behind PayerAuthGuard; the SESSION `payer_id` is
 *     stamped on the row and used as BOTH the `created_by` and the event ACTOR
 *     (actor_type:"payer"). Every read/write is owner-scoped (payer_id in the WHERE,
 *     no-oracle 404 for an unknown OR foreign id — XB-A horizontal authz). `payer_id`
 *     is consumed only as the ownership key + the opaque actor_id; it never enters a
 *     payload (the event stays PII-free, no schema change).
 *
 * Lifecycle (ADR open-item b), enforced for both surfaces:
 *   draft -> open    (via PATCH status="open")
 *   draft -> closed  (via close endpoint)
 *   open  -> closed  (via close endpoint)
 * `closed` is terminal — no reopen, no edits. Field edits are allowed only while
 * the posting is `draft` or `open`. Everything else is rejected.
 */
@Injectable()
export class JobPostingsService {
  private readonly logger = new Logger(JobPostingsService.name);

  constructor(
    private readonly repo: JobPostingsRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
    private readonly aiCost: AiCostRecorder,
    // ADR-0036 moment ③ — resolves the reach set server-side and materializes it.
    // MatchModule is @Global, so no new import edge on JobPostingsModule.
    private readonly publishReach: PublishReachService,
  ) {}

  /**
   * ADR-0030 / TAX-6: canonicalize the posting's skill PHRASES into closed-set
   * skill_ids through the SAME `canonicalize_skill` pipeline the worker side uses —
   * one shared id space (the ADR-0028 promise on the skills dimension).
   *
   * BEST-EFFORT by design: an unreachable AI service / a disabled flag yields []
   * (the raw phrases are still stored) — canonicalization NEVER blocks or fails a
   * posting. SG-3: only ids the vector layer returned are stored; the anchor domain
   * mirrors the worker-side default until per-label domain resolution lands.
   * NOT a RANK input (invariant #4) — the reach-engine guard test locks that.
   */
  private async canonicalizeSkills(
    phrases: string[] | undefined,
    ctx: RequestContext,
  ): Promise<string[]> {
    if (!phrases?.length) return [];
    // PARALLEL by design (#226 review M1): sequential awaits made the worst case
    // N x timeout (10 x 8s = 80s of a held-open posting write against a blackholed
    // ai-service). allSettled bounds the whole pass at ONE client timeout (~8s) and a
    // single slow phrase can't serialize the rest. Order is preserved via the results
    // array; failures resolve null (canonicalizeSkill never rejects, belt+braces here).
    const results = await Promise.allSettled(
      phrases.map((phrase) =>
        // BL-19: the WRITE's ctx, shared by every phrase, so the whole fan-out reads as one
        // trace on the far side instead of N unrelated ones.
        this.ai.canonicalizeSkill({ phrase, domain_id: "cnc-machining", lang: "en" }, ctx),
      ),
    );
    const ids: string[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue; // never let canonicalization break a write
      const res = r.value;

      // ONE COST RECORD PER PHRASE (#745). This is a FAN-OUT: a 10-skill posting is 10
      // separate embeds and therefore 10 separate billable calls, which is precisely why
      // per-call recording matters here and why the event is keyed on `ai_call_id` rather
      // than on the write that triggered it. Recording once per posting would collapse ten
      // calls into one row and under-report the surface by an order of magnitude.
      //
      // EMITTED FOR EVERY FULFILLED RESULT, not just `matched` ones. A below-floor miss and
      // a no-candidate miss cost exactly the same embed as a hit; ledgering only the hits
      // would under-count exactly the phrases the vocabulary is worst at — the ones that
      // motivate growing it. `record` no-ops on null metadata, which covers the flag being
      // off, a spend-ledger block, a pseudonymize block, and an unreachable ai-service.
      //
      // `aiJobId` is null: canonicalization runs inline inside a posting write, and minting
      // an `ai_jobs` row per skill phrase to satisfy a signature would be worse than a null.
      await this.aiCost.record(
        res?.ai_metadata ?? null,
        "skill_embedding",
        null,
        ctx.correlationId,
        ctx.requestId,
      );

      if (res?.status === "matched" && res.skill_id && !ids.includes(res.skill_id)) {
        ids.push(res.skill_id);
      }
    }
    return ids;
  }

  // ----- OPS surface (ADR-0012, unchanged) ----------------------------------

  async create(dto: CreateJobPostingDto, ctx: RequestContext): Promise<JobPostingApi> {
    return this.insertAndEmit(
      {
        createdBy: dto.created_by,
        payerId: null,
        orgLabel: dto.org_label,
        roleTitle: dto.role_title,
        locationLabel: dto.location_label ?? null,
        description: dto.description ?? null,
        vacancyBand: resolveCreateBand(dto),
        skillPhrases: dto.skills ?? [],
        skillIds: await this.canonicalizeSkills(dto.skills, ctx),
      },
      { actor_type: "ops", actor_id: dto.created_by },
      ctx,
    );
  }

  list(query: ListJobPostingsQueryDto): Promise<JobPostingApi[]> {
    return this.repo.list(query.status);
  }

  async getOne(id: string): Promise<JobPostingApi> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`Job posting ${id} not found`);
    return row;
  }

  async update(id: string, dto: UpdateJobPostingDto, ctx: RequestContext): Promise<JobPostingApi> {
    const current = await this.getOne(id);
    const prepared = this.prepareUpdate(current, dto);
    if (prepared.changedFields.includes("skills")) {
      prepared.patch.skillIds = await this.canonicalizeSkills(dto.skills, ctx);
    }

    const updated = await this.repo.update(id, prepared.patch);
    if (!updated) throw new NotFoundException(`Job posting ${id} not found`);

    await this.emitUpdated(
      updated,
      { actor_type: "ops", actor_id: updated.created_by },
      prepared,
      ctx,
    );
    await this.materializeIfNeeded(
      current,
      updated,
      dto,
      { actor_type: "ops", actor_id: updated.created_by },
      ctx,
    );
    return updated;
  }

  async close(id: string, ctx: RequestContext): Promise<JobPostingApi> {
    const current = await this.getOne(id);
    const previousStatus = assertCloseable(current);

    const closed = await this.repo.close(id, previousStatus, new Date());
    if (!closed) throw new ConflictException("Job posting is already closed");

    await this.emitClosed(
      closed,
      { actor_type: "ops", actor_id: closed.created_by },
      previousStatus,
      ctx,
    );
    return closed;
  }

  /** Ops: mark a posting VERIFIED — lights the worker-visible "Verified job" badge. */
  verify(id: string, ctx: RequestContext): Promise<JobPostingApi> {
    return this.setVerification(id, "verified", ctx);
  }

  /** Ops: mark a posting REJECTED (reviewed and declined). */
  reject(id: string, ctx: RequestContext): Promise<JobPostingApi> {
    return this.setVerification(id, "rejected", ctx);
  }

  /**
   * Ops trust review — set the posting's [verificationStatus] and emit the PII-free
   * `job_posting.verification_updated` (id + enums only). The lifecycle `status` is
   * untouched. IDEMPOTENT: setting the value it already has is a no-op (no write, no
   * event) — a re-delivered verify never emits a duplicate. The ops actor id mirrors
   * the other ops writes (`created_by`, the opaque ops-actor on the row).
   */
  private async setVerification(
    id: string,
    next: JobPostingVerificationStatus,
    ctx: RequestContext,
  ): Promise<JobPostingApi> {
    const current = await this.getOne(id); // 404 if missing
    const previous = current.verification_status;
    if (previous === next) return current; // idempotent — nothing changed

    const updated = await this.repo.update(id, {
      verificationStatus: next,
      updatedAt: new Date(),
    });
    if (!updated) throw new NotFoundException(`Job posting ${id} not found`);

    const actor: JobPostingActor = { actor_type: "ops", actor_id: updated.created_by };
    const payload: PayloadInputOf<"job_posting.verification_updated"> = {
      job_posting_id: updated.id,
      verification_status: next,
      previous_status: previous,
    };
    await this.events.emit(
      this.emitParams("job_posting.verification_updated", updated.id, actor, payload, ctx),
    );
    return updated;
  }

  // ----- PAYER self-serve surface (ADR-0019 / ADR-0022 module 9) -------------
  // Identity is the SESSION payer (XB-A); the body never carries payer_id/created_by.

  async createForPayer(
    payerId: string,
    dto: PayerCreateJobPostingDto,
    ctx: RequestContext,
  ): Promise<JobPostingApi> {
    return this.insertAndEmit(
      {
        // The payer is BOTH the owner and the (only) creator identity we have.
        createdBy: payerId,
        payerId,
        orgLabel: dto.org_label,
        roleTitle: dto.role_title,
        locationLabel: dto.location_label ?? null,
        description: dto.description ?? null,
        vacancyBand: resolveCreateBand(dto),
        skillPhrases: dto.skills ?? [],
        skillIds: await this.canonicalizeSkills(dto.skills, ctx),
      },
      { actor_type: "payer", actor_id: payerId },
      ctx,
    );
  }

  listForPayer(payerId: string, query: ListJobPostingsQueryDto): Promise<JobPostingApi[]> {
    return this.repo.listByPayer(payerId, query.status);
  }

  /** One of the caller's OWN postings; no-oracle 404 for an unknown OR foreign id. */
  async getOneForPayer(id: string, payerId: string): Promise<JobPostingApi> {
    const row = await this.repo.findByIdAndPayer(id, payerId);
    if (!row) throw new NotFoundException("Job posting not found");
    return row;
  }

  async updateForPayer(
    id: string,
    payerId: string,
    dto: UpdateJobPostingDto,
    ctx: RequestContext,
  ): Promise<JobPostingApi> {
    const current = await this.getOneForPayer(id, payerId); // no-oracle 404
    const prepared = this.prepareUpdate(current, dto);
    if (prepared.changedFields.includes("skills")) {
      prepared.patch.skillIds = await this.canonicalizeSkills(dto.skills, ctx);
    }

    const updated = await this.repo.updateOwned(id, payerId, prepared.patch);
    if (!updated) throw new NotFoundException("Job posting not found");

    await this.emitUpdated(updated, { actor_type: "payer", actor_id: payerId }, prepared, ctx);
    await this.materializeIfNeeded(
      current,
      updated,
      dto,
      { actor_type: "payer", actor_id: payerId },
      ctx,
    );
    return updated;
  }

  async closeForPayer(id: string, payerId: string, ctx: RequestContext): Promise<JobPostingApi> {
    const current = await this.getOneForPayer(id, payerId); // no-oracle 404
    const previousStatus = assertCloseable(current);

    const closed = await this.repo.closeOwned(id, payerId, previousStatus, new Date());
    if (!closed) throw new ConflictException("Job posting is already closed");

    await this.emitClosed(closed, { actor_type: "payer", actor_id: payerId }, previousStatus, ctx);
    return closed;
  }

  /**
   * Pause one of the caller's OWN LIVE postings (open -> paused; B1). The DB transition is
   * guarded on id + payer_id + status='open', so a non-open / gone / not-owned row is a no-op
   * → 409 (without leaking which). A paused posting is excluded from any open-filtered feed
   * until resumed. Emits the PII-free `job_posting.paused`.
   */
  async pauseForPayer(id: string, payerId: string, ctx: RequestContext): Promise<JobPostingApi> {
    await this.getOneForPayer(id, payerId); // no-oracle 404 (unknown OR foreign id)
    const paused = await this.repo.transitionOwned(id, payerId, "open", "paused");
    if (!paused) throw new ConflictException("Only an open job posting can be paused");

    const actor: JobPostingActor = { actor_type: "payer", actor_id: payerId };
    const payload: PayloadInputOf<"job_posting.paused"> = {
      job_posting_id: paused.id,
      previous_status: "open",
      status: "paused",
    };
    await this.events.emit(this.emitParams("job_posting.paused", paused.id, actor, payload, ctx));
    return paused;
  }

  /**
   * Resume one of the caller's OWN paused postings (paused -> open; B1). Guarded on id +
   * payer_id + status='paused' (non-paused / gone / not-owned → 409). Emits the PII-free
   * `job_posting.resumed`.
   */
  async resumeForPayer(id: string, payerId: string, ctx: RequestContext): Promise<JobPostingApi> {
    await this.getOneForPayer(id, payerId); // no-oracle 404
    const resumed = await this.repo.transitionOwned(id, payerId, "paused", "open");
    if (!resumed) throw new ConflictException("Only a paused job posting can be resumed");

    const actor: JobPostingActor = { actor_type: "payer", actor_id: payerId };
    const payload: PayloadInputOf<"job_posting.resumed"> = {
      job_posting_id: resumed.id,
      previous_status: "paused",
      status: "open",
    };
    await this.events.emit(this.emitParams("job_posting.resumed", resumed.id, actor, payload, ctx));

    // ADR-0036 MOMENT ③ ON UNPAUSE. A pause does NOT clear `job_reach` (a pause is
    // reversible and re-materializing a big reach set on every pause/resume cycle would
    // churn the widest table in the system), so the rows are still there — but the
    // SUPPLY has moved while the posting slept: workers profiled during the pause have
    // no row, and workers who turned a skill off still do. Re-materializing on resume is
    // what makes "a paused job stops feeding the worker app" (Policy 18) reversible
    // WITHOUT the posting coming back stale.
    //
    // `published_at` is NOT restamped (the trigger is "unpause", and
    // `PublishReachService` only stamps on first open) — a posting must not be able to
    // pause/resume its way back to the top of a newest-first feed.
    await this.materializeReach(resumed, "unpause", actor, ctx);
    return resumed;
  }

  // ----- shared internals (one chokepoint for both surfaces) -----------------

  /**
   * ADR-0036 MOMENT ③ — decide whether this edit needs the reach set rebuilt, and do it.
   *
   * Two triggers, both required:
   *  - PUBLISH (draft → open). The whole reach set is written for the first time.
   *  - EDIT that changed `match_skill_ids` or the unticks on an ALREADY-OPEN posting.
   *    Skipping this would leave the posting serving the workers its OLD skills reached
   *    while displaying the new ones — the reach set would quietly lie.
   *
   * A posting with no `match_skill_ids` reaches nobody and is NOT materialized here: the
   * D3 backfill leaves those empty on purpose and prints them to an ops worklist, and
   * inventing skills for them would be exactly the guessing that runner refuses to do.
   */
  private async materializeIfNeeded(
    before: JobPostingApi,
    after: JobPostingApi,
    dto: UpdateJobPostingDto,
    actor: JobPostingActor,
    ctx: RequestContext,
  ): Promise<void> {
    const publishing = before.status === "draft" && after.status === "open";
    const skillsChanged = dto.match_skill_ids !== undefined;
    if (!publishing && !skillsChanged) return;
    if (!publishing && after.status !== "open") return;

    // The skills to resolve from: the edit's, else what the posting already carries.
    const matchSkillIds = dto.match_skill_ids ?? after.match_skill_ids;
    if (matchSkillIds.length === 0) {
      // Reaches nobody. Not a crash and not a guess — the E13 alert is the right
      // channel for it, and `materialize` emits it once the (empty) set is written.
      // Only do that on a PUBLISH; an unrelated edit should not raise a fresh alert.
      if (!publishing) return;
    }

    await this.materializeReach(
      after,
      publishing ? "publish" : "edit",
      actor,
      ctx,
      matchSkillIds,
      dto.unticked_related_ids,
    );
  }

  /**
   * Resolve + materialize, never failing the write that triggered it.
   *
   * The posting IS published — the status transition and its `job_posting.updated` /
   * `job_posting.resumed` event have already committed. If the reach materialization
   * then fails, the honest outcome is a live posting with a stale/empty reach set plus a
   * loud log, NOT a 500 that tells the payer their publish failed when it did not.
   * `job_reach` is a rebuildable cache (`db:materialize:reach` is the repair tool and is
   * safe to re-run), and `db:verify:match-v1` fails the deploy gate on an unmaterialized
   * open posting — so the gap is detected, not silent.
   */
  private async materializeReach(
    posting: JobPostingApi,
    trigger: "publish" | "unpause" | "edit",
    actor: JobPostingActor,
    ctx: RequestContext,
    matchSkillIds?: readonly string[],
    untickedIds?: readonly string[],
  ): Promise<void> {
    const skills = matchSkillIds ?? posting.match_skill_ids;
    if (skills.length === 0 && trigger !== "publish") return;
    try {
      await this.publishReach.materialize(
        posting.id,
        {
          matchSkillIds: skills,
          untickedIds: untickedIds ?? [],
          trigger,
          actor,
        },
        ctx,
      );
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      const msg = err instanceof Error ? err.message : "unknown";
      this.logger.error(
        `reach materialization FAILED for posting=${posting.id} trigger=${trigger} ` +
          `(${cls}: ${msg}); the posting IS live — re-run db:materialize:reach ` +
          `--job-posting-id=${posting.id}`,
      );
    }
  }

  /**
   * POLICY 27 — the audited ops widen. Appends to `reach_skill_ids`, re-materializes,
   * and emits `job_posting.reach_widened`. Never narrows (the DTO cannot express it).
   */
  opsWidenReach(
    id: string,
    addSkillIds: readonly string[],
    opsActorId: string,
    ctx: RequestContext,
  ) {
    return this.publishReach.opsWiden(id, addSkillIds, opsActorId, ctx);
  }

  /** Insert a posting (always status=draft) and emit the created event for the actor. */
  private async insertAndEmit(
    input: {
      createdBy: string;
      payerId: string | null;
      orgLabel: string;
      roleTitle: string;
      locationLabel: string | null;
      description: string | null;
      vacancyBand: JobPosting["vacancyBand"];
      // ADR-0030 / TAX-6: poster phrases + their vector-assigned closed-set ids.
      skillPhrases: string[];
      skillIds: string[];
    },
    actor: JobPostingActor,
    ctx: RequestContext,
  ): Promise<JobPostingApi> {
    // status is ALWAYS draft on create — any client-supplied status is ignored.
    const row = await this.repo.create({ ...input, status: "draft" });

    const payload: PayloadInputOf<"job_posting.created"> = {
      job_posting_id: row.id,
      vacancy_band: row.vacancy_band,
      status: "draft",
      created_by: row.created_by,
      has_location: row.location_label != null,
      has_description: row.description != null,
    };
    await this.events.emit(this.emitParams("job_posting.created", row.id, actor, payload, ctx));
    return row;
  }

  /**
   * Validate an edit against the current row and build the column patch + the
   * changed-field KEY list in lockstep (KEYS only, never the values — no free text
   * leaves this method). Throws the lifecycle/no-op errors. Shared by both surfaces.
   */
  private prepareUpdate(current: JobPostingApi, dto: UpdateJobPostingDto): PreparedUpdate {
    // closed is terminal: no edits, no status changes.
    if (current.status === "closed") {
      throw new ConflictException("Job posting is closed and cannot be edited");
    }
    // The only status transition allowed via PATCH is publish (draft -> open).
    if (dto.status === "open" && current.status !== "draft") {
      throw new ConflictException(`Cannot transition job posting from ${current.status} to open`);
    }

    const patch: JobPostingUpdate = { updatedAt: new Date() };
    const changedFields: PreparedUpdate["changedFields"] = [];

    if (dto.org_label !== undefined && dto.org_label !== current.org_label) {
      patch.orgLabel = dto.org_label;
      changedFields.push("org_label");
    }
    if (dto.role_title !== undefined && dto.role_title !== current.role_title) {
      patch.roleTitle = dto.role_title;
      changedFields.push("role_title");
    }
    if (dto.location_label !== undefined && dto.location_label !== current.location_label) {
      patch.locationLabel = dto.location_label;
      changedFields.push("location_label");
    }
    if (dto.description !== undefined && dto.description !== current.description) {
      patch.description = dto.description;
      changedFields.push("description");
    }

    // Resolve the requested band from EITHER the raw `vacancies` count (intake only —
    // derived then discarded, never stored/evented) OR the pre-chosen band.
    const requestedBand =
      dto.vacancies !== undefined ? bandForCount(dto.vacancies) : dto.vacancy_band;

    let bandChanged = false;
    if (requestedBand !== undefined && requestedBand !== current.vacancy_band) {
      patch.vacancyBand = requestedBand;
      changedFields.push("vacancy_band");
      bandChanged = true;
    }

    // ADR-0030 / TAX-6: replace-all semantics when `skills` is provided. Only the
    // PHRASES are patched here (sync); the caller re-canonicalizes the ids (async)
    // when this field changed. Order-sensitive compare is fine — the input order is
    // the poster's order and a reorder IS a change.
    //
    // BACKFILL EXCEPTION (#226 review M3): identical phrases RESENT while the stored
    // ids are empty also count as a change — a posting created during an ai-service
    // outage stores phrases with ids [] and would otherwise 400 ("no effective
    // changes") forever; re-PATCHing the same skills is the operator's retry.
    if (
      dto.skills !== undefined &&
      (JSON.stringify(dto.skills) !== JSON.stringify(current.skill_phrases) ||
        (dto.skills.length > 0 && current.skill_ids.length === 0))
    ) {
      patch.skillPhrases = dto.skills;
      changedFields.push("skills");
    }

    // ── Matching V1 (ADR-0036) display fields ────────────────────────────────
    // `match_skill_ids` / `unticked_related_ids` are DELIBERATELY not patched here:
    // they go through `PublishReachService`, which resolves the reach set server-side.
    // Their presence is only RECORDED on the changed-field list.
    if (dto.city !== undefined && dto.city !== current.city) {
      patch.city = dto.city;
      changedFields.push("city");
    }
    if (
      (dto.pay_min !== undefined && dto.pay_min !== current.pay_min) ||
      (dto.pay_max !== undefined && dto.pay_max !== current.pay_max)
    ) {
      if (dto.pay_min !== undefined) patch.payMin = dto.pay_min;
      if (dto.pay_max !== undefined) patch.payMax = dto.pay_max;
      changedFields.push("pay_band");
    }
    if (dto.shift !== undefined && dto.shift !== current.shift) {
      patch.shift = dto.shift;
      changedFields.push("shift");
    }
    if (dto.needed_by !== undefined && dto.needed_by !== current.needed_by) {
      patch.neededBy = dto.needed_by;
      changedFields.push("needed_by");
    }
    if (
      dto.match_skill_ids !== undefined &&
      JSON.stringify([...dto.match_skill_ids].sort()) !==
        JSON.stringify([...current.match_skill_ids].sort())
    ) {
      changedFields.push("match_skills");
    }

    if (dto.status === "open" && current.status !== "open") {
      patch.status = "open";
      changedFields.push("status");
    }

    if (changedFields.length === 0) {
      // Nothing actually changed (idempotent no-op edit). Don't write or emit.
      throw new BadRequestException("no effective changes to apply");
    }

    return { patch, changedFields, bandChanged };
  }

  private emitUpdated(
    updated: JobPostingApi,
    actor: JobPostingActor,
    prepared: PreparedUpdate,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"job_posting.updated"> = {
      job_posting_id: updated.id,
      changed_fields: prepared.changedFields,
      status: updated.status,
      // Only carry the band when it actually changed; otherwise null.
      vacancy_band: prepared.bandChanged ? updated.vacancy_band : null,
    };
    return this.events.emit(
      this.emitParams("job_posting.updated", updated.id, actor, payload, ctx),
    );
  }

  private emitClosed(
    closed: JobPostingApi,
    actor: JobPostingActor,
    previousStatus: "draft" | "open",
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"job_posting.closed"> = {
      job_posting_id: closed.id,
      previous_status: previousStatus,
      status: "closed",
    };
    return this.events.emit(this.emitParams("job_posting.closed", closed.id, actor, payload, ctx));
  }

  /**
   * Common emit params: the acting identity (ops creator OR session payer), the
   * job_posting subject, and tracing ids. `payer_id` is NEVER a payload field — when
   * a payer acts, it rides `actor.actor_id` (opaque), keeping the event PII-free.
   */
  private emitParams<N extends JobPostingEventName>(
    event_name: N,
    jobPostingId: string,
    actor: JobPostingActor,
    payload: PayloadInputOf<N>,
    ctx: RequestContext,
  ): EmitParams<N> {
    return {
      event_name,
      actor,
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    } as EmitParams<N>;
  }
}

/**
 * The create band: derive from the raw `vacancies` count when supplied (intake only —
 * the integer is discarded here and NEVER stored/evented), otherwise use the
 * pre-chosen band. Both DTOs' refines guarantee exactly one is present.
 */
function resolveCreateBand(
  dto: CreateJobPostingDto | PayerCreateJobPostingDto,
): JobPosting["vacancyBand"] {
  return dto.vacancies !== undefined ? bandForCount(dto.vacancies) : dto.vacancy_band!;
}

/**
 * Assert a posting is closeable and narrow its status to the two closeable states. `closed`
 * is terminal; a `paused` posting (B1) must be RESUMED before closing (so the shipped
 * `job_posting.closed` payload's `previous_status` stays draft|open — no event-schema change).
 */
function assertCloseable(current: JobPostingApi): "draft" | "open" {
  if (current.status === "closed") {
    throw new ConflictException("Job posting is already closed");
  }
  if (current.status === "paused") {
    throw new ConflictException("Resume the job posting before closing it");
  }
  // ADR-0037 — a posting frozen by the payer-suspension cascade is not closeable through
  // the ORDINARY path, for the same reason `paused` is not: closing it here would leave
  // `previous_status` set on a non-suspended row (which the DB CHECK rejects) and would
  // silently opt the posting out of the reinstatement restore. Deliberately reachable only
  // by the ops surface — the owning payer cannot authenticate at all while suspended. The
  // admin force-close (ADMIN-3a) IS allowed to take it terminal and clears the marker.
  if (current.status === "suspended") {
    throw new ConflictException("The owning payer is suspended; reinstate them before closing");
  }
  return current.status;
}
