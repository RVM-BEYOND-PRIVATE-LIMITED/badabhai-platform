import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { WORKER_FEEDBACK_CATEGORIES } from "@badabhai/types";
import type { NewWorkerFeedback } from "@badabhai/db";

import { FeedbackService } from "./feedback.service";
import type { FeedbackRepository } from "./feedback.repository";
import type { SubmitFeedbackDto } from "./feedback.dto";
import type { EventsService } from "../events/events.service";
import type { WorkersRepository } from "../workers/workers.repository";
import type { RequestContext } from "../common/request-context";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const FEEDBACK_ID = "ffffffff-0000-4000-8000-000000000001";
const APP_BUILD = "abc1234";
/** A SCREEN NAME, as `resolveScreenTemplate` hands it over — one of the app's own constants. */
const SCREEN = "/jobs/detail/:id";
const CTX: RequestContext = { requestId: "req-1", correlationId: "corr-1" };

/**
 * The worker's own words, written to look exactly like what a real one types: their name and
 * their phone number, in the middle of a complaint. EVERY privacy assertion in this file scans
 * for these two strings, because this is the one column on the worker spine allowed to hold
 * them — and the events table and the logs are two places that are not.
 */
const NAME = "mera naam Ramesh";
const PHONE = "9876543210";
const MESSAGE = `${NAME} hai, ${PHONE} par call karo, app kal se khul hi nahi raha`;

/** A fake `tx` token the mocked withTransaction hands to the callback (the mocks ignore it). */
const FAKE_TX = { __tx: true } as unknown;

/** Recursively collect every primitive leaf value of an object (for the no-PII scan). */
function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out);
  } else {
    out.push(String(value));
  }
  return out;
}

/**
 * A uuid, matched ANYWHERE inside a string rather than as a whole value — the ids this feature
 * carries arrive both bare (`worker_id`) and embedded (`feedback.submitted:<uuid>`, and every log
 * line), and only the substring form catches both.
 */
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A phone-shaped digit run — mirrors pseudonymize.py `_PHONE_RE`. */
const PHONE_LIKE_RE = /(?<!\d)\+?\d[\d\s-]{7,}\d(?!\d)/;
/**
 * True if any leaf of `value` looks phone-shaped once its uuids are masked out.
 *
 * MASKING FIRST IS THE WHOLE TRICK. A uuid is a long hyphenated hex run that the phone pattern
 * matches, and uuids are the legitimate opaque ids this event exists to carry — scanning without
 * masking them would fail on every correct implementation, which is a test nobody keeps. What
 * survives the mask is a digit run that is not an id, which is the thing worth failing on.
 */
function hasPhoneShapedLeaf(value: unknown): boolean {
  return leaves(value).some((leaf) => PHONE_LIKE_RE.test(leaf.replace(UUID_ANYWHERE_RE, "<uuid>")));
}

/** One captured `EventsService.emit` call — recorded whole, for the no-PII scan. */
interface CapturedEmit {
  event_name: string;
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
  requestId?: string;
  tx?: unknown;
}

function make(opts: { workerExists?: boolean; emitThrows?: boolean } = {}) {
  /** Call order across the two mocked layers — how "inside the transaction" is asserted. */
  const trace: string[] = [];
  const emitted: CapturedEmit[] = [];

  const repo = {
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      trace.push("tx:open");
      const out = await cb(FAKE_TX);
      trace.push("tx:commit");
      return out;
    }),
    // Params are typed even though the body ignores them: `mock.calls` is only inspectable when
    // the double declares the signature it stands in for.
    insert: vi.fn(async (_input: NewWorkerFeedback, _tx?: unknown) => {
      trace.push("insert");
      return { id: FEEDBACK_ID };
    }),
  };
  const workers = {
    findById: vi.fn(async () => ((opts.workerExists ?? true) ? { id: WORKER_ID } : undefined)),
  };
  const events = {
    emit: vi.fn(async (params: CapturedEmit) => {
      trace.push("emit");
      if (opts.emitThrows) throw new Error("simulated emit failure");
      // Recorded AFTER the throw check — a failed emit must never be observed as committed.
      emitted.push(params);
      return undefined;
    }),
  };

  const service = new FeedbackService(
    repo as unknown as FeedbackRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
  );

  // Capture logger output so we can prove the worker's words never reach a log line.
  const logs: string[] = [];
  (service as unknown as { logger: Record<string, (m: string) => void> }).logger = {
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
  };

  return { service, repo, workers, events, emitted, logs, trace };
}

const dto = (over: Partial<SubmitFeedbackDto> = {}): SubmitFeedbackDto => ({
  message: MESSAGE,
  ...over,
});

describe("FeedbackService.submit — the row (#997)", () => {
  it("stores the message under the TOKEN's worker, with the sanitized build", async () => {
    const { service, repo } = make();
    await service.submit(WORKER_ID, dto({ category: "problem" }), { appBuild: APP_BUILD, screenContext: SCREEN }, CTX);
    expect(repo.insert).toHaveBeenCalledWith(
      {
        workerId: WORKER_ID,
        category: "problem",
        message: MESSAGE,
        appBuild: APP_BUILD,
        screenContext: SCREEN,
      },
      FAKE_TX,
    );
  });

  it("returns the row id and nothing the worker typed", async () => {
    const { service } = make();
    await expect(service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX)).resolves.toEqual({
      id: FEEDBACK_ID,
    });
  });

  it("404s an unknown worker instead of letting the FK surface as a 500", async () => {
    // A deleted-mid-session account is the realistic path here, and a driver error after the
    // worker typed a paragraph is the worst way to tell them.
    const { service, repo } = make({ workerExists: false });
    await expect(service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("records an ABSENT category as null — never as 'other'", async () => {
    // Untagged is a real answer. Defaulting it would turn silence into a choice and make the
    // category histogram ops read a lie.
    const { service, repo, emitted } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX);
    expect(repo.insert.mock.calls[0]![0]).toMatchObject({ category: null });
    expect(emitted[0]!.payload).toMatchObject({ category: null });
  });

  it("carries every tag the client can send through to both the row and the event", async () => {
    for (const category of WORKER_FEEDBACK_CATEGORIES) {
      const { service, repo, emitted } = make();
      await service.submit(WORKER_ID, dto({ category }), { appBuild: null, screenContext: null }, CTX);
      expect(repo.insert.mock.calls[0]![0]).toMatchObject({ category });
      expect(emitted[0]!.payload).toMatchObject({ category });
    }
  });
});

describe("FeedbackService.submit — the event", () => {
  it("emits feedback.submitted with the SHAPE of the submission", async () => {
    const { service, emitted } = make();
    await service.submit(WORKER_ID, dto({ category: "suggestion" }), { appBuild: APP_BUILD, screenContext: SCREEN }, CTX);
    expect(emitted).toHaveLength(1);
    const evt = emitted[0]!;
    expect(evt.event_name).toBe("feedback.submitted");
    expect(evt.actor).toEqual({ actor_type: "worker", actor_id: WORKER_ID });
    expect(evt.subject).toEqual({ subject_type: "worker", subject_id: WORKER_ID });
    expect(evt.payload).toEqual({
      worker_id: WORKER_ID,
      feedback_id: FEEDBACK_ID,
      category: "suggestion",
      message_length: MESSAGE.length,
      app_build: APP_BUILD,
      screen_context: SCREEN,
    });
    expect(evt.correlationId).toBe(CTX.correlationId);
    expect(evt.requestId).toBe(CTX.requestId);
  });

  it("keys idempotency off the ROW id, so a committed-then-retried request cannot double-audit", async () => {
    const { service, emitted } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX);
    expect(emitted[0]!.idempotencyKey).toBe(`feedback.submitted:${FEEDBACK_ID}`);
  });

  it("NEVER puts the worker's words on the event — not the text, not a fragment, not a hash", async () => {
    // §2: the events table is exactly where raw PII must not land, and `message` is unbounded
    // free text a worker was explicitly invited to write anything into. The serialized scan is
    // the assertion that matters — it catches the text arriving under ANY field name, including
    // one nobody has thought of yet.
    const { service, emitted } = make();
    await service.submit(WORKER_ID, dto({ category: "problem" }), { appBuild: APP_BUILD, screenContext: SCREEN }, CTX);
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain(MESSAGE);
    expect(serialized).not.toContain(NAME);
    expect(serialized).not.toContain(PHONE);
    // No phone-shaped digit run on any non-uuid leaf either — the catch for a number that is
    // not the one this test happens to type.
    expect(hasPhoneShapedLeaf(emitted)).toBe(false);
    // What DID ride is the size of what was said.
    expect(emitted[0]!.payload.message_length).toBe(MESSAGE.length);
  });

  it("NEVER writes the worker's words to a log line", async () => {
    // The words are one authenticated admin screen away, behind an audited surface. Logging
    // them here would route around exactly that control, into a sink with no access story.
    const { service, logs } = make();
    await service.submit(WORKER_ID, dto({ category: "problem" }), { appBuild: APP_BUILD, screenContext: SCREEN }, CTX);
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(MESSAGE);
    expect(allLogs).not.toContain(NAME);
    expect(allLogs).not.toContain(PHONE);
    // Ids are stripped first: a uuid is a long hyphenated hex run that trips the phone pattern,
    // and logging one is exactly what this line is SUPPOSED to do.
    expect(allLogs.replace(UUID_ANYWHERE_RE, "<uuid>")).not.toMatch(PHONE_LIKE_RE);
    // …and it is not silent either: an operator asking "did it land?" gets the row id.
    expect(allLogs).toContain(FEEDBACK_ID);
    expect(allLogs).toContain(`length=${MESSAGE.length}`);
  });

  /**
   * ⚠ THE LOG LINE'S THIRD FIELD, WHICH SHIPPED WITH NO TEST AT ALL. `screen=` is the only
   * client-influenced value this service interpolates into a log, and the raw `dto.screen` —
   * unvalidated, `z.unknown()`, an unbounded attacker-chosen string — is still in scope on the
   * DTO at that line. Rewriting the interpolation to read `dto.screen` instead of the resolved
   * `client.screenContext` passed 44/44 before this test existed, because the fixture never set
   * `screen` and the privacy assertions above scan only for the message, the name and the phone.
   */
  it("logs the RESOLVED screen, never the raw one off the DTO", async () => {
    const { service, logs } = make();
    await service.submit(
      WORKER_ID,
      // What a client actually posts, and what the edge turned it into. They differ on purpose:
      // if the log read the DTO, the raw path — and its uuid — would appear.
      dto({ screen: "/jobs/detail/6f2c04e0-4f89-41d3-9a0c-0305e82c3301?q=welder" }),
      { appBuild: APP_BUILD, screenContext: "/jobs/detail/:id" },
      CTX,
    );
    const allLogs = logs.join("\n");
    expect(allLogs).toContain("screen=/jobs/detail/:id");
    expect(allLogs).not.toContain("6f2c04e0-4f89-41d3-9a0c-0305e82c3301");
    expect(allLogs).not.toContain("q=welder");
  });

  it("logs `unknown` for an absent screen rather than the word undefined", async () => {
    const { service, logs } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX);
    expect(logs.join("\n")).toContain("screen=unknown");
  });

  it("never logs the FULL worker id — enough to correlate, not enough to be a directory", async () => {
    const { service, logs } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX);
    expect(logs.join("\n")).not.toContain(WORKER_ID);
  });
});

describe("FeedbackService.submit — the row and the audit record are one write", () => {
  it("inserts and emits on the SAME transaction handle", async () => {
    // A feedback row with no audit record, or an audit record for a row that never landed, are
    // both states nobody can reconcile afterwards. Sharing the `tx` is what makes both
    // impossible rather than merely unlikely.
    const { service, repo, events } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: APP_BUILD, screenContext: SCREEN }, CTX);
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(repo.insert.mock.calls[0]![1]).toBe(FAKE_TX);
    expect((events.emit.mock.calls[0]![0] as CapturedEmit).tx).toBe(FAKE_TX);
  });

  it("does both INSIDE the transaction, before it commits", async () => {
    const { service, trace } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX);
    expect(trace).toEqual(["tx:open", "insert", "emit", "tx:commit"]);
  });

  it("propagates an emit failure so the row rolls back with it", async () => {
    // NOT the `job.search_performed` best-effort case: that event has no system-of-record row
    // behind it, so swallowing its failure costs telemetry only. Here it would cost the audit.
    const { service, trace } = make({ emitThrows: true });
    await expect(service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX)).rejects.toThrow(
      "simulated emit failure",
    );
    // The transaction never reached commit — the insert goes back with it.
    expect(trace).toEqual(["tx:open", "insert", "emit"]);
  });

  it("logs nothing at all when the write failed", async () => {
    // A "feedback recorded" line for a rolled-back transaction is worse than silence: it is the
    // line an operator would trust while looking for a row that does not exist.
    const { service, logs } = make({ emitThrows: true });
    await expect(service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX)).rejects.toThrow();
    expect(logs).toEqual([]);
  });
});

describe("FeedbackService.submit — the screen context is carried, and it is a SCREEN NAME", () => {
  it("stores and events the screen the edge handed over", async () => {
    // The service does not resolve — `resolveScreenTemplate` already did, at the controller.
    // What this pins is that the value reaches BOTH sinks: the row (where an admin reads it) and
    // the event (where the shape of the complaint is recorded). A field that landed in only one
    // would leave the spine and the screen disagreeing about which screen a report came from.
    const { service, repo, emitted } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: SCREEN }, CTX);
    expect(repo.insert.mock.calls[0]![0]).toMatchObject({ screenContext: SCREEN });
    expect(emitted[0]!.payload.screen_context).toBe(SCREEN);
  });

  it("carries NULL through unchanged — an unknown screen is a value, not a missing field", async () => {
    // Null is what a client that sent nothing, a value that failed normalization, and a row
    // written before the column existed all produce, and all three mean the same thing.
    // Substituting a placeholder here would invent a screen the worker was never on.
    const { service, repo, emitted } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: null, screenContext: null }, CTX);
    expect(repo.insert.mock.calls[0]![0]).toMatchObject({ screenContext: null });
    expect(emitted[0]!.payload.screen_context).toBeNull();
  });

  it("keeps the build stamp and the screen in their OWN fields — never crossed", async () => {
    // The two are adjacent nullable strings that the service takes as one named object for
    // exactly this reason: swapped, both would still pass every CHECK and every payload rule,
    // and nothing anywhere would fail. This is the assertion that would notice.
    const { service, repo, emitted } = make();
    await service.submit(WORKER_ID, dto(), { appBuild: APP_BUILD, screenContext: SCREEN }, CTX);
    expect(repo.insert.mock.calls[0]![0]).toMatchObject({
      appBuild: APP_BUILD,
      screenContext: SCREEN,
    });
    expect(emitted[0]!.payload.app_build).toBe(APP_BUILD);
    expect(emitted[0]!.payload.screen_context).toBe(SCREEN);
  });
});
