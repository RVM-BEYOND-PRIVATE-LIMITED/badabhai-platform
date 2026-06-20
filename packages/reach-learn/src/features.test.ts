import { describe, it, expect } from "vitest";
import type { JobSpec, WorkerSignals } from "@badabhai/reach-engine";
import {
  assertEventPiiFree,
  assertFeatureVectorClean,
  buildFeatureVector,
  FEATURE_ALLOWLIST,
} from "./features";
import { SIGNALS } from "./types";

const job: JobSpec = { jobId: "job-1", roleIds: ["role_a"], city: "pune" };
const worker: WorkerSignals = { workerId: "wkr-1", roleId: "role_a", city: "pune", experienceYears: 3 };

describe("PII boundary — fail closed (ADR-0017 Decision 2 / security gate)", () => {
  it("throws on a PII-shaped KEY in an event payload", () => {
    expect(() => assertEventPiiFree({ worker_id: "w", phone: "x" })).toThrow(/PII-shaped key/);
    expect(() => assertEventPiiFree({ full_name: "Asha" })).toThrow(/PII-shaped key/);
    expect(() => assertEventPiiFree({ employer: "Acme" })).toThrow(/PII-shaped key/);
    expect(() => assertEventPiiFree({ geo: { lat: 1, lng: 2 } })).toThrow(/PII-shaped key/);
  });

  it("throws on a PII-shaped VALUE (phone / email) even under an innocent key", () => {
    expect(() => assertEventPiiFree({ note: "+91 98765 43210" })).toThrow(/PII-shaped value/);
    expect(() => assertEventPiiFree({ ref: "asha@example.com" })).toThrow(/PII-shaped value/);
  });

  it("accepts a clean PII-free feed/application payload (ids + enums + signals)", () => {
    expect(() =>
      assertEventPiiFree({ worker_id: "w-1", job_id: "j-1", rank: 2, score: 0.8, hot: true }),
    ).not.toThrow();
    expect(() =>
      assertEventPiiFree({ worker_id: "w-1", job_id: "j-1", reason: "too_far" }),
    ).not.toThrow();
  });
});

describe("feature vector — fixed allowlist, no ids, no PII", () => {
  it("contains EXACTLY the six signal raws", () => {
    const vec = buildFeatureVector(job, worker);
    expect(Object.keys(vec).sort()).toEqual([...SIGNALS].sort());
    expect(FEATURE_ALLOWLIST).toEqual(SIGNALS);
    for (const s of SIGNALS) expect(typeof vec[s]).toBe("number");
  });

  it("rejects any non-allowlisted key (e.g. an id leaking in)", () => {
    expect(() =>
      assertFeatureVectorClean({ ...buildFeatureVector(job, worker), worker_id: "w-1" } as never),
    ).toThrow(/not in the allowlist/);
  });

  it("rejects a non-finite feature value", () => {
    expect(() => assertFeatureVectorClean({ ...buildFeatureVector(job, worker), role: NaN })).toThrow(
      /finite number/,
    );
  });
});
