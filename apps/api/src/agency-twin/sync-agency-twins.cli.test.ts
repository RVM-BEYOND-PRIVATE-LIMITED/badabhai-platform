import { describe, expect, it } from "vitest";
import { parseSyncAgencyTwinsArgs } from "./sync-agency-twins.cli";

/** The CLI refuses to guess the target's deploy state (ADR-0050 §5 trigger 3). */
describe("sync-agency-twins CLI — argument contract", () => {
  const BASE = ["--match-v1=on", "--agency-twin-sync=on"];

  it("is a dry run unless --apply is given", () => {
    expect(parseSyncAgencyTwinsArgs(BASE)).toMatchObject({
      apply: false,
      matchV1Enabled: true,
      armed: true,
      job: null,
    });
    expect(parseSyncAgencyTwinsArgs([...BASE, "--apply"]).apply).toBe(true);
  });

  it("requires BOTH deploy-state flags, as on|off only", () => {
    expect(() => parseSyncAgencyTwinsArgs(["--match-v1=on"])).toThrow(/agency-twin-sync/);
    expect(() => parseSyncAgencyTwinsArgs(["--agency-twin-sync=on"])).toThrow(/match-v1/);
    expect(() => parseSyncAgencyTwinsArgs(["--match-v1=true", "--agency-twin-sync=on"])).toThrow();
    expect(parseSyncAgencyTwinsArgs(["--match-v1=off", "--agency-twin-sync=off"])).toMatchObject({
      matchV1Enabled: false,
      armed: false,
    });
  });

  it("refuses an unknown flag, a positional, a non-uuid --job and a bad batch size", () => {
    expect(() => parseSyncAgencyTwinsArgs([...BASE, "--force"])).toThrow();
    expect(() => parseSyncAgencyTwinsArgs([...BASE, "stray"])).toThrow();
    expect(() => parseSyncAgencyTwinsArgs([...BASE, "--job=abc"])).toThrow(/uuid/);
    expect(() => parseSyncAgencyTwinsArgs([...BASE, "--batch-size=0"])).toThrow(/batch-size/);
  });

  it("accepts the shared production-write acknowledgement flag (the ops guard reads it)", () => {
    expect(() =>
      parseSyncAgencyTwinsArgs([...BASE, "--apply", "--i-am-authorised-to-write-to-production"]),
    ).not.toThrow();
  });
});
