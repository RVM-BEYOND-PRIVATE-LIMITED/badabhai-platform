import { describe, expect, it } from "vitest";

import { pendingUpdateFrom } from "./resume-pending-update";
import type { PendingChatUpdateFacts } from "./resume.repository";
import { resolveResumeSource } from "./resume-source";

/**
 * ADR-0043 — the two pure decisions behind the résumé history: which flow a résumé is labelled
 * with (ruling R1), and what an accepted chat update looks like while it is on its way.
 */
describe("resolveResumeSource — an accepted CV import wins over the road (ruling R1)", () => {
  const IMPORT = "66666666-6666-4666-8666-666666666666";

  it.each([
    // [road, import accepted, label]
    ["chat", IMPORT, "resume_upload"],
    ["form", IMPORT, "resume_upload"],
    [null, IMPORT, "resume_upload"],
    ["chat", null, "chat"],
    ["form", null, "form"],
    // A profile whose road was never recorded (pre-0107) shows NO label, never a guessed one.
    [null, null, null],
  ] as const)("road=%s import=%s → %s", (source, seededFromImportId, expected) => {
    expect(resolveResumeSource({ source, seededFromImportId })).toBe(expected);
  });
});

describe("pendingUpdateFrom — what the worker is told while their update is on its way", () => {
  const REQUESTED = new Date("2026-09-24T10:00:00.000Z");
  const TIMEOUT_MS = 20 * 60 * 1000;
  const facts = (over: Partial<PendingChatUpdateFacts> = {}): PendingChatUpdateFacts => ({
    sessionId: "s-1",
    requestedAt: REQUESTED,
    extractionStatus: "running",
    profileStatus: null,
    landed: false,
    ...over,
  });
  const at = (minutes: number) => new Date(REQUESTED.getTime() + minutes * 60 * 1000);

  it("nothing accepted → null", () => {
    expect(pendingUpdateFrom(null, at(1), TIMEOUT_MS)).toBeNull();
  });

  it("LANDED → null — the newest history entry is the answer, whatever the other facts say", () => {
    expect(
      pendingUpdateFrom(facts({ landed: true, extractionStatus: "failed" }), at(60), TIMEOUT_MS),
    ).toBeNull();
  });

  it("still running inside the window → in_progress, stamped with when the worker said Haan", () => {
    expect(pendingUpdateFrom(facts(), at(5), TIMEOUT_MS)).toEqual({
      requested_at: REQUESTED.toISOString(),
      status: "in_progress",
    });
  });

  it("no extraction job created yet is still in_progress — the flush may not have enqueued it", () => {
    expect(pendingUpdateFrom(facts({ extractionStatus: null }), at(1), TIMEOUT_MS)?.status).toBe(
      "in_progress",
    );
  });

  it("the extraction FAILED → failed, without waiting for the clock", () => {
    expect(
      pendingUpdateFrom(facts({ extractionStatus: "failed" }), at(1), TIMEOUT_MS)?.status,
    ).toBe("failed");
  });

  it("an EMPTY extraction (draft) → failed — it will never be confirmed into a résumé", () => {
    expect(
      pendingUpdateFrom(
        facts({ extractionStatus: "completed", profileStatus: "draft" }),
        at(1),
        TIMEOUT_MS,
      )?.status,
    ).toBe("failed");
  });

  it("past the deadline with nothing landed → failed — a generate that hit the cap leaves no row", () => {
    const stuck = facts({ extractionStatus: "completed", profileStatus: "confirmed" });
    expect(pendingUpdateFrom(stuck, at(19), TIMEOUT_MS)?.status).toBe("in_progress");
    expect(pendingUpdateFrom(stuck, at(21), TIMEOUT_MS)?.status).toBe("failed");
  });
});
