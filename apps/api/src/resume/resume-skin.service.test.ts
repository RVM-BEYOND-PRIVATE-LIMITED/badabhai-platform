import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEvent } from "@badabhai/event-schema";
import type { Database } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { ResumeSkinService } from "./resume-skin.service";
import type { ResumeSkinRepository } from "./resume-skin.repository";
import type { ResumeRerenderService } from "./resume-rerender.service";
import { ResumeSkinReader } from "./resume-skin.reader";
import type { ResumeSkin } from "@badabhai/types";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const NOW = new Date("2026-09-28T10:00:00.000Z");

/**
 * #1801 — `ResumeSkinService`, against a FAKE TRANSACTION that behaves like one: writes made on the
 * `tx` are staged and become visible only if the callback returns, and are discarded if it throws.
 * That is what lets "an emit failure rolls the preference back" be asserted on the stored state
 * rather than inferred from call order.
 */
function harness(
  opts: {
    enabled?: boolean;
    stored?: string | null;
    emitThrows?: boolean;
    /** A concurrent first choice commits THIS skin, so our insert loses (ON CONFLICT DO NOTHING). */
    concurrentWinner?: string;
  } = {},
) {
  const db = { committed: opts.stored ?? null };
  const TX = { tx: true } as unknown as Database;
  let staged: string | null | undefined;

  const repo = {
    withTransaction: vi.fn(async <T>(cb: (tx: Database) => Promise<T>): Promise<T> => {
      staged = undefined;
      const result = await cb(TX); // a throw propagates and `staged` is never committed
      if (staged !== undefined) db.committed = staged;
      return result;
    }),
    findSkin: vi.fn(async (_workerId: string) => db.committed),
    lockSkin: vi.fn(async (_workerId: string, _tx: Database) => db.committed),
    insertSkin: vi.fn(async (_workerId: string, skin: string, _at: Date, _tx: Database) => {
      if (opts.concurrentWinner !== undefined) {
        db.committed = opts.concurrentWinner; // the other transaction committed first
        return false;
      }
      staged = skin;
      return true;
    }),
    updateSkin: vi.fn(async (_workerId: string, skin: string, _at: Date, _tx: Database) => {
      staged = skin;
    }),
  };
  const events = {
    emit: vi.fn(async (params: Record<string, unknown>) => {
      if (opts.emitThrows) throw new Error("events insert failed");
      return params;
    }),
  };
  const rerender = { enqueueLatest: vi.fn(async () => "resume-1" as string | null) };
  // THE REAL READER over the same fake repository — the flag gate and the default live there.
  const reader = new ResumeSkinReader(repo as unknown as ResumeSkinRepository, {
    RESUME_SKINS_ENABLED: opts.enabled ?? true,
  });
  const service = new ResumeSkinService(
    repo as unknown as ResumeSkinRepository,
    reader,
    events as unknown as EventsService,
    rerender as unknown as ResumeRerenderService,
  );
  return { service, reader, repo, events, rerender, db, TX };
}

function untouched(repo: ReturnType<typeof harness>["repo"]): void {
  for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
}

describe("ResumeSkinService — flag OFF means absent (no query touches migration 0128)", () => {
  it("state answers disabled and reads nothing", async () => {
    const h = harness({ enabled: false, stored: "neela" });
    expect(await h.service.state(WORKER)).toEqual({ enabled: false, skin: null, skins: [] });
    untouched(h.repo);
  });

  it("set is a 404 and writes nothing, emits nothing, queues nothing", async () => {
    const h = harness({ enabled: false });
    await expect(h.service.set(WORKER, "neela", CTX, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    untouched(h.repo);
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });

  it("the render read (ResumeSkinReader.forWorker) is null and reads nothing", async () => {
    const h = harness({ enabled: false, stored: "neela" });
    expect(await h.reader.forWorker(WORKER)).toBeNull();
    untouched(h.repo);
  });

  it("an unset flag is off (only `true` turns it on)", async () => {
    const h = harness();
    const off = new ResumeSkinReader(
      h.repo as unknown as ResumeSkinRepository,
      {} as { RESUME_SKINS_ENABLED: boolean },
    );
    expect(off.enabled).toBe(false);
    expect(await off.forWorker(WORKER)).toBeNull();
    untouched(h.repo);
  });
});

describe("ResumeSkinService — reads (flag on)", () => {
  it("state: no row reads as the house default, and offers exactly RESUME_SKINS", async () => {
    const h = harness({ stored: null });
    expect(await h.service.state(WORKER)).toEqual({
      enabled: true,
      skin: "neela",
      skins: ["neela"],
    });
    expect(h.repo.findSkin).toHaveBeenCalledWith(WORKER);
  });

  it("the render read: the stored skin, or Neela when there is none", async () => {
    expect(await harness({ stored: "neela" }).reader.forWorker(WORKER)).toBe("neela");
    expect(await harness({ stored: null }).reader.forWorker(WORKER)).toBe("neela");
  });

  it("a stored value this build does not know is read as none — never handed to the renderer", async () => {
    const h = harness({ stored: "loha" });
    expect(await h.reader.forWorker(WORKER)).toBe("neela");
    expect(await h.service.state(WORKER)).toMatchObject({ skin: "neela" });
  });
});

/**
 * A skin OTHER than the house default. The vocabulary holds only Neela today, so no real request
 * can reach the re-render; this stand-in (typed past the DTO, which would reject it over HTTP)
 * pins the rule the second skin will exercise: re-render iff the skin the page PRINTS IN changes.
 */
const OTHER_SKIN = "saada" as unknown as ResumeSkin;

describe("ResumeSkinService.set — a persisted REAL change", () => {
  it("first choice: inserts, emits resume.skin_changed with previous_skin null ON THE SAME tx", async () => {
    const h = harness({ stored: null });
    expect(await h.service.set(WORKER, "neela", CTX, NOW)).toEqual({
      skin: "neela",
      previous_skin: null,
      change: "changed",
    });
    expect(h.db.committed).toBe("neela");
    expect(h.repo.lockSkin).toHaveBeenCalledWith(WORKER, h.TX);
    expect(h.repo.insertSkin).toHaveBeenCalledWith(WORKER, "neela", NOW, h.TX);
    expect(h.repo.updateSkin).not.toHaveBeenCalled();

    expect(h.events.emit).toHaveBeenCalledTimes(1);
    const params = h.events.emit.mock.calls[0]![0];
    expect(params).toEqual({
      event_name: "resume.skin_changed",
      actor: { actor_type: "worker", actor_id: WORKER },
      subject: { subject_type: "worker", subject_id: WORKER },
      payload: { worker_id: WORKER, skin: "neela", previous_skin: null },
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
      tx: h.TX,
    });
    // THE EXACT PAYLOAD, and it validates against the registry — not merely "an emit happened".
    const {
      correlationId: _c,
      requestId: _r,
      tx: _tx,
      ...input
    } = params as Record<string, unknown>;
    expect(
      Object.keys(
        createEvent({
          ...input,
          source: "api",
          metadata: { environment: "test", service: "api" },
        } as never).payload as object,
      ).sort(),
    ).toEqual(["previous_skin", "skin", "worker_id"]);

    // …but NO re-render: with no row the sheet already printed in Neela, so choosing Neela
    // changes no byte of the PDF.
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });

  it("a change the page SHOWS (to a non-default skin) queues a re-render of the latest résumé", async () => {
    const h = harness({ stored: null });
    expect((await h.service.set(WORKER, OTHER_SKIN, CTX, NOW)).change).toBe("changed");
    expect(h.rerender.enqueueLatest).toHaveBeenCalledWith(WORKER, CTX);
  });

  it("the re-render is queued AFTER the transaction commits, never inside it", async () => {
    const h = harness({ stored: null });
    const order: string[] = [];
    h.repo.withTransaction.mockImplementationOnce(async (cb) => {
      order.push("tx:open");
      const r = await cb(h.TX);
      order.push("tx:commit");
      return r;
    });
    h.rerender.enqueueLatest.mockImplementationOnce(async () => {
      order.push("rerender");
      return "resume-1";
    });
    await h.service.set(WORKER, OTHER_SKIN, CTX, NOW);
    expect(order).toEqual(["tx:open", "tx:commit", "rerender"]);
  });

  it("a change from a skin this build does not know UPDATES, reporting previous_skin null", async () => {
    const h = harness({ stored: "loha" });
    expect(await h.service.set(WORKER, "neela", CTX, NOW)).toEqual({
      skin: "neela",
      previous_skin: null,
      change: "changed",
    });
    expect(h.repo.updateSkin).toHaveBeenCalledWith(WORKER, "neela", NOW, h.TX);
    expect(h.repo.insertSkin).not.toHaveBeenCalled();
    expect(h.db.committed).toBe("neela");
    expect(h.events.emit.mock.calls[0]![0]).toMatchObject({
      payload: { worker_id: WORKER, skin: "neela", previous_skin: null },
    });
    // An unknown stored skin already rendered as Neela, so the page does not change.
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });
});

describe("ResumeSkinService.set — NOT a change", () => {
  it("re-selecting the skin already held writes nothing, emits nothing, re-renders nothing", async () => {
    const h = harness({ stored: "neela" });
    expect(await h.service.set(WORKER, "neela", CTX, NOW)).toEqual({
      skin: "neela",
      previous_skin: "neela",
      change: "unchanged",
    });
    expect(h.repo.insertSkin).not.toHaveBeenCalled();
    expect(h.repo.updateSkin).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });

  it("a retried first choice is a no-op the second time (exactly one event overall)", async () => {
    const h = harness({ stored: null });
    await h.service.set(WORKER, "neela", CTX, NOW);
    const again = await h.service.set(WORKER, "neela", CTX, NOW);
    expect(again.change).toBe("unchanged");
    expect(h.events.emit).toHaveBeenCalledTimes(1);
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });

  it("a concurrent first choice of the SAME skin (a double-tap) is the retry no-op, not a 409", async () => {
    const h = harness({ stored: null, concurrentWinner: "neela" });
    expect(await h.service.set(WORKER, "neela", CTX, NOW)).toEqual({
      skin: "neela",
      previous_skin: "neela",
      change: "unchanged",
    });
    expect(h.repo.lockSkin).toHaveBeenCalledTimes(2); // re-read after losing the insert
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });
});

describe("ResumeSkinService.set — fails closed", () => {
  it("an emit failure ROLLS THE PREFERENCE BACK and queues no re-render", async () => {
    const h = harness({ stored: null, emitThrows: true });
    await expect(h.service.set(WORKER, "neela", CTX, NOW)).rejects.toThrow("events insert failed");
    expect(h.repo.insertSkin).toHaveBeenCalledTimes(1); // the write WAS attempted on the tx…
    expect(h.db.committed).toBeNull(); // …and did not survive it
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
  });

  it("a concurrent first choice of a DIFFERENT skin is a 409 — no event, nothing of ours committed", async () => {
    const h = harness({ stored: null, concurrentWinner: "neela" });
    await expect(h.service.set(WORKER, OTHER_SKIN, CTX, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
    expect(h.db.committed).toBe("neela"); // the winner's choice stands
  });

  it("a re-render that cannot be queued never fails the committed choice", async () => {
    const h = harness({ stored: null });
    h.rerender.enqueueLatest.mockResolvedValueOnce(null);
    expect((await h.service.set(WORKER, OTHER_SKIN, CTX, NOW)).change).toBe("changed");
    expect(h.rerender.enqueueLatest).toHaveBeenCalledTimes(1);
    expect(h.db.committed).toBe(OTHER_SKIN);
  });
});
