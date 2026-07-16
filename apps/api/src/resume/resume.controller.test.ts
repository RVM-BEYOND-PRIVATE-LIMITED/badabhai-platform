import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { ResumeController } from "./resume.controller";
import type { ResumeService } from "./resume.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const IP = "203.0.113.9";
const RES_ID = "11111111-1111-1111-1111-111111111111";
const OWNER = { id: "22222222-2222-2222-2222-222222222222", sid: "sid-owner" };
const OTHER_WORKER_ID = "99999999-9999-9999-9999-999999999999";

/**
 * The controller is THIN: it validates/guards (covered elsewhere), applies the
 * per-IP cap, and delegates to ResumeService. These tests assert delegation +
 * the cap-first ordering; the business logic lives in resume.service.test.ts.
 */
function make() {
  const resume = {
    generate: vi.fn(async () => ({ resume_id: "r", version: 1 })),
    getById: vi.fn(async () => ({ resume_id: RES_ID })),
    regenerate: vi.fn(async () => ({ resume_id: "r2", version: 3 })),
    download: vi.fn(async () => ({ url: "https://signed/u?token=x", expires_in: 900 })),
    recordShare: vi.fn(async () => ({ ok: true })),
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { RESUME_RATE_LIMIT_PER_IP_PER_HOUR: 20 } as ServerConfig;
  const controller = new ResumeController(
    resume as unknown as ResumeService,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { controller, resume, ipRateLimit };
}

describe("ResumeController (thin) — delegation", () => {
  // TD70 item 5: an unauthenticated POST /resume/generate must 401 — the guard
  // metadata is the binding contract here (WorkerAuthGuard's 401-on-missing/invalid
  // bearer behaviour is covered by its own spec + guard-contract.test.ts).
  it("generate is worker-guarded (unauthenticated → 401 via WorkerAuthGuard)", () => {
    const guards = (Reflect.getMetadata("__guards__", ResumeController.prototype.generate) ??
      []) as unknown[];
    expect(guards).toContain(WorkerAuthGuard);
  });

  it("generate derives worker_id from the SESSION (body worker_id omitted)", async () => {
    const { controller, resume } = make();
    await controller.generate({ profile_id: "p" } as never, OWNER, CTX);
    expect(resume.generate).toHaveBeenCalledWith({ worker_id: OWNER.id, profile_id: "p" }, CTX);
  });

  it("generate accepts a MATCHING legacy body worker_id (back-compat) — id still session-derived", async () => {
    const { controller, resume } = make();
    await controller.generate({ worker_id: OWNER.id, profile_id: "p" } as never, OWNER, CTX);
    expect(resume.generate).toHaveBeenCalledWith({ worker_id: OWNER.id, profile_id: "p" }, CTX);
  });

  it("generate 404s (no existence oracle) when the body worker_id ≠ session worker; service never reached", () => {
    const { controller, resume } = make();
    // The handler throws synchronously (before any await), so assert the sync throw.
    expect(() =>
      controller.generate({ worker_id: OTHER_WORKER_ID, profile_id: "p" } as never, OWNER, CTX),
    ).toThrow(NotFoundException);
    expect(resume.generate).not.toHaveBeenCalled();
  });

  it("get delegates to getById", async () => {
    const { controller, resume } = make();
    await controller.get(RES_ID);
    expect(resume.getById).toHaveBeenCalledWith(RES_ID);
  });

  it("regenerate delegates to the service", async () => {
    const { controller, resume } = make();
    await controller.regenerate(RES_ID, CTX);
    expect(resume.regenerate).toHaveBeenCalledWith(RES_ID, CTX);
  });

  it("share delegates to recordShare", async () => {
    const { controller, resume } = make();
    await controller.share(RES_ID, { channel: "whatsapp" }, CTX);
    expect(resume.recordShare).toHaveBeenCalledWith(RES_ID, { channel: "whatsapp" }, CTX);
  });

  it("download applies the per-IP cap FIRST, then delegates with the authed worker id", async () => {
    const { controller, resume, ipRateLimit } = make();
    const res = await controller.download(RES_ID, OWNER, IP, CTX);
    expect(res).toEqual({ url: "https://signed/u?token=x", expires_in: 900 });
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("resume_download", IP, 20);
    // Worker id comes from @CurrentWorker, never the path/body.
    expect(resume.download).toHaveBeenCalledWith(OWNER.id, RES_ID, CTX);
  });

  it("download surfaces a 429 from the cap and never reaches the service", async () => {
    const { controller, resume, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"), // any throw; the real impl throws 429
    );
    await expect(controller.download(RES_ID, OWNER, IP, CTX)).rejects.toBeTruthy();
    expect(resume.download).not.toHaveBeenCalled();
  });
});
