import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeOptionMapService } from "./resume-option-map.service";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as never;
const WORKER = "11111111-1111-4111-8111-111111111111";
const STORAGE_KEY = `resume-uploads/${WORKER}/abc.pdf`;
const MIME = "application/pdf";

const QUESTIONS = [
  {
    question_key: "turning_machine",
    answer_type: "multi_select" as const,
    options: [
      { option_key: "opt_a", label_text: "Option A" },
      { option_key: "opt_b", label_text: "Option B" },
    ],
  },
  {
    question_key: "can_program",
    answer_type: "single_select" as const,
    options: [{ option_key: "yes_prog", label_text: "Yes" }],
  },
];

function output(overrides: Record<string, unknown> = {}) {
  return {
    mappings: [],
    failure_reason: null,
    notes: [],
    ai_metadata: { ai_call_id: "c1", task_type: "resume_option_map" } as never,
    ...overrides,
  };
}

/** Today's posture by default: autofill on (as in production) and the F4 skip switch off. */
const TODAY = { RESUME_AUTOFILL_ENABLED: true, RESUME_OPTION_MAP_REQUIRES_AUTOFILL: false };

function setup(
  opts: {
    out?: Record<string, unknown> | null;
    config?: { RESUME_AUTOFILL_ENABLED: boolean; RESUME_OPTION_MAP_REQUIRES_AUTOFILL: boolean };
  } = {},
) {
  const resolved = "out" in opts ? opts.out : output();
  const ai = { mapResumeOptions: vi.fn().mockResolvedValue(resolved) };
  const aiCost = { record: vi.fn().mockResolvedValue(undefined) };
  const svc = new ResumeOptionMapService(ai as never, aiCost as never, opts.config ?? TODAY);
  return { svc, ai, aiCost };
}

describe("ResumeOptionMapService — the third call, gated twice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the storage KEY with the pack's closed questions, never the document", async () => {
    const { svc, ai } = setup();
    await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);

    const sent = ai.mapResumeOptions.mock.calls[0]![0];
    expect(sent.storage_key).toBe(STORAGE_KEY);
    expect(sent.questions).toHaveLength(2);
    expect(JSON.stringify(sent)).not.toContain("lines");
  });

  it("asks nothing and spends nothing when there are no option questions", async () => {
    const { svc, ai, aiCost } = setup();
    await expect(svc.map(WORKER, STORAGE_KEY, MIME, [], CTX)).resolves.toEqual([]);

    expect(ai.mapResumeOptions).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
  });

  it("records the spend even when the mapping degraded", async () => {
    const { svc, aiCost } = setup({
      out: output({ failure_reason: "ocr_below_floor" }),
    });
    const result = await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);

    expect(aiCost.record).toHaveBeenCalledOnce();
    expect(aiCost.record.mock.calls[0]![1]).toBe("resume_option_map");
    expect(result).toEqual([]);
  });

  it("treats a null from the AI service as an outage, not as a bad document", async () => {
    const { svc, aiCost } = setup({ out: null });
    const result = await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);

    expect(result).toEqual([]);
    expect(aiCost.record).not.toHaveBeenCalled();
  });

  it("keeps verbatim mappings and drops invented ids, wrong questions and overfull singles", async () => {
    const { svc } = setup({
      out: output({
        mappings: [
          {
            question_key: "turning_machine",
            option_keys: ["opt_a", "opt_b"],
            evidence: { message_index: 0, quote: "x" },
          },
          {
            question_key: "not_a_question",
            option_keys: ["opt_a"],
            evidence: { message_index: 0, quote: "x" },
          },
          {
            question_key: "can_program",
            option_keys: ["yes_prog", "opt_a"],
            evidence: { message_index: 0, quote: "x" },
          },
        ],
      }),
    });
    // THE SECOND WALL, narrowed against the pack's own lists: the verbatim multi survives,
    // the unknown question is dropped, and the overfull single is dropped whole — even
    // though one of its two ids was valid. Keeping the "good" half would mean trusting the
    // model's judgment about which half to believe.
    const result = await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);

    expect(result).toEqual([{ questionKey: "turning_machine", optionKeys: ["opt_a", "opt_b"] }]);
  });

  it("a mapping carrying even one invented id is dropped whole, never filtered", async () => {
    const { svc } = setup({
      out: output({
        mappings: [
          {
            question_key: "turning_machine",
            option_keys: ["opt_a", "invented"],
            evidence: { message_index: 0, quote: "x" },
          },
        ],
      }),
    });
    const result = await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);

    expect(result).toEqual([]);
  });

  it("keeps only the first mapping per question", async () => {
    const { svc } = setup({
      out: output({
        mappings: [
          {
            question_key: "turning_machine",
            option_keys: ["opt_a"],
            evidence: { message_index: 0, quote: "x" },
          },
          {
            question_key: "turning_machine",
            option_keys: ["opt_b"],
            evidence: { message_index: 0, quote: "x" },
          },
        ],
      }),
    });
    const result = await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);

    expect(result).toEqual([{ questionKey: "turning_machine", optionKeys: ["opt_a"] }]);
  });
});

describe("ResumeOptionMapService — audit fix F4, skip the call nobody can apply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("switch ON and autofill OFF: no model call, no spend, no mappings", async () => {
    const { svc, ai, aiCost } = setup({
      config: { RESUME_AUTOFILL_ENABLED: false, RESUME_OPTION_MAP_REQUIRES_AUTOFILL: true },
    });
    await expect(svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX)).resolves.toEqual([]);
    expect(ai.mapResumeOptions).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
  });

  it.each([
    ["switch OFF, autofill OFF (today when autofill is off)", false, false],
    ["switch OFF, autofill ON (today in production)", true, false],
    ["switch ON, autofill ON (autofill still has its mapping)", true, true],
  ])("%s: the call runs exactly as before", async (_label, autofill, requires) => {
    const { svc, ai, aiCost } = setup({
      config: { RESUME_AUTOFILL_ENABLED: autofill, RESUME_OPTION_MAP_REQUIRES_AUTOFILL: requires },
    });
    await svc.map(WORKER, STORAGE_KEY, MIME, QUESTIONS, CTX);
    expect(ai.mapResumeOptions).toHaveBeenCalledTimes(1);
    expect(aiCost.record).toHaveBeenCalledTimes(1);
  });
});
