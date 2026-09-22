import { Logger } from "@nestjs/common";
import type { ResumeParseOutput } from "@badabhai/ai-contracts";
import type { BadaBhaiEvent } from "@badabhai/event-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventsService } from "../../events/events.service";
import { ResumeImportProcessor } from "./resume-import.processor";
import { ResumeParseService } from "./resume-parse.service";
import { ResumeRouteService } from "./resume-route.service";

/**
 * The whole job — the REAL parse service, the REAL route service, the REAL event builder — over
 * a fake repository that behaves like the table (amended 2026-09-15).
 *
 * WHAT THE FAKE MODELS, AND WHY EACH PART IS HERE:
 *   - The `wri_*` CHECKs, copied from `resume-import.ts`, with SQL's NULL-passes semantics. A
 *     split write that the database would accept, the fake accepts too; that is the point — the
 *     defect was a row that was LEGAL and wrong.
 *   - Transactions that ROLL BACK, and events that commit only with them. Without rollback, a
 *     throw inside the settle would look like a half-written row here and like nothing in
 *     Postgres, and the retry test would be testing a fiction.
 *   - A POLLER: every committed state is recorded. The client reads committed rows; the
 *     invariant it depends on is "no committed state is `parsed` with a null route".
 *
 * The SQL guards themselves are pinned where CI can see them (`*.query.test.ts`) and against
 * real CHECKs in the RUN_DB_TESTS suite. This file is the cross-service property neither can
 * express: across a retry the document is read ONCE, and each delivery emits an event for the
 * transition it settled and for no other — so a redelivery that settled nothing emits NOTHING,
 * not "at most one".
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";
const JOB = {
  // A REAL uuid, because the REAL event builder validates the envelope — which is the point of
  // using it rather than a mock that accepts anything.
  data: {
    workerId: WORKER,
    importId: IMPORT,
    correlationId: "33333333-3333-4333-8333-333333333333",
    requestId: "req-1",
  },
} as never;

type Row = {
  id: string;
  workerId: string;
  storageKey: string;
  mime: string;
  status: string;
  extractionMethod: string | null;
  ocrConfidence: number | null;
  pageCount: number | null;
  route: string | null;
  formKind: string | null;
  /** Task 1 B2 — the model's closed-list judgment; any of the 21 on either route. */
  associationKind: string | null;
  suggestionsEnc: string | null;
  failureReason: string | null;
};

const ASSOCIATION_KINDS = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "cam_programmer",
  "cad_draughtsman",
  "conventional_machinist",
  "tool_die_maker",
  "welder",
  "sheet_metal_worker",
  "press_operator",
  "painter_coating",
  "fitter",
  "maintenance_technician",
  "industrial_electrician",
  "assembly_line_worker",
  "quality_inspector",
  "injection_moulding_operator",
  "mould_die_maker",
  "blow_moulding_operator",
  "rubber_moulding_operator",
  "plastic_process_technician",
];

const IN = (set: readonly string[], v: string | null) => v === null || set.includes(v);

/** `resume-import.ts:109-138`, with SQL's rule that a NULL CHECK result passes. */
function assertChecks(r: Row): void {
  const fail = (name: string) => {
    throw new Error(`new row violates check constraint "${name}"`);
  };
  if (!["uploaded", "parsing", "parsed", "failed", "discarded"].includes(r.status)) fail("wri_status_chk");
  if (!IN(["pdf_text", "docx", "ocr"], r.extractionMethod)) fail("wri_extraction_method_chk");
  if (!IN(["form", "chat"], r.route)) fail("wri_route_chk");
  if (r.pageCount !== null && r.pageCount <= 0) fail("wri_page_count_chk");
  const ocrOk =
    (r.ocrConfidence === null && r.extractionMethod !== "ocr") ||
    (r.extractionMethod === "ocr" &&
      (r.ocrConfidence === null || (r.ocrConfidence >= 0 && r.ocrConfidence <= 1)));
  if (!ocrOk) fail("wri_ocr_confidence_chk");
  if (r.route !== null && (r.route === "form") !== (r.formKind !== null)) fail("wri_form_kind_chk");
  if (!IN(ASSOCIATION_KINDS, r.associationKind)) fail("wri_association_kind_chk");
  if ((r.status === "failed") !== (r.failureReason !== null)) fail("wri_failure_reason_chk");
  if (r.suggestionsEnc !== null && r.status !== "parsed") fail("wri_suggestions_chk");
}

class FakeImportsTable {
  row: Row = {
    id: IMPORT,
    workerId: WORKER,
    storageKey: `resume-uploads/${WORKER}/abc.pdf`,
    mime: "application/pdf",
    status: "uploaded",
    extractionMethod: null,
    ocrConfidence: null,
    pageCount: null,
    route: null,
    formKind: null,
    associationKind: null,
    suggestionsEnc: null,
    failureReason: null,
  };
  /** What a poller could have read: every committed state, in order. */
  readonly committed: Row[] = [];
  readonly events: BadaBhaiEvent[] = [];
  /** How many more in-transaction event inserts should throw — the events table falling over. */
  eventFailures = 0;
  private readonly keys = new Set<string>();
  private tx: { executor: symbol; pendingEvents: { event: BadaBhaiEvent; key?: string | null }[] } | null =
    null;

  async findForWorker(id: string, workerId: string) {
    return id === this.row.id && workerId === this.row.workerId ? { ...this.row } : undefined;
  }

  async markParsing(id: string): Promise<boolean> {
    return this.autocommit(() => {
      if (id !== this.row.id || this.row.status !== "uploaded") return false;
      this.row.status = "parsing";
      return true;
    });
  }

  async withTransaction<T>(cb: (tx: never) => Promise<T>): Promise<T> {
    const before = { ...this.row };
    this.tx = { executor: Symbol("tx"), pendingEvents: [] };
    try {
      const result = await cb(this.tx.executor as never);
      assertChecks(this.row);
      for (const { event, key } of this.tx.pendingEvents) this.commitEvent(event, key);
      if (JSON.stringify(before) !== JSON.stringify(this.row)) this.committed.push({ ...this.row });
      return result;
    } catch (error) {
      this.row = before;
      throw error;
    } finally {
      this.tx = null;
    }
  }

  async settleParsed(
    id: string,
    facts: { extractionMethod: string; pageCount: number | null; ocrConfidence: number | null , fieldsExtracted: 3},
    routing: { route: string; formKind: string | null; associationKind: string | null; suggestionsEnc: string | null },
    tx: unknown,
  ): Promise<boolean> {
    this.requireTx(tx);
    if (id !== this.row.id || this.row.status !== "parsing") return false;
    Object.assign(this.row, {
      status: "parsed",
      extractionMethod: facts.extractionMethod,
      pageCount: facts.pageCount,
      ocrConfidence: facts.extractionMethod === "ocr" ? facts.ocrConfidence : null,
      route: routing.route,
      formKind: routing.route === "form" ? routing.formKind : null,
      associationKind: routing.associationKind,
      suggestionsEnc: routing.suggestionsEnc,
    });
    assertChecks(this.row);
    return true;
  }

  async markFailed(id: string, reason: string, extractionMethod: string | null, tx: unknown) {
    this.requireTx(tx);
    if (id !== this.row.id || this.row.status !== "parsing") return false;
    Object.assign(this.row, { status: "failed", failureReason: reason, extractionMethod });
    assertChecks(this.row);
    return true;
  }

  /** The events repository's `insert`, routed through the open transaction when given one. */
  async insertEvent(event: BadaBhaiEvent, key?: string | null, executor?: unknown): Promise<boolean> {
    if (executor !== undefined) {
      this.requireTx(executor);
      if (this.eventFailures > 0) {
        this.eventFailures -= 1;
        throw new Error("events insert failed");
      }
      this.tx!.pendingEvents.push({ event, key });
      return true;
    }
    return this.commitEvent(event, key);
  }

  private commitEvent(event: BadaBhaiEvent, key?: string | null): boolean {
    if (key) {
      if (this.keys.has(key)) return false;
      this.keys.add(key);
    }
    this.events.push(event);
    return true;
  }

  private requireTx(tx: unknown): void {
    if (this.tx === null || tx !== this.tx.executor) {
      throw new Error("write outside the open transaction");
    }
  }

  private autocommit(write: () => boolean): boolean {
    const wrote = write();
    assertChecks(this.row);
    if (wrote) this.committed.push({ ...this.row });
    return wrote;
  }
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

function parseOutput(overrides: Partial<ResumeParseOutput> = {}): ResumeParseOutput {
  return {
    fields: { role_label: field("CNC Turner", "CNC Turner") },
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

function setup(
  opts: {
    out?: ResumeParseOutput;
    encryptFailures?: number;
    eventFailures?: number;
    summaryThrows?: boolean;
  } = {},
) {
  const table = new FakeImportsTable();
  table.eventFailures = opts.eventFailures ?? 0;
  const ai = { parseResume: vi.fn().mockResolvedValue(opts.out ?? parseOutput()) };
  const aiCost = { record: vi.fn().mockResolvedValue(undefined) };
  const events = new EventsService(
    { insert: table.insertEvent.bind(table) } as never,
    { NODE_ENV: "test" } as never,
  );
  const occupations = { resolve: vi.fn().mockResolvedValue({ pinned: null }) };
  const packs = {
    loadUniversal: vi.fn().mockResolvedValue({
      pack_id: "qp_universal",
      items: [
        {
          question_key: "primary_trade",
          prompt_text: "primary_trade",
          display_order: 0,
          target_kind: "attribute",
          target_field: "trade",
          target_skill_id: null,
          answer_type: "text",
          is_mandatory: false,
          is_core: false,
          max_asks: 2,
          min_turn: null,
          max_turn: null,
          ask_if: null,
          skip_if: null,
          parent_item_key: null,
          retry_text: null,
          why_text: null,
          options: [],
        },
      ],
    }),
    loadForFamily: vi.fn().mockResolvedValue({ pack_id: "qp_cnc_turning", items: [] }),
  };
  let encryptFailures = opts.encryptFailures ?? 0;
  const crypto = {
    encrypt: vi.fn((plaintext: string) => {
      if (encryptFailures > 0) {
        encryptFailures -= 1;
        throw new Error("key unavailable");
      }
      return `enc(${plaintext.length})`;
    }),
  };

  const parse = new ResumeParseService(table as never, ai as never, aiCost as never, events);
  const routing = new ResumeRouteService(
    table as never,
    occupations as never,
    packs as never,
    crypto as never,
    events,
    { map: vi.fn(async () => []) } as never,
  );
  // RI-summary is best-effort: null means "no summary", never a failure.
  //
  // THE ORDERING PROBE. Every call records what the row and the events table looked like AT
  // THAT MOMENT. That is the only way to pin #1654's race from outside: the real defect is
  // not "was the summary called" but "was it called while the client could still not see a
  // terminal row". A summary that runs after `markFailed` has already committed has lost —
  // the worker-app's `_pollToTerminal` returns on `hasFailed` and the chat has already asked
  // its first question by the time the line lands.
  const observed: { status: string; failureEvents: number }[] = [];
  const summary = {
    summarizeAndStage: vi.fn(async () => {
      observed.push({
        status: table.row.status,
        failureEvents: table.events.filter((e) => e.event_name === "profile.resume_parse_failed")
          .length,
      });
      if (opts.summaryThrows) throw new Error("summary exploded");
      return null;
    }),
  };
  return {
    processor: new ResumeImportProcessor(parse, routing, summary as never),
    table,
    ai,
    crypto,
    summary,
    observed,
  };
}

/** The client's reading: terminal status plus a null route means "chat". Never true of a form worker. */
const parsedWithoutRoute = (rows: Row[]) =>
  rows.filter((r) => r.status === "parsed" && r.route === null);

describe("ResumeImportProcessor — status and route land together, or not at all", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("a form-routed worker is NEVER observable as `parsed` with a null route", async () => {
    // THE DEFECT, stated as the client experiences it. The first cut committed `parsed` in the
    // parse service and the route in a second update; a poll between them sent this worker to
    // the chat.
    const { processor, table } = setup();

    const result = await processor.process(JOB);

    expect(result).toEqual({ import_id: IMPORT, route: "form" });
    // VACUITY CHECK: the poller saw something. An empty history would satisfy the next line.
    expect(table.committed.map((r) => r.status)).toEqual(["parsing", "parsed"]);
    expect(parsedWithoutRoute(table.committed)).toEqual([]);
    expect(table.row).toMatchObject({ status: "parsed", route: "form", formKind: "cnc_turner" });
    expect(table.row.suggestionsEnc).toMatch(/^enc\(/);
    expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parsed"]);
  });

  it("a seal that fails BEFORE the transaction opens leaves `parsing`, and the redelivery neither re-bills nor double-counts", async () => {
    // Attempts are 3 (`queue.module.ts`). This fault — the seal — happens while the decision is
    // still being made, so nothing was ever written and there is nothing to roll back; the row
    // is left `parsing` by omission. The rollback path proper is the test below, which faults
    // the event insert with the transaction open.
    //
    // The retry must see a row past `uploaded`, NOT call the AI service again, and complete
    // without inventing a route.
    const { processor, table, ai, crypto } = setup({ encryptFailures: 1 });

    await expect(processor.process(JOB)).rejects.toThrow("key unavailable");
    expect(table.row.status).toBe("parsing");
    expect(table.events).toEqual([]);

    const retried = await processor.process(JOB);

    expect(retried).toEqual({ import_id: IMPORT, route: null });
    expect(ai.parseResume).toHaveBeenCalledTimes(1);
    // VACUITY CHECK: the fault really was on the first delivery's settle path.
    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    // ZERO, NOT "AT MOST ONE". The implemented contract is that a delivery which settled nothing
    // emits nothing; `<= 1` was also satisfied by the redelivery emitting a `resume_parsed` for
    // a row it never wrote, which is the double-count the guard exists to stop.
    expect(table.events).toEqual([]);
    expect(parsedWithoutRoute(table.committed)).toEqual([]);
  });

  it("an emit that fails INSIDE the settle rolls the status back — no `parsed` row without its event", async () => {
    // THE ATOMICITY PROPERTY ITSELF, which the seal test above cannot show: the fault lands with
    // the transaction OPEN and the row already assigned `parsed`, `form` and a sealed token. The
    // event and the status must survive or die together — a committed `parsed` row with no
    // event is a handover the funnel never counted, on a TERMINAL row nothing will ever retry.
    const { processor, table, ai } = setup({ eventFailures: 1 });

    await expect(processor.process(JOB)).rejects.toThrow("events insert failed");

    expect(table.row).toMatchObject({ status: "parsing", route: null, formKind: null });
    expect(table.row.suggestionsEnc).toBeNull();
    expect(table.events).toEqual([]);
    // VACUITY CHECK: the poller saw the lock and NOTHING after it. An empty history would
    // satisfy `parsedWithoutRoute` on its own.
    expect(table.committed.map((r) => r.status)).toEqual(["parsing"]);
    expect(parsedWithoutRoute(table.committed)).toEqual([]);

    const retried = await processor.process(JOB);

    expect(retried).toEqual({ import_id: IMPORT, route: null });
    expect(ai.parseResume).toHaveBeenCalledTimes(1);
    expect(table.events).toEqual([]);
    expect(table.row.status).toBe("parsing");
  });

  it("a redelivery after a successful settle changes nothing and emits nothing", async () => {
    const { processor, table, ai } = setup();
    await processor.process(JOB);
    const settled = { ...table.row };

    const again = await processor.process(JOB);

    expect(again).toEqual({ import_id: IMPORT, route: null });
    expect(ai.parseResume).toHaveBeenCalledTimes(1);
    expect(table.row).toEqual(settled);
    expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parsed"]);
  });

  it("a success with no extraction method is a failure — one event, a closed reason, no cast", async () => {
    // The contract types `extraction_method` as an open nullable string. Before the narrowing a
    // cast carried null into a settle and an event that both refuse it, after the spend.
    const { processor, table } = setup({ out: parseOutput({ extraction_method: null }) });

    const result = await processor.process(JOB);

    expect(result).toEqual({ import_id: IMPORT, route: null });
    expect(table.row).toMatchObject({ status: "failed", failureReason: "parse_output_invalid" });
    expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parse_failed"]);
    expect(parsedWithoutRoute(table.committed)).toEqual([]);
  });
});

/**
 * Ruling D9 amendment (owner, 2026-09-22, #1654) — the identity line survives OUR failure.
 *
 * THE ASSERTION THAT MATTERS IS THE ORDER, not the call count. Widening the gate alone ships
 * a feature that is green in every unit test and invisible to every worker: `markFailed` makes
 * the row terminal, the app's poll returns on the first terminal read, the chat opens and asks
 * `identityForChat` — and the summary's LLM call is still in flight. `observed` records the
 * row's status and the failure-event count AT THE MOMENT the summary was entered; both must
 * still say "nothing has settled yet".
 */
describe("ResumeImportProcessor — the identity summary and OUR failures (#1654)", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Extraction SUCCEEDED; only our own model reply was unusable. */
  const OURS = ["parse_output_invalid", "parse_deadline_exceeded"] as const;
  /** The document itself was the problem. Nothing a second read could recover. */
  const THE_DOCUMENTS = ["no_text_layer", "encrypted_document"] as const;

  it.each(OURS)(
    "%s: the summary is attempted, and the failure settles only AFTER it",
    async (reason) => {
      const { processor, table, summary, observed } = setup({
        out: parseOutput({ failure_reason: reason, fields: {} }),
      });

      const result = await processor.process(JOB);

      expect(summary.summarizeAndStage).toHaveBeenCalledOnce();
      // The row is fetched by id + worker inside the service; the draft carries no document.
      expect(summary.summarizeAndStage).toHaveBeenCalledWith(WORKER, IMPORT, {
        correlationId: "33333333-3333-4333-8333-333333333333",
        requestId: "req-1",
      });
      // THE REGRESSION PIN. Still `parsing`, still uncounted, when the line was staged.
      expect(observed).toEqual([{ status: "parsing", failureEvents: 0 }]);
      // …and the settle really did happen afterwards, so this is an ORDER and not an omission.
      expect(table.row).toMatchObject({ status: "failed", failureReason: reason });
      expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parse_failed"]);
      expect(table.committed.map((r) => r.status)).toEqual(["parsing", "failed"]);
      expect(result).toEqual({ import_id: IMPORT, route: null });
    },
  );

  it.each(THE_DOCUMENTS)("%s: nothing is summarised, and the failure settles as before", async (reason) => {
    // THE DOCUMENT'S FAILURE, NOT OURS. The summary would degrade inside its own `extract()`
    // and stage nothing anyway — the closed set is what stops us paying a storage fetch and a
    // model call to rediscover that.
    const { processor, table, summary, observed } = setup({
      out: parseOutput({ failure_reason: reason, fields: {}, extraction_method: null }),
    });

    await processor.process(JOB);

    expect(summary.summarizeAndStage).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
    expect(table.row).toMatchObject({ status: "failed", failureReason: reason });
    expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parse_failed"]);
  });

  it("still exactly ONE `profile.resume_parse_failed`, including across a redelivery", async () => {
    // The settle moved; its guard did not. `markFailed` is still `WHERE status = 'parsing'`
    // and the event still rides the same transaction under the same idempotency key, so the
    // second delivery finds a row past `uploaded`, never reaches the summary, and counts
    // nothing.
    const { processor, table, ai, summary } = setup({
      out: parseOutput({ failure_reason: "parse_output_invalid", fields: {} }),
    });
    await processor.process(JOB);
    const settled = { ...table.row };

    const again = await processor.process(JOB);

    expect(again).toEqual({ import_id: IMPORT, route: null });
    expect(ai.parseResume).toHaveBeenCalledTimes(1);
    expect(summary.summarizeAndStage).toHaveBeenCalledTimes(1);
    expect(table.row).toEqual(settled);
    expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parse_failed"]);
  });

  it("a summary that THROWS still leaves the worker his failure record", async () => {
    // The summary is best-effort; the settle is not. The deferral must not have made the
    // failure record contingent on a second LLM call succeeding.
    const { processor, table, observed } = setup({
      out: parseOutput({ failure_reason: "parse_deadline_exceeded", fields: {} }),
      summaryThrows: true,
    });

    const result = await processor.process(JOB);

    expect(result).toEqual({ import_id: IMPORT, route: null });
    expect(observed).toEqual([{ status: "parsing", failureEvents: 0 }]);
    expect(table.row).toMatchObject({
      status: "failed",
      failureReason: "parse_deadline_exceeded",
    });
    expect(table.events.map((e) => e.event_name)).toEqual(["profile.resume_parse_failed"]);
  });

  it("on a PARSED import the summary still runs before the settle — the order that already worked", async () => {
    // VACUITY CHECK on the whole block: the failed path was made to match this one, so this
    // one must still be what it was.
    const { processor, table, observed } = setup();

    await processor.process(JOB);

    expect(observed).toEqual([{ status: "parsing", failureEvents: 0 }]);
    expect(table.row).toMatchObject({ status: "parsed", route: "form" });
  });
});
