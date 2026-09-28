import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { ResumeController } from "./resume.controller";
import type { ResumeService } from "./resume.service";
import type { ResumeSkinService } from "./resume-skin.service";
import { SetResumeSkinSchema } from "./resume-skin.dto";
import { ConsentGuard } from "../auth/consent.guard";
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
    myDocument: vi.fn(async () => ({
      resume_id: RES_ID,
      version: 1,
      document: null,
      render_status: "pending",
      rendered_at: null,
    })),
    history: vi.fn(async () => ({ items: [], pending_update: null })),
    regenerate: vi.fn(async () => ({ resume_id: "r2", version: 3 })),
    download: vi.fn(async () => ({ url: "https://signed/u?token=x", expires_in: 900 })),
    recordShare: vi.fn(async () => ({ ok: true })),
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { RESUME_RATE_LIMIT_PER_IP_PER_HOUR: 20 } as ServerConfig;
  const skins = {
    state: vi.fn(async () => ({ enabled: true, skin: "neela", skins: ["neela"] })),
    set: vi.fn(async () => ({ skin: "neela", previous_skin: null, change: "changed" })),
  };
  const controller = new ResumeController(
    resume as unknown as ResumeService,
    ipRateLimit as unknown as IpRateLimit,
    config,
    skins as unknown as ResumeSkinService,
  );
  return { controller, resume, ipRateLimit, skins };
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

  /**
   * #1397 — the document route had NO controller coverage, and it just became a route clients
   * POLL. Three properties its docblock calls load-bearing are asserted here rather than left
   * as prose: the id is session-derived, the response is uncacheable, and the literal path is
   * declared before the parameterised one.
   */
  it("myDocument delegates with the SESSION worker id — no id is taken from the request", async () => {
    const { controller, resume } = make();
    await controller.myDocument(OWNER);
    expect(resume.myDocument).toHaveBeenCalledWith(OWNER.id);
    expect(resume.myDocument).toHaveBeenCalledTimes(1);
  });

  it("myDocument is worker-guarded (unauthenticated → 401 via WorkerAuthGuard)", () => {
    const guards = (Reflect.getMetadata("__guards__", ResumeController.prototype.myDocument) ??
      []) as unknown[];
    expect(guards).toContain(WorkerAuthGuard);
  });

  it("myDocument sets Cache-Control: no-store — a cached 'pending' is a poll that never ends", () => {
    const headers = (Reflect.getMetadata("__headers__", ResumeController.prototype.myDocument) ??
      []) as { name: string; value: string }[];
    expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
  });

  it("myDocument is declared BEFORE the :id route — else 'document' is parsed as a uuid and 400s", () => {
    // Nest matches in declaration order, and method order on the prototype IS declaration order.
    const methods = Object.getOwnPropertyNames(ResumeController.prototype);
    expect(methods.indexOf("myDocument")).toBeLessThan(methods.indexOf("get"));
  });

  // ADR-0043 — the history route shares every load-bearing property `myDocument` has: the id
  // comes from the session, the answer is polled so it must not be cached, and the literal path
  // must be declared before the parameterised one.
  it("history delegates with the SESSION worker id — no id is taken from the request", async () => {
    const { controller, resume } = make();
    await controller.history(OWNER);
    expect(resume.history).toHaveBeenCalledWith(OWNER.id);
  });

  it("history is worker-guarded, no-store, and declared BEFORE the :id route", () => {
    const guards = (Reflect.getMetadata("__guards__", ResumeController.prototype.history) ??
      []) as unknown[];
    expect(guards).toContain(WorkerAuthGuard);
    const headers = (Reflect.getMetadata("__headers__", ResumeController.prototype.history) ??
      []) as { name: string; value: string }[];
    expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
    const methods = Object.getOwnPropertyNames(ResumeController.prototype);
    expect(methods.indexOf("history")).toBeLessThan(methods.indexOf("get"));
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

  it("share applies the per-IP cap FIRST, then delegates with the authed worker id", async () => {
    // R16 §5.1 — the worker id is the point. It comes from the SESSION, never from the body,
    // so a client cannot name whose share this was.
    const { controller, resume, ipRateLimit } = make();
    await controller.share(RES_ID, OWNER, { channel: "link" }, IP, CTX);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "resume_share",
      IP,
      expect.any(Number),
    );
    expect(resume.recordShare).toHaveBeenCalledWith(OWNER.id, RES_ID, { channel: "link" }, CTX);
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

/**
 * #1801 — the two skin routes. Thin: the worker is the SESSION's, the body is the closed skin
 * enum and nothing else, and both literal paths are declared before `:id`.
 */
describe("ResumeController — résumé skin (#1801)", () => {
  const guardsOf = (method: "mySkin" | "setMySkin") =>
    (Reflect.getMetadata("__guards__", ResumeController.prototype[method]) ?? []) as unknown[];

  it("mySkin delegates with the SESSION worker id", async () => {
    const { controller, skins } = make();
    expect(await controller.mySkin(OWNER)).toEqual({
      enabled: true,
      skin: "neela",
      skins: ["neela"],
    });
    expect(skins.state).toHaveBeenCalledWith(OWNER.id);
  });

  it("setMySkin delegates the validated skin with the SESSION worker id and the request ctx", async () => {
    const { controller, skins } = make();
    await controller.setMySkin({ skin: "neela" }, OWNER, CTX);
    expect(skins.set).toHaveBeenCalledWith(OWNER.id, "neela", CTX);
  });

  it("both routes are [WorkerAuthGuard, ConsentGuard], in that order", () => {
    for (const method of ["mySkin", "setMySkin"] as const) {
      expect(guardsOf(method), method).toEqual([WorkerAuthGuard, ConsentGuard]);
    }
  });

  it("mySkin is no-store, and both skin routes are declared BEFORE the :id route", () => {
    const headers = (Reflect.getMetadata("__headers__", ResumeController.prototype.mySkin) ??
      []) as { name: string; value: string }[];
    expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
    const methods = Object.getOwnPropertyNames(ResumeController.prototype);
    expect(methods.indexOf("mySkin")).toBeLessThan(methods.indexOf("get"));
    expect(methods.indexOf("setMySkin")).toBeLessThan(methods.indexOf("get"));
  });

  it("the PUT body accepts only a skin from RESUME_SKINS — unknown skins and extra keys are a 400", () => {
    expect(SetResumeSkinSchema.safeParse({ skin: "neela" }).success).toBe(true);
    for (const body of [
      { skin: "saada" },
      { skin: "kaagaz" },
      { skin: "loha" },
      { skin: "Neela" },
      { skin: "" },
      { skin: null },
      {},
      { skin: "neela", worker_id: OTHER_WORKER_ID },
      { skin: "neela", template_id: "classic" },
    ]) {
      expect(SetResumeSkinSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
