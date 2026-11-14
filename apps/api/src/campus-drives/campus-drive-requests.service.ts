import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { containsHardIdentifier } from "../common/hard-identifier";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { inFlightConflict } from "../common/idempotency/in-flight-conflict";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { AUDIENCE_REFUSAL_REASONS } from "../job-postings/posting-audience.service";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { encodeDriveCursor } from "./campus-drive-cursor";
import { DRIVE_REQUESTER_NOT_VERIFIED, driveRequesterStanding } from "./campus-drive-eligibility";
import type {
  PayerCampusDriveRequestPage,
  PayerCampusDriveRequestView,
  PayerCreateCampusDriveRequestDto,
  PayerListCampusDriveRequestsQueryDto,
} from "./campus-drive-requests.dto";
import {
  CampusDriveRequestsRepository,
  type DriveRequestRow,
} from "./campus-drive-requests.repository";
import { cleanReviewReason } from "../campus-link/campus-review-reason";
import { indiaDay, latestDriveDay } from "./campus-drive-dates";
import { cleanDriveLine, screeningCopyOf } from "./campus-drive-text";
import { DRIVE_CANCELLABLE_STATUSES } from "./campus-drive-transitions";

/** Machine-readable `reason`s on this service's 4xx; the company app branches on these. */
export const DRIVE_REQUEST_REFUSAL_REASONS = {
  /**
   * 403: the company's account (the tenant's anchor row) is not `active`: suspended, archived or
   * never activated. The account half of the R2 withdrawn rule (migration review L2).
   */
  notActive: "company_not_active",
  /** 403: not a verified employer; `missing` lists what is missing (`campus-drive-eligibility`). */
  notVerified: DRIVE_REQUESTER_NOT_VERIFIED,
  /** 400: `preferred_from` is before today in India. */
  datesInPast: "preferred_dates_in_past",
  /** 400: `preferred_to` is more than a year after today in India. */
  datesTooFar: "preferred_dates_too_far",
  /** 400: `roles_note` holds a phone, an email or another hard identifier (`identifier` says which). */
  rolesNoteIdentifier: "roles_note_has_identifier",
  /** 400: `contact_name` held nothing visible. */
  contactNameEmpty: "contact_name_required",
  /** 400: a branch id that is not an active option. PR 4's reason, one spelling for both routes. */
  branchNotOffered: AUDIENCE_REFUSAL_REASONS.targetingOptionNotOffered,
  /** 409: the same `Idempotency-Key` was used for a different request. */
  keyReused: "idempotency_key_reused",
  /** 409: the request is declined or completed, so there is nothing to cancel. */
  notCancellable: "drive_request_not_cancellable",
} as const;

/** The `payer_idem` scope of this route: its own, never shared (#2103). */
const IDEMPOTENCY_SCOPE = "campus_drive_request";

/**
 * The in-flight 409's message. A wire contract like the purchase routes' (#2111): the client
 * re-reads its list on `reason: "in_flight"`, never re-posts. Do not reword it.
 */
const IN_FLIGHT_MESSAGE =
  "This drive request is already being sent; check your drive requests before trying again";

/** The PayerRoleGuard refusal, byte for byte, for the service's own role check. */
const ROLE_REFUSAL = "Payer role is not permitted for this resource";

/** A create body, normalised: what is stored and what a same-key repeat is compared against. */
interface NormalisedRequest {
  jobPostingId: string | null;
  branchIds: number[];
  preferredFrom: string;
  preferredTo: string;
  openings: number;
  rolesNote: string | null;
  contactName: string;
  contactPhone: string;
}

/** A 4xx in the house payer shape: `reason` beside `statusCode` / `error` / `message`. */
function refused(
  status: 400 | 403 | 409,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): BadRequestException | ForbiddenException | ConflictException {
  const body = {
    statusCode: status,
    error: status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Conflict",
    message,
    reason,
    ...extra,
  };
  if (status === 400) return new BadRequestException(body);
  if (status === 403) return new ForbiddenException(body);
  return new ConflictException(body);
}

/** Sorted and de-duplicated: the stored order is canonical, so a repeat compares equal. */
function canonical(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * The body as it would be stored: hidden characters removed, the branches canonical, the posting id
 * lower-cased. Pure; the only refusal is a contact name with nothing visible in it.
 */
function shape(dto: PayerCreateCampusDriveRequestDto): NormalisedRequest {
  const contactName = cleanDriveLine(dto.contact_name);
  if (contactName === undefined) {
    throw refused(400, DRIVE_REQUEST_REFUSAL_REASONS.contactNameEmpty, "contact_name is required");
  }
  return {
    jobPostingId: dto.job_posting_id?.toLowerCase() ?? null,
    branchIds: canonical(dto.branch_ids),
    preferredFrom: dto.preferred_from,
    preferredTo: dto.preferred_to,
    openings: dto.openings,
    // A note, like the review's: PR 5's cleaner (hidden characters out, newlines and ZWNJ / ZWJ in).
    rolesNote: cleanReviewReason(dto.roles_note) ?? null,
    contactName,
    contactPhone: dto.contact_phone,
  };
}

/**
 * #2746 PR 6 — A COMPANY ASKS RVM'S PLACEMENT TEAM FOR A CAMPUS DRIVE (`/payer/campus-drive-requests`).
 *
 * WHO. Employer accounts only: the routes carry `@PayerRoles("employer")` (the house 403 for an
 * agency), and this service re-checks the tenant's role. Every read and write is TENANT-SCOPED in
 * the query (ADR-0053; `PayerTenantScopeService.resolve`, once per request): a foreign or unknown id
 * is the house neutral 404. THE SWITCH GATES NEW REQUESTS ONLY (owner ruling R1, 14 Nov 2026):
 * while `campus_drive_requests` is not live for the company (pilot removal, global off), CREATE is
 * that same 404, and the company's list, read and cancel of requests it already made keep working
 * (R81: a switch gates capabilities, never stored state). Creating needs a VERIFIED employer
 * (`campus-drive-eligibility.ts`): otherwise 403 `company_not_verified` with `missing`.
 *
 * CREATE, IN ORDER: the body (zod, strict), the key (required), tenancy, the switch, the contact
 * name, then the Redis reservation. Under it, a key this company has already used answers FIRST
 * (the stored request, or 409 for a different body), so a retry the next day still gets its
 * request. Only a new request then meets the rest: the employer check (the tenant's role, account
 * status, verification and GSTIN: the four facts Campus's withdrawn rule reads), the dates (from ≥
 * today in India, to ≤ a year after it), the roles note (hidden characters removed; the note AND a
 * normalised copy screened for a hard identifier, the cleaned note stored), the
 * posting (the company's own, checked in the query), the branches (active options). Then ONE
 * transaction: the row (contact as AES ciphertext, `is_test` from `payers.is_test_account`) and
 * `campus_drive.requested` v1. A refused attempt writes no row, so the key stays free for a
 * corrected body.
 *
 * IDEMPOTENCY, TWO LAYERS. `RequestIdempotency` (Redis, the `payer_idem` / `campus_drive_request`
 * scope, keyed by the tenant) turns a duplicate in flight into the house 409 `in_flight` and
 * replays the first answer for its window; the stored outcome is ENCRYPTED (`secret`), because it
 * carries the contact. The LASTING guard is the table's unique `(payer_id, idempotency_key)`: the
 * insert is `ON CONFLICT DO NOTHING`, and a repeat reads the row the key made. The Redis key also
 * carries a hash of the normalised body, so the same key with a DIFFERENT body is never served the
 * first answer: it reaches the table, finds the key taken by another request, and is refused with
 * 409 `idempotency_key_reused` — inside the Redis window and after it alike.
 *
 * CANCEL from `requested` or `scheduled` (a scheduled drive may be called off: Campus reads the
 * cancellation in its feed; BadaBhai does not touch Campus's drive record). The row is locked
 * `FOR UPDATE` first, the lock Campus's decision takes too, so the two serialise. A repeat cancel
 * is 200 with the row unchanged and no event; a declined or completed request is 409
 * `drive_request_not_cancellable`.
 *
 * WHAT A COMPANY READS BACK: its request with the status, `scheduled_on`, `campus_drive_ref` and
 * the placement team's `decision_reason`; the contact only as the name and the phone's last four
 * digits (`null` once erased). LOGS AND EVENTS CARRY IDS, ENUMS AND DATES ONLY.
 */
@Injectable()
export class CampusDriveRequestsService {
  private readonly logger = new Logger(CampusDriveRequestsService.name);

  constructor(
    private readonly repo: CampusDriveRequestsRepository,
    private readonly options: PostingAudienceRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly idempotency: RequestIdempotency,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** `POST /payer/campus-drive-requests`. */
  async create(
    actorPayerId: string,
    dto: PayerCreateCampusDriveRequestDto,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<PayerCampusDriveRequestView> {
    const scope = await this.liveScope(actorPayerId);
    const request = shape(dto);
    const fingerprint = this.fingerprint(request);
    return this.idempotency.runOnce({
      namespace: "payer_idem",
      scope: IDEMPOTENCY_SCOPE,
      // The tenant, as the table's unique key is: two logins of one company share one key space.
      subject: scope.tenantKey,
      subjectLabel: "tenant",
      logLabel: "payer",
      idempotencyKey: `${idempotencyKey}:${fingerprint}`,
      // The stored answer carries the contact's name: encrypted at rest in Redis.
      secret: true,
      inFlight: (): never => {
        throw inFlightConflict(IN_FLIGHT_MESSAGE);
      },
      work: () => this.createOnce(scope, request, idempotencyKey, ctx),
    });
  }

  /** `GET /payer/campus-drive-requests`: the company's own, newest first. */
  async list(
    actorPayerId: string,
    query: PayerListCampusDriveRequestsQueryDto,
  ): Promise<PayerCampusDriveRequestPage> {
    const scope = await this.tenancy.resolve(actorPayerId);
    const rows = await this.repo.listOwn(scope.tenantKey, query.cursor, query.limit);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      drive_requests: page.map((row) => this.view(row)),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeDriveCursor("company", { at: last.createdKey, id: last.id })
          : null,
    };
  }

  /** `GET /payer/campus-drive-requests/:id`: one of the company's own; anything else is 404. */
  async getOne(actorPayerId: string, id: string): Promise<PayerCampusDriveRequestView> {
    const scope = await this.tenancy.resolve(actorPayerId);
    const row = await this.repo.findOwn(scope.tenantKey, id.toLowerCase());
    if (row === undefined) throw new NotFoundException();
    return this.view(row);
  }

  /** `POST /payer/campus-drive-requests/:id/cancel`. */
  async cancel(
    actorPayerId: string,
    id: string,
    ctx: RequestContext,
  ): Promise<PayerCampusDriveRequestView> {
    // No switch read: a company cancels a request it already made, live or not (owner ruling R1).
    const scope = await this.tenancy.resolve(actorPayerId);
    const requestId = id.toLowerCase();
    const row = await this.repo.withTransaction(async (tx) => {
      const held = await this.repo.lockOwn(tx, scope.tenantKey, requestId);
      if (held === undefined) throw new NotFoundException();
      if (held.status === "cancelled") return held;
      if (!DRIVE_CANCELLABLE_STATUSES.includes(held.status)) {
        throw refused(
          409,
          DRIVE_REQUEST_REFUSAL_REASONS.notCancellable,
          "This drive request is already closed",
          { status: held.status },
        );
      }
      const cancelled = await this.repo.markCancelled(tx, requestId);
      // Impossible under the row lock; refused, never half-done, if it ever happens.
      if (cancelled === undefined) throw new ServiceUnavailableException();
      const payload: PayloadInputOf<"campus_drive.cancelled"> = {
        campus_drive_request_id: requestId,
        payer_id: scope.tenantKey,
        previous_status: held.status as "requested" | "scheduled",
      };
      await this.events.emit({
        event_name: "campus_drive.cancelled",
        actor: { actor_type: "payer", actor_id: scope.actorPayerId },
        subject: { subject_type: "payer", subject_id: scope.tenantKey },
        payload,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
      this.logger.log(
        `campus drive request cancelled: id=${requestId} tenant=${scope.tenantKey} from=${held.status}`,
      );
      return cancelled;
    });
    return this.view(row);
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * The caller's tenant scope, or the house 404 while the switch is not live for the company. For
   * CREATE only (owner ruling R1): the switch gates a new request, never the ones already made.
   */
  private async liveScope(actorPayerId: string): Promise<PayerTenantScope> {
    const scope = await this.tenancy.resolve(actorPayerId);
    if (!(await this.rollout.isEnabledFor("campus_drive_requests", scope.tenantKey))) {
      throw new NotFoundException();
    }
    return scope;
  }

  /**
   * Every refusal of a NEW request, in order; returns the company's `is_test_account` for the row.
   * Not run for a repeat of a stored request, so a retry the next day, or after an admin changed the
   * company's record, still answers the request it made.
   */
  private async assertCreatable(
    scope: PayerTenantScope,
    request: NormalisedRequest,
  ): Promise<{ isTest: boolean }> {
    // The tenant's (the anchor's) standing: the four facts R2 reads, so no request is withdrawn
    // from birth (migration review L2). The role, then the account, then the verification.
    const facts = await this.repo.requesterFacts(scope.tenantKey);
    if (facts.role !== "employer") throw new ForbiddenException(ROLE_REFUSAL);
    if (facts.status !== "active") {
      this.logger.log(
        `campus drive request refused: tenant=${scope.tenantKey} account=${facts.status ?? "none"}`,
      );
      throw refused(
        403,
        DRIVE_REQUEST_REFUSAL_REASONS.notActive,
        "Only an active company account can ask for a campus drive",
      );
    }
    const standing = driveRequesterStanding(facts);
    if (!standing.eligible) {
      this.logger.log(
        `campus drive request refused: tenant=${scope.tenantKey} not verified (${standing.missing.join(",")})`,
      );
      throw refused(
        403,
        DRIVE_REQUEST_REFUSAL_REASONS.notVerified,
        "Only a verified company can ask for a campus drive",
        { missing: standing.missing },
      );
    }

    if (request.preferredFrom < indiaDay()) {
      throw refused(
        400,
        DRIVE_REQUEST_REFUSAL_REASONS.datesInPast,
        "preferred_from cannot be before today",
      );
    }

    if (request.preferredTo > latestDriveDay()) {
      throw refused(
        400,
        DRIVE_REQUEST_REFUSAL_REASONS.datesTooFar,
        "preferred_to cannot be more than a year after today",
      );
    }

    if (request.rolesNote !== null) {
      // BOTH the note as stored and its normalised copy are screened, and either refuses (security
      // review M1, re-check N1): the copy catches other scripts' digits and full-width characters,
      // the note what normalising could break up. The cleaned note is stored.
      const identifier =
        containsHardIdentifier(request.rolesNote) ??
        containsHardIdentifier(screeningCopyOf(request.rolesNote));
      if (identifier !== null) {
        // The class only (`phone`, `email`, …), never the text that matched.
        throw refused(
          400,
          DRIVE_REQUEST_REFUSAL_REASONS.rolesNoteIdentifier,
          "roles_note looks like it holds contact details or an ID; put the contact person in contact_name and contact_phone, and write a number range with words or commas (15,000 to 18,000), not as one long run of digits",
          { identifier },
        );
      }
    }

    const { jobPostingId, branchIds } = request;
    if (jobPostingId !== null && !(await this.repo.isOwnPosting(scope.tenantKey, jobPostingId))) {
      // The same 404 for a foreign and an unknown posting: no oracle.
      throw new NotFoundException();
    }

    if (branchIds.length > 0) {
      const active = await this.options.activeOptionRefs("branch", branchIds.map(String));
      const missing = branchIds.filter((id) => !active.has(String(id)));
      if (missing.length > 0) {
        // RVM location ids are reference data, never personal data: safe to name.
        throw refused(
          400,
          DRIVE_REQUEST_REFUSAL_REASONS.branchNotOffered,
          `branch_ids holds a branch that is not offered: ${missing.join(", ")}`,
        );
      }
    }

    return { isTest: facts.isTestAccount };
  }

  /**
   * A digest of the normalised body for the Redis key only, so a different body under the same key
   * is never served the first answer. Never stored, logged or sent: `RequestIdempotency` keys Redis
   * on a keyed HMAC of the whole key, this digest included.
   */
  private fingerprint(request: NormalisedRequest): string {
    return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex").slice(0, 32);
  }

  /**
   * A key this company already used answers with the request it made (or 409 for a different
   * body), before any check. Otherwise the checks, then the row and its event in one transaction;
   * a concurrent create under the same key loses the insert and answers the winner's row.
   */
  private async createOnce(
    scope: PayerTenantScope,
    request: NormalisedRequest,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<PayerCampusDriveRequestView> {
    const stored = await this.repo.findByIdempotencyKey(scope.tenantKey, idempotencyKey);
    if (stored !== undefined) return this.answerRepeat(scope, stored, request);

    const { isTest } = await this.assertCreatable(scope, request);
    const created = await this.repo.withTransaction(async (tx) => {
      const row = await this.repo.insert(tx, {
        payerId: scope.tenantKey,
        createdBy: scope.actorPayerId,
        jobPostingId: request.jobPostingId,
        branchIds: request.branchIds,
        preferredFrom: request.preferredFrom,
        preferredTo: request.preferredTo,
        openings: request.openings,
        rolesNote: request.rolesNote,
        contactNameEnc: this.pii.encrypt(request.contactName),
        contactPhoneEnc: this.pii.encrypt(request.contactPhone),
        isTest,
        idempotencyKey,
      });
      if (row === undefined) return undefined;
      const payload: PayloadInputOf<"campus_drive.requested"> = {
        campus_drive_request_id: row.id,
        payer_id: scope.tenantKey,
        job_posting_id: row.jobPostingId,
        branch_ids: [...row.branchIds],
        preferred_from: row.preferredFrom,
        preferred_to: row.preferredTo,
        openings: row.openings,
        has_roles_note: row.rolesNote !== null,
        is_test: row.isTest,
      };
      await this.events.emit({
        event_name: "campus_drive.requested",
        actor: { actor_type: "payer", actor_id: scope.actorPayerId },
        subject: { subject_type: "payer", subject_id: scope.tenantKey },
        payload,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
      return row;
    });

    if (created !== undefined) {
      this.logger.log(`campus drive request created: id=${created.id} tenant=${scope.tenantKey}`);
      return this.view(created);
    }

    // A concurrent create under the same key won the insert: answer with its row.
    const existing = await this.repo.findByIdempotencyKey(scope.tenantKey, idempotencyKey);
    // Gone between the conflict and this read (its company was deleted): nothing to answer with.
    if (existing === undefined) throw new ServiceUnavailableException();
    return this.answerRepeat(scope, existing, request);
  }

  /** A repeat under a stored key: the same request is the stored row, a different one a 409. */
  private answerRepeat(
    scope: PayerTenantScope,
    existing: DriveRequestRow,
    request: NormalisedRequest,
  ): PayerCampusDriveRequestView {
    if (!this.sameRequest(existing, request)) {
      this.logger.warn(
        `campus drive request refused: tenant=${scope.tenantKey} reused a key of request=${existing.id}`,
      );
      throw refused(
        409,
        DRIVE_REQUEST_REFUSAL_REASONS.keyReused,
        "This Idempotency-Key was already used for a different drive request",
      );
    }
    this.logger.log(`campus drive request replayed: id=${existing.id} tenant=${scope.tenantKey}`);
    return this.view(existing);
  }

  /** Is the stored row the request this body describes? An erased contact compares as unknown. */
  private sameRequest(row: DriveRequestRow, request: NormalisedRequest): boolean {
    const sameFields =
      row.jobPostingId === request.jobPostingId &&
      row.branchIds.length === request.branchIds.length &&
      canonical(row.branchIds).every((id, i) => id === request.branchIds[i]) &&
      row.preferredFrom === request.preferredFrom &&
      row.preferredTo === request.preferredTo &&
      row.openings === request.openings &&
      row.rolesNote === request.rolesNote;
    if (!sameFields) return false;
    if (row.contactNameEnc === null || row.contactPhoneEnc === null) return true;
    return (
      this.pii.decrypt(row.contactNameEnc) === request.contactName &&
      this.pii.decrypt(row.contactPhoneEnc) === request.contactPhone
    );
  }

  /** The company's read of one row: the contact as entered, phone to its last four digits. */
  private view(row: DriveRequestRow): PayerCampusDriveRequestView {
    const contact =
      row.contactNameEnc === null || row.contactPhoneEnc === null
        ? null
        : {
            name: this.pii.decrypt(row.contactNameEnc),
            phone_last4: this.pii.decrypt(row.contactPhoneEnc).slice(-4),
          };
    return {
      id: row.id,
      job_posting_id: row.jobPostingId,
      branch_ids: [...row.branchIds],
      preferred_from: row.preferredFrom,
      preferred_to: row.preferredTo,
      openings: row.openings,
      roles_note: row.rolesNote,
      contact,
      status: row.status,
      scheduled_on: row.scheduledOn,
      campus_drive_ref: row.campusDriveRef,
      decision_reason: row.decisionReason,
      decided_at: row.decidedAt?.toISOString() ?? null,
      cancelled_at: row.cancelledAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
