import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../common/request-context";
import { WorkerLanguagesService } from "./worker-languages.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

interface EmittedEvent {
  event_name: string;
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  correlationId: string;
  requestId: string;
}

interface RenderJob {
  resumeId: string;
  workerId: string;
  force?: boolean;
  failClosed?: boolean;
}

function setup(
  opts: {
    workerMissing?: boolean;
    latestResume?: { id: string } | null;
    replacedExisting?: boolean;
    stored?: { language: string; canSpeak: boolean; canRead: boolean; canWrite: boolean }[];
  } = {},
) {
  // Typed explicitly, not inferred: `vi.fn(async () => …)` infers a zero-arg signature and the
  // `mock.calls[0][1]` assertions below become tsc errors while vitest stays green.
  const replaceForWorker = vi.fn(
    async (
      _workerId: string,
      languages: readonly {
        language: string;
        canSpeak: boolean;
        canRead: boolean;
        canWrite: boolean;
      }[],
    ) => ({
      languagesWritten: languages.length,
      replacedExisting: opts.replacedExisting ?? false,
    }),
  );
  const loadForResume = vi.fn(async (_workerId: string) => opts.stored ?? []);
  const findById = vi.fn(async (_id: string) =>
    opts.workerMissing === true ? undefined : { id: WORKER },
  );
  const latestResume = vi.fn(async (_id: string) => opts.latestResume ?? undefined);
  const emit = vi.fn(async (_event: EmittedEvent) => undefined);
  const add = vi.fn(async (_name: string, _data: RenderJob): Promise<void> => undefined);

  const svc = new WorkerLanguagesService(
    { replaceForWorker, loadForResume } as never,
    { findById, latestResume } as never,
    { emit } as never,
    { add } as never,
  );
  return { svc, replaceForWorker, loadForResume, findById, emit, add };
}

describe("WorkerLanguagesService.replaceForWorker (Layer A (b))", () => {
  it("writes the worker's ticks and returns the count", async () => {
    const { svc, replaceForWorker, add } = setup({ latestResume: { id: "res-1" } });
    const res = await svc.replaceForWorker(
      WORKER,
      {
        languages: [
          { language: "hindi", can_speak: true, can_read: true, can_write: true },
          { language: "english", can_speak: false, can_read: true, can_write: false },
        ],
      },
      CTX,
    );

    expect(replaceForWorker).toHaveBeenCalledWith(WORKER, [
      { language: "hindi", canSpeak: true, canRead: true, canWrite: true },
      { language: "english", canSpeak: false, canRead: true, canWrite: false },
    ]);
    expect(res).toEqual({ worker_id: WORKER, language_count: 2 });
    expect(add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ failClosed: false, force: true }),
    );
  });

  it("emits counts, never the languages themselves", async () => {
    const { svc, emit } = setup({ replacedExisting: true });
    await svc.replaceForWorker(
      WORKER,
      { languages: [{ language: "haryanvi", can_speak: true, can_read: false, can_write: false }] },
      CTX,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![0];
    expect(event.event_name).toBe("worker.languages_recorded");
    expect(event.payload).toEqual({
      worker_id: WORKER,
      language_count: 1,
      replaced_existing: true,
    });
    expect(JSON.stringify(event)).not.toContain("haryanvi");
  });

  it("an empty list is a real answer — it clears the rows and reports zero", async () => {
    const { svc, replaceForWorker, emit } = setup({ replacedExisting: true });
    const res = await svc.replaceForWorker(WORKER, { languages: [] }, CTX);
    expect(replaceForWorker).toHaveBeenCalledWith(WORKER, []);
    expect(res.language_count).toBe(0);
    const event = emit.mock.calls[0]![0];
    expect(event.payload).toEqual({
      worker_id: WORKER,
      language_count: 0,
      replaced_existing: true,
    });
  });

  it("404s a missing worker before touching the table", async () => {
    const { svc, replaceForWorker } = setup({ workerMissing: true });
    await expect(svc.replaceForWorker(WORKER, { languages: [] }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(replaceForWorker).not.toHaveBeenCalled();
  });
});

describe("WorkerLanguagesService.getForWorker", () => {
  it("returns stored rows in the PUT's own shapes", async () => {
    const { svc } = setup({
      stored: [{ language: "hindi", canSpeak: true, canRead: false, canWrite: true }],
    });
    await expect(svc.getForWorker(WORKER)).resolves.toEqual({
      languages: [{ language: "hindi", can_speak: true, can_read: false, can_write: true }],
      partial: false,
      dropped_count: 0,
    });
  });

  it("withholds a row whose slug left the dictionary, and says so", async () => {
    // The column is plain text with no membership CHECK, so a hand-written or retired slug can
    // exist. Returning it would make the worker's unedited save a 400; `partial` is what stops
    // the client re-sending the list and erasing the withheld row.
    const { svc } = setup({
      stored: [
        { language: "hindi", canSpeak: true, canRead: false, canWrite: false },
        { language: "klingon", canSpeak: true, canRead: false, canWrite: false },
      ],
    });
    const res = await svc.getForWorker(WORKER);
    expect(res.languages).toHaveLength(1);
    expect(res.partial).toBe(true);
    expect(res.dropped_count).toBe(1);
  });
});
