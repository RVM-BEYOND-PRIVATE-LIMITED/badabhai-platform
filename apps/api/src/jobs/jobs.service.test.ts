import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { JobsService } from "./jobs.service";
import type { JobsRepository, WorkerVisibleJobRow } from "./jobs.repository";

const JOB_ID = "22222222-2222-4222-8222-222222222222";

/** A fully-populated worker-visible row (every SHOW field carries a value). */
const FULL_ROW: WorkerVisibleJobRow = {
  id: JOB_ID,
  tradeKey: "cnc_operator",
  title: "CNC Operator — Night Shift",
  city: "Pune",
  area: "Pimpri-Chinchwad",
  payMin: 18000,
  payMax: 25000,
  minExperienceYears: 2,
  maxExperienceYears: 5,
  neededBy: "immediate",
  shift: "night",
  description: "Operate and set Fanuc-control machines on the night line.",
  benefits: ["PF + ESI", "Canteen"],
  requirements: ["Fanuc control", "ITI / Diploma"],
};

function setup(row: unknown) {
  const repo = { findWorkerVisibleJobById: vi.fn(async () => row) };
  const svc = new JobsService(repo as unknown as JobsRepository);
  return { svc, repo };
}

describe("JobsService.getWorkerVisibleJob — neutral 404 (no oracle)", () => {
  it("404s with EXACTLY 'Job not found' on an unknown id, and emits NO event", async () => {
    const { svc } = setup(undefined);
    const err = await svc.getWorkerVisibleJob(JOB_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    // NEUTRAL: no id echo (XB-A/F-3 precedent, cf. AgencyService.getOwnJob).
    expect((err as NotFoundException).message).toBe("Job not found");
    // ADR-0024 final addendum §"Event ruling": the detail read emits NO event —
    // structurally guaranteed here: the service is constructed from the repository
    // ALONE (ctor arity 1; no EventsService seam exists anywhere in this module).
    expect(JobsService.length).toBe(1);
  });

  it("a CLOSED job is byte-identical to an unknown one (the repo's status='open' WHERE folds both)", async () => {
    // The repository returns `undefined` for a closed row exactly as for an
    // unknown id (status='open' is IN the WHERE) — so the service sees the SAME
    // input and must produce the SAME error, byte for byte.
    const unknownErr = (await setup(undefined)
      .svc.getWorkerVisibleJob(JOB_ID)
      .catch((e: unknown) => e)) as NotFoundException;
    const closedErr = (await setup(undefined)
      .svc.getWorkerVisibleJob(JOB_ID)
      .catch((e: unknown) => e)) as NotFoundException;
    expect(closedErr.message).toBe(unknownErr.message);
    expect(JSON.stringify(closedErr.getResponse())).toBe(JSON.stringify(unknownErr.getResponse()));
    expect(closedErr.getStatus()).toBe(unknownErr.getStatus());
  });
});

describe("JobsService.getWorkerVisibleJob — the ADR-0024 SHOW projection", () => {
  it("returns EVERY contract field, mapped snake_case, values intact", async () => {
    const { svc, repo } = setup(FULL_ROW);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    expect(repo.findWorkerVisibleJobById).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(out).toEqual({
      job_id: JOB_ID,
      trade_key: "cnc_operator",
      title: "CNC Operator — Night Shift",
      city: "Pune",
      area: "Pimpri-Chinchwad",
      pay_min: 18000,
      pay_max: 25000,
      min_experience_years: 2,
      max_experience_years: 5,
      needed_by: "immediate",
      shift: "night",
      description: "Operate and set Fanuc-control machines on the night line.",
      benefits: ["PF + ESI", "Canteen"],
      requirements: ["Fanuc control", "ITI / Diploma"],
    });
  });

  it("passes nulls through HONESTLY on every nullable field (absent data, never fabricated)", async () => {
    const bare: WorkerVisibleJobRow = {
      id: JOB_ID,
      tradeKey: "fitter",
      title: "Fitter",
      city: "Rajkot",
      area: null,
      payMin: null,
      payMax: null,
      minExperienceYears: null,
      maxExperienceYears: null,
      neededBy: null,
      shift: null,
      description: null,
      benefits: null,
      requirements: null,
    };
    const { svc } = setup(bare);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    expect(out).toEqual({
      job_id: JOB_ID,
      trade_key: "fitter",
      title: "Fitter",
      city: "Rajkot",
      area: null,
      pay_min: null,
      pay_max: null,
      min_experience_years: null,
      max_experience_years: null,
      needed_by: null,
      shift: null,
      description: null,
      benefits: null,
      requirements: null,
    });
  });

  it("PROJECTION: the serialized response never contains payer/payer_id/applicants/status keys", async () => {
    // Belt-and-braces: even if the repo (hypothetically) leaked the hidden
    // columns, the service's EXPLICIT field-by-field mapping drops them — the
    // ADR-0024 HIDE set can never ride this response.
    const leakyRow = {
      ...FULL_ROW,
      payerId: "99999999-9999-4999-8999-999999999999",
      status: "open",
      applicantsReceived: 7,
    };
    const { svc } = setup(leakyRow);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    const json = JSON.stringify(out);
    for (const forbidden of ["payer", "payer_id", "applicants", "status"]) {
      expect(json, `response must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});
