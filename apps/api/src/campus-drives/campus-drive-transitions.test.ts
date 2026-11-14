import { describe, expect, it } from "vitest";
import { CAMPUS_DRIVE_REQUEST_STATUSES } from "@badabhai/db";
import {
  DRIVE_CANCELLABLE_STATUSES,
  DRIVE_DECISION_TRANSITIONS,
  judgeDriveDecision,
  type DriveDecision,
  type DriveDecisionInput,
  type HeldDriveRequest,
} from "./campus-drive-transitions";

const STAFF = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER_STAFF = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function held(over: Partial<HeldDriveRequest> = {}): HeldDriveRequest {
  return {
    status: "requested",
    timing: "none",
    decidedByRef: null,
    decisionReason: null,
    scheduledOn: null,
    campusDriveRef: null,
    ...over,
  };
}

function input(
  decision: DriveDecision,
  over: Partial<DriveDecisionInput> = {},
): DriveDecisionInput {
  return {
    decision,
    decidedByRef: STAFF,
    reason: null,
    scheduledOn: decision === "scheduled" ? "2026-12-05" : null,
    campusDriveRef: decision === "scheduled" ? "campus-drive:000417" : null,
    ...over,
  };
}

/** The whole matrix: every status × every decision, with a newer decision time. */
const EXPECTED: Record<string, Record<DriveDecision, "write" | "not_allowed">> = {
  requested: { scheduled: "write", declined: "write", completed: "not_allowed" },
  scheduled: { scheduled: "write", declined: "write", completed: "write" },
  declined: { scheduled: "not_allowed", declined: "not_allowed", completed: "not_allowed" },
  completed: { scheduled: "not_allowed", declined: "not_allowed", completed: "not_allowed" },
  cancelled: { scheduled: "not_allowed", declined: "not_allowed", completed: "not_allowed" },
};

describe("the transition table", () => {
  it("covers every status the table's CHECK allows", () => {
    expect(Object.keys(DRIVE_DECISION_TRANSITIONS).sort()).toEqual(
      [...CAMPUS_DRIVE_REQUEST_STATUSES].sort(),
    );
    expect(Object.keys(EXPECTED).sort()).toEqual([...CAMPUS_DRIVE_REQUEST_STATUSES].sort());
  });

  for (const status of CAMPUS_DRIVE_REQUEST_STATUSES) {
    for (const decision of ["scheduled", "declined", "completed"] as const) {
      it(`${status} → ${decision}: ${EXPECTED[status]![decision]}`, () => {
        const timing = status === "requested" ? "none" : "newer";
        const scheduledOn = status === "scheduled" || status === "completed" ? "2026-12-01" : null;
        const outcome = judgeDriveDecision(
          held({ status, timing, scheduledOn, campusDriveRef: scheduledOn && "drive:1" }),
          input(decision),
        );
        expect(outcome.kind).toBe(EXPECTED[status]![decision]);
      });
    }
  }

  it("the company cancels from requested and scheduled only", () => {
    expect([...DRIVE_CANCELLABLE_STATUSES].sort()).toEqual(["requested", "scheduled"]);
  });
});

describe("what a write stores", () => {
  it("scheduled stores the new date and Campus's drive id; a reschedule replaces them", () => {
    expect(judgeDriveDecision(held(), input("scheduled"))).toEqual({
      kind: "write",
      write: {
        status: "scheduled",
        previousStatus: "requested",
        scheduledOn: "2026-12-05",
        campusDriveRef: "campus-drive:000417",
      },
    });
    const rescheduled = judgeDriveDecision(
      held({
        status: "scheduled",
        timing: "newer",
        scheduledOn: "2026-12-01",
        campusDriveRef: "d:1",
      }),
      input("scheduled", { scheduledOn: "2026-12-09", campusDriveRef: "d:2" }),
    );
    expect(rescheduled).toEqual({
      kind: "write",
      write: {
        status: "scheduled",
        previousStatus: "scheduled",
        scheduledOn: "2026-12-09",
        campusDriveRef: "d:2",
      },
    });
  });

  it("declined clears the date and the drive id; completed keeps them", () => {
    const scheduled = held({
      status: "scheduled",
      timing: "newer",
      scheduledOn: "2026-12-05",
      campusDriveRef: "campus-drive:000417",
    });
    expect(judgeDriveDecision(scheduled, input("declined"))).toEqual({
      kind: "write",
      write: {
        status: "declined",
        previousStatus: "scheduled",
        scheduledOn: null,
        campusDriveRef: null,
      },
    });
    expect(judgeDriveDecision(scheduled, input("completed"))).toEqual({
      kind: "write",
      write: {
        status: "completed",
        previousStatus: "scheduled",
        scheduledOn: "2026-12-05",
        campusDriveRef: "campus-drive:000417",
      },
    });
  });
});

describe("the newest decision wins (decided_at)", () => {
  const scheduled = held({
    status: "scheduled",
    timing: "same",
    decidedByRef: STAFF,
    decisionReason: null,
    scheduledOn: "2026-12-05",
    campusDriveRef: "campus-drive:000417",
  });

  it("an OLDER decision is superseded, whatever it says and whatever the status", () => {
    for (const status of CAMPUS_DRIVE_REQUEST_STATUSES) {
      for (const decision of ["scheduled", "declined", "completed"] as const) {
        expect(
          judgeDriveDecision(held({ status, timing: "older" }), input(decision)).kind,
          `${status} ${decision}`,
        ).toBe("superseded");
      }
    }
  });

  it("the SAME decision at the same instant is a replay", () => {
    expect(judgeDriveDecision(scheduled, input("scheduled"))).toEqual({ kind: "replay" });
    const declined = held({
      status: "declined",
      timing: "same",
      decidedByRef: STAFF,
      decisionReason: "full",
    });
    expect(judgeDriveDecision(declined, input("declined", { reason: "full" }))).toEqual({
      kind: "replay",
    });
  });

  it("the same instant with ANY field different is superseded", () => {
    for (const changed of [
      input("declined"),
      input("scheduled", { scheduledOn: "2026-12-06" }),
      input("scheduled", { campusDriveRef: "campus-drive:000418" }),
      input("scheduled", { decidedByRef: OTHER_STAFF }),
      input("scheduled", { reason: "moved to the morning" }),
    ]) {
      expect(judgeDriveDecision(scheduled, changed).kind).toBe("superseded");
    }
  });

  it("a request the company cancelled after a decision: older is superseded, any other not allowed", () => {
    const cancelled = { ...scheduled, status: "cancelled" as const };
    expect(judgeDriveDecision({ ...cancelled, timing: "older" }, input("scheduled")).kind).toBe(
      "superseded",
    );
    // A late retry of the very decision the company cancelled names the status, not a replay.
    expect(judgeDriveDecision(cancelled, input("scheduled")).kind).toBe("not_allowed");
    expect(judgeDriveDecision({ ...cancelled, timing: "newer" }, input("declined")).kind).toBe(
      "not_allowed",
    );
  });

  it("a request with no decision yet accepts any time", () => {
    expect(judgeDriveDecision(held({ timing: "none" }), input("scheduled")).kind).toBe("write");
  });
});
