import { Logger } from "@nestjs/common";
import type { ParsedField } from "@badabhai/ai-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeRouteService } from "./resume-route.service";
import type { ParsedDraft } from "./resume-parse.service";

/**
 * RI-4's routing decision, and the settle that records it. Three properties carry this file:
 *
 *   1. THE DECISION IS THE ROUTER'S, not the model's. Every case below drives it through the
 *      labels a parse produces and asserts the route the deterministic table already gives the
 *      interview for the same words.
 *   2. NOTHING BECOMES AN ANSWER (ruling D2). The only write this service may make is
 *      `settleParsed`, and a test asserts exactly that rather than trusting the reading.
 *   3. ONE WRITE, ONE EVENT, OR NEITHER (amended 2026-09-15). Status and route land in one
 *      guarded statement, the event rides the same transaction with an idempotency key, and a
 *      guard that wrote nothing emits nothing. An outage degrades to chat; a fault throws.
 */

const CTX = { correlationId: "corr-1", requestId: "req-1" };
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";
/** The transaction executor handed to `withTransaction`'s callback — identity is what's asserted. */
const TX = { executor: "tx" } as never;

const field = (value: unknown): ParsedField => ({
  value,
  evidence: { message_index: 1, quote: "a line from the document" },
  source: "transcript",
  normalization: "verbatim",
  confidence: 0.9,
});

const packItem = (questionKey: string, targetField: string) => ({
  question_key: questionKey,
  prompt_text: questionKey,
  display_order: 0,
  target_kind: "attribute" as const,
  target_field: targetField,
  target_skill_id: null,
  answer_type: "text" as const,
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
});

function setup(
  opts: {
    pinnedFamily?: string | null;
    resolveThrows?: boolean;
    settled?: boolean;
    universalThrows?: Error;
    familyThrows?: Error;
    encryptThrows?: boolean;
  } = {},
) {
  // `inTx` is how a test tells "called inside the transaction" from "called next to it". The
  // settle and the emit must BOTH see it true; a refactor that emits after the callback returns
  // would pass an identity check on `tx` by accident and fail this one.
  const seen = { inTx: false, settleInTx: false, emitInTx: false };
  const imports = {
    withTransaction: vi.fn(async (cb: (tx: never) => Promise<unknown>) => {
      seen.inTx = true;
      try {
        return await cb(TX);
      } finally {
        seen.inTx = false;
      }
    }),
    settleParsed: vi.fn(async () => {
      seen.settleInTx = seen.inTx;
      return opts.settled ?? true;
    }),
  };
  const occupations = {
    resolve: opts.resolveThrows
      ? vi.fn().mockRejectedValue(new Error("occupation index unavailable"))
      : vi.fn().mockResolvedValue({
          pinned:
            opts.pinnedFamily === undefined || opts.pinnedFamily === null
              ? null
              : { familyId: opts.pinnedFamily, label: "CNC Turner", jobDomainId: "d", confidence: 0.9, iscoUnitCode: null, layer: "L0" },
        }),
  };
  const packs = {
    loadUniversal: opts.universalThrows
      ? vi.fn().mockRejectedValue(opts.universalThrows)
      : vi.fn().mockResolvedValue({
          pack_id: "qp_universal",
          items: [packItem("primary_trade", "trade")],
        }),
    loadForFamily: opts.familyThrows
      ? vi.fn().mockRejectedValue(opts.familyThrows)
      : vi.fn().mockResolvedValue({ pack_id: "qp_cnc_turning", items: [] }),
  };
  const crypto = {
    encrypt: vi.fn((plaintext: string) => {
      if (opts.encryptThrows) throw new Error("key unavailable");
      return `enc(${plaintext})`;
    }),
  };
  const events = {
    emit: vi.fn(async () => {
      seen.emitInTx = seen.inTx;
      return undefined;
    }),
  };

  const svc = new ResumeRouteService(
    imports as never,
    occupations as never,
    packs as never,
    crypto as never,
    events as never,
  );
  return { svc, imports, occupations, packs, crypto, events, seen };
}

const parsedDraft = (fields: Record<string, ParsedField>): ParsedDraft => ({
  status: "parsed",
  importId: IMPORT,
  fields,
  employments: [],
  extractionMethod: "pdf_text",
  pageCount: 1,
  ocrConfidence: null,
});

type EmitCall = { payload: Record<string, unknown>; tx?: unknown; idempotencyKey?: string };
const emitCall = (events: { emit: { mock: { calls: unknown[][] } } }): EmitCall =>
  events.emit.mock.calls[0]![0] as EmitCall;
const routingWritten = (imports: { settleParsed: { mock: { calls: unknown[][] } } }) =>
  imports.settleParsed.mock.calls[0]![2] as {
    route: string;
    formKind: string | null;
    suggestionsEnc: string | null;
  };

describe("the deterministic router decides, and the résumé only supplies its inputs", () => {
  it("a CNC turner's résumé hands him to the turning form", async () => {
    const { svc, imports } = setup();
    const result = await svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner"), domain_label: field("CNC Machining") }),
      CTX,
    );

    expect(result?.route).toBe("form");
    expect(result?.formKind).toBe("cnc_turner");
    expect(imports.settleParsed).toHaveBeenCalledWith(
      IMPORT,
      { extractionMethod: "pdf_text", pageCount: 1, ocrConfidence: null },
      expect.objectContaining({ route: "form", formKind: "cnc_turner" }),
      TX,
    );
  });

  it("'CNC Turner cum VMC Operator' is VETOED to chat — and the same label without the conflict is not", async () => {
    // THE CONFLICT VETO, reached through a résumé instead of a spoken turn. Nothing in this
    // phase knows what a VMC is; the routing table already did.
    //
    // THE POSITIVE CONTROL IS THE TEST. "Chat" is also what an empty haystack produces, so
    // asserting the veto alone passes when the label never reaches the router at all — a
    // mutation nulling `role_label` proved exactly that. The pair distinguishes them: same
    // worker, same everything, one word removed, and the route must change.
    const vetoed = await setup().svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner cum VMC Operator") }),
      CTX,
    );
    const clean = await setup().svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(vetoed?.route).toBe("chat");
    expect(vetoed?.formKind).toBeNull();
    expect(clean?.route).toBe("form");
    expect(clean?.formKind).toBe("cnc_turner");
  });

  it("a résumé with no role at all routes to chat rather than guessing", async () => {
    const { svc, occupations } = setup();
    const result = await svc.route(WORKER, parsedDraft({ current_city: field("Pune") }), CTX);

    expect(result?.route).toBe("chat");
    // Nothing to resolve, so nothing is asked of the occupation ladder.
    expect(occupations.resolve).not.toHaveBeenCalled();
  });

  it("the chat route stores NO form kind — the CHECK constraint is an equivalence", async () => {
    const { svc, imports } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("Security Guard") }), CTX);
    expect(routingWritten(imports)).toEqual(
      expect.objectContaining({ route: "chat", formKind: null }),
    );
  });
});

describe("DEGRADES ON AN OUTAGE (ruling D9)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an occupation index that is down costs corroboration, not the worker's journey", async () => {
    const { svc, events } = setup({ resolveThrows: true });
    const result = await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    // The TERM match still stands on the model's own labels, so this particular worker is still
    // routed. The point is that nothing threw.
    expect(result?.route).toBe("form");
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it("a universal pack that cannot load settles CHAT with nothing staged — and still counts it", async () => {
    // "CNC Turner" routes to the FORM when the packs load (first describe). Using the same label
    // here is the positive control: a chat result can only come from the degrade, not from a
    // label the router never matched.
    const error = Object.assign(new TypeError("pack qp_universal@v3 at /packs/universal.json"), {});
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, imports, events, crypto } = setup({ universalThrows: error });

    const result = await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(result).toEqual({
      route: "chat",
      formKind: null,
      fieldsExtracted: 1,
      suggestionsOffered: 0,
    });
    expect(routingWritten(imports)).toEqual({ route: "chat", formKind: null, suggestionsEnc: null });
    expect(crypto.encrypt).not.toHaveBeenCalled();
    const call = emitCall(events);
    expect(call.payload).toMatchObject({ route: "chat", form_kind: null, suggestions_offered: 0 });

    // THE CLASS NAME, NEVER THE MESSAGE — the message is where a pack path or key would ride.
    const logged = errorLog.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("qp_universal@v3");
  });

  it("a trade pack that cannot load also degrades — a form with no pack behind it is not a route", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, imports } = setup({ familyThrows: new Error("family pack unavailable") });
    const result = await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(result?.route).toBe("chat");
    expect(routingWritten(imports)).toEqual({ route: "chat", formKind: null, suggestionsEnc: null });
  });

  it("a failed parse settles nothing, emits nothing, and returns null — not a pretend chat route", async () => {
    // The funnel's middle step must stay answerable. `resume_parse_failed` has already been
    // emitted by the parse service; emitting `resume_parsed` here too would count one document
    // as both a success and a failure.
    //
    // CHANGED 2026-09-15: this used to assert `route: "chat"`. A route this call never decided
    // is exactly the kind of claim the settle fix removes, so the return is now `null`.
    const { svc, events, imports } = setup();
    const result = await svc.route(
      WORKER,
      { status: "failed", importId: IMPORT, reason: "empty_document" },
      CTX,
    );

    expect(result).toBeNull();
    expect(events.emit).not.toHaveBeenCalled();
    expect(imports.withTransaction).not.toHaveBeenCalled();
    expect(imports.settleParsed).not.toHaveBeenCalled();
  });
});

describe("A FAULT IS NOT AN OUTAGE — it throws and settles nothing (CLAUDE.md §3)", () => {
  it("a suggestion payload that cannot be encrypted rejects the route and never opens the settle", async () => {
    // THE MUTATION THIS PINS: widening the pack-load catch to the whole decision. That would
    // turn "we could not seal his employer names" into a quiet chat route with a `parsed` row.
    const { svc, imports, events, crypto } = setup({ encryptThrows: true });

    await expect(
      svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX),
    ).rejects.toThrow("key unavailable");

    // VACUITY CHECK: the throw must have come from the encrypt, not from somewhere earlier.
    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    expect(imports.withTransaction).not.toHaveBeenCalled();
    expect(imports.settleParsed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("an event payload the registry would refuse is refused BEFORE the transaction opens", async () => {
    const { svc, imports, events } = setup();
    const draft = { ...parsedDraft({ role_label: field("CNC Turner") }), extractionMethod: "html" };

    await expect(svc.route(WORKER, draft as never, CTX)).rejects.toThrow();
    expect(imports.withTransaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("one write, one event, or neither", () => {
  it("the settle and the emit run INSIDE one transaction, and the event carries its idempotency key", async () => {
    const { svc, imports, events, seen } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(imports.withTransaction).toHaveBeenCalledTimes(1);
    expect(seen.settleInTx).toBe(true);
    expect(seen.emitInTx).toBe(true);
    const call = emitCall(events);
    expect(call.tx).toBe(TX);
    expect(call.idempotencyKey).toBe(`profile.resume_parsed:${IMPORT}`);
  });

  it("a guard that wrote nothing emits nothing and returns null", async () => {
    // A redelivery, or a row already failed or erased. The boolean is the entitlement to emit;
    // ignoring it counts one document twice.
    const { svc, imports, events } = setup({ settled: false });
    const result = await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(imports.settleParsed).toHaveBeenCalledTimes(1);
    expect(events.emit).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("what is written, and what is never written", () => {
  it("staged suggestions are ENCRYPTED — the row never holds the worker's words in clear", async () => {
    const { svc, imports, crypto } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    expect(routingWritten(imports).suggestionsEnc).toMatch(/^enc\(/);
    // VACUITY CHECK. If the payload were empty this assertion would pass while proving nothing,
    // so assert the plaintext actually contained the value before asserting it was encrypted.
    expect(crypto.encrypt.mock.calls[0]![0]).toContain("CNC Turner");
  });

  it("an import with nothing to offer stores null rather than an encrypted empty object", async () => {
    const { svc, imports, crypto } = setup();
    await svc.route(WORKER, parsedDraft({ machines: field(["Fanuc Oi-MF"]) }), CTX);

    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(routingWritten(imports).suggestionsEnc).toBeNull();
  });

  it("`settleParsed` is the ONLY write — no answer, no attribute (ruling D2)", async () => {
    // Structural, not incidental. The repository this service holds exposes exactly one write it
    // can reach (plus the transaction it runs in); if a later change injects an answer
    // repository here, this breaks.
    const { svc, imports } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(Object.keys(imports)).toEqual(["withTransaction", "settleParsed"]);
    expect(imports.settleParsed).toHaveBeenCalledTimes(1);
  });
});

describe("the event is the funnel's middle number, and carries no document text", () => {
  let emitted: Record<string, unknown>;

  beforeEach(async () => {
    const { svc, events } = setup();
    await svc.route(
      WORKER,
      parsedDraft({
        role_label: field("CNC Turner"),
        current_city: field("Pune"),
        machines: field(["Fanuc Oi-MF"]),
      }),
      CTX,
    );
    emitted = emitCall(events).payload;
  });

  it("counts what was extracted AND what was offered — two numbers, never one", () => {
    // They differ by everything that mapped nowhere. One number would hide exactly the drift
    // this event exists to make visible.
    expect(emitted.fields_extracted).toBe(3);
    expect(emitted.suggestions_offered).toBe(1);
  });

  it("carries the route and the form kind, which are otherwise unreproducible", () => {
    expect(emitted.route).toBe("form");
    expect(emitted.form_kind).toBe("cnc_turner");
    expect(emitted.extraction_method).toBe("pdf_text");
  });

  it("contains no value from the document", () => {
    const serialised = JSON.stringify(emitted);
    for (const leaked of ["CNC Turner", "Pune", "Fanuc"]) {
      expect(serialised).not.toContain(leaked);
    }
  });
});
