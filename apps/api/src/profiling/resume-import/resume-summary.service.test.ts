import { beforeEach, describe, expect, it, vi } from "vitest";

import { TRADE_FORM_KINDS } from "../trade-form-router";
import { ResumeSummaryService } from "./resume-summary.service";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as never;
const WORKER = "11111111-1111-4111-8111-111111111111";
const STORAGE_KEY = `resume-uploads/${WORKER}/abc.pdf`;
const MIME = "application/pdf";

function output(overrides: Record<string, unknown> = {}) {
  return {
    role_kind: "cnc_turner",
    experience_text: "5 saal ka tajurba",
    summary_text: "CNC lathe par kaam, Fanuc control",
    failure_reason: null,
    notes: [],
    ai_metadata: { ai_call_id: "c1", task_type: "resume_profile_summary" } as never,
    ...overrides,
  };
}

function setup(opts: { out?: Record<string, unknown> | null } = {}) {
  const resolved = "out" in opts ? opts.out : output();
  const ai = { summarizeResume: vi.fn().mockResolvedValue(resolved) };
  const aiCost = { record: vi.fn().mockResolvedValue(undefined) };
  const svc = new ResumeSummaryService(ai as never, aiCost as never);
  return { svc, ai, aiCost };
}

describe("ResumeSummaryService — backend-only, best-effort, never shown in chat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the storage KEY with the 9 enabled kinds, never the document", async () => {
    const { svc, ai } = setup();
    await svc.summarize(WORKER, STORAGE_KEY, MIME, CTX);

    const sent = ai.summarizeResume.mock.calls[0]![0];
    expect(sent.storage_key).toBe(STORAGE_KEY);
    expect(sent.role_kinds).toEqual([...TRADE_FORM_KINDS]);
    // 9 enabled forms, not the 21 declared kinds.
    expect(sent.role_kinds).toHaveLength(9);
    expect(JSON.stringify(sent)).not.toContain("lines");
  });

  it("records the spend even when the summary degraded", async () => {
    const { svc, aiCost } = setup({
      out: output({ failure_reason: "ocr_below_floor", role_kind: null }),
    });
    const result = await svc.summarize(WORKER, STORAGE_KEY, MIME, CTX);

    expect(aiCost.record).toHaveBeenCalledOnce();
    expect(aiCost.record.mock.calls[0]![1]).toBe("resume_profile_summary");
    expect(result?.failureReason).toBe("ocr_below_floor");
  });

  it("treats a null from the AI service as an outage, not as a bad document", async () => {
    const { svc, aiCost } = setup({ out: null });
    const result = await svc.summarize(WORKER, STORAGE_KEY, MIME, CTX);

    expect(result).toBeNull();
    expect(aiCost.record).not.toHaveBeenCalled();
  });

  it("narrows an off-list role to null rather than inheriting it", async () => {
    const { svc } = setup({ out: output({ role_kind: "bus_driver" }) });
    const result = await svc.summarize(WORKER, STORAGE_KEY, MIME, CTX);

    expect(result?.roleKind).toBeNull();
    // The Hinglish strings survive — only the role is narrowed.
    expect(result?.experienceText).toBe("5 saal ka tajurba");
  });

  it("returns null when the model judged nothing at all", async () => {
    const { svc } = setup({
      out: output({ role_kind: null, experience_text: null, summary_text: null }),
    });
    await expect(svc.summarize(WORKER, STORAGE_KEY, MIME, CTX)).resolves.toBeNull();
  });
});
