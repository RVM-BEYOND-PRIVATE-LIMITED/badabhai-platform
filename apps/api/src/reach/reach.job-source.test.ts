import { describe, it, expect, afterEach } from "vitest";
import { uuidSchema } from "@badabhai/validators";
import {
  StubJobSource,
  createStubJobSourceOrThrow,
  type JobSource,
} from "./reach.job-source";

describe("StubJobSource fixtures", () => {
  const source: JobSource = new StubJobSource();

  it("every fixture jobId parses as a UUID (guards the feed.shown.job_id contract, D6)", async () => {
    const jobs = await source.listOpenJobSpecs();
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      // feed.shown.job_id validates as uuidSchema — a non-UUID stub id would throw
      // at createEvent. Each fixture id MUST pass.
      expect(uuidSchema.safeParse(j.jobId).success).toBe(true);
    }
  });

  it("getJobSpec returns the matching fixture, null for an unknown id", async () => {
    const jobs = await source.listOpenJobSpecs();
    const first = jobs[0]!;
    const found = await source.getJobSpec(first.jobId);
    expect(found?.jobId).toBe(first.jobId);
    expect(await source.getJobSpec("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("fixtures carry ONLY JobSpec fields — no employer name/contact (faceless)", async () => {
    const jobs = await source.listOpenJobSpecs();
    const allowed = new Set([
      "jobId",
      "roleIds",
      "location",
      "city",
      "maxTravelKm",
      "minExperienceYears",
      "maxExperienceYears",
      "payMin",
      "payMax",
      "neededBy",
    ]);
    for (const j of jobs) {
      for (const key of Object.keys(j)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it("returns defensive copies (callers can't mutate the shared fixtures)", async () => {
    const a = await source.listOpenJobSpecs();
    a[0]!.roleIds.push("tampered");
    const b = await source.listOpenJobSpecs();
    expect(b[0]!.roleIds).not.toContain("tampered");
  });
});

describe("createStubJobSourceOrThrow — D6 production gate", () => {
  const prev = process.env.NODE_ENV;

  // Restore NODE_ENV after each case so env never leaks into other tests.
  afterEach(() => {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  });

  it("builds the stub in development/test (dev shortcut allowed)", () => {
    process.env.NODE_ENV = "test";
    expect(createStubJobSourceOrThrow()).toBeInstanceOf(StubJobSource);
  });

  it("THROWS in production — the stub must never silently serve fixtures", () => {
    process.env.NODE_ENV = "production";
    expect(() => createStubJobSourceOrThrow()).toThrow();
  });

  it("THROWS when NODE_ENV is unset (fail-closed via isDevEnv)", () => {
    delete process.env.NODE_ENV;
    expect(() => createStubJobSourceOrThrow()).toThrow();
  });
});
