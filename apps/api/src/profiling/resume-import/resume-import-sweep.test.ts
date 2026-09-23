import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "@badabhai/db";
import { serverEnvSchema } from "@badabhai/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResumeImportSweepProcessor,
  RESUME_IMPORT_SWEEP_BATCH_LIMIT,
} from "./resume-import-sweep.processor";
import { staleParsingStatement, staleUploadedStatement } from "./resume-import.repository";
import { ResumeParseService, type FailedDraft } from "./resume-parse.service";

/**
 * ADR-0041 §7's stale-import sweep (#1665) — the ruling, the vacuity guard and the race.
 *
 * WHAT IS PROVED WHERE, because it is not all provable in one place. The PREDICATE (only
 * `parsing`, only past the threshold) lives in SQL, so it is pinned against `drizzle.mock()` —
 * no database, and the WHERE clause itself is the thing under test. The BEHAVIOUR (one event,
 * the right actor, who wins a race) needs the real {@link ResumeParseService} over a fake
 * repository that keeps the one property the race turns on: `markFailed` is a GUARDED update.
 * A fake that always returned true would make every race test vacuous.
 */

const IMPORT_A = "11111111-1111-4111-8111-111111111111";
const IMPORT_B = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const db = drizzle.mock() as unknown as Database;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// The work list — the predicate, read off the compiled SQL
// ---------------------------------------------------------------------------------------------

describe("staleParsingStatement", () => {
  const staleBefore = new Date("2026-09-23T12:00:00.000Z");
  const compiled = staleParsingStatement(db, staleBefore, RESUME_IMPORT_SWEEP_BATCH_LIMIT).toSQL();

  it("asks ONLY for rows still in `parsing` — never a settled one", () => {
    // THE VACUITY GUARD'S FIRST HALF. Without `status = 'parsing'` the sweep's work list would
    // be every aged row in the table, including `parsed` ones a worker has already been routed
    // on. `markFailed`'s own guard would refuse to write them, so nothing would corrupt — but
    // the sweep would spend a transaction per healthy import forever, and the predicate would
    // have stopped saying what it means.
    expect(compiled.sql).toMatch(/"worker_resume_import"\."status" = \$\d+/);
    expect(compiled.params).toContain("parsing");
    // And it is not asking for any OTHER status by accident.
    for (const other of ["uploaded", "parsed", "failed", "discarded"]) {
      expect(compiled.params).not.toContain(other);
    }
  });

  it("asks ONLY for rows untouched since before the threshold", () => {
    // THE VACUITY GUARD'S SECOND HALF, and the one with teeth: drop this and the sweep settles
    // `failed` over every parse currently in flight, emitting the failure event for jobs that
    // are working perfectly. `<` and not `<=`, and bound to the caller's instant.
    expect(compiled.sql).toMatch(/"worker_resume_import"\."updated_at" < \$\d+/);
    // Bound to the caller's instant. Drizzle serialises a `timestamptz` param to a string, so
    // the comparison is on the instant it denotes, not on the object.
    const bound = compiled.params.find((p) => typeof p === "string" && p.includes("2026-09-23"));
    expect(bound, `no timestamp param in ${JSON.stringify(compiled.params)}`).toBeDefined();
    expect(new Date(bound as string).getTime()).toBe(staleBefore.getTime());
  });

  it("is a CONJUNCTION of the two, bounded and oldest-first", () => {
    // `or` would satisfy both assertions above while handing back the whole table. Pinned as
    // one clause, with the FIFO order that stops a row starving behind newer arrivals and the
    // limit that stops one tick holding a read over thousands of rows.
    expect(compiled.sql).toMatch(
      /where \("worker_resume_import"\."status" = \$\d+ and "worker_resume_import"\."updated_at" < \$\d+\)/,
    );
    expect(compiled.sql).toMatch(/order by "worker_resume_import"\."updated_at" asc/);
    expect(compiled.params).toContain(RESUME_IMPORT_SWEEP_BATCH_LIMIT);
  });

  it("selects opaque ids and a timestamp — never the document", () => {
    // The one cross-worker read in the repository. A `select()` here would put every worker's
    // storage key and sealed suggestion token behind a method that takes no owner.
    expect(compiled.sql).toMatch(/^select "id", "worker_id", "updated_at" from/);
    for (const forbidden of ["storage_key", "suggestions_enc", "identity_summary_text", "mime"]) {
      expect(compiled.sql).not.toContain(forbidden);
    }
  });
});

describe("staleUploadedStatement", () => {
  it("is a SEPARATE predicate over `uploaded`, and the sweep only ever counts it", () => {
    const compiled = staleUploadedStatement(db, new Date("2026-09-23T12:00:00.000Z"), 100).toSQL();
    expect(compiled.params).toContain("uploaded");
    expect(compiled.params).not.toContain("parsing");
    // Projected to one opaque column: this is a bounded COUNT, not a work list.
    expect(compiled.sql).toMatch(/^select "id" from/);
  });
});

// ---------------------------------------------------------------------------------------------
// The harness — a fake row store that keeps the guarded UPDATE
// ---------------------------------------------------------------------------------------------

interface FakeRow {
  id: string;
  workerId: string;
  status: string;
  failureReason: string | null;
  extractionMethod: string | null;
  updatedAt: Date;
}

const TX = {} as Database;

/**
 * The repository, faked down to the one property every race test below depends on: `markFailed`
 * is `UPDATE ... WHERE status = 'parsing'` and returns whether it matched a row. A fake that
 * always returned true would let two events be emitted for one import and every assertion here
 * would still pass.
 */
function fakeImports(rows: FakeRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    byId,
    findStaleParsing: vi.fn(async (staleBefore: Date, limit: number) =>
      [...byId.values()]
        .filter((r) => r.status === "parsing" && r.updatedAt < staleBefore)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, limit)
        .map((r) => ({ id: r.id, workerId: r.workerId, updatedAt: r.updatedAt })),
    ),
    countStaleUploaded: vi.fn(async (staleBefore: Date, limit: number) =>
      Math.min(
        [...byId.values()].filter((r) => r.status === "uploaded" && r.updatedAt < staleBefore)
          .length,
        limit,
      ),
    ),
    withTransaction: vi.fn(async (cb: (tx: Database) => Promise<unknown>) => cb(TX)),
    markFailed: vi.fn(
      async (id: string, reason: string, extractionMethod: string | null): Promise<boolean> => {
        const row = byId.get(id);
        if (!row || row.status !== "parsing") return false; // THE GUARD
        row.status = "failed";
        row.failureReason = reason;
        row.extractionMethod = extractionMethod;
        return true;
      },
    ),
  };
}

/** The emit params this suite reads back off the spine. */
interface EmittedEvent {
  event_name: string;
  actor: { actor_type: string; actor_id: string | null };
  subject: { subject_type: string; subject_id: string };
  payload: { worker_id: string; import_id: string; reason: string; extraction_method: unknown };
  idempotencyKey: string;
  tx: unknown;
}

function fakeEvents() {
  return { emit: vi.fn(async (_params: EmittedEvent) => ({})) };
}

const row = (over: Partial<FakeRow> = {}): FakeRow => ({
  id: IMPORT_A,
  workerId: WORKER,
  status: "parsing",
  failureReason: null,
  extractionMethod: null,
  updatedAt: new Date("2026-09-23T10:00:00.000Z"),
  ...over,
});

function harness(rows: FakeRow[]) {
  const imports = fakeImports(rows);
  const events = fakeEvents();
  const parse = new ResumeParseService(
    imports as never,
    {} as never, // AiService — the sweep reads no document and calls no model.
    {} as never, // AiCostRecorder — the sweep re-bills nothing.
    events as never,
  );
  const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
  const config = {
    RESUME_IMPORT_STALE_AFTER_SECONDS: 1_800,
    RESUME_IMPORT_SWEEP_INTERVAL_MINUTES: 15,
  };
  const proc = new ResumeImportSweepProcessor(
    imports as never,
    parse,
    queue as never,
    config as never,
  );
  return { proc, parse, imports, events, queue, config };
}

/** The one emit's params, as the spine received them. */
function emitted(events: ReturnType<typeof fakeEvents>, nth = 0): EmittedEvent {
  const call = events.emit.mock.calls[nth];
  expect(call, `expected an emit at index ${nth}`).toBeDefined();
  return call![0];
}

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

describe("ResumeImportSweepProcessor", () => {
  it("settles a row past the threshold as parse_deadline_exceeded, with a SYSTEM actor", async () => {
    const { proc, imports, events } = harness([
      row({ updatedAt: new Date("2026-09-23T10:00:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z")); // 2h > the 30m threshold

    await expect(proc.process()).resolves.toMatchObject({ stale: 1, settled: 1 });

    // The row.
    expect(imports.byId.get(IMPORT_A)).toMatchObject({
      status: "failed",
      failureReason: "parse_deadline_exceeded",
      // A `parsing` row never had a method written; null is the fact, not a default.
      extractionMethod: null,
    });

    // EXACTLY ONE event, and THE RULING: the reason is the same one a job-settled deadline
    // carries, and `system` is what tells the two apart (owner, 2026-09-23).
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(emitted(events)).toMatchObject({
      event_name: "profile.resume_parse_failed",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "worker", subject_id: WORKER },
      payload: {
        worker_id: WORKER,
        import_id: IMPORT_A,
        reason: "parse_deadline_exceeded",
        extraction_method: null,
      },
      idempotencyKey: `profile.resume_parse_failed:${IMPORT_A}`,
    });
    // ON THE SAME TRANSACTION as the row write. A `failed` row without its event is a failure
    // the funnel never counted; an event without the row is one counted twice.
    expect(emitted(events).tx).toBe(TX);
  });

  it("leaves a row INSIDE the threshold alone — the vacuity guard", async () => {
    // 10 minutes old against a 30-minute threshold: a job that may well still be working.
    const { proc, imports, events } = harness([
      row({ updatedAt: new Date("2026-09-23T11:50:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    await expect(proc.process()).resolves.toMatchObject({ stale: 0, settled: 0 });

    expect(imports.byId.get(IMPORT_A)).toMatchObject({ status: "parsing", failureReason: null });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("asks for rows stale past RESUME_IMPORT_STALE_AFTER_SECONDS, bounded by the batch limit", async () => {
    const { proc, imports } = harness([]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    await proc.process();

    const [staleBefore, limit] = imports.findStaleParsing.mock.calls[0] as [Date, number];
    expect(limit).toBe(RESUME_IMPORT_SWEEP_BATCH_LIMIT);
    // 12:00 minus 30 minutes. Drop the subtraction and this becomes 12:00 — every in-flight
    // parse swept on its first tick.
    expect(staleBefore.toISOString()).toBe("2026-09-23T11:30:00.000Z");
  });

  it("touches nothing that has already reached `parsed`, `failed` or `discarded`", async () => {
    const { proc, imports, events } = harness([
      row({ id: IMPORT_A, status: "parsed", updatedAt: new Date("2026-09-23T09:00:00Z") }),
      row({
        id: IMPORT_B,
        status: "failed",
        failureReason: "ocr_below_floor",
        updatedAt: new Date("2026-09-23T09:00:00Z"),
      }),
      row({
        id: "44444444-4444-4444-8444-444444444444",
        status: "discarded",
        updatedAt: new Date("2026-09-23T09:00:00Z"),
      }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    await expect(proc.process()).resolves.toMatchObject({ stale: 0, settled: 0 });

    expect(imports.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // The already-failed row keeps ITS reason — a sweep must never overwrite a recorded cause.
    expect(imports.byId.get(IMPORT_B)?.failureReason).toBe("ocr_below_floor");
  });

  it("counts rows stranded at `uploaded` and settles NONE of them", async () => {
    // THE DECIDED SCOPE (see the processor docblock). An `uploaded` row has no reply
    // outstanding — nothing was ever asked of the parser — so writing `parse_deadline_exceeded`
    // over it would put "our parser let this worker down" into the metric for an import the
    // parser never saw. It is counted so the backlog is visible, and left alone otherwise.
    const { proc, imports, events } = harness([
      row({ id: IMPORT_A, status: "uploaded", updatedAt: new Date("2026-09-23T09:00:00Z") }),
      row({ id: IMPORT_B, status: "uploaded", updatedAt: new Date("2026-09-23T09:30:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    await expect(proc.process()).resolves.toEqual({ stale: 0, settled: 0, staleUploaded: 2 });

    expect(imports.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(imports.byId.get(IMPORT_A)?.status).toBe("uploaded");
  });

  it("continues past a per-row failure instead of stranding the backlog", async () => {
    const { proc, imports, events } = harness([
      row({ id: IMPORT_A, updatedAt: new Date("2026-09-23T09:00:00Z") }),
      row({ id: IMPORT_B, updatedAt: new Date("2026-09-23T09:30:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    imports.withTransaction.mockRejectedValueOnce(new Error("deadlock detected"));

    await expect(proc.process()).resolves.toMatchObject({ stale: 2, settled: 1 });

    // Oldest-first, so A was the one that threw and B still got settled.
    expect(imports.byId.get(IMPORT_A)?.status).toBe("parsing");
    expect(imports.byId.get(IMPORT_B)?.status).toBe("failed");
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// THE RULING — actor, not a ninth reason
// ---------------------------------------------------------------------------------------------

describe("a swept row and a job-settled row (owner ruling, 2026-09-23)", () => {
  it("carry the SAME reason and are told apart ONLY by the actor", async () => {
    const { proc, parse, events } = harness([
      row({ id: IMPORT_A, updatedAt: new Date("2026-09-23T09:00:00Z") }),
      row({ id: IMPORT_B, updatedAt: new Date("2026-09-23T09:00:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    // (a) The JOB path: the #1654 deferral settling its own deadline failure.
    const draft: FailedDraft = {
      status: "failed",
      importId: IMPORT_B,
      reason: "parse_deadline_exceeded",
      extractionMethod: null,
      settled: false,
    };
    await parse.settleFailure(WORKER, draft, { correlationId: "c", requestId: "r" });

    // (b) The SWEEP path, over what is left.
    await proc.process();

    expect(events.emit).toHaveBeenCalledTimes(2);
    const job = emitted(events, 0);
    const swept = emitted(events, 1);

    // NO NINTH REASON. Both say the same thing about the import.
    expect(job.payload.reason).toBe("parse_deadline_exceeded");
    expect(swept.payload.reason).toBe("parse_deadline_exceeded");
    expect(job.event_name).toBe(swept.event_name);

    // THE ACTOR IS THE SEPARATOR, and it is already on every envelope.
    expect(job.actor).toEqual({ actor_type: "worker", actor_id: WORKER });
    expect(swept.actor).toEqual({ actor_type: "system", actor_id: null });

    // The SUBJECT is the worker on both — the import is his either way; only the hand that
    // settled it differs.
    expect(job.subject).toEqual(swept.subject);
  });
});

// ---------------------------------------------------------------------------------------------
// The race — one event, from either order
// ---------------------------------------------------------------------------------------------

describe("a sweep racing a live settle", () => {
  it("emits exactly ONE event when the live delivery wins", async () => {
    const { proc, parse, imports, events } = harness([
      row({ id: IMPORT_A, updatedAt: new Date("2026-09-23T09:00:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    // THE WINDOW ITSELF, not a re-read that would close it for free. The sweep's work list is
    // read while the row is genuinely `parsing`, and the live delivery settles it BEFORE the
    // sweep's own guarded UPDATE runs — the exact interval a lock would exist to cover, and
    // which the `WHERE status = 'parsing'` guard covers instead. Re-reading after the settle
    // would make this test pass without ever reaching `settleStale`.
    imports.findStaleParsing.mockImplementationOnce(async () => {
      const list = [
        { id: IMPORT_A, workerId: WORKER, updatedAt: new Date("2026-09-23T09:00:00Z") },
      ];
      await parse.settleFailure(
        WORKER,
        {
          status: "failed",
          importId: IMPORT_A,
          reason: "parse_output_invalid",
          extractionMethod: "pdf_text",
          settled: false,
        },
        { correlationId: "c", requestId: "r" },
      );
      return list;
    });

    // The sweep DOES reach its settle — and loses.
    await expect(proc.process()).resolves.toMatchObject({ stale: 1, settled: 0 });
    expect(imports.markFailed).toHaveBeenCalledTimes(2);

    // ONE event, from the winner. The sweep's `markFailed` matched zero rows and it emitted
    // nothing — so the funnel counts this import once, under the reason that actually happened.
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(emitted(events).actor).toEqual({ actor_type: "worker", actor_id: WORKER });
    expect(emitted(events).payload.reason).toBe("parse_output_invalid");
    expect(imports.byId.get(IMPORT_A)?.failureReason).toBe("parse_output_invalid");
  });

  it("emits exactly ONE event when the sweep wins", async () => {
    const { proc, parse, imports, events } = harness([
      row({ id: IMPORT_A, updatedAt: new Date("2026-09-23T09:00:00Z") }),
    ]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    await proc.process();

    // The live delivery comes back AFTER the sweep settled — a process that was paused, or a
    // BullMQ redelivery that had already read its draft. It loses the guard and writes nothing.
    const recorded = await parse.settleFailure(
      WORKER,
      {
        status: "failed",
        importId: IMPORT_A,
        reason: "parse_output_invalid",
        extractionMethod: "pdf_text",
        settled: false,
      },
      { correlationId: "c", requestId: "r" },
    );

    expect(recorded).toBe(false);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(emitted(events).actor).toEqual({ actor_type: "system", actor_id: null });
    // AND THE ROW IS NOT REWRITTEN. The loser must not overwrite the winner's reason.
    expect(imports.byId.get(IMPORT_A)).toMatchObject({
      failureReason: "parse_deadline_exceeded",
      extractionMethod: null,
    });
  });

  it("emits nothing at all on a second sweep tick over the same row", async () => {
    // A duplicated Redis job, or simply the next tick before the read reflects the write.
    const { proc, events } = harness([row({ updatedAt: new Date("2026-09-23T09:00:00Z") })]);
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));

    await proc.process();
    await expect(proc.process()).resolves.toMatchObject({ stale: 0, settled: 0 });

    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

describe("sweep registration", () => {
  it("registers the repeatable scheduler at boot", async () => {
    const { proc, queue } = harness([]);
    await proc.onApplicationBootstrap();
    await proc.whenRegistrationSettled();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("resume-import-sweep", {
      every: 900_000, // 15 minutes
    });
  });

  it("is IDEMPOTENT across boots — the same scheduler id, never a second scheduler", async () => {
    const { proc, queue } = harness([]);

    await proc.onApplicationBootstrap();
    await proc.whenRegistrationSettled();
    await proc.onApplicationBootstrap();
    await proc.whenRegistrationSettled();

    // Two boots, two upserts, ONE id. `upsertJobScheduler` keys on that id, so a rolling
    // deploy re-asserts the same scheduler (updating the cadence if config moved) instead of
    // stacking a duplicate that would double every tick.
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    const ids = new Set(queue.upsertJobScheduler.mock.calls.map((c) => c[0] as string));
    expect([...ids]).toEqual(["resume-import-sweep"]);
  });

  it("never throws out of boot when registration fails", async () => {
    const { proc, queue } = harness([]);
    queue.upsertJobScheduler.mockRejectedValue(new Error("redis down"));

    // A dead sweep is reported, not thrown: `onApplicationBootstrap` gates `app.listen()`, so
    // blocking here through a Redis outage would keep the whole API from serving.
    await expect(proc.onApplicationBootstrap()).resolves.toBeUndefined();
    proc.onModuleDestroy(); // abort the backoff chain so the test does not idle
    await proc.whenRegistrationSettled();
  });
});

// ---------------------------------------------------------------------------------------------
// The threshold's arithmetic, pinned where it is declared
// ---------------------------------------------------------------------------------------------

describe("RESUME_IMPORT_STALE_AFTER_SECONDS", () => {
  const defaults = serverEnvSchema.parse({
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
    JWT_SECRET: "y".repeat(40),
    // base64 of 32 zero-ish bytes — the schema checks the decoded length, not the string.
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });

  it("sits safely above the longest a legitimate delivery can take", () => {
    // The derivation in `packages/config/src/server.ts`, checked rather than trusted:
    //   3 AI calls x 100 s transport budget      = 300 s   (parse + summary + option-map)
    //   x 3 BullMQ attempts                      = 900 s
    //   + 1 s + 2 s exponential backoff          = 903 s
    //   + 30 s stalled-job reclaim               = 933 s
    const perDelivery = 3 * 100;
    const ceiling = 3 * perDelivery + 1 + 2 + 30;
    expect(ceiling).toBe(933);
    expect(defaults.RESUME_IMPORT_STALE_AFTER_SECONDS).toBeGreaterThan(ceiling);
    expect(defaults.RESUME_IMPORT_STALE_AFTER_SECONDS).toBe(1_800);
  });

  it("is not enforced by a cadence coarser than itself", () => {
    // A tick slower than the threshold makes the threshold a fiction: a row would wait up to
    // threshold + interval to be counted. This is why the cadence is in MINUTES where its
    // ACCOUNT_DELETION / CHAT_ABANDONMENT twins are in hours.
    const intervalSeconds = defaults.RESUME_IMPORT_SWEEP_INTERVAL_MINUTES * 60;
    expect(intervalSeconds).toBeLessThanOrEqual(defaults.RESUME_IMPORT_STALE_AFTER_SECONDS);
  });
});
