import { describe, expect, it } from "vitest";
import { EVENT_DOMAINS } from "./enums";
import { getEventDefinition } from "./registry";
import { validateEvent } from "./validate";

/**
 * #2746 PR 6 — the campus-drive request lifecycle: `campus_drive.requested`, `.decided` and
 * `.cancelled`, each v1. IDS, ENUMS AND DATES ONLY: the contact person, the roles note and the
 * placement team's reason never ride the spine, and every payload is strict, so a key carrying one
 * is refused rather than dropped.
 */

const REQUEST = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const COMPANY = "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10";
const POSTING = "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5";
const STAFF = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function envelope(eventName: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
    event_name: eventName,
    event_version: 1,
    occurred_at: "2026-11-14T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: COMPANY },
    subject: { subject_type: "payer", subject_id: COMPANY },
    source: "api",
    correlation_id: "1f0e0d0c-0b0a-4908-8706-050403020100",
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const REQUESTED = {
  campus_drive_request_id: REQUEST,
  payer_id: COMPANY,
  job_posting_id: POSTING,
  branch_ids: [1, 3],
  preferred_from: "2026-12-01",
  preferred_to: "2026-12-15",
  openings: 12,
  has_roles_note: true,
  is_test: false,
};

const DECIDED = {
  campus_drive_request_id: REQUEST,
  payer_id: COMPANY,
  decision: "scheduled",
  previous_status: "requested",
  decided_by_ref: STAFF,
  decided_at: "2026-11-20T09:00:00.000+05:30",
  scheduled_on: "2026-12-05",
  campus_drive_ref: "campus-drive:000417",
  has_reason: false,
};

const CANCELLED = {
  campus_drive_request_id: REQUEST,
  payer_id: COMPANY,
  previous_status: "scheduled",
};

describe("the campus_drive domain", () => {
  it("is a registered domain, and each event is v1 in it", () => {
    expect(EVENT_DOMAINS).toContain("campus_drive");
    for (const name of [
      "campus_drive.requested",
      "campus_drive.decided",
      "campus_drive.cancelled",
    ] as const) {
      const def = getEventDefinition(name);
      expect(def.version, name).toBe(1);
      expect(def.domain, name).toBe("campus_drive");
    }
  });
});

describe("campus_drive.requested v1", () => {
  const payload = getEventDefinition("campus_drive.requested").payload;

  it("accepts the ids-and-dates payload, with or without a posting and with any branch", () => {
    expect(validateEvent(envelope("campus_drive.requested", REQUESTED)).success).toBe(true);
    expect(payload.safeParse({ ...REQUESTED, job_posting_id: null, branch_ids: [] }).success).toBe(
      true,
    );
  });

  it.each([["contact_name"], ["contact_phone"], ["roles_note"], ["phone_last4"], ["org_name"]])(
    "refuses a %s key: the contact and the note never ride the spine",
    (key) => {
      expect(payload.safeParse({ ...REQUESTED, [key]: "x" }).success).toBe(false);
    },
  );

  it("refuses a datetime where a date belongs, a zero opening and an over-long branch list", () => {
    expect(
      payload.safeParse({ ...REQUESTED, preferred_from: "2026-12-01T00:00:00Z" }).success,
    ).toBe(false);
    expect(payload.safeParse({ ...REQUESTED, openings: 0 }).success).toBe(false);
    expect(payload.safeParse({ ...REQUESTED, openings: 1001 }).success).toBe(false);
    expect(
      payload.safeParse({ ...REQUESTED, branch_ids: Array.from({ length: 51 }, (_, i) => i + 1) })
        .success,
    ).toBe(false);
    expect(payload.safeParse({ ...REQUESTED, branch_ids: [0] }).success).toBe(false);
  });
});

describe("campus_drive.decided v1", () => {
  const payload = getEventDefinition("campus_drive.decided").payload;

  it("accepts a schedule, a reschedule, a decline and a completion", () => {
    expect(validateEvent(envelope("campus_drive.decided", DECIDED)).success).toBe(true);
    expect(payload.safeParse({ ...DECIDED, previous_status: "scheduled" }).success).toBe(true);
    expect(
      payload.safeParse({
        ...DECIDED,
        decision: "declined",
        scheduled_on: null,
        campus_drive_ref: null,
        has_reason: true,
      }).success,
    ).toBe(true);
    expect(
      payload.safeParse({ ...DECIDED, decision: "completed", previous_status: "scheduled" })
        .success,
    ).toBe(true);
  });

  it("refuses a decision out of a terminal state, and a decision that is not one", () => {
    for (const from of ["declined", "completed", "cancelled"]) {
      expect(payload.safeParse({ ...DECIDED, previous_status: from }).success, from).toBe(false);
    }
    for (const decision of ["requested", "cancelled", "approved"]) {
      expect(payload.safeParse({ ...DECIDED, decision }).success, decision).toBe(false);
    }
  });

  it("takes a layout-valid staff uuid only: never a name or an email", () => {
    expect(
      payload.safeParse({ ...DECIDED, decided_by_ref: "00000000-0000-0000-0000-000000000000" })
        .success,
    ).toBe(true);
    expect(payload.safeParse({ ...DECIDED, decided_by_ref: "asha@rvm.example" }).success).toBe(
      false,
    );
    expect(payload.safeParse({ ...DECIDED, decided_by_ref: STAFF.toUpperCase() }).success).toBe(
      false,
    );
  });

  it("keeps campus_drive_ref to Campus's id charset, so it cannot hold free text", () => {
    expect(payload.safeParse({ ...DECIDED, campus_drive_ref: "Drive for Asha" }).success).toBe(
      false,
    );
    expect(payload.safeParse({ ...DECIDED, campus_drive_ref: "x".repeat(201) }).success).toBe(
      false,
    );
  });

  it("refuses the reason text and a contact: ids, enums and dates only", () => {
    expect(payload.safeParse({ ...DECIDED, reason: "no slot this month" }).success).toBe(false);
    expect(payload.safeParse({ ...DECIDED, contact_phone: "+919876543210" }).success).toBe(false);
  });
});

describe("campus_drive.cancelled v1", () => {
  const payload = getEventDefinition("campus_drive.cancelled").payload;

  it("accepts a cancel from requested or scheduled, and nothing else", () => {
    expect(validateEvent(envelope("campus_drive.cancelled", CANCELLED)).success).toBe(true);
    expect(payload.safeParse({ ...CANCELLED, previous_status: "requested" }).success).toBe(true);
    for (const from of ["declined", "completed", "cancelled"]) {
      expect(payload.safeParse({ ...CANCELLED, previous_status: from }).success, from).toBe(false);
    }
  });

  it("is strict", () => {
    expect(payload.safeParse({ ...CANCELLED, reason: "no longer hiring" }).success).toBe(false);
  });
});
