import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../common/request-context";
import { SetAnswerTextSourceSchema } from "./worker-answer-source.dto";
import { WorkerAnswerSourceService } from "./worker-answer-source.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

/** The one free-text pack answer a model is allowed to restate (#1350). */
const KEY = "iti_project_work";

/**
 * The two sentences this route exists to choose between: what the fresher actually typed, and what
 * the model made of it. Neither may appear in an event, a log line, or a queued job.
 */
const OWN_WORDS = "ITI me hydraulic jack banaya tha, lathe pe turning aur welding khud kiya";
const POLISHED =
  "Fabricated a hydraulic jack during ITI training, performing lathe turning and welding";

function setup(answersUpdated = 1, latestResume: unknown = null) {
  // Typed explicitly. `vi.fn(async () => ...)` infers a ZERO-ARG signature, so `mock.calls[0][1]`
  // is a type error even though the call happens at runtime - the tests passed and tsc did not.
  //
  // Returns how many answer rows it updated; ZERO is the not-this-worker's-answer answer, which
  // the service must turn into a 404.
  const setTextPolishDeclined = vi.fn(
    async (_workerId: string, _attributeKey: string, _declined: boolean) => answersUpdated,
  );
  const emit = vi.fn(async (_event: { event_name: string; payload: unknown }) => undefined);
  const add = vi.fn(async (_name: string, _data: unknown) => undefined);
  const latest = vi.fn(async (_workerId: string) => latestResume);
  const svc = new WorkerAnswerSourceService(
    { setTextPolishDeclined } as never,
    { latestResume: latest } as never,
    { emit } as never,
    { add } as never,
  );
  return { svc, setTextPolishDeclined, emit, add, latestResume: latest };
}

/** Through the real schema, so a test cannot hand the service a body the route would refuse. */
const body = (source: string) => SetAnswerTextSourceSchema.parse({ source });

/**
 * ═══ THE FRESHER'S SAY OVER A REWRITE OF HIS OWN SENTENCE (#1485) ═══
 *
 * The twin of `choosing which description prints (#1354)`, for the worker that one cannot reach: a
 * fresher has no employment, so the per-employment refusal gave him nothing, while his Zone 4 is
 * assembled from pack answers and its single worker-written segment carries more weight than any
 * line on an experienced worker's sheet.
 *
 * ADR-0039 is explicit that no test can assert the absence of a plausible-but-false rewrite — only
 * the worker knows. What is protected here is therefore his ABILITY TO SAY SO: that the refusal is
 * recorded, that it reaches the PDF an employer reads, that a wrong key cannot become a read of
 * somebody else's profile, and that neither sentence leaks while all that happens.
 */
describe("choosing which answer text prints (#1485)", () => {
  beforeEach(() => {
    // The real Logger would print a line per assertion run. Spied, not merely silenced — the
    // no-leak test below reads what was written.
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  it("records a refusal as declined, and reports how many answers moved", async () => {
    const { svc, setTextPolishDeclined } = setup(1, { id: "res-1" });
    const out = await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    // `own_words` is the REFUSAL: he is asking for his sentence, which means declining the model's.
    // Inverted, the sheet would keep printing the rewrite he just rejected.
    expect(setTextPolishDeclined).toHaveBeenCalledWith(WORKER, KEY, true);
    expect(out).toEqual({ answers_updated: 1 });
  });

  it("puts the rewrite back when he changes his mind", async () => {
    // The column is a flag and the polish is left in place precisely so this direction costs
    // nothing. A service that only ever wrote `true` would strand him on his first answer.
    const { svc, setTextPolishDeclined } = setup();
    await svc.setTextSource(WORKER, KEY, body("polished"), CTX);
    expect(setTextPolishDeclined).toHaveBeenCalledWith(WORKER, KEY, false);
  });

  it("404s an answer he does not have — never 403, no existence oracle", async () => {
    // Zero rows updated is what the UPDATE returns when the key is not this worker's answer AND
    // when it is nobody's: the WHERE carries `worker_id`, so the two cases are indistinguishable
    // by construction. A 403 would separate them, and "forbidden" on a key he never answered
    // tells him the row exists for SOMEONE — another worker's profile read off the status code.
    const { svc } = setup(0);
    await expect(svc.setTextSource(WORKER, KEY, body("own_words"), CTX)).rejects.toThrow(
      /not found/i,
    );
  });

  it("emits nothing and re-renders nothing when no answer was updated (fail closed)", async () => {
    const { svc, emit, add } = setup(0, { id: "res-1" });
    await expect(svc.setTextSource(WORKER, KEY, body("own_words"), CTX)).rejects.toThrow();
    // An event for a decision that was never stored would put a refusal in the audit trail that
    // no sheet honours, and a re-render would rebuild the PDF to say exactly what it already said.
    expect(emit).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    // DISCRIMINATING: the same two calls DO happen once a row moves, so the assertions above are
    // reading the guard and not a service that simply never emits or enqueues.
    const ok = setup(1, { id: "res-1" });
    await ok.svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    expect(ok.emit).toHaveBeenCalled();
    expect(ok.add).toHaveBeenCalled();
  });

  it("re-renders the EXISTING resume in place, so the choice reaches the sheet", async () => {
    // He is on the resume screen when he makes this choice, so there is a resume — and a choice
    // that does not reach the PDF an employer reads is not a choice. `force` is load-bearing: the
    // processor skips an already-rendered resume by default, which is every resume on this path.
    const { svc, add } = setup(1, { id: "res-1" });
    await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toBe("render");
    expect(add.mock.calls[0]![1]).toMatchObject({
      resumeId: "res-1",
      workerId: WORKER,
      force: true,
      correlationId: "corr",
    });
  });

  it("skips the re-render when he has no resume yet, and still records the choice", async () => {
    // The discriminating half of the test above: nothing to rebuild is the ordinary state of a
    // worker who answered the pack before his first generate, and it is not a failure.
    const { svc, add, setTextPolishDeclined } = setup(1, null);
    const out = await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    expect(add).not.toHaveBeenCalled();
    expect(setTextPolishDeclined).toHaveBeenCalledWith(WORKER, KEY, true);
    expect(out.answers_updated).toBe(1);
  });

  it("does not fail his write when the re-render queue is down", async () => {
    // Built inline rather than through setup(): the failure under test is the queue path throwing,
    // which setup()'s resolving mocks exist to avoid.
    const svc = new WorkerAnswerSourceService(
      { setTextPolishDeclined: async () => 1 } as never,
      {
        latestResume: async () => {
          throw new Error("redis down");
        },
      } as never,
      { emit: async () => undefined } as never,
      { add: async () => undefined } as never,
    );
    // The refusal is already committed by this point. Losing the re-render costs a stale PDF until
    // the next render; failing the request would tell him his refusal did not register, and the
    // only thing he can do about that is stop trusting the button.
    await expect(svc.setTextSource(WORKER, KEY, body("own_words"), CTX)).resolves.toEqual({
      answers_updated: 1,
    });
  });

  it("does not fail his write when the queue itself rejects the job", async () => {
    const svc = new WorkerAnswerSourceService(
      { setTextPolishDeclined: async () => 1 } as never,
      { latestResume: async () => ({ id: "res-1" }) } as never,
      { emit: async () => undefined } as never,
      {
        add: async () => {
          throw new Error("queue closed");
        },
      } as never,
    );
    await expect(svc.setTextSource(WORKER, KEY, body("polished"), CTX)).resolves.toEqual({
      answers_updated: 1,
    });
  });

  it("emits worker.answer_text_source_set carrying NEITHER his sentence nor the rewrite", async () => {
    const { svc, emit } = setup(1, { id: "res-1" });
    await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    const event = emit.mock.calls[0]![0];
    // A reused event name would make this decision unqueryable: the spine could not answer how
    // often workers refuse a rewrite, which is the one number #1350's mitigation is judged on.
    expect(event.event_name).toBe("worker.answer_text_source_set");

    // HALF ONE — nothing that is either version of the sentence travels. The whole premise of the
    // route is that one of the two may be false; an audit trail does not need the words to record
    // that he got to choose between them.
    const serialised = JSON.stringify(event.payload);
    for (const leak of [OWN_WORDS, POLISHED, "hydraulic jack", "welding", "lathe"]) {
      expect(serialised).not.toContain(leak);
    }
    // HALF TWO — an allow-list, so a payload that GROWS a field fails here rather than shipping a
    // `value_text` someone added for debugging.
    expect(event.payload).toEqual({
      worker_id: WORKER,
      attribute_key: KEY,
      source: "own_words",
    });
  });

  it("logs the key and the choice, never either sentence", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { svc } = setup(1, { id: "res-1" });
    await svc.setTextSource(WORKER, KEY, body("polished"), CTX);
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    // DISCRIMINATING: the line exists and says what happened, so the absence assertions below are
    // reading a real log line and not a service that logs nothing at all.
    expect(lines).toContain(KEY);
    expect(lines).toContain("polished");
    for (const leak of [OWN_WORDS, POLISHED, "hydraulic jack"]) {
      expect(lines).not.toContain(leak);
    }
  });

  it("puts neither sentence on the render job either", async () => {
    // The job is a pointer — resume id, worker id, flags. A producer that helpfully attached the
    // text would put it in Redis, which §3 counts as outside the DB boundary.
    const { svc, add } = setup(1, { id: "res-1" });
    await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    const job = JSON.stringify(add.mock.calls[0]![1]);
    for (const leak of [OWN_WORDS, POLISHED, "hydraulic jack"]) {
      expect(job).not.toContain(leak);
    }
  });

  it("writes the decision BEFORE emitting and re-rendering", async () => {
    // Order is the whole of "fail closed" here: an event emitted ahead of the UPDATE would survive
    // a write that then failed, and the spine would record a refusal the sheet never honours.
    const { svc, setTextPolishDeclined, emit, add } = setup(1, { id: "res-1" });
    await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    expect(setTextPolishDeclined.mock.invocationCallOrder[0]!).toBeLessThan(
      emit.mock.invocationCallOrder[0]!,
    );
    expect(emit.mock.invocationCallOrder[0]!).toBeLessThan(add.mock.invocationCallOrder[0]!);
  });

  it("is idempotent at this layer — the same choice twice is the same write twice", async () => {
    // PUT, not POST: the route is a state he sets and re-sets. Nothing here may treat the second
    // identical call as a no-op, because the first one may have been the one that got lost.
    const { svc, setTextPolishDeclined } = setup(1, { id: "res-1" });
    await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    await svc.setTextSource(WORKER, KEY, body("own_words"), CTX);
    expect(setTextPolishDeclined).toHaveBeenCalledTimes(2);
    expect(setTextPolishDeclined.mock.calls[1]).toEqual([WORKER, KEY, true]);
  });
});
