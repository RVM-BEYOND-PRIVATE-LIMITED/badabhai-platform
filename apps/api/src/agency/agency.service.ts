import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { InviteInstallSource, PayloadInputOf } from "@badabhai/event-schema";
import type { AgencyInviteMedium, Job, JobNeededBy, TradeKey } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { readOwnedById, assertOwnedRows } from "../payers/payer-scope";
import { AgencyJobsRepository, type AgencyJobUpdate } from "./agency-jobs.repository";
import { AgencyInvitesRepository, type AgencyInviteStageCounts } from "./agency-invites.repository";
import type { CreateAgencyJobDto, InviteContextDto, UpdateAgencyJobDto } from "./agency.dto";

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
 * One minted invite as returned to the agency. Opaque id + bearer code + the relative share
 * link — and NOTHING that denotes a person (there is no invitee field, by construction).
 */
export interface AgencyInviteMint {
  agency_invite_id: string;
  code: string;
  link: string;
}

/**
 * The non-PII METADATA stamped on a minted invite (W1). One object rather than three more
 * positional parameters, because all three travel together through the whole mint path
 * (`createInvite`/`createInviteBatch` → `mintOneInvite` → insert + emit) and a positional
 * list of four optionals is exactly how a `campaign` ends up written into a `medium`.
 *
 * EVERY FIELD IS REFERENT-FREE — it describes the LINK, never a person. `campaign` is the
 * long-standing ADR-0020 tag; `medium` is the match-window discriminator; `context` is the
 * closed `{role?, city?}` slug object. All three are validated at the HTTP boundary
 * (`agency.dto.ts`); this type carries already-screened values.
 *
 * On the BATCH path this is ONE object applied identically to all N invites — never
 * indexed, never per-invite. That is the module-2 boundary, not a convenience.
 */
export interface AgencyInviteMeta {
  campaign?: string;
  medium?: AgencyInviteMedium;
  context?: InviteContextDto;
}

/**
 * Bounded retries for a `agency_invites_code_uq` collision on mint. A 48-bit code makes a
 * collision astronomically unlikely (~4e-12 within a 50-code batch); this exists so the
 * failure mode is a NEUTRAL error rather than a raw Drizzle unique-violation 500, and it is
 * bounded so a pathological code space can never spin.
 */
const CODE_COLLISION_RETRIES = 3;

/**
 * Bounded retries for PERSISTING the `agency_invite.created` event of a row that is already
 * durably written. The emit is idempotency-keyed (`agency_invite.created:<invite_id>`), so a
 * retry is exactly-once at the DB — including the case where the previous attempt actually
 * committed the event row and failed on the way back. Bounded so a hard failure (e.g. an
 * invalid payload, which is deterministic) can never spin.
 */
const EVENT_EMIT_RETRIES = 3;

/**
 * Postgres unique-violation (23505). Used ONLY to classify a failure of the invite ROW
 * INSERT, where the sole unique index in play is `agency_invites_code_uq`. It is deliberately
 * NOT applied to any other statement: the `events` table has its own idempotency-key unique
 * index, and treating ITS 23505 as "the invite code collided" is what previously re-ran the
 * row insert and wrote a duplicate row holding a live bearer code.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** ORDER-SENSITIVE equality for the benefits/requirements chip lists (display order matters). */
function sameStringList(a: string[], b: string[] | null): boolean {
  return b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Agency Supply Portal demand slice (ADR-0022, ACCEPTED) — backend business logic +
 * event emission. Repo/service split: data access lives in the two repositories; this
 * service owns the rules, the tenant chokepoint calls (`readOwnedById`/`assertOwnedRows`
 * on `jobs.payer_id` / `agency_invites.inviter_payer_id`), and the events.
 *
 * INVARIANTS enforced here:
 *  - `payerId` is ALWAYS the SESSION payer (passed in by the controller from the verified
 *    session — XB-A); it is never read from a body/param.
 *  - No-oracle: an unknown job and another payer's job both surface the IDENTICAL neutral
 *    404 (`readOwnedById` returns undefined for both → 404 here).
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
  ) {}

  // ───────────────────────────── Demand CRUD on jobs ─────────────────────────────

  /** Create an OWNED job (payer_id = session, status='open'). Emits job.created. */
  async createJob(
    payerId: string,
    dto: CreateAgencyJobDto,
    ctx: RequestContext,
  ): Promise<AgencyJobView> {
    const row = await this.jobsRepo.create(
      {
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
        // Worker-visible content (ADR-0024 final addendum) — the DTO already screened
        // every free-text surface fail-closed (looksLikePii + looksLikeOrgName).
        description: dto.description ?? null,
        shift: dto.shift ?? null,
        benefits: dto.benefits ?? null,
        requirements: dto.requirements ?? null,
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

    // TD64 — emit job.available per matched worker. Deferred: requires a
    // worker-matching query (trade_key + city) that does not exist yet. The event
    // schema and allowlist entry are ready; uncomment when the matcher lands.
    // See docs/registers/tech-debt-register.md § TD64.

    return AgencyService.toJobView(row);
  }

  /** List the payer's OWN jobs (faceless projection). Defense-in-depth ownership re-check. */
  async listOwnJobs(payerId: string): Promise<AgencyJobView[]> {
    const rows = await this.jobsRepo.listOwned(payerId);
    // Belt-and-braces: every returned row must belong to the payer (the WHERE already
    // scopes this, but assertOwnedRows is the cross-tenant guarantee on list reads).
    assertOwnedRows(
      payerId,
      rows.map((r) => ({ ...r, payerId: r.payerId ?? "" })),
    );
    return rows.map(AgencyService.toJobView);
  }

  /** Get ONE owned job; neutral 404 for unknown-or-not-owned (no-oracle). */
  async getOwnJob(payerId: string, jobId: string): Promise<AgencyJobView> {
    const row = await this.readOwnedJob(payerId, jobId);
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
    const current = await this.readOwnedJob(payerId, jobId);
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
    // Worker-visible content (ADR-0024 final addendum). changed_fields carries the
    // KEYS only — the screened free text itself NEVER enters the event payload.
    if (dto.description !== undefined && dto.description !== current.description) {
      patch.description = dto.description;
      changedFields.push("description");
    }
    if (dto.shift !== undefined && dto.shift !== current.shift) {
      patch.shift = dto.shift;
      changedFields.push("shift");
    }
    if (dto.benefits !== undefined && !sameStringList(dto.benefits, current.benefits)) {
      patch.benefits = dto.benefits;
      changedFields.push("benefits");
    }
    if (dto.requirements !== undefined && !sameStringList(dto.requirements, current.requirements)) {
      patch.requirements = dto.requirements;
      changedFields.push("requirements");
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

    const updated = await this.jobsRepo.updateOwned(jobId, payerId, patch);
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
    const current = await this.readOwnedJob(payerId, jobId);
    if (!current) throw new NotFoundException("Job not found");
    if (current.status === "closed") {
      throw new BadRequestException("Job is already closed");
    }

    const closed = await this.jobsRepo.closeOwnedIfOpen(jobId, payerId, new Date());
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
    const current = await this.readOwnedJob(payerId, jobId);
    if (!current) throw new NotFoundException("Job not found");
    if (current.status === "closed") {
      throw new BadRequestException("Job is already closed/paused");
    }

    const paused = await this.jobsRepo.closeOwnedIfOpen(jobId, payerId, new Date());
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
    meta: AgencyInviteMeta,
    ctx: RequestContext,
  ): Promise<AgencyInviteMint> {
    return this.mintOneInvite(payerId, meta, ctx);
  }

  /**
   * BATCH mint (ADR-0022 Amendment 3) — mint `count` INDEPENDENT invites in one request.
   *
   * This is OUTBOUND, referent-free token GENERATION, not the DEAD module-2 bulk upload:
   * the caller supplies a scalar CARDINALITY (plus one optional non-PII tag), never a list
   * of people. See {@link CreateAgencyInviteBatchSchema} — the DTO shape is the boundary.
   *
   * Structure (each point is a security condition, not a style choice):
   *  - N INDEPENDENT invites, each with its OWN `randomUUID`-derived code and its OWN
   *    `agency_invite.created` v1 event keyed `agency_invite.created:<invite_id>`. There is
   *    deliberately NO batch event, NO batch id, NO count field and NO `codes[]` anywhere on
   *    the spine: each invite is an independent state change with its own created → clicked
   *    → accepted lifecycle, and a code is a BEARER TOKEN that must never enter the
   *    permanent audit record.
   *  - ROW-THEN-EVENT per iteration, exactly like the singular mint. There is no wrapping
   *    transaction: rolling back after events were emitted would leave the spine pointing at
   *    invite ids that no longer exist. A mid-batch failure therefore returns the
   *    successfully minted SUBSET, and never a leaked DB error string.
   *
   *    C5, RESTATED TO WHAT THE CODE ACTUALLY GUARANTEES (the previous wording overclaimed):
   *      · NEVER an event without a durably written row — the row insert always precedes the
   *        emit, and a failed insert emits nothing.
   *      · NEVER a returned code whose event is not on the spine — the mint returns only
   *        AFTER its `agency_invite.created` is persisted, so `invites.length` is exactly the
   *        number of rows carrying an event.
   *      · A row whose event cannot be persisted is NOT silently orphaned: the keyed emit is
   *        retried {@link EVENT_EMIT_RETRIES} times and, if it still fails, the row is
   *        flagged with an explicit code-free reconciliation marker (see
   *        {@link emitInviteCreated}) and its code is returned to nobody. That row is still
   *        WRITTEN — the invites repository exposes no rollback/void, and closing the window
   *        for real needs the tx seam `EventsService.emit({ tx })` already provides
   *        (`db.transaction` → tx-aware `invitesRepo.create` + emit on the same tx). That is
   *        a repository-level change, tracked, not silently assumed away here.
   *  - The hourly cap for all N units is already RESERVED by the controller before we get
   *    here (one atomic INCRBY, fail-closed) — a batch that would cross the cap mints zero.
   */
  async createInviteBatch(
    payerId: string,
    count: number,
    meta: AgencyInviteMeta,
    ctx: RequestContext,
  ): Promise<{ invites: AgencyInviteMint[] }> {
    const invites: AgencyInviteMint[] = [];
    for (let i = 0; i < count; i += 1) {
      try {
        // ONE `meta` for all N — never indexed, never per-invite. See
        // CreateAgencyInviteBatchSchema: per-invite metadata is the `labels[]` violation.
        invites.push(await this.mintOneInvite(payerId, meta, ctx));
      } catch (err) {
        // Partial success is the CORRECT outcome: the invites already minted are durable
        // and their events are already on the spine, so we stop and return the subset.
        // Log the SHAPE of the failure only — never a code (a live bearer token), never a
        // full payer id, never the DB error surface, which is echoed to nobody.
        this.logger.error(
          `agency invite batch stopped early payer=${payerId.slice(0, 8)}… minted=${invites.length}/${count} (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
        );
        break;
      }
    }

    if (invites.length === 0) {
      // Nothing was written and nothing was emitted. Surface a NEUTRAL failure — no DB
      // error text, no constraint name, no stack (an externally reachable endpoint must
      // not be a schema-disclosure channel).
      throw new ServiceUnavailableException(
        "This is temporarily unavailable; please retry shortly",
      );
    }
    return { invites };
  }

  /**
   * Mint exactly ONE invite: row first, then its event. Shared verbatim by the singular and
   * batch paths so the two can never drift.
   *
   * The two steps are SEPARATELY guarded on purpose (they used to share one try block, which
   * conflated two unrelated failures — see {@link insertInviteWithFreshCode} and
   * {@link emitInviteCreated} for what each one may and may not retry). Returning happens
   * only after the event is persisted, so a returned code is always a code on the spine.
   */
  private async mintOneInvite(
    payerId: string,
    meta: AgencyInviteMeta,
    ctx: RequestContext,
  ): Promise<AgencyInviteMint> {
    const { id, code } = await this.insertInviteWithFreshCode(payerId, meta);
    await this.emitInviteCreated(id, payerId, meta, ctx);
    return { agency_invite_id: id, code, link: `/i/${code}` };
  }

  /**
   * Insert ONE invite row with a freshly generated code. NOTHING ELSE IS INSIDE THIS TRY.
   *
   * CODE ENTROPY: every code is INDEPENDENTLY derived from its own `randomUUID` — never
   * from a shared batch id, counter, index, timestamp or common prefix. A derived scheme
   * (`<batchId>-01..N`) would make the other N-1 codes guessable from ONE leaked or scanned
   * code; independent codes keep the guessing cost at 2^48 / live_codes, which — with the
   * per-code cap accounting — makes a batch of N indistinguishable from N single mints.
   *
   * A unique-index collision on `agency_invites_code_uq` (~4e-12 within a 50-code batch) is
   * retried a BOUNDED number of times with a fresh code, so it can never surface as an
   * unhandled 500. Any OTHER error propagates unchanged (the batch caller stops there).
   *
   * THE SCOPE OF THAT RETRY IS THE POINT. When the event emit shared this try block, a 23505
   * raised by the EVENTS idempotency-key unique index was misread as a code collision and
   * re-ran the WHOLE iteration — writing a SECOND invite row holding a live bearer code that
   * was charged to nobody's cap and returned to nobody. The only statement that can raise
   * here now is the row insert, so the only 23505 reachable is the one this retry is for.
   *
   * Returns the code WE generated rather than the column echoed back, so the value handed to
   * the agency is the one we actually attempted to store.
   */
  private async insertInviteWithFreshCode(
    payerId: string,
    meta: AgencyInviteMeta,
  ): Promise<{ id: string; code: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      const code = randomUUID().replace(/-/g, "").slice(0, 12);
      try {
        const invite = await this.invitesRepo.create({
          code,
          inviterPayerId: payerId,
          campaign: meta.campaign,
          medium: meta.medium,
          payload: meta.context,
        });
        return { id: invite.id, code };
      } catch (err) {
        // Only a CODE collision is retryable — anything else is the caller's problem.
        if (!isUniqueViolation(err)) throw err;
        lastErr = err;
      }
    }
    // Bounded retries exhausted: neutral surface, never the constraint name or the code.
    this.logger.error(
      `agency invite code collision retries exhausted payer=${payerId.slice(0, 8)}… (reason: ${
        lastErr instanceof Error ? lastErr.name : "unknown"
      })`,
    );
    throw new ServiceUnavailableException("This is temporarily unavailable; please retry shortly");
  }

  /**
   * Put the invite's `agency_invite.created` on the audit spine (invariant #1). The row is
   * ALREADY durably written when this runs, so a failure here is not a neutral "mint failed"
   * — it is a live bearer credential with no audit record, which is the worse of the two
   * inconsistent states (an event without a row is a dangling reference; a row without an
   * event is an unauditable credential that can still be redeemed).
   *
   * So this does NOT fail on the first error:
   *  1. It RETRIES the emit, bounded. The emit is keyed `agency_invite.created:<invite_id>`,
   *     so a retry is a DB-level no-op if the previous attempt actually landed — the retry
   *     can create a duplicate event no more than it can create a duplicate row.
   *  2. If every attempt fails, it logs an explicit ORPHAN reconciliation marker naming the
   *     INVITE ID — an opaque uuid, never the code (a bearer token) and never the full payer
   *     id — so the row is discoverable rather than silently unauditable.
   *  3. It then throws NEUTRALLY, so the code is returned to nobody and the batch stops with
   *     `invites.length` equal to the number of rows that ARE on the spine.
   *
   * RESIDUAL, stated rather than papered over: the row itself survives. `AgencyInvitesRepository`
   * exposes no delete/void and `agency_invites.status` has no non-live value, so this service
   * cannot compensate. The real close is the transaction seam `EmitParams.tx` already exists
   * for — `db.transaction(tx => invitesRepo.create(…, tx))` + `emit({ …, tx })` — which makes
   * the row and its event commit or roll back together. That is a repository-signature change
   * and is escalated, not assumed.
   */
  private async emitInviteCreated(
    inviteId: string,
    payerId: string,
    meta: AgencyInviteMeta,
    ctx: RequestContext,
  ): Promise<void> {
    // KEY NAMES ONLY — the role/city slugs stay on the row and never reach the spine (see
    // AgencyInviteCreatedPayload for why this is asymmetric with `campaign`). Sorted so the
    // emitted value is stable regardless of the order the client happened to send the keys
    // in, and omitted entirely when there is no context (an empty array would be
    // indistinguishable from "the agency sent {}").
    const contextKeys = Object.keys(meta.context ?? {}).sort();

    const payload: PayloadInputOf<"agency_invite.created"> = {
      agency_invite_id: inviteId,
      inviter_payer_id: payerId,
      channel: "whatsapp",
      campaign: meta.campaign,
      medium: meta.medium,
      ...(contextKeys.length > 0 ? { payload_keys: contextKeys } : {}),
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt < EVENT_EMIT_RETRIES; attempt += 1) {
      try {
        await this.events.emit({
          event_name: "agency_invite.created",
          actor: { actor_type: "payer", actor_id: payerId },
          subject: { subject_type: "agency_invite", subject_id: inviteId },
          payload,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `agency_invite.created:${inviteId}`,
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }

    this.logger.error(
      `AUDIT ORPHAN agency_invite row written but agency_invite.created not persisted ` +
        `invite=${inviteId} payer=${payerId.slice(0, 8)}… attempts=${EVENT_EMIT_RETRIES} ` +
        `(reason: ${lastErr instanceof Error ? lastErr.name : "unknown"}) — ` +
        `reconcile by re-emitting agency_invite.created for this invite id`,
    );
    throw new ServiceUnavailableException("This is temporarily unavailable; please retry shortly");
  }

  /**
   * Record a click on an invite link (attribution). NEUTRAL/no-op on an unknown code
   * (no-oracle — the response is identical whether the code exists or not). This is NOT
   * owner-scoped (a click arrives from anyone with the link), but it carries no PII and
   * leaks nothing about the agency. Does NOT advance to 'accepted' (that is the gated seam).
   *
   * TD113: this now EMITS `agency_invite.clicked` on a known code — the stage had a status
   * column but no event, so the agency funnel's middle was invisible on the audit spine
   * (invariant #1). An UNKNOWN code emits NOTHING, which is what keeps the public caller
   * from being an existence oracle: the response is byte-identical either way.
   *
   * NO WORKER HANDLE: a click happens BEFORE the DPDP consent gate, so no worker identity
   * is read, written, or emitted here (invariant #6) — `agency_invite.accepted` remains the
   * only agency event that carries a worker id.
   */
  async recordInviteClick(code: string): Promise<{ ok: true }> {
    const invite = await this.invitesRepo.findByCode(code);
    // Unknown code → neutral no-op (same response shape, no oracle, no event).
    if (!invite) return { ok: true };
    // Only advance created -> clicked (don't regress an accepted/clicked invite).
    if (invite.status === "created") {
      await this.invitesRepo.setStatus(invite.id, "clicked");
    }
    const payload: PayloadInputOf<"agency_invite.clicked"> = {
      agency_invite_id: invite.id,
      inviter_payer_id: invite.inviterPayerId,
      channel: "whatsapp",
    };
    // DELIBERATELY UNKEYED, exactly like the sibling `invite.clicked`: a click is a
    // repeatable behavioural fact (the same link can be opened many times) and collapsing
    // them would destroy the funnel signal this event exists to provide.
    await this.events.emit({
      event_name: "agency_invite.clicked",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "agency_invite", subject_id: invite.id },
      payload,
    });
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
  async attributeWorkerToInvite(
    code: string,
    workerId: string,
    /**
     * B4 — which leg of the post-Dynamic-Links chain carried the code across the Play
     * Store round-trip. OPTIONAL, defaults to "unknown": every existing caller keeps
     * compiling and every pre-B4 client keeps working unchanged (invariant #8).
     */
    source: InviteInstallSource = "unknown",
  ): Promise<AttributionResult> {
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

    // B4 — the install ACTUALLY attributed + which leg delivered it. Same instant as
    // `accepted` above, different question (`source`). The `markAccepted` single-winner
    // write guarantees at most one per invite; the key makes a retry a no-op.
    await this.events.emit({
      event_name: "invite.install",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "agency_invite", subject_id: invite.id },
      payload: { invite_id: invite.id, invite_kind: "agency", source },
      idempotencyKey: `invite.install:${invite.id}`,
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
   * The single-resource owned read chokepoint for jobs. The repo already scopes by payer
   * in the WHERE; `readOwnedById` is the tenant chokepoint that re-asserts ownership on the
   * fetched row (defense-in-depth). Returns undefined for unknown-or-not-owned (no-oracle).
   */
  private readOwnedJob(payerId: string, jobId: string): Promise<Job | undefined> {
    return readOwnedById(payerId, async () => {
      const row = await this.jobsRepo.findOwnedById(jobId, payerId);
      // `jobs.payerId` is nullable in the schema, but a row returned by the owner-scoped
      // query always has it === payerId; normalize the type for the scope helper.
      return row ? { ...row, payerId: row.payerId ?? "" } : undefined;
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
