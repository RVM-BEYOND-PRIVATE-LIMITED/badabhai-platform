import { describe, it, expect } from "vitest";
import type { JobPosting } from "@badabhai/db";
import { uuidSchema } from "@badabhai/validators";
import {
  JobPostingsJobSource,
  canonicalizeRoleTitle,
  mapPostingToJobSpec,
} from "./reach.job-postings-source";
import type { JobPostingsRepository } from "../job-postings/job-postings.repository";

/** Minimal posting row factory (real-shaped; PII-free free text). */
function posting(over: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    createdBy: "11111111-1111-4111-8111-111111111111",
    orgLabel: "Acme Tools (org label — NON-PII)",
    roleTitle: "VMC Operator",
    locationLabel: "Pune",
    description: "Day shift, immediate need.",
    vacancyBand: "2-5",
    status: "open",
    createdAt: new Date("2026-06-17T00:00:00Z"),
    updatedAt: new Date("2026-06-17T00:00:00Z"),
    closedAt: null,
    ...over,
  } as JobPosting;
}

/** A fake repo exposing only the two reads the source uses. */
function fakeRepo(rows: JobPosting[]): JobPostingsRepository {
  return {
    findById: async (id: string) => rows.find((r) => r.id === id),
    list: async (status?: string) =>
      status ? rows.filter((r) => r.status === status) : rows,
  } as unknown as JobPostingsRepository;
}

describe("canonicalizeRoleTitle", () => {
  it("maps a known role NAME to its canonical taxonomy id", () => {
    expect(canonicalizeRoleTitle("VMC Operator")).toEqual(["role_vmc_operator"]);
    expect(canonicalizeRoleTitle("CNC Programmer")).toEqual(["role_cnc_programmer"]);
  });

  it("is tolerant of case / punctuation / spacing", () => {
    expect(canonicalizeRoleTitle("  vmc   operator ")).toEqual(["role_vmc_operator"]);
    expect(canonicalizeRoleTitle("CNC-Programmer")).toEqual(["role_cnc_programmer"]);
  });

  it("accepts the canonical id itself", () => {
    expect(canonicalizeRoleTitle("role_vmc_operator")).toEqual(["role_vmc_operator"]);
  });

  it("returns [] for an unknown title (honest unknown — never fabricates a role)", () => {
    expect(canonicalizeRoleTitle("Welder")).toEqual([]);
    expect(canonicalizeRoleTitle("")).toEqual([]);
    expect(canonicalizeRoleTitle(null)).toEqual([]);
  });
});

describe("mapPostingToJobSpec", () => {
  it("maps id + canonical role + city, lowercasing the city slug", () => {
    const spec = mapPostingToJobSpec(posting({ locationLabel: "Pune" }));
    expect(spec.jobId).toBe("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(spec.roleIds).toEqual(["role_vmc_operator"]);
    expect(spec.city).toBe("pune");
  });

  it("omits city when locationLabel is blank/null", () => {
    expect(mapPostingToJobSpec(posting({ locationLabel: null })).city).toBeUndefined();
    expect(mapPostingToJobSpec(posting({ locationLabel: "   " })).city).toBeUndefined();
  });

  it("is FACELESS — emits ONLY JobSpec fields, never orgLabel/description/createdBy", () => {
    const spec = mapPostingToJobSpec(posting());
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
    for (const key of Object.keys(spec)) expect(allowed.has(key)).toBe(true);
  });

  it("jobId satisfies the feed.shown.job_id UUID contract (D6)", () => {
    expect(uuidSchema.safeParse(mapPostingToJobSpec(posting()).jobId).success).toBe(true);
  });
});

describe("JobPostingsJobSource", () => {
  it("getJobSpec returns the mapped spec for an existing draft/open posting", async () => {
    const src = new JobPostingsJobSource(
      fakeRepo([posting({ status: "open" }), posting({ id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", status: "draft" })]),
    );
    expect((await src.getJobSpec("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"))?.jobId).toBe(
      "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    );
    // draft is servable (ops can review before flipping open)
    expect(await src.getJobSpec("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e")).not.toBeNull();
  });

  it("getJobSpec returns null for an unknown id AND for a closed posting", async () => {
    const src = new JobPostingsJobSource(
      fakeRepo([posting({ status: "closed" })]),
    );
    expect(await src.getJobSpec("ffffffff-ffff-4fff-8fff-ffffffffffff")).toBeNull();
    expect(await src.getJobSpec("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).toBeNull();
  });

  it("listOpenJobSpecs maps only open postings", async () => {
    const src = new JobPostingsJobSource(
      fakeRepo([
        posting({ id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", status: "open" }),
        posting({ id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", status: "draft" }),
        posting({ id: "2c3d4e5f-6a7b-4c8d-89e0-1f2a3b4c5d6e", status: "closed" }),
      ]),
    );
    const open = await src.listOpenJobSpecs();
    expect(open.map((s) => s.jobId)).toEqual(["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"]);
  });
});
