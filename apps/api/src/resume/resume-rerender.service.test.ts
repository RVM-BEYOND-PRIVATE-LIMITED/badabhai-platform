import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";

import type { RequestContext } from "../common/request-context";
import type { ResumeRenderJobData } from "../queue/queue.constants";
import type { WorkersRepository } from "../workers/workers.repository";
import { ResumeRerenderService } from "./resume-rerender.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const RESUME = "22222222-2222-4222-8222-222222222222";
const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };

/**
 * #1801 — the shared cosmetic re-render seam. The job must be EXACTLY the one the private copies
 * in the profile services enqueue, and it must be queued only when there is a résumé to redraw.
 */
function harness(
  opts: { latest?: { id: string } | undefined; lookupThrows?: boolean; addThrows?: boolean } = {},
) {
  const workers = {
    latestResume: vi.fn(async (_workerId: string) => {
      if (opts.lookupThrows) throw new Error("db down");
      return opts.latest;
    }),
  };
  const queue = {
    add: vi.fn(async (_name: string, _job: ResumeRenderJobData) => {
      if (opts.addThrows) throw new Error("redis down");
      return {};
    }),
  };
  const service = new ResumeRerenderService(
    workers as unknown as WorkersRepository,
    queue as unknown as Queue<ResumeRenderJobData>,
  );
  return { service, workers, queue };
}

describe("ResumeRerenderService.enqueueLatest", () => {
  it("queues a forced, fail-OPEN re-render of the LATEST résumé, refs only", async () => {
    const h = harness({ latest: { id: RESUME } });
    expect(await h.service.enqueueLatest(WORKER, CTX)).toBe(RESUME);
    expect(h.workers.latestResume).toHaveBeenCalledWith(WORKER);
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    expect(h.queue.add).toHaveBeenCalledWith("render", {
      resumeId: RESUME,
      workerId: WORKER,
      force: true,
      failClosed: false,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  it("queues NOTHING when the worker has no résumé yet", async () => {
    const h = harness({ latest: undefined });
    expect(await h.service.enqueueLatest(WORKER, CTX)).toBeNull();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("never throws — a failed lookup or a dead queue is logged and answered null", async () => {
    for (const opts of [{ lookupThrows: true }, { latest: { id: RESUME }, addThrows: true }]) {
      const h = harness(opts);
      await expect(h.service.enqueueLatest(WORKER, CTX)).resolves.toBeNull();
    }
  });
});
