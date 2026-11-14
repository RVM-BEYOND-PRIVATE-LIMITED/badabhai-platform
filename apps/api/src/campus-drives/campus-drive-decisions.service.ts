import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database } from "@badabhai/db";
import type { z } from "zod";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { isCanonicalUuid } from "../common/uuid";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type {
  CampusDriveDecisionBodySchema,
  CampusDriveDecisionResponseSchema,
  CampusDriveRequestPageSchema,
  CampusDriveRequestSchema,
  CampusDriveRequestsQuerySchema,
  CampusErrorCode,
} from "../campus-link/campus-link.contract";
import { decodeDriveCursor, encodeDriveCursor } from "./campus-drive-cursor";
import type { CampusDriveCall } from "./campus-drive-http";
import {
  CampusDriveRequestsRepository,
  type DriveFeedRow,
  type DriveRequestRow,
} from "./campus-drive-requests.repository";
import { cleanDriveText } from "./campus-drive-text";
import { judgeDriveDecision, type DriveDecisionInput } from "./campus-drive-transitions";

/** The parsed query of `GET drive-requests`. */
export type CampusDriveRequestsQuery = z.output<typeof CampusDriveRequestsQuerySchema>;
/** The parsed body of `POST drive-requests/:id/decision`. */
export type CampusDriveDecisionBody = z.output<typeof CampusDriveDecisionBodySchema>;
/** The answer to `GET drive-requests`. */
export type CampusDriveRequestPage = z.input<typeof CampusDriveRequestPageSchema>;
/** The answer to `POST drive-requests/:id/decision`. */
export type CampusDriveDecisionResult = z.input<typeof CampusDriveDecisionResponseSchema>;
type CampusDriveRequestItem = z.input<typeof CampusDriveRequestSchema>;

/**
 * How far ahead of BadaBhai's clock a Campus `decided_at` may be. Further ahead is 400
 * `VALIDATION_FAILED`: a time from the future would outrank every later decision. The same five
 * minutes as #2746 PR 5's `CAMPUS_MAX_CLOCK_SKEW_MS` (`campus-link.contract.ts`, not on this
 * branch's base): one of the two goes when the branches meet.
 */
export const DRIVE_DECISION_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The house neutral 404: nothing in it says whether the request exists. */
function neutralNotFound(): NotFoundException {
  return new NotFoundException();
}

/** A 409 with the Campus `error.code` (and anything else Campus needs to act on it). */
function campusConflict(code: CampusErrorCode, extra: Record<string, unknown> = {}) {
  return new ConflictException({ code, ...extra });
}

/** A 400 in the Campus validation shape, naming one field. */
function campusInvalid(path: string, message: string): BadRequestException {
  return new BadRequestException({
    code: "VALIDATION_FAILED" satisfies CampusErrorCode,
    message: "Validation failed",
    issues: [{ path, message }],
  });
}

/**
 * #2746 PR 6 — RVM'S PLACEMENT TEAM WORKS THE CAMPUS-DRIVE REQUESTS, from BadaBhai Campus. PULL,
 * NOT PUSH: Campus reads `GET drive-requests` and posts each decision back
 * (`POST drive-requests/:id/decision`), the same direction as the rest of the link; BadaBhai pushes
 * nothing. Mounted only behind `CampusServiceGuard` (its own token, address allow-list, per-minute
 * cap, audit row per call, and the neutral 404 while `CAMPUS_LINK_ENABLED` is off).
 *
 * THE SWITCH (capabilities only, R81). `campus_drive_requests` off everywhere → both routes are the
 * neutral 404 before any read (`isLiveForServiceCaller`). In `pilot` that check is true for every
 * company, so each request's OWNER is then checked with `isEnabledFor` and the owner's tenant key
 * (`PayerTenantScopeService.resolve`): the feed leaves out, and a decision 404s for, every company
 * not live — a company off the pilot list, or one tenancy refuses.
 *
 * THE FEED discloses each listed request's CONTACT (name and phone, decrypted) and the company's
 * display name to RVM's placement team, which calls the company to arrange the drive: the purpose
 * the contact was collected for. Test companies' requests are listed with `is_test: true`.
 *
 * A DECISION: `decided_at` within five minutes of BadaBhai's clock (400 otherwise, before any
 * read), the request row `FOR UPDATE`, then `judgeDriveDecision` (ordering by `decided_at`, then
 * the transitions; `campus-drive-transitions.ts`). A write stores Campus's `decided_at`, emits
 * `campus_drive.decided` v1 and writes the staff member's `audit_logs` row (actor = the
 * `decided_by_ref`, `campus_staff`) in the same transaction. A replay writes nothing and answers
 * the row as it is. `DECISION_SUPERSEDED` and `DECISION_NOT_ALLOWED` (with the `status`) store
 * nothing. The company's cancel takes the same row lock, so the two serialise.
 *
 * LOGS AND EVENTS CARRY IDS, ENUMS AND DATES: never the contact, the roles note or the reason.
 */
@Injectable()
export class CampusDriveDecisionsService {
  private readonly logger = new Logger(CampusDriveDecisionsService.name);

  constructor(
    private readonly repo: CampusDriveRequestsRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** `GET drive-requests`: every request of a company live on the switch, in change order. */
  async list(query: CampusDriveRequestsQuery): Promise<CampusDriveRequestPage> {
    if (!this.rollout.isLiveForServiceCaller("campus_drive_requests")) throw neutralNotFound();
    let after: { at: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeDriveCursor("campus", query.cursor);
      if (decoded === null) throw campusInvalid("cursor", "cursor is malformed");
      after = decoded;
    }

    const rows = await this.repo.listFeed(
      { status: query.status, changedSince: query.changed_since, after },
      query.limit,
    );
    const page = rows.slice(0, query.limit);
    const live = await this.liveOwners(page.map((row) => row.payerId));
    const last = page[page.length - 1];
    return {
      drive_requests: page.filter((row) => live.has(row.payerId)).map((row) => this.item(row)),
      // The cursor is the last row READ, listed or not, so a page of requests the switch leaves
      // out still moves Campus forward.
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeDriveCursor("campus", { at: last.changedKey, id: last.id })
          : null,
    };
  }

  /** `POST drive-requests/:id/decision`. */
  async decide(
    requestId: string,
    body: CampusDriveDecisionBody,
    call: CampusDriveCall,
  ): Promise<CampusDriveDecisionResult> {
    // The body first: a time from BadaBhai's future would outrank every later decision.
    const decidedAtMs = Date.parse(body.decided_at);
    if (
      !Number.isFinite(decidedAtMs) ||
      decidedAtMs - Date.now() > DRIVE_DECISION_MAX_CLOCK_SKEW_MS
    ) {
      throw campusInvalid(
        "decided_at",
        `more than ${DRIVE_DECISION_MAX_CLOCK_SKEW_MS / 60_000} minutes ahead of BadaBhai's clock`,
      );
    }
    // A malformed id cannot name a request: the same 404 as an unknown one, before any read.
    if (!isCanonicalUuid(requestId)) throw neutralNotFound();
    if (!this.rollout.isLiveForServiceCaller("campus_drive_requests")) throw neutralNotFound();

    const id = requestId.toLowerCase();
    const owner = await this.repo.findOwner(id);
    if (owner === undefined) throw neutralNotFound();
    // Before the transaction: the tenancy and pilot reads use their own connections, and a
    // transaction holding a pool connection while waiting for another can starve the pool.
    if (!(await this.liveForOwner(owner.payerId))) throw neutralNotFound();

    const input: DriveDecisionInput = {
      decision: body.decision,
      decidedByRef: body.decided_by_ref.toLowerCase(),
      reason: cleanDriveText(body.reason) ?? null,
      scheduledOn: body.decision === "scheduled" ? body.scheduled_on : null,
      campusDriveRef: body.decision === "scheduled" ? body.campus_drive_ref : null,
    };

    return this.repo.withTransaction(async (tx) => {
      const held = await this.repo.lockForDecision(tx, id, body.decided_at);
      // Gone since the pre-check (its company was deleted): the same 404.
      if (held === undefined || held.payerId !== owner.payerId) throw neutralNotFound();

      const outcome = judgeDriveDecision(held, input);
      switch (outcome.kind) {
        case "replay":
          this.logOutcome(id, input.decision, "unchanged");
          return this.answer(held, body.decided_at);
        case "superseded":
          this.logOutcome(id, input.decision, "superseded");
          throw campusConflict("DECISION_SUPERSEDED");
        case "not_allowed":
          this.logOutcome(id, input.decision, `not_allowed_from_${held.status}`);
          throw campusConflict("DECISION_NOT_ALLOWED", { status: held.status });
        case "write": {
          const written = await this.repo.writeDecision(tx, id, {
            ...outcome.write,
            decidedAt: body.decided_at,
            decidedByRef: input.decidedByRef,
            decisionReason: input.reason,
          });
          // Impossible under the row lock (the WHERE re-checks the status); refused, never half-done.
          if (written === undefined) {
            throw campusConflict("DECISION_NOT_ALLOWED", { status: held.status });
          }
          await this.record(tx, written, outcome.write.previousStatus, input, body, call);
          this.logOutcome(id, input.decision, "written");
          return this.answer(written, body.decided_at);
        }
      }
    });
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * Is `campus_drive_requests` live for this request's OWNER? The tenant key comes from
   * `PayerTenantScopeService`, exactly as a request by that company resolves it; a tenancy refusal
   * (`on` mode: an inactive org, a denial) fails closed as "not live".
   */
  private async liveForOwner(owner: string): Promise<boolean> {
    let tenantKey: TenantKey;
    try {
      tenantKey = (await this.tenancy.resolve(owner)).tenantKey;
    } catch (err) {
      if (!(err instanceof ForbiddenException)) throw err;
      this.logger.warn(
        `campus drive: owner tenancy refused (tenant=${owner}); treated as not live`,
      );
      return false;
    }
    return this.rollout.isEnabledFor("campus_drive_requests", tenantKey);
  }

  /** The owners in a page that are live, each company read once however many requests it has. */
  private async liveOwners(owners: readonly string[]): Promise<Set<string>> {
    const live = new Set<string>();
    for (const owner of new Set(owners)) {
      if (await this.liveForOwner(owner)) live.add(owner);
    }
    return live;
  }

  /** The event and the staff member's audit row, on the decision's transaction. */
  private async record(
    tx: Database,
    written: DriveRequestRow,
    previousStatus: "requested" | "scheduled",
    input: DriveDecisionInput,
    body: CampusDriveDecisionBody,
    call: CampusDriveCall,
  ): Promise<void> {
    const payload: PayloadInputOf<"campus_drive.decided"> = {
      campus_drive_request_id: written.id,
      payer_id: written.payerId,
      decision: input.decision,
      previous_status: previousStatus,
      decided_by_ref: input.decidedByRef,
      decided_at: body.decided_at,
      scheduled_on: written.scheduledOn,
      campus_drive_ref: written.campusDriveRef,
      has_reason: input.reason !== null,
    };
    const event = await this.events.emit({
      event_name: "campus_drive.decided",
      // Campus is a service caller, not a BadaBhai principal (#2752's and PR 5's events do the
      // same); the staff member is `decided_by_ref` in the payload and the audit row's actor.
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: written.payerId },
      payload,
      correlationId: call.ctx.correlationId,
      requestId: call.ctx.requestId,
      tx,
    });
    await this.repo.writeDecisionAudit(tx, {
      driveRequestId: written.id,
      decidedByRef: input.decidedByRef,
      metadata: {
        payer_id: written.payerId,
        decision: input.decision,
        previous_status: previousStatus,
        decided_at: body.decided_at,
        scheduled_on: written.scheduledOn,
        campus_drive_ref: written.campusDriveRef,
        has_reason: input.reason !== null,
        campus_call_id: call.callId,
        event_id: event.event_id,
      },
    });
  }

  /** The decision's answer: the row as it now stands, and the decision time Campus sent. */
  private answer(row: DriveRequestRow, decidedAt: string): CampusDriveDecisionResult {
    return {
      drive_request_id: row.id,
      status: row.status,
      scheduled_on: row.scheduledOn,
      campus_drive_ref: row.campusDriveRef,
      decided_at: decidedAt,
      changed_at: row.changedKey,
    };
  }

  /** One feed item: the contact and the company name decrypted for the placement team. */
  private item(row: DriveFeedRow): CampusDriveRequestItem {
    const contact =
      row.contactNameEnc === null || row.contactPhoneEnc === null
        ? null
        : {
            name: this.pii.decrypt(row.contactNameEnc),
            phone: this.pii.decrypt(row.contactPhoneEnc),
          };
    return {
      id: row.id,
      company: { id: row.payerId, name: this.pii.decrypt(row.companyNameEnc).trim() },
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
      decided_at: row.decidedKey,
      decided_by_ref: row.decidedByRef,
      reason: row.decisionReason,
      is_test: row.isTest,
      requested_at: row.createdKey,
      cancelled_at: row.cancelledKey,
      changed_at: row.changedKey,
    };
  }

  /** Ids and enums only. */
  private logOutcome(id: string, decision: string, outcome: string): void {
    this.logger.log(`campus drive decision: request=${id} decision=${decision} outcome=${outcome}`);
  }
}
