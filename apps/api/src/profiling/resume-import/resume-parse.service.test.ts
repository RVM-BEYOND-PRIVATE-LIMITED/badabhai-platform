import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeParseOutput } from "@badabhai/ai-contracts";

import { ResumeParseService } from "./resume-parse.service";
import { RESUME_PARSE_TARGET_FIELDS } from "./resume-parse-fields";

/**
 * RI-3's Nest half: the call, the second wall, the spend record, the status transitions.
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

function setup(opts: { row?: Record<string, unknown> | null; out?: ResumeParseOutput | null }) {
  const imports = {
    // `null` means "no such row for this worker"; omitted means the ordinary uploaded row.
    findForWorker: vi.fn().mockResolvedValue(opts.row === undefined ? row() : (opts.row ?? undefined)),
    markParsing: vi.fn().mockResolvedValue(true),
    markParsed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  // `?? parseOutput()` would swallow an EXPLICIT null, which is the one case the outage
  // test exists to exercise. `in` distinguishes "not specified" from "specified as null".
  const ai = {
    parseResume: vi.fn().mockResolvedValue("out" in opts ? opts.out : parseOutput()),
  };
  const aiCost = { record: vi.fn().mockResolvedValue(undefined) };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const svc = new ResumeParseService(
    imports as never,
    ai as never,
    aiCost as never,
    events as never,
  );
  return { svc, imports, ai, aiCost, events };
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
    expect(imports.markFailed).toHaveBeenCalledWith(IMPORT, "parse_unavailable", null);
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
    expect(imports.markFailed).toHaveBeenCalledWith(IMPORT, "encrypted_document", null);
    const payload = events.emit.mock.calls[0]![0].payload;
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

  it("writes the extraction facts, which can come from nowhere else", async () => {
    const { svc, imports } = setup({
      out: parseOutput({ extraction_method: "ocr", page_count: 2, ocr_confidence: 0.83 }),
    });
    await svc.parse(WORKER, IMPORT, CTX);

    expect(imports.markParsed).toHaveBeenCalledWith(IMPORT, {
      extractionMethod: "ocr",
      pageCount: 2,
      ocrConfidence: 0.83,
    });
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

  it("an import belonging to another worker is simply not found", async () => {
    // `findForWorker` is worker-scoped BY CONSTRUCTION — the repository exposes no method
    // that can fetch this row by id alone, so the ownership check is the type system's
    // rather than a branch someone could forget. A miss here must spend nothing.
    const { svc, ai, aiCost } = setup({ row: null });
    const result = await svc.parse(WORKER, IMPORT, CTX);

    expect(result).toEqual({ status: "not_found" });
    expect(ai.parseResume).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
  });
});
