import { describe, expect, it } from "vitest";
import { ErasureAuditBuilder } from "./erasure-audit";

/**
 * The rules that decide whether a DSAR erasure SUCCEEDED, tested without a bucket, a database or
 * a Redis — because "was the worker's data actually destroyed" is the one question this record
 * exists to answer, and it should not need an integration harness to check.
 */
describe("ErasureAuditBuilder — the verdict is fail-closed", () => {
  it("an empty erasure is nothing_to_delete, not deleted", () => {
    const audit = new ErasureAuditBuilder().build();
    expect(audit.outcome).toBe("nothing_to_delete");
    expect(audit.objects_deleted).toBe(0);
  });

  it("a sweep that removed something is `deleted`", () => {
    const b = new ErasureAuditBuilder();
    b.swept("voice_prefix", "voice-notes/w/", 1, 3);
    expect(b.build()).toMatchObject({ outcome: "deleted", objects_deleted: 3, objects_failed: 0 });
  });

  it("a sweep that found nothing is NOT a failure — an empty bucket is a legitimate result", () => {
    const b = new ErasureAuditBuilder();
    b.swept("voice_prefix", "voice-notes/w/", 1, 0);
    expect(b.build()).toMatchObject({ outcome: "nothing_to_delete", objects_failed: 0 });
  });

  it("ONE failed leg outranks every success beneath it", () => {
    // The whole reason the verdict is derived rather than accumulated: an erasure with a dead
    // bucket is not a successful erasure with a footnote. The worker's audio may still exist.
    const b = new ErasureAuditBuilder();
    b.swept("resume_objects", "by-row", 2, 2);
    b.swept("conversation_prefix", "w/", 1, 5);
    b.failed("voice_prefix", "voice-notes/w/", 1);
    const audit = b.build();
    expect(audit.outcome).toBe("failed");
    // …and the successes are still counted. Reporting 0 deleted would be its own dishonesty.
    expect(audit.objects_deleted).toBe(7);
    expect(audit.objects_failed).toBe(1);
  });

  it("counts what a failing leg managed BEFORE it failed", () => {
    // The per-row loops delete one object at a time and continue past an error, so a leg can be
    // both partly successful and failed. Reporting only the failure would understate the erasure.
    const b = new ErasureAuditBuilder();
    b.failed("resume_objects", "by-row", 3, 2);
    expect(b.build()).toMatchObject({ outcome: "failed", objects_deleted: 2, objects_failed: 1 });
  });

  it("a SKIPPED leg does not make an erasure incomplete, and does not fake a sweep", () => {
    // An unconfigured bucket holds nothing to erase, so it is not a gap — but the record must
    // still distinguish it from a sweep that ran and found nothing.
    const b = new ErasureAuditBuilder();
    b.skipped("voice_prefix", "voice-notes/w/");
    const audit = b.build();
    expect(audit.outcome).toBe("nothing_to_delete");
    expect(audit.objects_failed).toBe(0);
    expect(audit.legs[0]).toMatchObject({ outcome: "skipped", attempted: 0, deleted: 0 });
  });

  it("keeps the legs in the order they ran, so the record reads as a sequence", () => {
    const b = new ErasureAuditBuilder();
    b.swept("resume_objects", "by-row", 1, 1);
    b.skipped("voice_objects", "by-row");
    b.failed("conversation_prefix", "w/", 1);
    expect(b.build().legs.map((l) => l.leg)).toEqual([
      "resume_objects",
      "voice_objects",
      "conversation_prefix",
    ]);
  });
});
