import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { WorkersService } from "./workers.service";
import type { WorkersRepository } from "./workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const NAME = "Asha Kumari";
const TOKEN = "v1.opaqueciphertext"; // encrypt() output — must NOT contain the name

function setup(workerExists = true) {
  const repo = {
    findById: vi.fn(async (_id: string) => (workerExists ? { id: "w-1", fullName: null } : undefined)),
    updateFullName: vi.fn(async (_id: string, _token: string) => ({ id: "w-1" })),
  };
  const pii = { encrypt: vi.fn((_plaintext: string) => TOKEN) };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = new WorkersService(
    repo as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    events as unknown as EventsService,
  );
  return { svc, repo, pii, events };
}

describe("WorkersService.setFullName (TD21)", () => {
  it("encrypts the name before storing — a plaintext name is never persisted", async () => {
    const { svc, repo, pii } = setup();
    await svc.setFullName("w-1", NAME, CTX);

    expect(pii.encrypt).toHaveBeenCalledWith(NAME);
    expect(repo.updateFullName).toHaveBeenCalledWith("w-1", TOKEN);
    // the value handed to the DB is the ciphertext token, not the name
    expect(repo.updateFullName.mock.calls[0]![1]).not.toContain("Asha");
  });

  it("emits a PII-free worker.name_recorded event (no name) and returns only worker_id", async () => {
    const { svc, events } = setup();
    const res = await svc.setFullName("w-1", NAME, CTX);

    expect(res).toEqual({ worker_id: "w-1" });
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.name_recorded");
    expect(emitArg.payload).toEqual({ worker_id: "w-1" });
    // the name must appear NOWHERE in the emitted event
    expect(JSON.stringify(emitArg)).not.toMatch(/Asha/i);
  });

  it("throws NotFound for an unknown worker — no write, no event", async () => {
    const { svc, repo, events } = setup(false);
    await expect(svc.setFullName("missing", NAME, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateFullName).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
