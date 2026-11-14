import {
  BadRequestException,
  ConflictException,
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
import type { CampusCall } from "../campus-link/campus-call";
import { assertCampusTime } from "../campus-link/campus-clock";
import { cleanReviewReason } from "../campus-link/campus-review-reason";
import {
  CAMPUS_EARLIEST_DECISION_TIME,
  type CampusDriveDecisionBodySchema,
  type CampusDriveDecisionResponseSchema,
  type CampusDriveRequestPageSchema,
  type CampusDriveRequestSchema,
  type CampusDriveRequestsQuerySchema,
  type CampusErrorCode,
} from "../campus-link/campus-link.contract";
import { decodeDriveCursor, encodeDriveCursor } from "./campus-drive-cursor";
import { indiaDay, latestDriveDay } from "./campus-drive-dates";
import { driveCompanyWithdrawn } from "./campus-drive-eligibility";
import {
  CampusDriveRequestsRepository,
  type DriveCompanyColumns,
  type DriveFeedRow,
  type DriveRequestRow,
} from "./campus-drive-requests.repository";
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

const EARLIEST_MS = Date.parse(CAMPUS_EARLIEST_DECISION_TIME);

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

/** The standing columns as the shared withdrawn rule reads them. */
function withdrawn(row: DriveCompanyColumns): boolean {
  return driveCompanyWithdrawn({
    role: row.companyRole,
    status: row.companyStatus,
    verificationStatus: row.companyVerification,
    hasGstNumber: row.companyHasGst,
  });
}

/**
 * `changed_since` as the feed's SQL reads it: an instant before the earliest Campus time
 * (`CAMPUS_EARLIEST_DECISION_TIME`) is CLAMPED up to it, never refused, because a first sync may
 * send the epoch and nothing is older. A year-0000 time parses in JavaScript but fails Postgres's
 * `timestamptz` cast (22008), so it must never reach SQL as sent.
 */
function feedSince(changedSince: string | undefined): string | undefined {
  if (changedSince === undefined) return undefined;
  const at = Date.parse(changedSince);
  return Number.isFinite(at) && at >= EARLIEST_MS ? changedSince : CAMPUS_EARLIEST_DECISION_TIME;
}

/**
 * #2746 PR 6 — RVM'S PLACEMENT TEAM WORKS THE CAMPUS-DRIVE REQUESTS, from BadaBhai Campus. PULL,
 * NOT PUSH: Campus reads `GET drive-requests` and posts each decision back
 * (`POST drive-requests/:id/decision`), the same direction as the rest of the link; BadaBhai pushes
 * nothing. Mounted only behind `CampusServiceGuard` (its own token, address allow-list, per-minute
 * cap, audit row per call, and the neutral 404 while `CAMPUS_LINK_ENABLED` is off).
 *
 * NO ROLLOUT SWITCH HERE (owner ruling R1, 14 Nov 2026). `campus_drive_requests` gates a company
 * making a NEW request, and nothing else: once a request exists, Campus lists it and decides it
 * whatever the switch says (pilot removal, global off), and its cancellation and an erasure reach
 * the feed. That is R81: a switch gates capabilities, never stored state. So the feed skips
 * nothing, and the cursor never moves past a row Campus has not been shown. No tenancy read
 * either: a stored request names its company (`payer_id`), and nothing here writes tenancy.
 *
 * WITHDRAWN FROM CAMPUS (owner ruling R2). A company that would not pass the create check today
 * (verification withdrawn, GSTIN removed), or whose account an admin suspended or archived, is
 * WITHDRAWN (`driveCompanyWithdrawn`, read in the same statement as the request). Its requests stay
 * in the feed with status and dates only, flagged `company_withdrawn`: no contact and no roles
 * note. A decision on one is 409 `COMPANY_WITHDRAWN`, nothing stored. The full item comes back as
 * soon as the company is verified or reinstated: the standing is read live, and the feed's
 * `changed_at` follows the company record, so Campus pulls the request again either way.
 *
 * THE FEED discloses each listed request's CONTACT (name and phone, decrypted) and the company's
 * display name to RVM's placement team, which calls the company to arrange the drive: the purpose
 * the contact was collected for. Test companies' requests are listed with `is_test: true`.
 *
 * A DECISION: `decided_at` checked by the shared Campus clock rule (`assertCampusTime`: not before
 * `CAMPUS_EARLIEST_DECISION_TIME`, not more than `CAMPUS_MAX_CLOCK_SKEW_MS` ahead), and a
 * `scheduled_on` from today in India to a year ahead (400, before any read); the request row
 * `FOR UPDATE`; then withdrawn → 409 `COMPANY_WITHDRAWN`; then `judgeDriveDecision` (ordering by
 * `decided_at`, then the transitions, then a completion no earlier than the drive's date;
 * `campus-drive-transitions.ts`). A write stores Campus's `decided_at`, emits
 * `campus_drive.decided` v1 and writes the staff member's `audit_logs` row (actor = the
 * `decided_by_ref`, `CAMPUS_STAFF_ACTOR_TYPE`) in the same transaction. A replay writes nothing and
 * answers the held decision, only while it is still the request's current state (a request the
 * company cancelled since answers `DECISION_NOT_ALLOWED`). `DECISION_SUPERSEDED` and
 * `DECISION_NOT_ALLOWED` (with the `status`) store nothing. The company's cancel takes the same
 * row lock, so the two serialise.
 *
 * NO PENDING-ROW FLOOR, unlike the review (#2746 PR 5): a review row goes back to `pending` when the
 * company edits the posting, so a decision made before that reset must not land after it. A drive
 * request never goes back to `requested` and the company cannot edit it (only cancel it, which is
 * final), so there is no reset for a late decision to land behind; `requested` accepts any time
 * that passes the clock rule.
 *
 * The decision's `reason` is cleaned by PR 5's note cleaner (`cleanReviewReason`): hidden
 * characters removed, newlines and the Indic joiners ZWNJ / ZWJ kept.
 *
 * LOGS AND EVENTS CARRY IDS, ENUMS AND DATES: never the contact, the roles note or the reason.
 */
@Injectable()
export class CampusDriveDecisionsService {
  private readonly logger = new Logger(CampusDriveDecisionsService.name);

  constructor(
    private readonly repo: CampusDriveRequestsRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** `GET drive-requests`: every request, in change order. */
  async list(query: CampusDriveRequestsQuery): Promise<CampusDriveRequestPage> {
    let after: { at: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeDriveCursor("campus", query.cursor);
      if (decoded === null) throw campusInvalid("cursor", "cursor is malformed");
      after = decoded;
    }

    const rows = await this.repo.listFeed(
      { status: query.status, changedSince: feedSince(query.changed_since), after },
      query.limit,
    );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      drive_requests: page.map((row) => this.item(row)),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeDriveCursor("campus", { at: last.feedChangedKey, id: last.id })
          : null,
    };
  }

  /** `POST drive-requests/:id/decision`. */
  async decide(
    requestId: string,
    body: CampusDriveDecisionBody,
    call: CampusCall,
  ): Promise<CampusDriveDecisionResult> {
    // The body first: a time before the floor or from BadaBhai's future is 400, before any read.
    assertCampusTime("decided_at", body.decided_at);
    if (body.decision === "scheduled") assertDriveDay(body.scheduled_on);
    // A malformed id cannot name a request: the same 404 as an unknown one, before any read.
    if (!isCanonicalUuid(requestId)) throw neutralNotFound();

    const id = requestId.toLowerCase();
    const input: DriveDecisionInput = {
      decision: body.decision,
      decidedByRef: body.decided_by_ref.toLowerCase(),
      reason: cleanReviewReason(body.reason) ?? null,
      scheduledOn: body.decision === "scheduled" ? body.scheduled_on : null,
      campusDriveRef: body.decision === "scheduled" ? body.campus_drive_ref : null,
      decidedOn: indiaDay(new Date(body.decided_at)),
    };

    return this.repo.withTransaction(async (tx) => {
      const held = await this.repo.lockForDecision(tx, id, body.decided_at);
      if (held === undefined) throw neutralNotFound();
      if (withdrawn(held)) {
        this.logOutcome(id, input.decision, "company_withdrawn");
        throw campusConflict("COMPANY_WITHDRAWN", {
          message:
            "The company is not verified or its account is suspended or archived; this request cannot be decided until it is reinstated",
        });
      }

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
          throw campusConflict(
            "DECISION_NOT_ALLOWED",
            outcome.why === "before_scheduled_on"
              ? { status: held.status, message: "completed before the drive's scheduled_on" }
              : { status: held.status },
          );
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

  /** The event and the staff member's audit row, on the decision's transaction. */
  private async record(
    tx: Database,
    written: DriveRequestRow,
    previousStatus: "requested" | "scheduled",
    input: DriveDecisionInput,
    body: CampusDriveDecisionBody,
    call: CampusCall,
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

  /**
   * One feed item: the contact and the company name decrypted for the placement team. A withdrawn
   * company's request keeps its status and dates only: no contact, no roles note (owner ruling R2).
   */
  private item(row: DriveFeedRow): CampusDriveRequestItem {
    const companyWithdrawn = withdrawn(row);
    const contact =
      companyWithdrawn || row.contactNameEnc === null || row.contactPhoneEnc === null
        ? null
        : {
            name: this.pii.decrypt(row.contactNameEnc),
            phone: this.pii.decrypt(row.contactPhoneEnc),
          };
    return {
      id: row.id,
      company: { id: row.payerId, name: this.pii.decrypt(row.companyNameEnc).trim() },
      company_withdrawn: companyWithdrawn,
      job_posting_id: row.jobPostingId,
      branch_ids: [...row.branchIds],
      preferred_from: row.preferredFrom,
      preferred_to: row.preferredTo,
      openings: row.openings,
      roles_note: companyWithdrawn ? null : row.rolesNote,
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
      changed_at: row.feedChangedKey,
    };
  }

  /** Ids and enums only. */
  private logOutcome(id: string, decision: string, outcome: string): void {
    this.logger.log(`campus drive decision: request=${id} decision=${decision} outcome=${outcome}`);
  }
}

/**
 * SECURITY REVIEW L1 — a drive is scheduled for a day from today in India to a year ahead. A date
 * in the past cannot be a drive the company can still attend, and one years out is a typo; 400
 * `VALIDATION_FAILED` naming `scheduled_on`, before any read.
 */
function assertDriveDay(scheduledOn: string, now: Date = new Date()): void {
  const today = indiaDay(now);
  if (scheduledOn < today) throw campusInvalid("scheduled_on", "before today in India");
  if (scheduledOn > latestDriveDay(now)) {
    throw campusInvalid("scheduled_on", "more than a year after today in India");
  }
}
