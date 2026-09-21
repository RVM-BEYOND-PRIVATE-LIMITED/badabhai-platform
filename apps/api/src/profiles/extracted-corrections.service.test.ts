import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";

import { CorrectExtractedSchema } from "./extracted-corrections.dto";
import { ExtractedCorrectionsService } from "./extracted-corrections.service";
import { CORRECTABLE_FIELDS, MAX_CORRECTIONS_PER_PROFILE } from "./extracted-corrections.contract";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKER = "99999999-9999-4999-8999-999999999999";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ROW = "44444444-4444-4444-8444-444444444444";

const SKILLS_BODY = {
  profile_id: PROFILE,
  session_id: SESSION,
  corrections: [
    { field: "skills" as const, skill_ids: ["skill_fanuc", "skill_gdt_reading"] },
  ],
};

function make(over: Record<string, unknown> = {}) {
  const profiles = {
    findById: vi.fn(async () => ({ id: PROFILE, workerId: WORKER, source: "chat" })),
    setSkillLists: vi.fn(async () => undefined),
    setMachineLists: vi.fn(async () => undefined),
    setExperienceTotal: vi.fn(async () => undefined),
    ...((over.profiles ?? {}) as Record<string, unknown>),
  };
  const corrections = {
    insertCorrection: vi.fn(async () => ({ id: ROW })),
    countByProfile: vi.fn(async () => 18),
    ...((over.corrections ?? {}) as Record<string, unknown>),
  };
  const profileSkills = {
    replaceForProfile: vi.fn(async () => ({ skillsWritten: 2 })),
    ...((over.profileSkills ?? {}) as Record<string, unknown>),
  };
  const qualifications = {
    replaceForWorker: vi.fn(async () => ({
      worker_id: WORKER,
      certificate_count: 0,
      education_count: 1,
    })),
    ...((over.qualifications ?? {}) as Record<string, unknown>),
  };
  const workerSkills = {
    rebuildQuietly: vi.fn(async () => undefined),
    ...((over.workerSkills ?? {}) as Record<string, unknown>),
  };
  const chat = {
    findSession: vi.fn(async () => ({ id: SESSION, workerId: WORKER })),
    findPackPin: vi.fn(async () => ({ packId: "qp_universal", packVersion: 4 })),
    ...((over.chat ?? {}) as Record<string, unknown>),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const svc = new ExtractedCorrectionsService(
    profiles as never,
    corrections as never,
    profileSkills as never,
    qualifications as never,
    workerSkills as never,
    chat as never,
    events as never,
  );
  return { svc, profiles, corrections, profileSkills, qualifications, workerSkills, chat, events };
}

describe("ExtractedCorrectionsService — gates", () => {
  it("404s when the profile is missing or another worker's (no oracle)", async () => {
    for (const profile of [undefined, { id: PROFILE, workerId: OTHER_WORKER }]) {
      const { svc, corrections, events } = make({
        profiles: { findById: vi.fn(async () => profile) },
      });
      await expect(
        svc.correctExtracted({ worker_id: WORKER, ...SKILLS_BODY }, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(corrections.insertCorrection).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    }
  });

  it("404s when the session is missing or another worker's", async () => {
    for (const session of [undefined, { id: SESSION, workerId: OTHER_WORKER }]) {
      const { svc, corrections, events } = make({
        chat: { findSession: vi.fn(async () => session) },
      });
      await expect(
        svc.correctExtracted({ worker_id: WORKER, ...SKILLS_BODY }, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(corrections.insertCorrection).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    }
  });

  it("409s with the stable deferral reason when the session has no durable pin", async () => {
    const { svc, corrections, events, profileSkills } = make({
      chat: { findPackPin: vi.fn(async () => null) },
    });
    const err: Error = await svc
      .correctExtracted({ worker_id: WORKER, ...SKILLS_BODY }, CTX)
      .then(
        () => {
          throw new Error("expected rejection");
        },
        (e: Error) => e,
      );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain("no pack pin");
    // Deferred, never guessed: no audit row, no store write, no event.
    expect(corrections.insertCorrection).not.toHaveBeenCalled();
    expect(profileSkills.replaceForProfile).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("409s when the profile used its lifetime correction budget", async () => {
    const { svc, corrections, events } = make({
      corrections: { countByProfile: vi.fn(async () => MAX_CORRECTIONS_PER_PROFILE) },
    });
    const err: Error = await svc
      .correctExtracted({ worker_id: WORKER, ...SKILLS_BODY }, CTX)
      .then(
        () => {
          throw new Error("expected rejection");
        },
        (e: Error) => e,
      );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain("cap");
    expect(corrections.insertCorrection).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("ExtractedCorrectionsService — per-field delegation", () => {
  const base = { worker_id: WORKER, profile_id: PROFILE, session_id: SESSION };

  it("skills: authored rows (worker_confirmed, row id as evidence) + display columns + quiet rebuild + event", async () => {
    const { svc, corrections, profileSkills, profiles, workerSkills, events } = make();
    const res = await svc.correctExtracted(
      { ...base, ...SKILLS_BODY, corrections: SKILLS_BODY.corrections as never },
      CTX,
    );
    expect(corrections.insertCorrection).toHaveBeenCalledWith({
      profileId: PROFILE,
      sessionId: SESSION,
      field: "skills",
    });
    expect(profileSkills.replaceForProfile).toHaveBeenCalledWith(
      PROFILE,
      ["skill_fanuc", "skill_gdt_reading"],
      ROW,
    );
    expect(profiles.setSkillLists).toHaveBeenCalledWith(PROFILE, [
      "skill_fanuc",
      "skill_gdt_reading",
    ]);
    expect(workerSkills.rebuildQuietly).toHaveBeenCalledWith(WORKER, CTX);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "resume.edited",
        payload: {
          worker_id: WORKER,
          profile_id: PROFILE,
          correction_id: ROW,
          session_id: SESSION,
          field: "skills",
        },
        idempotencyKey: `resume.edited:${ROW}`,
      }),
    );
    // Counts only — never the corrected values.
    expect(res).toEqual({ profile_id: PROFILE, corrections_applied: 1, correction_count: 19 });
  });

  it("machines: display columns only (no authored relation exists)", async () => {
    const { svc, profiles, events } = make();
    await svc.correctExtracted(
      { ...base, corrections: [{ field: "machines", machine_ids: ["mach_cnc_lathe"] }] },
      CTX,
    );
    expect(profiles.setMachineLists).toHaveBeenCalledWith(PROFILE, ["mach_cnc_lathe"]);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: "resume.edited" }),
    );
  });

  it("experience: surgical total patch, sibling keys untouched by the service", async () => {
    const { svc, profiles } = make();
    await svc.correctExtracted(
      { ...base, corrections: [{ field: "experience", total_years: 8 }] },
      CTX,
    );
    expect(profiles.setExperienceTotal).toHaveBeenCalledWith(PROFILE, 8);
  });

  it("education/certificates: delegated to the existing qualifications writer, one list each", async () => {
    const { svc, qualifications } = make();
    const educations = [
      {
        credential: "iti",
        field: "Machinist",
        council: null,
        year: 2019,
        institute: "Govt ITI Pune",
      },
    ];
    await svc.correctExtracted({ ...base, corrections: [{ field: "education", educations }] }, CTX);
    expect(qualifications.replaceForWorker).toHaveBeenCalledWith(WORKER, { educations }, CTX);

    const certificates = [
      {
        name: "NCVT certificate",
        issuer: null,
        year: 2019,
        licence_number: null,
        licence_expiry: null,
      },
    ];
    await svc.correctExtracted(
      { ...base, corrections: [{ field: "certificates", certificates }] },
      CTX,
    );
    expect(qualifications.replaceForWorker).toHaveBeenCalledWith(WORKER, { certificates }, CTX);
  });

  it("applies several fields in one request, each audited and evented separately", async () => {
    const { svc, corrections, events } = make();
    const res = await svc.correctExtracted(
      {
        ...base,
        corrections: [
          { field: "machines", machine_ids: ["mach_cnc_lathe"] },
          { field: "experience", total_years: 8 },
        ],
      },
      CTX,
    );
    expect(corrections.insertCorrection).toHaveBeenCalledTimes(2);
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ corrections_applied: 2, correction_count: 20 });
  });
});

describe("CorrectExtractedSchema — the route contract", () => {
  const valid = {
    profile_id: PROFILE,
    session_id: SESSION,
    corrections: [{ field: "experience", total_years: 8 }],
  };

  it("accepts one correction per field, up to five", () => {
    expect(CorrectExtractedSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects repeat fields, empty lists, and oversized batches", () => {
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: [
          { field: "experience", total_years: 8 },
          { field: "experience", total_years: 9 },
        ],
      }).success,
    ).toBe(false);
    expect(CorrectExtractedSchema.safeParse({ ...valid, corrections: [] }).success).toBe(false);
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: Array.from({ length: 6 }, () => ({ field: "experience", total_years: 8 })),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown skill/machine ids (closed vocabulary, never free text)", () => {
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: [{ field: "skills", skill_ids: ["lathe work"] }],
      }).success,
    ).toBe(false);
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: [{ field: "machines", machine_ids: ["mach_not_a_machine"] }],
      }).success,
    ).toBe(false);
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: [{ field: "skills", skill_ids: [] }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer, negative and absurd totals", () => {
    for (const total_years of [-1, 61, 8.5]) {
      expect(
        CorrectExtractedSchema.safeParse({
          ...valid,
          corrections: [{ field: "experience", total_years }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields and bad uuids", () => {
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: [{ field: "salary", amount: 5 }],
      }).success,
    ).toBe(false);
    expect(CorrectExtractedSchema.safeParse({ ...valid, profile_id: "nope" }).success).toBe(false);
  });

  it("reuses the PUT entry schemas — a blank education entry fails here, not at the CHECK", () => {
    expect(
      CorrectExtractedSchema.safeParse({
        ...valid,
        corrections: [
          {
            field: "education",
            educations: [
              { credential: null, field: null, council: null, year: null, institute: null },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("contract constants", () => {
  it("documents the five correctable fields and the mirrored cap", () => {
    expect([...CORRECTABLE_FIELDS]).toEqual([
      "skills",
      "machines",
      "experience",
      "education",
      "certificates",
    ]);
    expect(MAX_CORRECTIONS_PER_PROFILE).toBe(20);
  });
});
