import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Job, JobNeededBy, TradeKey } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { readOwnedByIdOrg, assertOwnedRowsByOrg } from "../payers/payer-scope";
import { AgencyJobsRepository, type AgencyJobUpdate } from "./agency-jobs.repository";
import {
  AgencyInvitesRepository,
  type AgencyInviteStageCounts,
} from "./agency-invites.repository";
import type { CreateAgencyJobDto, UpdateAgencyJobDto } from "./agency.dto";

/** Faceless projection of an owned job — ids / status / counts / coarse bands ONLY. */
export interface AgencyJobView {
  id: string;
  status: Job["status"];
  tradeKey: TradeKey;
  title: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: JobNeededBy | null;
  applicantsReceived: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Funnel summary response — aggregate counts only, with a k-anon floor applied. */
export interface AgencyReferralsSummary {
  created: number;
  clicked: number;
  accepted: number;
  /** Counts below this floor are suppressed to 0 (k-anonymity — no single-invitee oracle). */
  minBucket: number;
}

/** Result of the internal consent-gated attribution seam. */
export type AttributionResult =
  | { ok: true }
  | { ok: false; reason: "unknown_code" | "already_attributed" | "no_consent" };

/**
 * Agency Supply Portal demand slice (ADR-0022, ACCEPTED) — backend business logic +
 * event emission. Repo/service split: data access lives in the two repositories; this
 * service owns the rules, the tenant chokepoint calls, and the events.
 *
 * TENANCY (ADR-0027 B5.x Inc 5 — the LAST resource-table flip): the JOBS surface OWNERSHIP
 * keys on `org_id`, resolved from the acting SESSION payer via {@link resolveOrgId} FIRST in
 * every job method (fail-closed on a null org). The tenant chokepoint calls flip to the org
 * helpers (`readOwnedByIdOrg`/`assertOwnedRowsByOrg`/`assertOrgOwns` on `jobs.org_id`). The
 * acting `payer_id` is UNCHANGED as the event actor/subject + is still stamped on create
 * (the partial CHECK ties payer→org). Two agency members in the SAME org share the org's
 * jobs; a foreign-org job is the SAME neutral 404. The INVITE surface stays payer-keyed on
 * `agency_invites.inviter_payer_id` (unchanged). BEHAVIOR-PRESERVING under today's solo orgs.
 *
 * INVARIANTS enforced here:
 *  - `payerId` is ALWAYS the SESSION payer (passed in by the controller from the verified
 *    session — XB-A); it is never read from a body/param. The service resolves its org.
 *  - No-oracle: an unknown job and another org's job both surface the IDENTICAL neutral
 *    404 (`readOwnedByIdOrg` returns undefined/throws-then-mapped for both → 404 here);
 *    a caller with no resolvable org fails closed into the same neutral shape.
 *  - Every write emits exactly one registry-validated event with the PAYER as actor.
 *  - Events are PII-FREE: opaque ids + enums + coarse bands + counts only.
 *  - The attribution write that sets `invited_worker_id`/emits `agency_invite.accepted` is
 *    GATED on an ACTIVE consent row (invariant #6) and is reachable ONLY from the internal
 *    seam (never an agency-facing worker-id endpoint).
 */
@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  /**
   * k-anonymity floor for the read-only referrals summary (ADR-0022 security condition
   * C.1 #2). Any stage count strictly below this is suppressed to 0, so an agency can
   * never determine from the funnel whether ONE specific named invitee consented (the
   * smallest distinguishable bucket is >= MIN_BUCKET). Conservative default; tunable.
   */
  static readonly MIN_BUCKET = 5;

  constructor(
    private readonly jobsRepo: AgencyJobsRepository,
    private readonly invitesRepo: AgencyInvitesRepository,
    private readonly consent: ConsentRepository,
    private readonly events: EventsService,
    // ADR-0027 B5.x Inc 5: resolves the OWNING org for an acting payer (the jobs tenancy flip).
    private readonly orgs: PayerOrgsRepository,
  ) {}

  /**
   * Resolve the OWNING org for an acting payer (ADR-0027 B5.x Inc 5 — the jobs tenancy pivot,
   * mirroring `UnlockService`/`ResumeDisclosureService.resolveOrgId`). Ownership keys on
   * `org_id`; the acting `payer_id` stays the event actor/subject + the create stamp unchanged.
   * Returns null when the payer has no active org membership. Uses `resolveOrgForPayer` ONLY
   * (never `ensureSoloOrg`, which writes) — the org is a foundation the auth path established.
   *
   * FAIL CLOSED: on a null result the CALLER returns the neutral/empty equivalent (createJob:
   * the invalid-create error path; reads: neutral 404 / empty list) — never a distinguishable
   * error (no oracle). Any error → null (fail closed).
   */
  private async resolveOrgId(payerId: string): Promise<string | null> {
    try {
      return (await this.orgs.resolveOrgForPayer(payerId))?.orgId ?? null;
    } catch {
      return null; // fail closed
    }
  }

  // ───────────────────────────── Demand CRUD on jobs ─────────────────────────────

  /** Create an OWNED job (org_id + payer_id = session, status='open'). Emits job.created. */
  async createJob(
    payerId: string,
    dto: CreateAgencyJobDto,
    ctx: RequestContext,
  ): Promise<AgencyJobView> {
    // ADR-0027 B5.x Inc 5: resolve the OWNING org FIRST + stamp it on the create. FAIL CLOSED:
    // a payer with no resolvable org cannot create a job — the partial CHECK
    // `jobs_org_id_when_payer_chk` would reject a payer-owned row without org_id anyway, so we
    // reject BEFORE the write with the same invalid-create error path (never a phantom job).
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) throw new BadRequestException("Unable to create job");

    const row = await this.jobsRepo.create(
      {
        orgId,
        payerId,
        tradeKey: dto.trade_key,
        title: dto.title,
        city: dto.city,
        area: dto.area ?? null,
        payMin: dto.pay_min ?? null,
        payMax: dto.pay_max ?? null,
        minExperienceYears: dto.min_experience_years ?? null,
        maxExperienceYears: dto.max_experience_years ?? null,
        neededBy: dto.needed_by ?? null,
      },
      "open",
    );

    const payload: PayloadInputOf<"job.created"> = {
      job_id: row.id,
      payer_id: payerId,
      status: "open",
      trade_key: row.tradeKey,
      city: row.city,
      pay_min: row.payMin,
      pay_max: row.payMax,
      min_experience_years: row.minExperienceYears,
      max_experience_years: row.maxExperienceYears,
    };
    await this.events.emit(this.jobEmitParams("job.created", row.id, payerId, payload, ctx));

    return AgencyService.toJobView(row);
  }

  /** List the org's OWN jobs (faceless projection). Defense-in-depth org ownership re-check. */
  async listOwnJobs(payerId: string): Promise<AgencyJobView[]> {
    // ADR-0027 B5.x Inc 5: resolve the OWNING org; a caller with no resolvable org reads an
    // EMPTY list (fail-closed read — never a distinguishable error, no oracle).
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) return [];

    const rows = await this.jobsRepo.listOwned(orgId);
    // Belt-and-braces: every returned row must belong to the org (the WHERE already scopes
    // this, but assertOwnedRowsByOrg is the cross-tenant guarantee on list reads). A row with
    // a null org_id (never expected from the org-scoped WHERE) normalizes to "" → 403.
    assertOwnedRowsByOrg(orgId, rows.map((r) => ({ ...r, orgId: r.orgId ?? "" })));
    return rows.map(AgencyService.toJobView);
  }

  /** Get ONE owned job; neutral 404 for unknown-or-not-owned (no-oracle). */
  async getOwnJob(payerId: string, jobId: string): Promise<AgencyJobView> {
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) throw new NotFoundException("Job not found"); // fail closed, no oracle
    const row = await this.readOwnedJob(orgId, jobId);
    if (!row) throw new NotFoundException("Job not found");
    return AgencyService.toJobView(row);
  }

  /** Edit an owned job. Neutral 404 if unknown-or-not-owned. Emits job.updated. */
  async updateJob(
    payerId: string,
    jobId: string,
    dto: UpdateAgencyJobDto,
    ctx: RequestContext,
  ): Promise<AgencyJobView> {
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) throw new NotFoundException("Job not found"); // fail closed, no oracle
    const current = await this.readOwnedJob(orgId, jobId);
    if (!current) throw new NotFoundException("Job not found");
    if (current.status === "closed") {
      // closed is terminal — no edits. (A neutral conflict, not a leak.)
      throw new BadRequestException("Job is closed and cannot be edited");
    }

    const patch: AgencyJobUpdate = { updatedAt: new Date() };
    const changedFields: PayloadInputOf<"job.updated">["changed_fields"] = [];

    if (dto.trade_key !== undefined && dto.trade_key !== current.tradeKey) {
      patch.tradeKey = dto.trade_key;
      changedFields.push("trade_key");
    }
    if (dto.title !== undefined && dto.title !== current.title) {
      patch.title = dto.title;
      changedFields.push("title");
    }
    if (dto.city !== undefined && dto.city !== current.city) {
      patch.city = dto.city;
      changedFields.push("city");
    }
    if (dto.area !== undefined && dto.area !== current.area) {
      patch.area = dto.area;
      changedFields.push("area");
    }
    if (dto.pay_min !== undefined && dto.pay_min !== current.payMin) {
      patch.payMin = dto.pay_min;
      changedFields.push("pay_min");
    }
    if (dto.pay_max !== undefined && dto.pay_max !== current.payMax) {
      patch.payMax = dto.pay_max;
      changedFields.push("pay_max");
    }
    if (
      dto.min_experience_years !== undefined &&
      dto.min_experience_years !== current.minExperienceYears
    ) {
      patch.minExperienceYears = dto.min_experience_years;
      changedFields.push("min_experience_years");
    }
    if (
      dto.max_experience_years !== undefined &&
      dto.max_experience_years !== current.maxExperienceYears
    ) {
      patch.maxExperienceYears = dto.max_experience_years;
      changedFields.push("max_experience_years");
    }
    if (dto.needed_by !== undefined && dto.needed_by !== current.neededBy) {
      patch.neededBy = dto.needed_by;
      changedFields.push("needed_by");
    }

    if (changedFields.length === 0) {
      throw new BadRequestException("no effective changes to apply");
    }

    // Cross-field ordering check against the RESULTING row (handles one-sided edits).
    const nextPayMin = patch.payMin ?? current.payMin;
    const nextPayMax = patch.payMax ?? current.payMax;
    if (nextPayMin != null && nextPayMax != null && nextPayMax < nextPayMin) {
      throw new BadRequestException("pay_max must be >= pay_min");
    }
    const nextExpMin = patch.minExperienceYears ?? current.minExperienceYears;
    const nextExpMax = patch.maxExperienceYears ?? current.maxExperienceYears;
    if (nextExpMin != null && nextExpMax != null && nextExpMax < nextExpMin) {
      throw new BadRequestException("max_experience_years must be >= min_experience_years");
    }

    const updated = await this.jobsRepo.updateOwned(jobId, orgId, patch);
    if (!updated) throw new NotFoundException("Job not found");

    const payload: PayloadInputOf<"job.updated"> = {
      job_id: updated.id,
      payer_id: payerId,
      status: updated.status,
      changed_fields: changedFields,
    };
    await this.events.emit(this.jobEmitParams("job.updated", updated.id, payerId, payload, ctx));

    return AgencyService.toJobView(updated);
  }

  /** Close an owned job (open -> closed, terminal). Emits job.closed. */
  async closeJob(payerId: string, jobId: string, ctx: RequestContext): Promise<AgencyJobView> {
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) throw new NotFoundException("Job not found"); // fail closed, no oracle
    const current = await this.readOwnedJob(orgId, jobId);
    if (!current) throw new NotFoundException("Job not found");
    if (current.status === "closed") {
      throw new BadRequestException("Job is already closed");
    }

    const closed = await this.jobsRepo.closeOwnedIfOpen(jobId, orgId, new Date());
    if (!closed) {
      // Raced to closed (or no longer owned-open) — neutral conflict, no oracle.
      throw new BadRequestException("Job is already closed");
    }

    const payload: PayloadInputOf<"job.closed"> = {
      job_id: closed.id,
      payer_id: payerId,
      previous_status: "open",
      status: "closed",
    };
    await this.events.emit(this.jobEmitParams("job.closed", closed.id, payerId, payload, ctx));

    return AgencyService.toJobView(closed);
  }

  /**
   * PAUSE — Phase-1 decision: `JobStatus` is `open|closed` ONLY (no DB CHECK adds a third
   * value cheaply, and a `paused` literal would mutate a SHIPPED union consumed by the
   * Reach open-feed filter + exhaustive switches). So pause == close for Phase-1: it sets
   * `status='closed'` (the Reach open-feed correctly stops serving it) and emits
   * `job.updated` with `changed_fields:["status"]` to record it as a serving-state toggle
   * distinct from a terminal close. Reopen is out of scope for this slice.
   */
  async pauseJob(payerId: string, jobId: string, ctx: RequestContext): Promise<AgencyJobView> {
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) throw new NotFoundException("Job not found"); // fail closed, no oracle
    const current = await this.readOwnedJob(orgId, jobId);
    if (!current) throw new NotFoundException("Job not found");
    if (current.status === "closed") {
      throw new BadRequestException("Job is already closed/paused");
    }

    const paused = await this.jobsRepo.closeOwnedIfOpen(jobId, orgId, new Date());
    if (!paused) {
      throw new BadRequestException("Job is already closed/paused");
    }

    const payload: PayloadInputOf<"job.updated"> = {
      job_id: paused.id,
      payer_id: payerId,
      status: paused.status,
      changed_fields: ["status"],
    };
    await this.events.emit(this.jobEmitParams("job.updated", paused.id, payerId, payload, ctx));

    return AgencyService.toJobView(paused);
  }

  // ───────────────────────────── Mock invite hook ─────────────────────────────

  /** Mint an OWNED opaque invite code. Returns the code only. Emits agency_invite.created. */
  async createInvite(
    payerId: string,
    campaign: string | undefined,
    ctx: RequestContext,
  ): Promise<{ agency_invite_id: string; code: string; link: string }> {
    const code = randomUUID().replace(/-/g, "").slice(0, 12);
    const invite = await this.invitesRepo.create({ code, inviterPayerId: payerId, campaign });

    const payload: PayloadInputOf<"agency_invite.created"> = {
      agency_invite_id: invite.id,
      inviter_payer_id: payerId,
      channel: "whatsapp",
      campaign,
    };
    await this.events.emit({
      event_name: "agency_invite.created",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "agency_invite", subject_id: invite.id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `agency_invite.created:${invite.id}`,
    });

    return { agency_invite_id: invite.id, code, link: `/i/${code}` };
  }

  /**
   * Record a click on an invite link (attribution). NEUTRAL/no-op on an unknown code
   * (no-oracle — the response is identical whether the code exists or not). This is NOT
   * owner-scoped (a click arrives from anyone with the link), but it carries no PII and
   * leaks nothing about the agency. Does NOT advance to 'accepted' (that is the gated seam).
   */
  async recordInviteClick(code: string): Promise<{ ok: true }> {
    const invite = await this.invitesRepo.findByCode(code);
    // Unknown code → neutral no-op (same response shape, no oracle).
    if (!invite) return { ok: true };
    // Only advance created -> clicked (don't regress an accepted/clicked invite).
    if (invite.status === "created") {
      await this.invitesRepo.setStatus(invite.id, "clicked");
    }
    return { ok: true };
  }

  // ─────────────────── Consent-gated attribution (INTERNAL seam) ───────────────────

  /**
   * INTERNAL service method (ADR-0022 security condition C.1 #1 — the build-blocker). The
   * ONLY path that sets `agency_invites.invited_worker_id`/status='accepted' and emits
   * `agency_invite.accepted`. It is INTENDED to be invoked from the worker onboarding/consent
   * path when an invite code is present — NOT by the agency, and the agency NEVER supplies a
   * worker id (there is deliberately no agency-facing endpoint that accepts one). That call
   * site is a tracked fast-follow; until it is wired this exported method has no caller, so
   * no attribution occurs (fail-safe — inert until wired).
   *
   * CONSENT GATE (fail-closed): attribution proceeds ONLY if the worker has an ACTIVE
   * consent row (latest consent exists AND `revokedAt IS NULL`). Otherwise it is a NO-OP
   * (`{ok:false, reason:"no_consent"}`) — a non-consented worker is NEVER attributed and
   * NO event is emitted. Also no-ops on an unknown code or an already-attributed invite
   * (idempotent).
   */
  async attributeWorkerToInvite(code: string, workerId: string): Promise<AttributionResult> {
    const invite = await this.invitesRepo.findByCode(code);
    if (!invite) return { ok: false, reason: "unknown_code" };
    if (invite.invitedWorkerId) return { ok: false, reason: "already_attributed" };

    // DPDP gate (invariant #6): require an ACTIVE consent before attributing.
    const latest = await this.consent.findLatestByWorker(workerId);
    if (!latest || latest.revokedAt !== null) {
      this.logger.log(
        `agency attribution skipped (no active consent) invite=${invite.id} (fail-closed)`,
      );
      return { ok: false, reason: "no_consent" };
    }

    const wrote = await this.invitesRepo.markAccepted(invite.id, workerId);
    if (!wrote) {
      // Lost a race to another attribution — treat as already attributed (no event).
      return { ok: false, reason: "already_attributed" };
    }

    const payload: PayloadInputOf<"agency_invite.accepted"> = {
      agency_invite_id: invite.id,
      inviter_payer_id: invite.inviterPayerId,
      invited_worker_id: workerId,
    };
    await this.events.emit({
      event_name: "agency_invite.accepted",
      // Not agency-triggered — the system records the post-consent attribution fact.
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "agency_invite", subject_id: invite.id },
      payload,
      idempotencyKey: `agency_invite.accepted:${invite.id}`,
    });

    return { ok: true };
  }

  // ───────────────────────── Read-only referrals summary ─────────────────────────

  /**
   * The agency's OWN funnel counts by stage, scoped by `inviter_payer_id == session`.
   * AGGREGATE-ONLY (no per-invite/per-worker rows ever leave the repo) with a k-anon floor:
   * any stage count strictly below {@link MIN_BUCKET} is suppressed to 0 so the agency can
   * never tell whether ONE specific named invitee consented (no consent oracle, ADR-0022
   * C.1 #2). `minBucket` is echoed so the client knows a 0 may mean "below floor".
   */
  async referralsSummary(payerId: string): Promise<AgencyReferralsSummary> {
    const raw: AgencyInviteStageCounts = await this.invitesRepo.stageCountsForOwner(payerId);
    const floor = (n: number): number => (n < AgencyService.MIN_BUCKET ? 0 : n);
    return {
      created: floor(raw.created),
      clicked: floor(raw.clicked),
      accepted: floor(raw.accepted),
      minBucket: AgencyService.MIN_BUCKET,
    };
  }

  // ──────────────────────────────── helpers ────────────────────────────────

  /**
   * The single-resource owned read chokepoint for jobs (ADR-0027 B5.x Inc 5 — org-keyed).
   * The repo already scopes by ORG in the WHERE; `readOwnedByIdOrg` is the tenant chokepoint
   * that re-asserts ORG ownership on the fetched row (defense-in-depth). Returns undefined for
   * unknown-or-not-owned (no-oracle). Takes the RESOLVED `orgId` (never the payer directly).
   */
  private readOwnedJob(orgId: string, jobId: string): Promise<Job | undefined> {
    return readOwnedByIdOrg(orgId, async () => {
      const row = await this.jobsRepo.findOwnedById(jobId, orgId);
      // `jobs.orgId` is nullable in the schema, but a row returned by the org-scoped query
      // always has it === orgId; normalize the type for the scope helper.
      return row ? { ...row, orgId: row.orgId ?? "" } : undefined;
    });
  }

  /** Common emit params for a job.* event: PAYER actor, `job` subject, tracing ids. */
  private jobEmitParams<N extends "job.created" | "job.updated" | "job.closed">(
    event_name: N,
    jobId: string,
    payerId: string,
    payload: PayloadInputOf<N>,
    ctx: RequestContext,
  ): EmitParams<N> {
    return {
      event_name,
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "job", subject_id: jobId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    } as EmitParams<N>;
  }

  /** Faceless projection of a `jobs` row — never returns the owner `payer_id`. */
  private static toJobView(row: Job): AgencyJobView {
    return {
      id: row.id,
      status: row.status,
      tradeKey: row.tradeKey,
      title: row.title,
      city: row.city,
      area: row.area,
      payMin: row.payMin,
      payMax: row.payMax,
      minExperienceYears: row.minExperienceYears,
      maxExperienceYears: row.maxExperienceYears,
      neededBy: row.neededBy,
      applicantsReceived: row.applicantsReceived,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
