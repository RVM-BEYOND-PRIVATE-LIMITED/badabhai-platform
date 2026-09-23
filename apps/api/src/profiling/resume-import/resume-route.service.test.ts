import { Logger } from "@nestjs/common";
import type { ParsedField, ResumeEmployment } from "@badabhai/ai-contracts";
import type { ResumeDegradedPostureName, TradeFormKindName } from "@badabhai/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeRouteService } from "./resume-route.service";
import type { ParsedDraft } from "./resume-parse.service";

/**
 * `familyForTradeForm` IS THE ONE THING HERE THAT CANNOT BE BROKEN FROM THE OUTSIDE. It throws
 * only when a kind the router can still return has lost its registry descriptor, and the router
 * and the registry are derived from each other — so there is no draft, no pack and no fake that
 * reaches it. A partial module mock is the only way to stand the assertion up, and the default
 * is a straight pass-through so every other test in this file runs against the real function.
 */
const registry = vi.hoisted(() => ({ familyThrows: false }));
vi.mock("../trade-form-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trade-form-router")>();
  return {
    ...actual,
    familyForTradeForm: (kind: Parameters<typeof actual.familyForTradeForm>[0]) => {
      if (registry.familyThrows) throw new Error(`no trade-form route for ${kind}`);
      return actual.familyForTradeForm(kind);
    },
  };
});

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
    emitThrows?: boolean;
    mappedOptions?: { questionKey: string; optionKeys: string[] }[];
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
              : {
                  familyId: opts.pinnedFamily,
                  label: "CNC Turner",
                  jobDomainId: "d",
                  confidence: 0.9,
                  iscoUnitCode: null,
                  layer: "L0",
                },
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
      // RECORDED BEFORE THE THROW. Whether the failure happened INSIDE the transaction is the
      // property under test; an emit that threw next to it would roll nothing back.
      seen.emitInTx = seen.inTx;
      if (opts.emitThrows) throw new Error("events table unavailable");
      return undefined;
    }),
  };

  // RI-autofill. NO MAPPINGS unless a test asks for them — every existing test in this
  // file asserts the route and the staged suggestions, which must be byte for byte what
  // they always were. TYPED TO TAKE its arguments, so asserting on the asked questions
  // compiles under `noUncheckedIndexedAccess` (same reason as the events mock below).
  const optionMap = {
    map: vi.fn(
      async (_w: unknown, _s: unknown, _m: unknown, _q: unknown) => opts.mappedOptions ?? [],
    ),
  };

  const svc = new ResumeRouteService(
    imports as never,
    occupations as never,
    packs as never,
    crypto as never,
    events as never,
    optionMap as never,
  );
  return { svc, imports, occupations, packs, crypto, events, optionMap, seen };
}

const parsedDraft = (
  fields: Record<string, ParsedField>,
  employments: ResumeEmployment[] = [],
  associationKind: TradeFormKindName | null = null,
  degradedPosture: ResumeDegradedPostureName | null = null,
): ParsedDraft => ({
  status: "parsed",
  importId: IMPORT,
  storageKey: `resume-uploads/${WORKER}/abc.pdf`,
  mime: "application/pdf",
  fields,
  employments,
  associationKind,
  extractionMethod: "pdf_text",
  pageCount: 1,
  ocrConfidence: null,
  // #1656 — the healthy default, so every other test in this file is a positive control
  // for the vacuity case: a posture only appears where one is passed.
  degradedPosture,
});

type EmitCall = { payload: Record<string, unknown>; tx?: unknown; idempotencyKey?: string };
const emitCall = (events: { emit: { mock: { calls: unknown[][] } } }): EmitCall =>
  events.emit.mock.calls[0]![0] as EmitCall;
const routingWritten = (imports: { settleParsed: { mock: { calls: unknown[][] } } }) =>
  imports.settleParsed.mock.calls[0]![2] as {
    route: string;
    formKind: string | null;
    associationKind: string | null;
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
    // #1660 - `fieldsExtracted` is the count the settle now persists. TWO here, and it is
    // the two fields this draft carries: asserting a literal that happens to match would
    // pass just as well if the service wrote a constant, so it is pinned to the SAME
    // expression the service derives it from.
    expect(imports.settleParsed).toHaveBeenCalledWith(
      IMPORT,
      {
        extractionMethod: "pdf_text",
        pageCount: 1,
        ocrConfidence: null,
        fieldsExtracted: 2,
        // #1656 — a healthy parse asserts NULL rather than omitting the key: the settle must
        // write "not degraded" explicitly, never leave the column to whatever was there.
        degradedPosture: null,
      },
      expect.objectContaining({ route: "form", formKind: "cnc_turner" }),
      TX,
    );
    // ...and the row and the event must never disagree about one import.
    const [, settledFacts] = imports.settleParsed.mock.calls[0]! as unknown as [
      string,
      { fieldsExtracted: number },
    ];
    expect(settledFacts.fieldsExtracted).toBe(result?.fieldsExtracted);
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
    const clean = await setup().svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner") }),
      CTX,
    );

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

  it("Task 1 B2 — the model's judgment is settled beside the route, and the route does not listen", async () => {
    // RECORDED, NOT ACTED ON. "Security Guard" matches no term rule, so the
    // route is chat with or without the judgment; what changes is only the
    // settled column. "fitter" is a real 21-kind the model may judge while the
    // router cannot route it (declared, no enabled form). Wiring judgments in
    // as a recall path waits on the handover ruling.
    const { svc, imports } = setup();
    const judged = await svc.route(
      WORKER,
      parsedDraft({ role_label: field("Security Guard") }, [], "fitter"),
      CTX,
    );
    const unjudged = await setup().svc.route(
      WORKER,
      parsedDraft({ role_label: field("Security Guard") }),
      CTX,
    );

    expect(judged?.route).toBe("chat");
    expect(unjudged?.route).toBe("chat");
    expect(routingWritten(imports)).toEqual(
      expect.objectContaining({ route: "chat", formKind: null, associationKind: "fitter" }),
    );
  });

  it("Task 1 B2 — a form route settles the judgment alongside the kind", async () => {
    const { svc, imports } = setup();
    const result = await svc.route(
      WORKER,
      parsedDraft(
        { role_label: field("CNC Turner"), domain_label: field("CNC Machining") },
        [],
        "cnc_turner",
      ),
      CTX,
    );

    expect(result?.route).toBe("form");
    expect(routingWritten(imports)).toEqual(
      expect.objectContaining({
        route: "form",
        formKind: "cnc_turner",
        associationKind: "cnc_turner",
      }),
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
    expect(routingWritten(imports)).toEqual({
      route: "chat",
      formKind: null,
      associationKind: null,
      suggestionsEnc: null,
    });
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
    expect(routingWritten(imports)).toEqual({
      route: "chat",
      formKind: null,
      associationKind: null,
      suggestionsEnc: null,
    });
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
      {
        status: "failed",
        importId: IMPORT,
        reason: "empty_document",
        extractionMethod: null,
        // ALREADY RECORDED by the parse service — a document-level reason is not deferred
        // (#1654). Either way this service settles nothing for a failed draft.
        settled: true,
      },
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

  it("a kind with no family in the registry FAILS LOUDLY — it is an assertion, not a pack outage", async () => {
    // THE MUTATION THIS PINS: moving `familyForTradeForm` back inside the pack-load try. It sits
    // one line away from two `await`s the catch is there to swallow, and swallowing it would
    // re-route EVERY worker of that kind to the chat while logging a pack outage that never
    // happened — the loud registry bug turned into a silent product one.
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, imports, packs, events } = setup();
    registry.familyThrows = true;
    let degradeLogs = -1;
    try {
      await expect(
        svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX),
      ).rejects.toThrow("no trade-form route for cnc_turner");
      // READ BEFORE THE RESTORE, which in vitest also clears the call record.
      degradeLogs = errorLog.mock.calls.length;
    } finally {
      registry.familyThrows = false;
      errorLog.mockRestore();
    }

    // VACUITY CHECK: the throw came from the family lookup, not from a pack that never loaded.
    // `loadUniversal` runs first inside `packItems`, so it must NOT have been reached at all.
    expect(packs.loadUniversal).not.toHaveBeenCalled();
    expect(packs.loadForFamily).not.toHaveBeenCalled();
    // And it was NOT reported as a degrade — the "packs unavailable" line is the mutation's tell.
    expect(degradeLogs).toBe(0);
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

  it("an emit that fails does so INSIDE the transaction, so the settle it belongs to rolls back", async () => {
    // THE PROPERTY, stated where only this file can state it: the emit must throw while the
    // transaction is still open. A refactor that emitted after `withTransaction` returned would
    // leave a committed `parsed` row whose event never landed — a handover the funnel never
    // counted and nothing would ever retry, because the row is terminal.
    //
    // `seen.emitInTx` is what distinguishes the two; the rejection alone does not, since an
    // emit next to the transaction rejects identically.
    const { svc, imports, events, seen } = setup({ emitThrows: true });

    await expect(
      svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX),
    ).rejects.toThrow("events table unavailable");

    expect(imports.withTransaction).toHaveBeenCalledTimes(1);
    expect(imports.settleParsed).toHaveBeenCalledTimes(1);
    expect(seen.settleInTx).toBe(true);
    expect(seen.emitInTx).toBe(true);
    expect(events.emit).toHaveBeenCalledTimes(1);
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

  it("a parsed résumé's employments ride the SAME staged blob, under `employments`, alongside `answers`", async () => {
    const { svc, crypto } = setup();
    const employment: ResumeEmployment = {
      employer_name: "Sandhar Technologies",
      role_title: "CNC Operator",
      start_year: 2019,
      end_year: 2021,
      evidence: { message_index: 0, quote: "Sandhar Technologies, CNC Operator, 2019-2021" },
    };
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }, [employment]), CTX);

    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    const plaintext = crypto.encrypt.mock.calls[0]![0] as string;
    expect(plaintext).toContain("Sandhar Technologies");
    const parsed = JSON.parse(plaintext) as { answers: unknown; employments: unknown[] };
    expect(parsed.employments).toEqual([
      {
        source: "resume",
        values: {
          employer_name: "Sandhar Technologies",
          employer_city: null,
          role_label: "CNC Operator",
          start_ym: null,
          end_ym: null,
          work_done: null,
        },
      },
    ]);
    // The pack-question suggestion still lands exactly where it always has, under `answers`.
    expect(Object.keys(parsed.answers as Record<string, unknown>)).toContain("primary_trade");
  });

  it("a résumé with employments but NO pack-answer suggestions still stages the employments (not folded into the null-payload path)", async () => {
    const { svc, imports, crypto } = setup();
    const employment: ResumeEmployment = {
      employer_name: "TVS Motor",
      role_title: null,
      start_year: null,
      end_year: null,
      evidence: { message_index: 0, quote: "TVS Motor" },
    };
    // `machines` maps to no destination question (see `resume-suggestions.ts`), so the pack
    // side alone would store null — the employment must still be the reason this stages.
    await svc.route(WORKER, parsedDraft({ machines: field(["Fanuc Oi-MF"]) }, [employment]), CTX);

    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    expect(routingWritten(imports).suggestionsEnc).toMatch(/^enc\(/);
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

describe("RI-autofill staging (owner override B) — the third call, on the form route only", () => {
  const optionItem = (question_key: string, answer_type: "single_select" | "multi_select") => ({
    ...packItem(question_key, question_key),
    answer_type,
    options: [
      {
        option_key: "opt_a",
        label_text: "Option A",
        value: null,
        implies_skill_id: null,
        is_none_of_above: false,
      },
      {
        option_key: "opt_b",
        label_text: "Option B",
        value: null,
        implies_skill_id: null,
        is_none_of_above: false,
      },
    ],
  });

  it("a form-routed import maps the TRADE pack's option questions and stages option_map in the token", async () => {
    const { svc, packs, crypto, optionMap } = setup();
    packs.loadForFamily.mockResolvedValue({
      pack_id: "qp_cnc_turning",
      items: [optionItem("turning_machine", "multi_select"), packItem("notes", "notes")],
    });
    optionMap.map.mockResolvedValue([{ questionKey: "turning_machine", optionKeys: ["opt_a"] }]);

    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    // Asked against the trade pack's option questions only — never the text question,
    // never universal. Closed ids travel; option prose and document text do not.
    expect(optionMap.map).toHaveBeenCalledTimes(1);
    const asked = optionMap.map.mock.calls[0]!;
    expect(asked[0]).toBe(WORKER);
    expect(asked[1]).toBe(`resume-uploads/${WORKER}/abc.pdf`);
    expect(asked[2]).toBe("application/pdf");
    expect(asked[3]).toEqual([
      {
        question_key: "turning_machine",
        answer_type: "multi_select",
        options: [
          { option_key: "opt_a", label_text: "Option A" },
          { option_key: "opt_b", label_text: "Option B" },
        ],
      },
    ]);
    const plaintext = crypto.encrypt.mock.calls[0]![0] as string;
    const parsed = JSON.parse(plaintext) as { option_map: unknown };
    expect(parsed.option_map).toEqual([
      { question_key: "turning_machine", option_keys: ["opt_a"] },
    ]);
  });

  it("a chat-routed import never runs the mapping call", async () => {
    // "welder" alone does not route without corroboration; force chat via an empty label.
    const { svc, optionMap } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("bus driver") }), CTX);

    expect(optionMap.map).not.toHaveBeenCalled();
  });

  it("an empty mapping stages nothing extra — the token is exactly today's shape plus an empty option_map", async () => {
    const { svc, crypto } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    const plaintext = crypto.encrypt.mock.calls[0]![0] as string;
    const parsed = JSON.parse(plaintext) as { option_map: unknown };
    expect(parsed.option_map).toEqual([]);
  });
});

/**
 * #1656 — the degraded posture reaches the ROW and the EVENT, from one source, in one write.
 *
 * WHY BOTH, AND THE PRECEDENT IS 0122's OWN HEADER: an event is not a read. The event is what
 * the funnel aggregates — "how often does our parser let a worker down" must stop counting
 * spend-capped no-ops as successful parses — and the row is what an operator can join against
 * an import someone reported. A log line serves neither.
 */
describe("the degraded posture is RECORDED, not just logged (#1656)", () => {
  const settledFacts = (imports: { settleParsed: { mock: { calls: unknown[][] } } }) =>
    imports.settleParsed.mock.calls[0]![1] as { fieldsExtracted: number; degradedPosture: string | null };

  it.each(["mock_no_parse", "llm_unavailable"] as const)(
    "%s lands on the row AND on the event, and the import still settles parsed and routes",
    async (posture) => {
      const { svc, imports, events } = setup();
      const result = await svc.route(
        WORKER,
        parsedDraft({ role_label: field("CNC Turner") }, [], null, posture),
        CTX,
      );

      expect(settledFacts(imports).degradedPosture).toBe(posture);
      expect(emitCall(events).payload.degraded_posture).toBe(posture);
      // RULING D9. A degraded posture is not a failure and must not cost the worker his
      // onboarding: he is still settled and still routed exactly as a healthy parse would be.
      expect(result?.route).toBe("form");
      expect(result?.formKind).toBe("cnc_turner");
    },
  );

  it("a healthy parse writes NULL and emits null — the vacuity guard", async () => {
    // Without this, a service that wrote a constant posture would pass both cases above. And
    // the event's `null` is load-bearing in its own right: the key is ALWAYS written, so an
    // absent key can keep meaning "emitted before #1656" and nothing else.
    const { svc, imports, events } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(settledFacts(imports).degradedPosture).toBeNull();
    const payload = emitCall(events).payload;
    expect(payload.degraded_posture).toBeNull();
    expect(Object.keys(payload)).toContain("degraded_posture");
  });

  it("the row and the event come from the SAME validated payload — they cannot disagree", async () => {
    // Recomputing the posture at the settle would be a second source that drifts the first time
    // either side moves. This is the identical discipline `fields_extracted` keeps (#1660).
    const { svc, imports, events } = setup();
    await svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner") }, [], null, "mock_no_parse"),
      CTX,
    );

    expect(settledFacts(imports).degradedPosture).toBe(emitCall(events).payload.degraded_posture);
  });

  it("the posture rides the SAME single guarded statement and the SAME transaction", async () => {
    // `030b7948`'s guarantee: no reader may see a `parsed` row without its route, so nothing
    // this field needs may become a second write or a second transaction.
    const { svc, imports, events, seen } = setup();
    await svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner") }, [], null, "llm_unavailable"),
      CTX,
    );

    expect(imports.settleParsed).toHaveBeenCalledTimes(1);
    expect(imports.withTransaction).toHaveBeenCalledTimes(1);
    expect(seen.settleInTx).toBe(true);
    expect(seen.emitInTx).toBe(true);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it("a guard that settled NOTHING emits nothing — a redelivery records no second posture", async () => {
    const { svc, events } = setup({ settled: false });
    const result = await svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner") }, [], null, "mock_no_parse"),
      CTX,
    );

    expect(result).toBeNull();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("the event carries the CODE and nothing else — no model text, no document text", async () => {
    const { svc, events } = setup();
    await svc.route(
      WORKER,
      parsedDraft(
        { role_label: field("CNC Turner"), current_city: field("Pune") },
        [],
        null,
        "mock_no_parse",
      ),
      CTX,
    );

    const serialised = JSON.stringify(emitCall(events).payload);
    expect(serialised).toContain("mock_no_parse");
    for (const leaked of ["CNC Turner", "Pune"]) expect(serialised).not.toContain(leaked);
  });
});
