import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../common/request-context";
import { OCCUPATIONS_MAX, SetMyOccupationsSchema } from "./worker-occupations.dto";
import { WorkerOccupationsService } from "./worker-occupations.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

function setup(opts: { rows?: string[]; workerExists?: boolean } = {}) {
  const replaceForWorker = vi.fn(async (_workerId: string, roleIds: readonly string[]) => ({
    occupationsWritten: roleIds.length,
    replacedExisting: false,
  }));
  const loadForWorker = vi.fn(async (_workerId: string) => opts.rows ?? []);
  const findById = vi.fn(async (_id: string) =>
    opts.workerExists === false ? undefined : { id: WORKER },
  );
  const emit = vi.fn(async (_event: unknown) => undefined);
  const rebuildQuietly = vi.fn(async (_workerId: string, _ctx?: RequestContext) => undefined);
  const svc = new WorkerOccupationsService(
    { replaceForWorker, loadForWorker } as never,
    { findById } as never,
    { emit } as never,
    { rebuildQuietly } as never,
  );
  return { svc, replaceForWorker, loadForWorker, emit, rebuildQuietly };
}

const parse = (body: unknown) => SetMyOccupationsSchema.parse(body);

describe("WorkerOccupationsService.replaceForWorker (Layer A (f))", () => {
  it("replaces the list in the submitted order, emits counts only, and rebuilds supply", async () => {
    const h = setup();
    const res = await h.svc.replaceForWorker(
      WORKER,
      parse({ occupations: [{ role_id: "role_welder" }, { role_id: "role_plumber" }] }),
      CTX,
    );
    expect(res).toEqual({ worker_id: WORKER, occupation_count: 2 });
    expect(h.replaceForWorker).toHaveBeenCalledWith(WORKER, ["role_welder", "role_plumber"]);

    const event = h.emit.mock.calls[0]![0] as { event_name: string; payload: unknown };
    expect(event.event_name).toBe("worker.occupations_recorded");
    expect(event.payload).toEqual({
      worker_id: WORKER,
      occupation_count: 2,
      replaced_existing: false,
    });
    // COUNTS ONLY — a per-worker role list may not ride the spine.
    expect(JSON.stringify(event)).not.toContain("role_welder");
    expect(JSON.stringify(event)).not.toContain("role_plumber");

    // Supply is re-derived through the existing role bridge, quietly.
    expect(h.rebuildQuietly).toHaveBeenCalledWith(WORKER, CTX);
  });

  it("an empty list is a real answer — it clears the rows and still rebuilds", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse({ occupations: [] }), CTX);
    expect(h.replaceForWorker).toHaveBeenCalledWith(WORKER, []);
    const event = h.emit.mock.calls[0]![0] as { payload: unknown };
    expect(event.payload).toMatchObject({ occupation_count: 0 });
    expect(h.rebuildQuietly).toHaveBeenCalledWith(WORKER, CTX);
  });

  it("404s and writes nothing for a worker that does not exist", async () => {
    const h = setup({ workerExists: false });
    await expect(
      h.svc.replaceForWorker(WORKER, parse({ occupations: [{ role_id: "role_welder" }] }), CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.replaceForWorker).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.rebuildQuietly).not.toHaveBeenCalled();
  });
});

describe("SetMyOccupationsSchema — the closed id space", () => {
  it("refuses an id outside the taxonomy", () => {
    expect(() => parse({ occupations: [{ role_id: "role_invented" }] })).toThrow();
    expect(() => parse({ occupations: [{ role_id: "mskill_mig_welder" }] })).toThrow();
  });

  it("refuses a duplicated role and more than the cap", () => {
    expect(() =>
      parse({ occupations: [{ role_id: "role_welder" }, { role_id: "role_welder" }] }),
    ).toThrow();
    const many = Array.from({ length: OCCUPATIONS_MAX + 1 }, () => ({
      role_id: "role_welder",
    }));
    expect(() => parse({ occupations: many })).toThrow();
  });

  it("refuses a label smuggled onto the entry (labels are read-only decoration)", () => {
    expect(() =>
      parse({ occupations: [{ role_id: "role_welder", label: "Master Welder" }] }),
    ).toThrow();
  });
});

describe("WorkerOccupationsService.getForWorker", () => {
  it("returns the stored order with taxonomy labels and no partial flag", async () => {
    const h = setup({ rows: ["role_welder", "role_plumber"] });
    const res = await h.svc.getForWorker(WORKER);
    expect(res).toEqual({
      occupations: [
        { role_id: "role_welder", label: "Welder" },
        { role_id: "role_plumber", label: "Plumber" },
      ],
      partial: false,
      dropped_count: 0,
    });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("withholds a row that no longer parses, and counts it", async () => {
    const h = setup({ rows: ["role_welder", "role_retired"] });
    const res = await h.svc.getForWorker(WORKER);
    expect(res.occupations).toEqual([{ role_id: "role_welder", label: "Welder" }]);
    expect(res.partial).toBe(true);
    expect(res.dropped_count).toBe(1);
  });
});
