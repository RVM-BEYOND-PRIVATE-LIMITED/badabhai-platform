import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { WORKER_SEARCH_EXIT_VIAS } from "@badabhai/db";
import { SEARCH_VISIBILITY_VIAS, validateEvent } from "@badabhai/event-schema";

import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { SearchExitRepository, StoredSearchExit } from "./search-exit.repository";
import { SearchExitService } from "./search-exit.service";

/**
 * #2753 item 6 — `SearchExitService`: the switch first, one row per exit, one event per REAL change
 * in the row's transaction, and never a consent write. The SQL is the DB gate's
 * (`worker-search-exits.db.test.ts`).
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "c-2753", requestId: "r-2753" } as RequestContext;
const FIRST = new Date("2026-11-16T04:30:00.000Z");

/** An in-memory `worker_search_exits` with the repository's contract, and a transaction log. */
/** `on`: the switch value; `null` = the key absent from the config. Default on. */
function harness(opts: { on?: boolean | null; emitFails?: boolean } = {}) {
  const rows = new Map<string, StoredSearchExit>();
  const log: string[] = [];
  let txOpen = false;
  const TX = { tx: "the-transaction" };
  const inTx = (tx: unknown) => {
    if (tx !== TX || !txOpen) throw new Error("a write outside the transaction");
  };
  const repo = {
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      txOpen = true;
      const snapshot = new Map(rows);
      try {
        const out = await cb(TX);
        log.push("commit");
        return out;
      } catch (err) {
        rows.clear();
        for (const [k, v] of snapshot) rows.set(k, v);
        log.push("rollback");
        throw err;
      } finally {
        txOpen = false;
      }
    }),
    find: vi.fn(async (workerId: string, tx?: unknown) => {
      if (tx !== undefined) inTx(tx);
      log.push(tx === undefined ? "find(pool)" : "find(tx)");
      return rows.get(workerId) ?? null;
    }),
    insert: vi.fn(async (workerId: string, via: StoredSearchExit["via"], tx: unknown) => {
      inTx(tx);
      log.push("insert");
      if (rows.has(workerId)) return null;
      const row = { hiddenAt: rows.size === 0 ? FIRST : new Date(), via };
      rows.set(workerId, row);
      return row;
    }),
    remove: vi.fn(async (workerId: string, tx: unknown) => {
      inTx(tx);
      log.push("remove");
      return rows.delete(workerId);
    }),
  };
  const events = {
    emit: vi.fn(async (p: { tx?: unknown; event_name: string }) => {
      inTx(p.tx);
      log.push(`emit:${p.event_name}`);
      if (opts.emitFails) throw new Error("spine down");
      return p;
    }),
  };
  const config = (opts.on === null
    ? {}
    : { SEARCH_EXIT_ENABLED: opts.on ?? true }) as unknown as ServerConfig;
  const svc = new SearchExitService(
    repo as unknown as SearchExitRepository,
    events as unknown as EventsService,
    config,
  );
  return { svc, repo, events, rows, log };
}

type EmitCall = {
  event_name: string;
  actor: unknown;
  subject: unknown;
  payload: Record<string, unknown>;
  idempotencyKey?: unknown;
};
const emittedPayloads = (h: ReturnType<typeof harness>) =>
  h.events.emit.mock.calls.map((c) => (c[0] as unknown as EmitCall).payload);

describe("SearchExitService — the switch first", () => {
  it.each([
    [false, "false"],
    [null, "absent"],
  ])(
    "SEARCH_EXIT_ENABLED %s (%s): every method is a 404 that reads and writes nothing",
    async (on, _label) => {
      const h = harness({ on });
      await expect(h.svc.visibilityFor(WORKER)).rejects.toBeInstanceOf(NotFoundException);
      await expect(h.svc.setVisibility(WORKER, false, "worker", CTX)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(h.svc.setVisibility(WORKER, true, "monthly_check", CTX)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // No table read, no transaction, no event.
      expect(h.repo.find).not.toHaveBeenCalled();
      expect(h.repo.withTransaction).not.toHaveBeenCalled();
      expect(h.events.emit).not.toHaveBeenCalled();
    },
  );
});

describe("SearchExitService — GET", () => {
  it("in search: visible, no date; one pool read, no event", async () => {
    const h = harness();
    expect(await h.svc.visibilityFor(WORKER)).toEqual({ visible: true, hidden_since: null });
    expect(h.log).toEqual(["find(pool)"]);
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("out of search: not visible, since the stored hidden_at (ISO)", async () => {
    const h = harness();
    h.rows.set(WORKER, { hiddenAt: FIRST, via: "worker" });
    expect(await h.svc.visibilityFor(WORKER)).toEqual({
      visible: false,
      hidden_since: FIRST.toISOString(),
    });
  });
});

describe("SearchExitService — PUT: one event per REAL change, in the row's transaction", () => {
  it("visible:false takes him out: one insert, one event IN the transaction, the GET shape back", async () => {
    const h = harness();
    expect(await h.svc.setVisibility(WORKER, false, "worker", CTX)).toEqual({
      visible: false,
      hidden_since: FIRST.toISOString(),
    });
    expect(h.log).toEqual(["insert", "emit:worker.search_visibility_changed", "commit"]);
    const call = h.events.emit.mock.calls[0]![0] as unknown as EmitCall;
    expect(call).toMatchObject({
      event_name: "worker.search_visibility_changed",
      actor: { actor_type: "worker", actor_id: WORKER },
      subject: { subject_type: "worker", subject_id: WORKER },
      payload: { worker_id: WORKER, visible: false, via: "worker" },
    });
    // Exactly-once is the transaction's, not a key's (out → in → out is two real exits).
    expect(call.idempotencyKey).toBeUndefined();
  });

  it("a repeat visible:false is a no-op: the FIRST hidden_at stands, no second event", async () => {
    const h = harness();
    await h.svc.setVisibility(WORKER, false, "worker", CTX);
    const again = await h.svc.setVisibility(WORKER, false, "worker", CTX);
    const third = await h.svc.setVisibility(WORKER, false, "monthly_check", CTX);
    expect(again).toEqual({ visible: false, hidden_since: FIRST.toISOString() });
    expect(third).toEqual(again);
    expect(h.events.emit).toHaveBeenCalledTimes(1);
    // The first via stands too.
    expect(h.rows.get(WORKER)).toEqual({ hiddenAt: FIRST, via: "worker" });
    // The repeat re-read his row on the TRANSACTION, never the global pool.
    expect(h.log.filter((l) => l.startsWith("find"))).toEqual(["find(tx)", "find(tx)"]);
  });

  it("visible:true brings him back: the row deleted, one event; a repeat is a no-op", async () => {
    const h = harness();
    await h.svc.setVisibility(WORKER, false, "worker", CTX);
    expect(await h.svc.setVisibility(WORKER, true, "worker", CTX)).toEqual({
      visible: true,
      hidden_since: null,
    });
    expect(h.rows.has(WORKER)).toBe(false);
    expect(await h.svc.setVisibility(WORKER, true, "worker", CTX)).toEqual({
      visible: true,
      hidden_since: null,
    });
    expect(emittedPayloads(h)).toEqual([
      { worker_id: WORKER, visible: false, via: "worker" },
      { worker_id: WORKER, visible: true, via: "worker" },
    ]);
  });

  it("visible:true while never out writes nothing and emits nothing", async () => {
    const h = harness();
    expect(await h.svc.setVisibility(WORKER, true, "worker", CTX)).toEqual({
      visible: true,
      hidden_since: null,
    });
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("out → in → out is two real exits, two events each way", async () => {
    const h = harness();
    for (const visible of [false, true, false, true]) {
      await h.svc.setVisibility(WORKER, visible, "worker", CTX);
    }
    expect(emittedPayloads(h).map((p) => p.visible)).toEqual([false, true, false, true]);
  });

  it("an emit failure rolls the change back: the spine and the table never disagree", async () => {
    const h = harness({ emitFails: true });
    await expect(h.svc.setVisibility(WORKER, false, "worker", CTX)).rejects.toThrow("spine down");
    expect(h.rows.has(WORKER)).toBe(false);
    expect(h.log.at(-1)).toBe("rollback");
  });

  it("REUSABLE for the monthly check: via monthly_check rides the same rules", async () => {
    const h = harness();
    await h.svc.setVisibility(WORKER, false, "monthly_check", CTX);
    expect(h.rows.get(WORKER)?.via).toBe("monthly_check");
    expect(emittedPayloads(h)).toEqual([
      { worker_id: WORKER, visible: false, via: "monthly_check" },
    ]);
  });

  it("every payload it emits validates against the registered event (ids and closed values)", async () => {
    const h = harness();
    await h.svc.setVisibility(WORKER, false, "worker", CTX);
    await h.svc.setVisibility(WORKER, true, "worker", CTX);
    for (const payload of emittedPayloads(h)) {
      const result = validateEvent({
        event_id: "22222222-2222-4222-8222-222222222222",
        event_name: "worker.search_visibility_changed",
        event_version: 1,
        occurred_at: "2026-11-16T10:00:00.000Z",
        actor: { actor_type: "worker", actor_id: WORKER },
        subject: { subject_type: "worker", subject_id: WORKER },
        source: "api",
        correlation_id: "33333333-3333-4333-8333-333333333333",
        causation_id: null,
        payload,
        metadata: { environment: "test", service: "api" },
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("SearchExitService — never a consent write", () => {
  it("its only collaborators are the exit table, the spine and the config (no consent service)", () => {
    // The constructor takes three things; none of them can write `worker_consents`.
    expect(SearchExitService.length).toBe(3);
    const h = harness();
    expect(Object.keys(h.repo).sort()).toEqual(["find", "insert", "remove", "withTransaction"]);
  });

  it("no source file of the module names worker_consents, a consent repository or a consent event", () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8")
        // Prose may SAY consent is untouched; the code may not touch it.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(text, file).not.toMatch(/worker_consents|workerConsents/);
      expect(text, file).not.toMatch(/ConsentRepository|ConsentService/);
      expect(text, file).not.toMatch(/consent\.(accepted|withdrawn|revoked)/);
    }
  });
});

describe("the via vocabulary is ONE set in three places", () => {
  it("the table's CHECK constant, the event's enum and the service's type agree", () => {
    expect([...WORKER_SEARCH_EXIT_VIAS]).toEqual([...SEARCH_VISIBILITY_VIAS]);
  });
});
