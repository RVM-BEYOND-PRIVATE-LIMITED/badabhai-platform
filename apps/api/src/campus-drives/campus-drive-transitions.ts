import type { CampusDriveRequestStatus } from "@badabhai/db";

/**
 * #2746 PR 6 — THE LIFE OF A CAMPUS-DRIVE REQUEST, as one pure decision. The repository reads the
 * row under `FOR UPDATE` (and the timing in SQL); this file says what a decision may do to it.
 *
 *     requested ──scheduled──► scheduled ──completed──► completed
 *         │                     │   ▲
 *         │                     │   └─scheduled (a reschedule: new date and/or drive id)
 *         ├──declined──► declined ◄──declined─┘
 *         └──cancel (company)──► cancelled ◄──cancel (company)── scheduled
 *
 * The placement team (Campus) moves `requested` → `scheduled` | `declined` and `scheduled` →
 * `scheduled` | `declined` | `completed`. The company cancels from `requested` or `scheduled`.
 * NOTHING LEAVES `declined`, `completed` OR `cancelled`: a decision there is 409
 * `DECISION_NOT_ALLOWED`, and so is `completed` straight from `requested` (a drive that was never
 * scheduled cannot have happened).
 *
 * THE NEWEST DECISION WINS, BY CAMPUS'S `decided_at` (the owner's rule for Campus decisions,
 * 2026-11-14), checked BEFORE the transition:
 *   1. older than the decision the row holds → 409 `DECISION_SUPERSEDED`, nothing stored;
 *   2. the same instant and the same decision (status, staff ref, reason, and for `scheduled` the
 *      date and drive id) while the row still holds that decision → a replay: 200 with the row as
 *      it is, nothing written, no event;
 *   3. the same instant with anything different → 409 `DECISION_SUPERSEDED`;
 *   4. newer (or the row holds no decision yet) → the transition rules above.
 * A row the company cancelled after a decision still holds that decision's time: an older decision
 * is SUPERSEDED, and any other is NOT ALLOWED (cancelled is final), so a late retry of the decision
 * the company cancelled answers a 409 that names the status.
 */

export type DriveDecision = "scheduled" | "declined" | "completed";

/** Who may move a request out of each status, and to what (Campus decisions only). */
export const DRIVE_DECISION_TRANSITIONS: Readonly<
  Record<CampusDriveRequestStatus, readonly DriveDecision[]>
> = {
  requested: ["scheduled", "declined"],
  scheduled: ["scheduled", "declined", "completed"],
  declined: [],
  completed: [],
  cancelled: [],
};

/** The statuses the company may cancel from. */
export const DRIVE_CANCELLABLE_STATUSES: readonly CampusDriveRequestStatus[] = [
  "requested",
  "scheduled",
];

/** The statuses that are a Campus decision (and so are what a replay compares against). */
const DECISION_STATUSES: readonly CampusDriveRequestStatus[] = [
  "scheduled",
  "declined",
  "completed",
];

/** The body's `decided_at` against the row's, as Postgres compared them (microsecond exact). */
export type DecisionTiming = "none" | "older" | "same" | "newer";

/** The row as locked: its status and the decision columns a replay is compared against. */
export interface HeldDriveRequest {
  status: CampusDriveRequestStatus;
  timing: DecisionTiming;
  decidedByRef: string | null;
  decisionReason: string | null;
  scheduledOn: string | null;
  campusDriveRef: string | null;
}

/** A decision as the service stores it: staff ref lower-cased, reason cleaned. */
export interface DriveDecisionInput {
  decision: DriveDecision;
  decidedByRef: string;
  reason: string | null;
  /** Set for `scheduled` only. */
  scheduledOn: string | null;
  /** Set for `scheduled` only. */
  campusDriveRef: string | null;
}

/** The decision columns a write stores, besides who and when. */
export interface DriveDecisionWrite {
  status: DriveDecision;
  previousStatus: "requested" | "scheduled";
  scheduledOn: string | null;
  campusDriveRef: string | null;
}

export type DriveDecisionOutcome =
  | { kind: "replay" }
  | { kind: "superseded" }
  | { kind: "not_allowed" }
  | { kind: "write"; write: DriveDecisionWrite };

/** What a decision does to the row it was locked with. Pure. */
export function judgeDriveDecision(
  held: HeldDriveRequest,
  input: DriveDecisionInput,
): DriveDecisionOutcome {
  if (held.timing === "older") return { kind: "superseded" };
  if (held.timing === "same" && DECISION_STATUSES.includes(held.status)) {
    return sameDecision(held, input) ? { kind: "replay" } : { kind: "superseded" };
  }
  if (!DRIVE_DECISION_TRANSITIONS[held.status].includes(input.decision)) {
    return { kind: "not_allowed" };
  }
  // Only `requested` and `scheduled` allow any decision (the table above).
  const previousStatus = held.status as "requested" | "scheduled";
  switch (input.decision) {
    case "scheduled":
      return {
        kind: "write",
        write: {
          status: "scheduled",
          previousStatus,
          scheduledOn: input.scheduledOn,
          campusDriveRef: input.campusDriveRef,
        },
      };
    case "declined":
      // The drive is not happening: no date and no drive id are shown for it any more. The
      // decision that set them is in its `campus_drive.decided` event.
      return {
        kind: "write",
        write: { status: "declined", previousStatus, scheduledOn: null, campusDriveRef: null },
      };
    case "completed":
      // Only from `scheduled`: the drive that happened keeps its date and Campus's id.
      return {
        kind: "write",
        write: {
          status: "completed",
          previousStatus,
          scheduledOn: held.scheduledOn,
          campusDriveRef: held.campusDriveRef,
        },
      };
  }
}

/** Does the row hold exactly this decision (the replay test)? */
function sameDecision(held: HeldDriveRequest, input: DriveDecisionInput): boolean {
  if (held.status !== input.decision) return false;
  if (held.decidedByRef !== input.decidedByRef || held.decisionReason !== input.reason) {
    return false;
  }
  return (
    input.decision !== "scheduled" ||
    (held.scheduledOn === input.scheduledOn && held.campusDriveRef === input.campusDriveRef)
  );
}
