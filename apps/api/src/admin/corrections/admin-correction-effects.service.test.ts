import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../common/request-context";
import { AdminCorrectionEffectsService } from "./admin-correction-effects.service";

/**
 * #2561 PR 3 — the after-save effects. The stores are already corrected when this runs; what is
 * pinned here is the fan-out: the read-table job, the matching rebuild, the résumé choice
 * (new `admin_edit` version for snapshot fields, in-place redraw for live fields), and one
 * faceless push whose payload carries no value, reason or admin identity.
 */

const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };

function harness(over: { devices?: unknown[]; pushThrows?: boolean } = {}) {
  const workers = {
    latestProfile: vi.fn(async () => ({ id: "profile-1" })),
    latestResume: vi.fn(async () => ({ id: "resume-1" })),
  };
  const workerSkills = { rebuildQuietly: vi.fn(async () => undefined) };
  const devices = {
    listPushTargets: vi.fn(async () => over.devices ?? [{ id: "device-1" }]),
  };
  const push = {
    enqueue: vi.fn(async () => {
      if (over.pushThrows) throw new Error("queue down");
    }),
  };
  const indexQueue = { add: vi.fn(async () => ({})) };
  const renderQueue = { add: vi.fn(async () => ({})) };
  const generateQueue = { add: vi.fn(async () => ({})) };
  const service = new AdminCorrectionEffectsService(
    workers as never,
    workerSkills as never,
    devices as never,
    push as never,
    indexQueue as never,
    renderQueue as never,
    generateQueue as never,
  );
  return { workers, workerSkills, devices, push, indexQueue, renderQueue, generateQueue, service };
}

const run = (service: AdminCorrectionEffectsService, factKey: string, eventName?: string) =>
  service.afterCorrection({
    workerId: "worker-1",
    factKey: factKey as never,
    eventName: (eventName ?? "admin.candidate_field_corrected") as never,
    sourceEventId: "event-1",
    ctx: CTX,
  });

describe("#2561 correction after-save effects", () => {
  it("a SNAPSHOT fact re-projects, rebuilds matching and queues a new admin_edit résumé", async () => {
    const h = harness();
    await run(h.service, "skills");

    expect(h.indexQueue.add).toHaveBeenCalledWith(
      "project-worker",
      { workerId: "worker-1" },
      expect.any(Object),
    );
    expect(h.workerSkills.rebuildQuietly).toHaveBeenCalledWith("worker-1", CTX);
    expect(h.generateQueue.add).toHaveBeenCalledWith(
      "generate",
      expect.objectContaining({
        workerId: "worker-1",
        profileId: "profile-1",
        trigger: "admin_edit",
        correlationId: CTX.correlationId,
        requestId: CTX.requestId,
      }),
      expect.any(Object),
    );
    expect(h.renderQueue.add).not.toHaveBeenCalled();
    expect(h.push.enqueue).toHaveBeenCalledWith({
      workerId: "worker-1",
      sourceEventId: "event-1",
      eventName: "admin.candidate_field_corrected",
      deviceIds: ["device-1"],
    });
  });

  it("a LIVE fact redraws the latest résumé in place and does not rebuild matching", async () => {
    const h = harness();
    await run(h.service, "languages");

    expect(h.workerSkills.rebuildQuietly).not.toHaveBeenCalled();
    expect(h.generateQueue.add).not.toHaveBeenCalled();
    expect(h.renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({
        resumeId: "resume-1",
        workerId: "worker-1",
        force: true,
        failClosed: false,
      }),
      expect.any(Object),
    );
  });

  it("work_history is a MATCH fact and a LIVE (in-place) résumé fact", async () => {
    const h = harness();
    await run(h.service, "work_history");

    expect(h.workerSkills.rebuildQuietly).toHaveBeenCalledWith("worker-1", CTX);
    expect(h.renderQueue.add).toHaveBeenCalledOnce();
    expect(h.generateQueue.add).not.toHaveBeenCalled();
  });

  it("a revert uses the reverted event name for the push and the same effect set", async () => {
    const h = harness();
    await run(h.service, "trade", "admin.candidate_field_reverted");

    expect(h.generateQueue.add).toHaveBeenCalledOnce();
    expect(h.push.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "admin.candidate_field_reverted" }),
    );
  });

  it("does not enqueue a push when the worker has no push target", async () => {
    const h = harness({ devices: [] });
    await run(h.service, "languages");
    expect(h.push.enqueue).not.toHaveBeenCalled();
  });

  it("is best-effort: a push failure never rejects the committed correction", async () => {
    const h = harness({ pushThrows: true });
    await expect(run(h.service, "languages")).resolves.toBeUndefined();
    expect(h.push.enqueue).toHaveBeenCalledOnce();
  });

  it("the push input carries no value, reason or admin identity", async () => {
    const h = harness();
    await run(h.service, "experience");
    const [input] = h.push.enqueue.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(input).sort()).toEqual([
      "deviceIds",
      "eventName",
      "sourceEventId",
      "workerId",
    ]);
  });
});
