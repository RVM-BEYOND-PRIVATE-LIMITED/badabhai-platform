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

function setup(
  opts: {
    out?: Record<string, unknown> | null;
    row?: Record<string, unknown> | null;
    staged?: boolean;
  } = {},
) {
  const resolved = "out" in opts ? opts.out : output();
  const ai = { summarizeResume: vi.fn().mockResolvedValue(resolved) };
  const aiCost = { record: vi.fn().mockResolvedValue(undefined) };
  const imports = {
    findForWorker: vi.fn().mockResolvedValue(
      "row" in opts
        ? opts.row
        : {
            id: "import-1",
            // THE DOCUMENT LIVES ON THE ROW, not in the caller's arguments (#1654). The
            // draft the processor hands in may now be a FAILED one, which carries neither
            // a storage key nor a mime — and this read was already happening anyway.
            storageKey: STORAGE_KEY,
            mime: MIME,
            identityRoleKind: null,
            identityExperienceText: null,
            identitySummaryText: null,
          },
    ),
    saveIdentitySummary: vi.fn().mockResolvedValue(opts.staged ?? true),
  };
  const svc = new ResumeSummaryService(ai as never, aiCost as never, imports as never);
  return { svc, ai, aiCost, imports };
}

describe("ResumeSummaryService — summarize (best-effort, never shown in chat)", () => {
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

describe("ResumeSummaryService — summarizeAndStage (check-then-call, staged for chat)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the staged line without a model call when the row already carries one", async () => {
    const { svc, ai, imports } = setup({
      row: {
        id: "import-1",
        storageKey: STORAGE_KEY,
        mime: MIME,
        identityRoleKind: "welder",
        identityExperienceText: "2 saal ka tajurba",
        identitySummaryText: "Welding ka kaam",
      },
    });
    const result = await svc.summarizeAndStage(WORKER, "import-1", CTX);

    expect(ai.summarizeResume).not.toHaveBeenCalled();
    expect(imports.saveIdentitySummary).not.toHaveBeenCalled();
    expect(result).toMatchObject({ roleKind: "welder", failureReason: null });
  });

  it("takes the storage key and mime off the ROW, never off the caller (#1654)", async () => {
    // The failed-parse draft the processor now hands in carries neither, so a signature that
    // demanded them was the reason the summary could only ever follow a SUCCESSFUL parse.
    const { svc, ai, imports } = setup();
    await svc.summarizeAndStage(WORKER, "import-1", CTX);

    expect(imports.findForWorker).toHaveBeenCalledWith("import-1", WORKER);
    // ONE read, not two: the staged-line check and the document both come off it.
    expect(imports.findForWorker).toHaveBeenCalledOnce();
    const sent = ai.summarizeResume.mock.calls[0]![0];
    expect(sent.storage_key).toBe(STORAGE_KEY);
    expect(sent.mime).toBe(MIME);
  });

  it("calls once and stages the line on the row", async () => {
    const { svc, ai, imports } = setup();
    const result = await svc.summarizeAndStage(WORKER, "import-1", CTX);

    expect(ai.summarizeResume).toHaveBeenCalledOnce();
    expect(imports.saveIdentitySummary).toHaveBeenCalledWith("import-1", {
      roleKind: "cnc_turner",
      experienceText: "5 saal ka tajurba",
      summaryText: "CNC lathe par kaam, Fanuc control",
    });
    expect(result?.roleKind).toBe("cnc_turner");
  });

  it("stages nothing when the model judged nothing, and never throws", async () => {
    const { svc, imports } = setup({
      out: output({ role_kind: null, experience_text: null, summary_text: null }),
    });
    await expect(
      svc.summarizeAndStage(WORKER, "import-1", CTX),
    ).resolves.toBeNull();
    expect(imports.saveIdentitySummary).not.toHaveBeenCalled();
  });

  it("returns null for a row that is gone without an existence oracle", async () => {
    const { svc, ai } = setup({ row: null });
    await expect(
      svc.summarizeAndStage(WORKER, "import-1", CTX),
    ).resolves.toBeNull();
    expect(ai.summarizeResume).not.toHaveBeenCalled();
  });
});
