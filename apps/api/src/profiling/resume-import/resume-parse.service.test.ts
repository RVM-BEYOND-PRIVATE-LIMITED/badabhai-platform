import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeParseOutput } from "@badabhai/ai-contracts";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";

import { ResumeParseService } from "./resume-parse.service";
import { RESUME_PARSE_TARGET_FIELDS } from "./resume-parse-fields";

/**
 * RI-3's Nest half: the call, the second wall, the spend record, the status transitions.
 *
 * AMENDED 2026-09-15: a successful parse writes NO status here any more — `settleParsed` in the
 * route service records `parsed` and the route in one statement — and a failure is recorded and
 * counted in one transaction, guarded, with an idempotency key.
 *
 * THE TWO THAT MATTER MOST, and they are not the happy path:
 *
 *   1. The spend is recorded even when the parse produced NOTHING. A call that happened was
 *      billed whatever its content turned out to be, and the case a spend investigation most
 *      needs to see is the one where money bought no coverage.
 *   2. A null from the AI service is an OUTAGE, never a problem with the worker's document.
 *      Every semantic failure comes back as a healthy 200 carrying its own reason, so there
 *      is no honest reading of null except "the service did not answer".
 */

const CTX = { correlationId: "corr-1", requestId: "req-1" } as never;
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";
/** The transaction executor — identity is what the tests assert. */
const TX = { executor: "tx" } as never;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: IMPORT,
    workerId: WORKER,
    storageKey: `resume-uploads/${WORKER}/abc.pdf`,
    mime: "application/pdf",
    status: "uploaded",
    ...overrides,
  };
}

function parseOutput(overrides: Partial<ResumeParseOutput> = {}): ResumeParseOutput {
  return {
    fields: {},
    employments: [],
    trade_association: null,
    unparsed_field_ids: [],
    notes: [],
    extraction_method: "pdf_text",
    page_count: 1,
    ocr_confidence: null,
    line_count: 12,
    failure_reason: null,
    ai_metadata: { ai_call_id: "c1", task_type: "resume_parse" } as never,
    ...overrides,
  };
}

function field(value: unknown, quote: string) {
  return {
    value,
    evidence: { message_index: 0, quote },
    source: "transcript" as const,
    normalization: "verbatim" as const,
    confidence: 0.9,
  };
}

function setup(opts: {
  row?: Record<string, unknown> | null;
  out?: ResumeParseOutput | null;
  markFailed?: boolean;
  emitThrows?: boolean;
}) {
  // `inTx` distinguishes "inside the transaction" from "next to it" — see the route test.
  const seen = { inTx: false, failedInTx: false, emitInTx: false };
  // THE WRITE SURFACE IS EXACTLY THIS. There is deliberately no `markParsed`: a success must
  // write no status, and re-adding such a call would throw here rather than pass quietly.
  const imports = {
    // `null` means "no such row for this worker"; omitted means the ordinary uploaded row.
    findForWorker: vi.fn().mockResolvedValue(opts.row === undefined ? row() : (opts.row ?? undefined)),
    markParsing: vi.fn().mockResolvedValue(true),
    withTransaction: vi.fn(async (cb: (tx: never) => Promise<unknown>) => {
      seen.inTx = true;
      try {
        return await cb(TX);
      } finally {
        seen.inTx = false;
      }
    }),
    markFailed: vi.fn(async () => {
      seen.failedInTx = seen.inTx;
      return opts.markFailed ?? true;
    }),
  };
  // `?? parseOutput()` would swallow an EXPLICIT null, which is the one case the outage
  // test exists to exercise. `in` distinguishes "not specified" from "specified as null".
  const ai = {
    parseResume: vi.fn().mockResolvedValue("out" in opts ? opts.out : parseOutput()),
  };
  const aiCost = { record: vi.fn().mockResolvedValue(undefined) };
  const events = {
    emit: vi.fn(async (_params: Record<string, unknown>) => {
      // RECORDED BEFORE THE THROW: whether the failure happened INSIDE the transaction is what
      // decides whether the status write rolls back with it.
      seen.emitInTx = seen.inTx;
      if (opts.emitThrows) throw new Error("events table unavailable");
      return undefined;
    }),
  };
  const svc = new ResumeParseService(
    imports as never,
    ai as never,
    aiCost as never,
    events as never,
  );
  return { svc, imports, ai, aiCost, events, seen };
}

describe("ResumeParseService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the storage KEY, never the document", async () => {
    // The ai-service fetches and extracts the object itself, so the résumé's text never
    // enters this process, its logs or its error paths. A future edit that "helpfully"
    // downloads the file here would undo that silently.
    const { svc, ai } = setup({});
    await svc.parse(WORKER, IMPORT, CTX);

    const sent = ai.parseResume.mock.calls[0]![0];
    expect(sent.storage_key).toBe(`resume-uploads/${WORKER}/abc.pdf`);
    expect(JSON.stringify(sent)).not.toContain("lines");
    expect(sent.target_fields).toEqual(RESUME_PARSE_TARGET_FIELDS);
  });

  it("records the spend even when the parse produced nothing usable", async () => {
    const { svc, aiCost } = setup({
      out: parseOutput({ failure_reason: "ocr_below_floor", extraction_method: "ocr" }),
    });
    await svc.parse(WORKER, IMPORT, CTX);

    expect(aiCost.record).toHaveBeenCalledOnce();
    expect(aiCost.record.mock.calls[0]![1]).toBe("resume_parse");
  });

  it("treats a null from the AI service as an outage, not as a bad document", async () => {
    const { svc, imports, events, aiCost } = setup({ out: null });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toMatchObject({ status: "failed", reason: "parse_unavailable" });
    expect(imports.markFailed).toHaveBeenCalledWith(IMPORT, "parse_unavailable", null, TX);
    // No call completed, so there is nothing to bill and a zero record would be a fiction.
    expect(aiCost.record).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledOnce();
  });

  it("passes the far side's own failure reason through unchanged", async () => {
    const { svc, imports, events } = setup({
      out: parseOutput({ failure_reason: "encrypted_document", extraction_method: null }),
    });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toMatchObject({ status: "failed", reason: "encrypted_document" });
    expect(imports.markFailed).toHaveBeenCalledWith(IMPORT, "encrypted_document", null, TX);
    const payload = events.emit.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(payload.reason).toBe("encrypted_document");
    expect(payload.extraction_method).toBeNull();
  });

  it("re-gates the response: a PAN the far side let through is dropped here", async () => {
    // THE SECOND WALL. On this route the far wall runs under a masking policy the owner can
    // flip, which is exactly when a second opinion is worth having.
    const { svc } = setup({
      out: parseOutput({
        fields: { current_city: field("PAN ABCDE1234F", "PAN ABCDE1234F") },
      }),
    });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result.status).toBe("parsed");
    expect((result as { fields: Record<string, unknown> }).fields.current_city).toBeUndefined();
  });

  it("keeps an honest field — the half that gets deleted if it is not asserted", async () => {
    const { svc } = setup({
      out: parseOutput({ fields: { current_city: field("Pune", "Pune") } }),
    });
    const result = await svc.parse(WORKER, IMPORT, CTX);
    const parsed = result as { fields: Record<string, { value: unknown }> };
    expect(parsed.fields.current_city!.value).toBe("Pune");
  });

  it("carries the extraction facts on the draft and writes NO status — the settle owns `parsed`", async () => {
    // CHANGED 2026-09-15. This used to assert a `markParsed` write. That write was the first half
    // of the split that let a client read `parsed` beside a null route; the facts can still come
    // from nowhere else, so they now travel on the draft to `settleParsed`.
    const { svc, imports, events } = setup({
      out: parseOutput({ extraction_method: "ocr", page_count: 2, ocr_confidence: 0.83 }),
    });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toMatchObject({
      status: "parsed",
      extractionMethod: "ocr",
      pageCount: 2,
      ocrConfidence: 0.83,
    });
    expect(imports.withTransaction).not.toHaveBeenCalled();
    expect(imports.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["outside the closed set", "html"],
  ])(
    "a SUCCESS whose extraction method is %s is `parse_output_invalid`, DEFERRED not cast",
    async (_label, method) => {
      // The contract types the method as an open nullable string; the column's CHECK and the
      // parsed event's non-null enum both refuse what a cast let through. The spend still counts.
      //
      // DEFERRED SINCE #1654: `parse_output_invalid` is one of the two reasons where the
      // document read fine and only our reply did not, so this service writes NOTHING and the
      // caller settles it after the identity summary has staged. The draft says so.
      const { svc, imports, events, aiCost } = setup({
        out: parseOutput({
          extraction_method: method,
          fields: { current_city: field("Pune", "Pune") },
        }),
      });
      const result = await svc.parse(WORKER, IMPORT, CTX);

      expect(result).toEqual({
        status: "failed",
        importId: IMPORT,
        reason: "parse_output_invalid",
        extractionMethod: null,
        settled: false,
      });
      expect(imports.markFailed).not.toHaveBeenCalled();
      expect(imports.withTransaction).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(aiCost.record).toHaveBeenCalledOnce();

      // …and `settleFailure` runs the identical transaction, with the same guard, the same
      // reason and the same idempotency key — it only runs it LATER.
      await svc.settleFailure(WORKER, result as never, CTX);

      expect(imports.markFailed).toHaveBeenCalledWith(IMPORT, "parse_output_invalid", null, TX);
      expect(events.emit).toHaveBeenCalledOnce();
      expect(events.emit.mock.calls[0]![0].idempotencyKey).toBe(
        `profile.resume_parse_failed:${IMPORT}`,
      );
      expect(events.emit.mock.calls[0]![0].payload).toMatchObject({
        reason: "parse_output_invalid",
        extraction_method: null,
      });
    },
  );

  it("`settleFailure` writes nothing for a draft this service already settled", async () => {
    // The processor only calls it on `settled: false`. This is the second guard: a draft that
    // says it is settled must never produce a second `profile.resume_parse_failed`.
    const { svc, imports, events } = setup({
      out: parseOutput({ failure_reason: "no_text_layer", extraction_method: "pdf_text" }),
    });
    const result = await svc.parse(WORKER, IMPORT, CTX);
    expect(result).toMatchObject({ status: "failed", settled: true });
    events.emit.mockClear();
    imports.markFailed.mockClear();

    await expect(svc.settleFailure(WORKER, result as never, CTX)).resolves.toBe(false);

    expect(imports.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a far-side failure naming a method outside the set records null, never the stray string", async () => {
    const { svc, imports, events } = setup({
      out: parseOutput({ failure_reason: "no_text_layer", extraction_method: "scanned" }),
    });
    await svc.parse(WORKER, IMPORT, CTX);

    expect(imports.markFailed).toHaveBeenCalledWith(IMPORT, "no_text_layer", null, TX);
    expect(events.emit.mock.calls[0]![0].payload).toMatchObject({ extraction_method: null });
  });

  it("a failure is written and counted INSIDE one transaction, with an idempotency key", async () => {
    const { svc, events, seen } = setup({
      out: parseOutput({ failure_reason: "ocr_below_floor", extraction_method: "ocr" }),
    });
    await svc.parse(WORKER, IMPORT, CTX);

    expect(seen.failedInTx).toBe(true);
    expect(seen.emitInTx).toBe(true);
    const call = events.emit.mock.calls[0]![0];
    expect(call.tx).toBe(TX);
    expect(call.idempotencyKey).toBe(`profile.resume_parse_failed:${IMPORT}`);
    expect(call.payload).toMatchObject({ extraction_method: "ocr", reason: "ocr_below_floor" });
  });

  it("an emit that fails does so INSIDE the transaction, so the `failed` write rolls back with it", async () => {
    // THE OTHER HALF OF "ONE WRITE, ONE EVENT, OR NEITHER", and the direction the guard cannot
    // cover: the guard stops a SECOND event, this stops a `failed` row with NO event — a
    // failure the funnel never counts, on a terminal row nothing will retry.
    //
    // A refactor that emitted after `withTransaction` returned would reject identically, so the
    // rejection is not the assertion; `seen.emitInTx` is.
    const { svc, imports, events, seen } = setup({ out: null, emitThrows: true });

    await expect(svc.parse(WORKER, IMPORT, CTX)).rejects.toThrow("events table unavailable");

    expect(imports.withTransaction).toHaveBeenCalledOnce();
    expect(imports.markFailed).toHaveBeenCalledOnce();
    expect(seen.failedInTx).toBe(true);
    expect(seen.emitInTx).toBe(true);
    expect(events.emit).toHaveBeenCalledOnce();
  });

  it("a failure guard that wrote nothing emits nothing, and does not claim the failure", async () => {
    // The row had already left `parsing` — settled by another path, or erased with the account.
    // Emitting anyway counts a failure this call never recorded.
    const { svc, imports, events } = setup({ out: null, markFailed: false });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(imports.markFailed).toHaveBeenCalledOnce();
    expect(events.emit).not.toHaveBeenCalled();
    expect(result.status).toBe("already_settled");
  });

  it("does NOT emit profile.resume_parsed — its payload needs RI-4's route", async () => {
    // Emitting it with a guessed route would record a handover that never happened. RI-4
    // owns `routeToTradeForm`, so RI-4 owns this event.
    const { svc, events } = setup({});
    await svc.parse(WORKER, IMPORT, CTX);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("is idempotent by status: a row already past `uploaded` is not re-parsed", async () => {
    // Re-running would spend a second model call on the same document — the cheapest kind of
    // duplicate charge to make and the hardest to notice, since both succeed.
    const { svc, ai, aiCost } = setup({ row: row({ status: "parsing" }) });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toEqual({ status: "already_settled", importStatus: "parsing" });
    expect(ai.parseResume).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
  });

  it("the LOSER of two concurrent deliveries stops instead of billing a second time", async () => {
    // `markParsing` is a conditional UPDATE `WHERE status = 'uploaded'`. Its boolean IS the
    // lock, and the first version of this service discarded it — so both deliveries read
    // `uploaded`, both called the AI service, and both billed for reading one document. The
    // repository's own docblock claimed the loser "gets zero rows back and stops"; nothing
    // made that true until this check existed.
    const { svc, imports, ai, aiCost } = setup({});
    imports.markParsing.mockResolvedValue(false);

    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toEqual({ status: "already_settled", importStatus: "parsing" });
    expect(ai.parseResume).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
  });

  it("an import belonging to another worker is simply not found", async () => {
    // `findForWorker` is worker-scoped BY CONSTRUCTION - the repository exposes no method
    // that can fetch this row by id alone, so the ownership check is the type system's
    // rather than a branch someone could forget. A miss here must spend nothing.
    const { svc, ai, aiCost } = setup({ row: null });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toEqual({ status: "not_found" });
    expect(ai.parseResume).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
  });
});

describe("ResumeParseService — trade association (Task 1 B2)", () => {
  it("sends the closed 21-kind list for the model to choose from", async () => {
    const { svc, ai } = setup({});
    await svc.parse(WORKER, IMPORT, CTX);

    const sent = ai.parseResume.mock.calls[0]![0] as { trade_kinds: unknown };
    expect(sent.trade_kinds).toEqual([...TRADE_FORM_KINDS_ALL]);
    expect(sent.trade_kinds).toContain("cnc_turner");
  });

  it("carries a listed judgment on the draft", async () => {
    const { svc } = setup({
      out: parseOutput({ trade_association: { kind: "welder" } }),
    });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toMatchObject({ status: "parsed", associationKind: "welder" });
  });

  it.each([["unlisted id", "astronaut"], ["wrong case", "CNC_TURNER"], ["empty", ""], ["absent", undefined]])(
    "narrows a %s judgment to null — never a value the CHECK would refuse",
    async (_label, kind) => {
      const { svc } = setup({
        out: parseOutput(
          kind === undefined ? {} : { trade_association: { kind: kind as string } },
        ),
      });
      const result = await svc.parse(WORKER, IMPORT, CTX);

      expect(result).toMatchObject({ status: "parsed", associationKind: null });
    },
  );
});
