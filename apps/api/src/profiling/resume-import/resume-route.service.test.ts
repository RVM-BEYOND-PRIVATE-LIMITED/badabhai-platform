import type { ParsedField } from "@badabhai/ai-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeRouteService } from "./resume-route.service";
import type { ParsedDraft } from "./resume-parse.service";

/**
 * RI-4's routing decision. Two properties carry this file:
 *
 *   1. THE DECISION IS THE ROUTER'S, not the model's. Every case below drives it through the
 *      labels a parse produces and asserts the route the deterministic table already gives the
 *      interview for the same words.
 *   2. NOTHING BECOMES AN ANSWER (ruling D2). The only write this service may make is
 *      `markRouted`, and a test asserts exactly that rather than trusting the reading.
 */

const CTX = { correlationId: "corr-1", requestId: "req-1" };
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";

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

function setup(opts: { pinnedFamily?: string | null; resolveThrows?: boolean } = {}) {
  const imports = { markRouted: vi.fn().mockResolvedValue(undefined) };
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
    loadUniversal: vi.fn().mockResolvedValue({
      pack_id: "qp_universal",
      items: [packItem("primary_trade", "trade")],
    }),
    loadForFamily: vi.fn().mockResolvedValue({ pack_id: "qp_cnc_turning", items: [] }),
  };
  const crypto = { encrypt: vi.fn((plaintext: string) => `enc(${plaintext})`) };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };

  const svc = new ResumeRouteService(
    imports as never,
    occupations as never,
    packs as never,
    crypto as never,
    events as never,
  );
  return { svc, imports, occupations, packs, crypto, events };
}

const parsedDraft = (fields: Record<string, ParsedField>): ParsedDraft => ({
  status: "parsed",
  importId: IMPORT,
  fields,
  employments: [],
  extractionMethod: "pdf_text",
});

describe("the deterministic router decides, and the résumé only supplies its inputs", () => {
  it("a CNC turner's résumé hands him to the turning form", async () => {
    const { svc, imports } = setup();
    const result = await svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner"), domain_label: field("CNC Machining") }),
      CTX,
    );

    expect(result.route).toBe("form");
    expect(result.formKind).toBe("cnc_turner");
    expect(imports.markRouted).toHaveBeenCalledWith(
      IMPORT,
      expect.objectContaining({ route: "form", formKind: "cnc_turner" }),
    );
  });

  it("'CNC Turner cum VMC Operator' falls through to the chat, as it does in the interview", async () => {
    // THE CONFLICT VETO, reached through a résumé instead of a spoken turn. Nothing in this
    // phase knows what a VMC is — the routing table already did, which is the entire reason
    // this phase needed no new decision logic.
    const { svc } = setup();
    const result = await svc.route(
      WORKER,
      parsedDraft({ role_label: field("CNC Turner cum VMC Operator") }),
      CTX,
    );

    expect(result.route).toBe("chat");
    expect(result.formKind).toBeNull();
  });

  it("a résumé with no role at all routes to chat rather than guessing", async () => {
    const { svc, occupations } = setup();
    const result = await svc.route(WORKER, parsedDraft({ current_city: field("Pune") }), CTX);

    expect(result.route).toBe("chat");
    // Nothing to resolve, so nothing is asked of the occupation ladder.
    expect(occupations.resolve).not.toHaveBeenCalled();
  });

  it("the chat route stores NO form kind — the CHECK constraint is an equivalence", async () => {
    const { svc, imports } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("Security Guard") }), CTX);
    expect(imports.markRouted).toHaveBeenCalledWith(
      IMPORT,
      expect.objectContaining({ route: "chat", formKind: null }),
    );
  });
});

describe("DEGRADES, NEVER FAILS (ruling D9)", () => {
  it("an occupation index that is down costs corroboration, not the worker's journey", async () => {
    const { svc, events } = setup({ resolveThrows: true });
    const result = await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    // The TERM match still stands on the model's own labels, so this particular worker is still
    // routed. The point is that nothing threw.
    expect(result.route).toBe("form");
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it("a failed parse routes to chat and does NOT emit `resume_parsed`", async () => {
    // The funnel's middle step must stay answerable. `resume_parse_failed` has already been
    // emitted by the parse service; emitting `resume_parsed` here too would count one document
    // as both a success and a failure.
    const { svc, events, imports } = setup();
    const result = await svc.route(
      WORKER,
      { status: "failed", importId: IMPORT, reason: "extraction_empty" },
      CTX,
    );

    expect(result.route).toBe("chat");
    expect(events.emit).not.toHaveBeenCalled();
    expect(imports.markRouted).not.toHaveBeenCalled();
  });
});

describe("what is written, and what is never written", () => {
  it("staged suggestions are ENCRYPTED — the row never holds the worker's words in clear", async () => {
    const { svc, imports, crypto } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    const written = imports.markRouted.mock.calls[0]![1] as { suggestionsEnc: string | null };
    expect(written.suggestionsEnc).toMatch(/^enc\(/);
    // VACUITY CHECK. If the payload were empty this assertion would pass while proving nothing,
    // so assert the plaintext actually contained the value before asserting it was encrypted.
    expect(crypto.encrypt.mock.calls[0]![0]).toContain("CNC Turner");
  });

  it("an import with nothing to offer stores null rather than an encrypted empty object", async () => {
    const { svc, imports, crypto } = setup();
    await svc.route(WORKER, parsedDraft({ machines: field(["Fanuc Oi-MF"]) }), CTX);

    expect(crypto.encrypt).not.toHaveBeenCalled();
    const written = imports.markRouted.mock.calls[0]![1] as { suggestionsEnc: string | null };
    expect(written.suggestionsEnc).toBeNull();
  });

  it("`markRouted` is the ONLY write — no answer, no attribute (ruling D2)", async () => {
    // Structural, not incidental. The repository this service holds exposes exactly one write it
    // can reach; if a later change injects an answer repository here, this breaks.
    const { svc, imports } = setup();
    await svc.route(WORKER, parsedDraft({ role_label: field("CNC Turner") }), CTX);

    expect(Object.keys(imports)).toEqual(["markRouted"]);
    expect(imports.markRouted).toHaveBeenCalledTimes(1);
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
    emitted = (events.emit.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
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
