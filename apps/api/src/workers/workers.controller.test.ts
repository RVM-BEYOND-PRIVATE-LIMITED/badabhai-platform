import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { WorkersController } from "./workers.controller";
import type { WorkersRepository } from "./workers.repository";
import type { WorkersService } from "./workers.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
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

const PROFILE_SUMMARY = {
  profile_status: "confirmed",
  confirmed_at: "2026-07-01T10:00:00.000Z",
  trade: {
    canonical_trade_id: "cnc_vmc",
    canonical_role_id: "role_vmc_operator",
    display_name: "VMC Operator",
  },
  city: "pune",
  strength: 9,
};

function make() {
  const workers = {
    list: vi.fn(async () => [{ id: ID, status: "active" }]),
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    latestProfile: vi.fn(async () => null),
    latestResume: vi.fn(async () => null),
  };
  const workersService = {
    setFullName: vi.fn(async () => ({ worker_id: ID })),
    getProfileSummary: vi.fn(async () => PROFILE_SUMMARY),
    getResumeFields: vi.fn(async () => ({
      full_name: "Asha",
      show_photo: true,
      night_shift_ready: false,
      has_photo: false,
    })),
    updateResumePrefs: vi.fn(async () => ({ worker_id: ID })),
    createPhotoUploadUrl: vi.fn(async () => ({
      storage_path: `photos/${ID}/9f8e7d6c-2222-4222-8222-000000000002.jpg`,
      upload_url: "https://storage.example/signed-upload?token=T",
      expires_in: 7200,
    })),
    confirmPhoto: vi.fn(async () => ({ worker_id: ID, has_photo: true as const })),
    getPhotoUrl: vi.fn(async () => ({
      url: "https://storage.example/signed-read?token=T",
      expires_in: 900,
    })),
    deletePhoto: vi.fn(async () => ({ worker_id: ID, has_photo: false as const })),
  };
  // ADR-0032 M-1: the mint route rides the per-IP hourly cap; default mock passes.
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { PHOTO_RATE_LIMIT_PER_IP_PER_HOUR: 20 } as ServerConfig;
  return {
    controller: new WorkersController(
      workers as unknown as WorkersRepository,
      workersService as unknown as WorkersService,
      ipRateLimit as unknown as IpRateLimit,
      config,
    ),
    workers,
    workersService,
    ipRateLimit,
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

  it("getMyProfileSummary takes the worker from the token and returns a PII-free summary (TD54)", async () => {
    const { controller, workersService } = make();
    const worker = { id: ID, sid: "sess-1" };
    const res = await controller.getMyProfileSummary(worker);
    // identity: the service gets the TOKEN worker id (guard-provided) — never a path/body id
    expect(workersService.getProfileSummary).toHaveBeenCalledWith(ID);
    expect(res).toEqual(PROFILE_SUMMARY);
    // the wire response never carries name/phone/hash material
    expect(JSON.stringify(res)).not.toMatch(/ciphertext|deadbeef|phone|full_?name/i);
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

  it("getMyResumeFields takes the worker from the token and returns the service projection", async () => {
    const { controller, workersService } = make();
    const worker = { id: ID, sid: "sess-1" };
    const res = await controller.getMyResumeFields(worker);
    // identity: the service gets the TOKEN worker id — never a path/body id
    expect(workersService.getResumeFields).toHaveBeenCalledWith(ID);
    expect(res).toEqual({
      full_name: "Asha",
      show_photo: true,
      night_shift_ready: false,
      has_photo: false,
    });
  });

  // ── ADR-0032: the photo routes — worker ALWAYS from the token, mint throttled ──

  it("createMyPhotoUploadUrl: token identity + the M-1 per-IP cap runs BEFORE minting", async () => {
    const { controller, workersService, ipRateLimit } = make();
    const worker = { id: ID, sid: "sess-1" };
    const res = await controller.createMyPhotoUploadUrl(worker, "1.2.3.4");
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "photo_upload_url",
      "1.2.3.4",
      20,
    );
    expect(workersService.createPhotoUploadUrl).toHaveBeenCalledWith(ID);
    expect(res.storage_path).toContain(`photos/${ID}/`);
  });

  it("createMyPhotoUploadUrl: a tripped cap propagates and the mint NEVER runs (fail-closed)", async () => {
    const { controller, workersService, ipRateLimit } = make();
    ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(new Error("429"));
    await expect(
      controller.createMyPhotoUploadUrl({ id: ID, sid: "sess-1" }, "1.2.3.4"),
    ).rejects.toThrow();
    expect(workersService.createPhotoUploadUrl).not.toHaveBeenCalled();
  });

  it("confirmMyPhoto / getMyPhotoUrl / deleteMyPhoto all take the worker from the token", async () => {
    const { controller, workersService } = make();
    const worker = { id: ID, sid: "sess-1" };
    const dto = { storage_path: `photos/${ID}/9f8e7d6c-2222-4222-8222-000000000002.jpg` };

    await controller.confirmMyPhoto(worker, dto as never, CTX);
    expect(workersService.confirmPhoto).toHaveBeenCalledWith(ID, dto, CTX);

    const urlRes = await controller.getMyPhotoUrl(worker);
    expect(workersService.getPhotoUrl).toHaveBeenCalledWith(ID);
    expect(urlRes.url).toContain("signed-read");

    const delRes = await controller.deleteMyPhoto(worker, CTX);
    expect(workersService.deletePhoto).toHaveBeenCalledWith(ID, CTX);
    expect(delRes).toEqual({ worker_id: ID, has_photo: false });
  });

  it("updateMyResumePrefs takes the worker from the token and returns only { ok: true }", async () => {
    const { controller, workersService } = make();
    const worker = { id: ID, sid: "sess-1" };
    const dto = { show_photo: false, night_shift_ready: true };
    const res = await controller.updateMyResumePrefs(worker, dto as never, CTX);
    // worker id from @CurrentWorker; the dto is passed through untouched
    expect(workersService.updateResumePrefs).toHaveBeenCalledWith(ID, dto, CTX);
    expect(res).toEqual({ ok: true });
  });
});
