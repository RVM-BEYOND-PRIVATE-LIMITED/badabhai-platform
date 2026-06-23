import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgencyJob } from "../../../../lib/contracts";

/**
 * Agency job Server-Action tests (ADR-0022, LIVE). Covers:
 *  - VERTICAL authz: requireAgent() runs FIRST on EVERY action (an employer's notFound()
 *    short-circuits before the seam is touched);
 *  - input validation: a bad job body / non-uuid id is rejected at the boundary;
 *  - NO-ORACLE: a `null` seam result (unknown OR not-owned) maps to the SAME neutral
 *    "not found" the page shows — never a cross-tenant existence oracle;
 *  - happy path threads the faceless job through.
 */

const requireAgent = vi.fn();
const createAgencyJob = vi.fn();
const updateAgencyJob = vi.fn();
const pauseAgencyJob = vi.fn();
const closeAgencyJob = vi.fn();

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../../../lib/payer-api", () => ({
  createAgencyJob: (i: unknown) => createAgencyJob(i),
  updateAgencyJob: (id: string, i: unknown) => updateAgencyJob(id, i),
  pauseAgencyJob: (id: string) => pauseAgencyJob(id),
  closeAgencyJob: (id: string) => closeAgencyJob(id),
}));

const {
  createAgencyJobAction,
  updateAgencyJobAction,
  pauseAgencyJobAction,
  closeAgencyJobAction,
} = await import("./jobs-actions");

const JOB_ID = "00000001-0000-4000-8000-000000000001";
const JOB: AgencyJob = {
  id: JOB_ID,
  status: "open",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: null,
  payMin: null,
  payMax: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  neededBy: null,
  applicantsReceived: 0,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};
const VALID_INPUT = { tradeKey: "cnc_operator", title: "CNC Operator", city: "Pune" };

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue({ payerId: "p", role: "agent", displayLabel: "A" });
  createAgencyJob.mockReset().mockResolvedValue(JOB);
  updateAgencyJob.mockReset().mockResolvedValue(JOB);
  pauseAgencyJob.mockReset().mockResolvedValue(JOB);
  closeAgencyJob.mockReset().mockResolvedValue(JOB);
});

describe("vertical authz — requireAgent FIRST on every action", () => {
  it("create: an employer (requireAgent throws) never reaches the seam", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(createAgencyJobAction(VALID_INPUT)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createAgencyJob).not.toHaveBeenCalled();
  });
  it("pause: an employer never reaches the seam", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(pauseAgencyJobAction({ jobId: JOB_ID })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(pauseAgencyJob).not.toHaveBeenCalled();
  });
  it("close: an employer never reaches the seam", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(closeAgencyJobAction({ jobId: JOB_ID })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(closeAgencyJob).not.toHaveBeenCalled();
  });
});

describe("create — validation + happy path", () => {
  it("creates a job from valid input", async () => {
    const res = await createAgencyJobAction(VALID_INPUT);
    expect(res).toEqual({ ok: true, job: JOB });
  });
  it("rejects an invalid body (missing required fields) without calling the seam", async () => {
    const res = await createAgencyJobAction({ title: "x" });
    expect(res.ok).toBe(false);
    expect(createAgencyJob).not.toHaveBeenCalled();
  });
  it("rejects an out-of-set trade key (cannot smuggle an arbitrary string)", async () => {
    const res = await createAgencyJobAction({ ...VALID_INPUT, tradeKey: "rocket_scientist" });
    expect(res.ok).toBe(false);
    expect(createAgencyJob).not.toHaveBeenCalled();
  });
});

describe("lifecycle — no-oracle on a null (unknown-or-not-owned) result", () => {
  it("pause: null seam result → neutral not-found", async () => {
    pauseAgencyJob.mockResolvedValueOnce(null);
    const res = await pauseAgencyJobAction({ jobId: JOB_ID });
    expect(res).toEqual({ ok: false, error: "That vacancy could not be found." });
  });
  it("close: null seam result → neutral not-found", async () => {
    closeAgencyJob.mockResolvedValueOnce(null);
    const res = await closeAgencyJobAction({ jobId: JOB_ID });
    expect(res).toEqual({ ok: false, error: "That vacancy could not be found." });
  });
  it("update: null seam result → neutral not-found", async () => {
    updateAgencyJob.mockResolvedValueOnce(null);
    const res = await updateAgencyJobAction(JOB_ID, VALID_INPUT);
    expect(res).toEqual({ ok: false, error: "That vacancy could not be found." });
  });
  it("pause: a non-uuid id is rejected before the seam (same neutral message)", async () => {
    const res = await pauseAgencyJobAction({ jobId: "not-a-uuid" });
    expect(res).toEqual({ ok: false, error: "That vacancy could not be found." });
    expect(pauseAgencyJob).not.toHaveBeenCalled();
  });
});

describe("lifecycle — happy path threads the faceless job", () => {
  it("pause returns the updated job", async () => {
    const res = await pauseAgencyJobAction({ jobId: JOB_ID });
    expect(res).toEqual({ ok: true, job: JOB });
  });
  it("close returns the updated job", async () => {
    const res = await closeAgencyJobAction({ jobId: JOB_ID });
    expect(res).toEqual({ ok: true, job: JOB });
  });
});
