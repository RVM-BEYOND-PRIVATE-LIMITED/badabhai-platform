import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { WorkersController } from "./workers.controller";
import type { WorkersRepository } from "./workers.repository";
import type { WorkersService } from "./workers.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ROW = {
  id: ID,
  status: "active",
  preferredLanguage: "hi",
  createdAt: new Date("2026-06-11T00:00:00Z"),
  // PII that must NEVER be surfaced by these endpoints:
  fullName: "v1.ciphertext",
  phoneE164: "v1.ciphertext",
  phoneHash: "deadbeef",
};

function make() {
  const workers = {
    list: vi.fn(async () => [{ id: ID, status: "active" }]),
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    latestProfile: vi.fn(async () => null),
    latestResume: vi.fn(async () => null),
  };
  const workersService = { setFullName: vi.fn(async () => ({ worker_id: ID })) };
  return {
    controller: new WorkersController(
      workers as unknown as WorkersRepository,
      workersService as unknown as WorkersService,
    ),
    workers,
    workersService,
  };
}

describe("WorkersController — list/getProfile (read, no-PII) + setName", () => {
  it("list clamps the limit and wraps the rows", async () => {
    const { controller, workers } = make();
    const res = await controller.list("nan");
    expect(workers.list).toHaveBeenCalledWith(100);
    expect(res).toEqual({ workers: [{ id: ID, status: "active" }] });
  });

  it("getProfile 404s for an unknown worker", async () => {
    const { controller } = make();
    await expect(controller.getProfile(ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getProfile returns a PII-free worker projection (no name/phone)", async () => {
    const { controller, workers } = make();
    workers.findById.mockResolvedValueOnce(WORKER_ROW);
    const res = await controller.getProfile(ID);
    expect(res.worker).toEqual({
      id: ID,
      status: "active",
      preferred_language: "hi",
      created_at: WORKER_ROW.createdAt,
    });
    expect(JSON.stringify(res)).not.toMatch(/ciphertext|deadbeef|phone|full_?name/i);
  });

  it("setName routes the PII through the service (returns only the id)", async () => {
    const { controller, workersService } = make();
    const res = await controller.setName(ID, { full_name: "Asha" } as never, CTX);
    expect(workersService.setFullName).toHaveBeenCalledWith(ID, "Asha", CTX);
    expect(res).toEqual({ worker_id: ID });
  });

  it("setMyName takes the worker from the token (not a body/path id) and returns only { ok: true }", async () => {
    const { controller, workersService } = make();
    const worker = { id: ID, sid: "sess-1" };
    const res = await controller.setMyName(worker, { full_name: "Asha" } as never, CTX);
    // worker id comes from @CurrentWorker — never the body
    expect(workersService.setFullName).toHaveBeenCalledWith(ID, "Asha", CTX);
    // response NEVER carries the name (or even the id): only { ok: true }
    expect(res).toEqual({ ok: true });
    expect(JSON.stringify(res)).not.toMatch(/Asha/i);
  });
});
