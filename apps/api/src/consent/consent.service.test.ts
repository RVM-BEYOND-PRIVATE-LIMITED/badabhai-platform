import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ConsentService } from "./consent.service";
import type { ConsentRepository } from "./consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
const DTO = {
  worker_id: WORKER,
  consent_version: "2026-06-01",
  purposes: ["profiling", "resume_generation"],
} as never;

function setup() {
  const consents = { create: vi.fn(async (_i: Record<string, unknown>) => ({ id: "consent-1" })) };
  const workers = { findById: vi.fn(async () => undefined as Record<string, unknown> | undefined) };
  const events = { emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p) };
  const pii = { hashIp: vi.fn(() => "iphash") };
  const svc = new ConsentService(
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
    pii as unknown as PiiCryptoService,
  );
  return { svc, consents, workers, events, pii };
}

describe("ConsentService.accept", () => {
  it("404s when the worker does not exist (nothing recorded/emitted)", async () => {
    const { svc, consents, events } = setup();
    await expect(svc.accept(DTO, "1.2.3.4", "ua", CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(consents.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("records consent + emits consent.accepted (hashed ip, no raw PII)", async () => {
    const { svc, workers, events, pii } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    const res = await svc.accept(DTO, "1.2.3.4", "ua", CTX);
    expect(res.consent_id).toBe("consent-1");
    expect(pii.hashIp).toHaveBeenCalledWith("1.2.3.4"); // ip is hashed, never stored raw
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("consent.accepted");
    expect(call.payload.purposes).toEqual(["profiling", "resume_generation"]);
    expect(JSON.stringify(call.payload)).not.toMatch(/phone|full_?name|1\.2\.3\.4/i);
  });

  it("passes ipHash null when no ip is provided", async () => {
    const { svc, workers, consents, pii } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    await svc.accept(DTO, undefined, undefined, CTX);
    expect(pii.hashIp).not.toHaveBeenCalled();
    expect(consents.create.mock.calls[0]![0]).toMatchObject({ ipHash: null, userAgent: null });
  });
});
