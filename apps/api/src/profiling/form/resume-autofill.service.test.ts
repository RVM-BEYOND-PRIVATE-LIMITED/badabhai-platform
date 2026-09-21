import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeAutofillService } from "./resume-autofill.service";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as never;
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";

const MACHINE_ITEM = {
  question_key: "turning_machine",
  prompt_text: "turning_machine",
  display_order: 0,
  target_kind: "attribute" as const,
  target_field: "turning_machine",
  target_skill_id: null,
  answer_type: "multi_select" as const,
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
};

const PACK = { pack_id: "qp_cnc_turning", version: 3, items: [MACHINE_ITEM] };

function setup(
  opts: {
    enabled?: boolean;
    route?: { route: string | null; formKind: string | null } | null;
    staged?: { questionKey: string; optionKeys: string[] }[];
    savedKeys?: string[];
    pack?: typeof PACK | null;
    packThrows?: boolean;
    writeThrows?: boolean;
  } = {},
) {
  const suggestions = {
    routeForImport: vi.fn(async () => opts.route ?? { route: "form", formKind: "cnc_turner" }),
    mappedOptionsForImport: vi.fn(
      async () => opts.staged ?? [{ questionKey: "turning_machine", optionKeys: ["opt_a"] }],
    ),
  };
  const packs = {
    loadForFamily: opts.packThrows
      ? vi.fn().mockRejectedValue(new Error("pack registry unavailable"))
      : vi.fn(async () => opts.pack ?? PACK),
  };
  const written: { answers: unknown[]; attributes: unknown[] } = { answers: [], attributes: [] };
  const answers = {
    listAnswers: vi.fn(async () =>
      (opts.savedKeys ?? []).map((questionKey) => ({ questionKey, status: "answered" })),
    ),
    withTransaction: vi.fn(async (cb: (tx: never) => Promise<unknown>) => cb("tx" as never)),
    upsertAnswer: vi.fn(async (row: unknown) => {
      if (opts.writeThrows) throw new Error("connection terminated unexpectedly");
      written.answers.push(row);
    }),
  };
  const attributes = {
    upsertMany: vi.fn(async (rows: unknown[]) => {
      written.attributes.push(...rows);
      return rows.length;
    }),
  };
  // TYPED TO TAKE its argument, so a test can assert on the emitted payload — `vi.fn(async () =>
  // …)` infers a zero-arg signature and `mock.calls[0][0]` is then a compile error under
  // `noUncheckedIndexedAccess` (the same reason `orchestrator.service.test.ts` types its own).
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const config = { RESUME_AUTOFILL_ENABLED: opts.enabled ?? true };
  const svc = new ResumeAutofillService(
    suggestions as never,
    packs as never,
    answers as never,
    attributes as never,
    events as never,
    config as never,
  );
  return { svc, suggestions, packs, answers, attributes, events, written };
}

describe("ResumeAutofillService — the identity Haan writes staged mappings as answers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a no-op without reading anything when the kill switch is off", async () => {
    const { svc, suggestions, answers, events } = setup({ enabled: false });
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 0, applied: 0, skippedAnswered: 0 });
    expect(suggestions.routeForImport).not.toHaveBeenCalled();
    expect(answers.upsertAnswer).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("writes the staged mapping as a `resume`-sourced answer plus its attribute, in one transaction", async () => {
    const { svc, answers, events, written } = setup();
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 1, applied: 1, skippedAnswered: 0 });
    // ONE TRANSACTION, both rows or neither — the same atomicity `answer()` keeps.
    expect(answers.withTransaction).toHaveBeenCalledTimes(1);
    expect(written.answers).toHaveLength(1);
    const row = written.answers[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      workerId: WORKER,
      packId: "qp_cnc_turning",
      questionKey: "turning_machine",
      status: "answered",
      source: "resume",
      chatSessionId: null,
    });
    // A multi-select resolves keys to VALUES, exactly as a chips tap does.
    expect(row.answerOptionKeys).toEqual(["Option A"]);
    expect(written.attributes).toHaveLength(1);
    // THE FUNNEL EVENT counts mapped/applied/skipped — never an answer or a label.
    const emitted = events.emit.mock.calls[0]![0] as {
      event_name: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(emitted.event_name).toBe("profile.resume_autofill_applied");
    expect(emitted.payload).toMatchObject({
      worker_id: WORKER,
      import_id: IMPORT,
      form_kind: "cnc_turner",
      mapped: 1,
      applied: 1,
      skipped_answered: 0,
    });
    expect(emitted.idempotencyKey).toBe(`profile.resume_autofill_applied:${IMPORT}`);
    expect(JSON.stringify(emitted.payload)).not.toContain("Option A");
  });

  it("a stored answer always wins — D7 skips without overwriting", async () => {
    const { svc, answers, events } = setup({ savedKeys: ["turning_machine"] });
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 1, applied: 0, skippedAnswered: 1 });
    expect(answers.upsertAnswer).not.toHaveBeenCalled();
    const emitted = events.emit.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(emitted.payload).toMatchObject({ applied: 0, skipped_answered: 1 });
  });

  it("a chat-routed import applies nothing and emits nothing", async () => {
    const { svc, answers, events } = setup({ route: { route: "chat", formKind: null } });
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 0, applied: 0, skippedAnswered: 0 });
    expect(answers.upsertAnswer).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("no staged mappings applies nothing and emits nothing", async () => {
    const { svc, answers, events } = setup({ staged: [] });
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 0, applied: 0, skippedAnswered: 0 });
    expect(answers.upsertAnswer).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("an unavailable pack degrades to zeros — the Haan handover still runs", async () => {
    const { svc, answers, events } = setup({ packThrows: true });
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 0, applied: 0, skippedAnswered: 0 });
    expect(answers.upsertAnswer).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a mapping for an unknown question is dropped, never written", async () => {
    const { svc, answers } = setup({
      staged: [{ questionKey: "retired_question", optionKeys: ["opt_a"] }],
    });
    const result = await svc.applyOnHaan(WORKER, IMPORT, CTX);

    expect(result).toEqual({ mapped: 1, applied: 0, skippedAnswered: 0 });
    expect(answers.upsertAnswer).not.toHaveBeenCalled();
  });
});
