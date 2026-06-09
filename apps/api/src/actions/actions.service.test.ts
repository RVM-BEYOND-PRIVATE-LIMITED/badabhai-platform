import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ActionsService } from "./actions.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

function make(workerExists = true) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const emitMany = vi.fn().mockImplementation((list: unknown[]) => Promise.resolve(list));
  const findById = vi.fn().mockResolvedValue(workerExists ? { id: WORKER } : undefined);
  const svc = new ActionsService({ findById } as never, { emit, emitMany } as never);
  return { svc, emit, emitMany, findById };
}

describe("ActionsService.record", () => {
  it("emits action.recorded for a known worker", async () => {
    const { svc, emit } = make();
    const res = await svc.record(
      { worker_id: WORKER, action_type: "resume_downloaded", target_type: "resume" },
      CTX as never,
    );
    expect(res).toEqual({ recorded: true, worker_id: WORKER, action_type: "resume_downloaded" });
    expect(emit).toHaveBeenCalledOnce();
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("action.recorded");
    expect(arg.actor).toEqual({ actor_type: "worker", actor_id: WORKER });
    expect(arg.subject).toEqual({ subject_type: "worker", subject_id: WORKER });
    expect(arg.payload.action_type).toBe("resume_downloaded");
  });

  it("404s for an unknown worker and does not emit", async () => {
    const { svc, emit } = make(false);
    await expect(
      svc.record({ worker_id: WORKER, action_type: "app_opened" }, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects PII-looking context (phone) and does not emit", async () => {
    const { svc, emit } = make();
    await expect(
      svc.record(
        { worker_id: WORKER, action_type: "profile_edited", context: { note: "call 9876543210" } },
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects PII-looking context (email) and does not emit", async () => {
    const { svc, emit } = make();
    await expect(
      svc.record(
        { worker_id: WORKER, action_type: "profile_edited", context: { x: "me@example.com" } },
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a spaced/formatted phone in context (does not emit)", async () => {
    const { svc, emit } = make();
    await expect(
      svc.record(
        { worker_id: WORKER, action_type: "profile_edited", context: { note: "+91 98765 43210" } },
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects PII smuggled into a context KEY (does not emit)", async () => {
    const { svc, emit } = make();
    await expect(
      svc.record(
        { worker_id: WORKER, action_type: "profile_edited", context: { "me@example.com": true } },
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("allows benign small numbers in context (e.g. counts/years apart)", async () => {
    const { svc, emit } = make();
    await svc.record(
      { worker_id: WORKER, action_type: "profile_edited", context: { fields: 3, since: "2019" } },
      CTX as never,
    );
    expect(emit).toHaveBeenCalledOnce();
  });
});

describe("ActionsService.recordBatch", () => {
  it("records a batch in one emitMany call and returns the count", async () => {
    const { svc, emitMany, findById } = make();
    const res = await svc.recordBatch(
      {
        actions: [
          { worker_id: WORKER, action_type: "app_opened" },
          { worker_id: WORKER, action_type: "resume_viewed", target_type: "resume" },
        ],
      },
      CTX as never,
    );
    expect(res).toEqual({ recorded_count: 2 });
    expect(emitMany).toHaveBeenCalledOnce();
    // distinct worker ids verified once
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole batch if any action carries PII", async () => {
    const { svc, emitMany } = make();
    await expect(
      svc.recordBatch(
        {
          actions: [
            { worker_id: WORKER, action_type: "app_opened" },
            { worker_id: WORKER, action_type: "profile_edited", context: { n: "99887766554" } },
          ],
        },
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emitMany).not.toHaveBeenCalled();
  });
});
