import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_INDEX_POLL_JOB,
  CANDIDATE_INDEX_POLL_SCHEDULER_ID,
  CANDIDATE_INDEX_REBUILD_JOB,
  CANDIDATE_INDEX_REBUILD_SCHEDULER_ID,
} from "../../queue/queue.constants";
import { CandidateIndexProcessor, workerIdOfEvent } from "./candidate-index.processor";

const WORKER_A = "11111111-1111-4111-8111-111111111111";
const WORKER_B = "22222222-2222-4222-8222-222222222222";

const CONFIG = {
  CANDIDATE_INDEX_POLL_INTERVAL_MINUTES: 5,
  CANDIDATE_INDEX_REBUILD_INTERVAL_HOURS: 24,
  CANDIDATE_INDEX_BATCH_LIMIT: 500,
} as never;

function makeProcessor(opts?: {
  events?: { createdAt: Date; subjectType: string; subjectId: string | null; payload: unknown }[];
  project?: (id: string) => Promise<boolean>;
  workerIds?: string[][];
}) {
  const events = opts?.events ?? [];
  const project = opts?.project ?? (async () => true);
  const index = {
    readEventBatch: vi.fn(async () => events),
    getWatermark: vi.fn(async () => 0),
    setWatermark: vi.fn(async () => undefined),
    listWorkerIds: vi.fn(async () => [] as string[]),
    upsertRow: vi.fn(async () => undefined),
  };
  if (opts?.workerIds) {
    let call = 0;
    index.listWorkerIds = vi.fn(async () => opts.workerIds![call++] ?? []);
  }
  const projector = { projectWorker: vi.fn(project), driftForWorker: vi.fn() };
  const upsertJobScheduler = vi.fn(async () => undefined);
  const queue = { upsertJobScheduler } as never;
  const processor = new CandidateIndexProcessor(projector as never, index as never, queue, CONFIG);
  return { processor, index, projector, upsertJobScheduler };
}

describe("workerIdOfEvent (ADR-0062 §3.5 resolution)", () => {
  it("prefers the worker subject", () => {
    expect(
      workerIdOfEvent({ subjectType: "worker", subjectId: WORKER_A, payload: {} }),
    ).toBe(WORKER_A);
  });

  it("falls back to payload.worker_id", () => {
    expect(
      workerIdOfEvent({
        subjectType: "job_posting",
        subjectId: "99999999-9999-4999-8999-999999999999",
        payload: { worker_id: WORKER_B },
      }),
    ).toBe(WORKER_B);
  });

  it("skips events naming no (valid) worker", () => {
    expect(workerIdOfEvent({ subjectType: "payer", subjectId: WORKER_A, payload: {} })).toBeNull();
    expect(workerIdOfEvent({ subjectType: "worker", subjectId: "not-a-uuid", payload: {} })).toBeNull();
    expect(workerIdOfEvent({ subjectType: "admin_session", subjectId: null, payload: {} })).toBeNull();
  });
});

describe("CandidateIndexProcessor.poll (B4, #2557)", () => {
  const at = (iso: string) => new Date(iso);

  it("projects each named worker and advances the watermark", async () => {
    const { processor, index, projector } = makeProcessor({
      events: [
        { createdAt: at("2026-11-05T10:00:00Z"), subjectType: "worker", subjectId: WORKER_A, payload: {} },
        { createdAt: at("2026-11-05T10:01:00Z"), subjectType: "profile", subjectId: "aaa", payload: { worker_id: WORKER_B } },
      ],
    });
    await expect(processor.poll()).resolves.toEqual({ projected: 2, skipped: 0 });
    expect(projector.projectWorker).toHaveBeenCalledWith(WORKER_A);
    expect(projector.projectWorker).toHaveBeenCalledWith(WORKER_B);
    expect(index.setWatermark).toHaveBeenCalledWith(at("2026-11-05T10:01:00Z").getTime());
  });

  it("skips worker-less events and continues past per-worker failures", async () => {
    const { processor } = makeProcessor({
      events: [
        { createdAt: at("2026-11-05T10:00:00Z"), subjectType: "admin_session", subjectId: null, payload: {} },
        { createdAt: at("2026-11-05T10:01:00Z"), subjectType: "worker", subjectId: WORKER_A, payload: {} },
      ],
      project: async (id) => {
        if (id === WORKER_A) throw new Error("boom");
        return true;
      },
    });
    await expect(processor.poll()).resolves.toEqual({ projected: 0, skipped: 2 });
  });

  it("does not move the watermark on an empty batch", async () => {
    const { processor, index } = makeProcessor({ events: [] });
    await expect(processor.poll()).resolves.toEqual({ projected: 0, skipped: 0 });
    expect(index.setWatermark).not.toHaveBeenCalled();
  });
});

describe("CandidateIndexProcessor.rebuild (nightly convergence)", () => {
  it("pages the workers table and projects every worker", async () => {
    const { processor, projector } = makeProcessor({ workerIds: [[WORKER_A, WORKER_B], []] });
    await expect(processor.rebuild()).resolves.toEqual({ projected: 2, skipped: 0 });
    expect(projector.projectWorker).toHaveBeenCalledWith(WORKER_A);
    expect(projector.projectWorker).toHaveBeenCalledWith(WORKER_B);
  });
});

describe("CandidateIndexProcessor wiring", () => {
  it("registers both schedulers at boot (poll + rebuild)", async () => {
    const { processor, upsertJobScheduler } = makeProcessor();
    await processor.onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith(CANDIDATE_INDEX_POLL_SCHEDULER_ID, {
      every: 5 * 60_000,
    });
    expect(upsertJobScheduler).toHaveBeenCalledWith(CANDIDATE_INDEX_REBUILD_SCHEDULER_ID, {
      every: 24 * 3_600_000,
    });
  });

  it("dispatches by job name", async () => {
    const { processor } = makeProcessor({ events: [] });
    await expect(processor.process({ name: CANDIDATE_INDEX_POLL_JOB } as never)).resolves.toEqual({
      projected: 0,
      skipped: 0,
    });
    await expect(
      processor.process({ name: CANDIDATE_INDEX_REBUILD_JOB } as never),
    ).resolves.toEqual({ projected: 0, skipped: 0 });
  });

  it("a Redis outage at registration only warns (next boot re-asserts)", async () => {
    const { processor } = makeProcessor();
    (processor as unknown as { queue: { upsertJobScheduler: unknown } }).queue.upsertJobScheduler =
      vi.fn(async () => {
        throw new Error("redis down");
      });
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
