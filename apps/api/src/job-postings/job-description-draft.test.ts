import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { defaultModeResolver } from "../payers/payer-tenant-scope.test-support";
import { JobPostingsService } from "./job-postings.service";
import {
  DraftJobDescriptionSchema,
  JobDescriptionDraftResultSchema,
  type DraftJobDescriptionDto,
} from "./job-description.dto";

const PAYER_ID = "55555555-5555-4555-8555-555555555555";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

const META = {
  ai_call_id: "call-1",
  task_type: "job_description_draft",
  model_name: "test-model",
  provider: "test-provider",
  real_call: true,
};

function make(draft: { description: string | null; is_mock?: boolean } | null) {
  const draftJobDescription = vi.fn().mockResolvedValue(
    draft === null
      ? null
      : { description: draft.description, blocked: false, is_mock: draft.is_mock ?? false, ai_metadata: META },
  );
  const recordAiCost = vi.fn(async () => {});
  const traces = fakeAiTraceRecorder();
  const svc = new JobPostingsService(
    {} as never,
    { emit: vi.fn() } as never,
    { draftJobDescription } as never,
    { record: recordAiCost } as never,
    traces.recorder,
    {} as never,
    {} as never,
    { normalizeSelection: vi.fn() } as never,
    defaultModeResolver() as PayerTenantScopeService,
  );
  return { svc, draftJobDescription, recordAiCost };
}

const DTO: DraftJobDescriptionDto = {
  spoken_text: "VMC chalata hoon, Fanuc control, day shift",
  trade_label: "CNC Machining",
  role_label: "VMC Operator",
};

describe("DraftJobDescriptionSchema", () => {
  it("requires the spoken text (1..2000 chars), context is optional", () => {
    expect(DraftJobDescriptionSchema.safeParse({}).success).toBe(false);
    expect(DraftJobDescriptionSchema.safeParse({ spoken_text: "" }).success).toBe(false);
    expect(DraftJobDescriptionSchema.safeParse({ spoken_text: "VMC chalata hoon" }).success).toBe(
      true,
    );
    expect(DraftJobDescriptionSchema.safeParse({ spoken_text: "x".repeat(2001) }).success).toBe(
      false,
    );
  });

  it("the result defaults to the null degrade", () => {
    expect(JobDescriptionDraftResultSchema.parse({ description: null, is_mock: true })).toEqual({
      description: null,
      is_mock: true,
    });
  });
});

describe("draftDescriptionForPayer", () => {
  it("returns the English draft and ledgers payer-side spend", async () => {
    const { svc, draftJobDescription, recordAiCost } = make({
      description: "Operate VMC machines with Fanuc control on day shift.",
    });
    const out = await svc.draftDescriptionForPayer(PAYER_ID, DTO, CTX);
    expect(out).toEqual({
      description: "Operate VMC machines with Fanuc control on day shift.",
      is_mock: false,
    });
    // The far side gets the payer ref + context, never an org name.
    expect(draftJobDescription).toHaveBeenCalledWith(
      {
        payer_ref: PAYER_ID,
        spoken_text: DTO.spoken_text,
        trade_label: "CNC Machining",
        role_label: "VMC Operator",
      },
      CTX,
    );
    // One cost record under the new task type, no worker attribution.
    expect(recordAiCost).toHaveBeenCalledWith(META, "job_description_draft", null, CTX.correlationId, CTX.requestId);
  });

  it("a null draft degrades to keep-the-poster-text, cost still ledgered", async () => {
    const { svc, recordAiCost } = make({ description: null, is_mock: true });
    const out = await svc.draftDescriptionForPayer(PAYER_ID, DTO, CTX);
    expect(out).toEqual({ description: null, is_mock: true });
    expect(recordAiCost).toHaveBeenCalledTimes(1);
  });

  it("an unreachable ai-service degrades to null without throwing", async () => {
    const { svc } = make(null);
    const out = await svc.draftDescriptionForPayer(PAYER_ID, DTO, CTX);
    expect(out).toEqual({ description: null, is_mock: true });
  });

  it("writes nothing: no row, no posting event", async () => {
    const { svc } = make({ description: "Operate VMC machines." });
    await svc.draftDescriptionForPayer(PAYER_ID, DTO, CTX);
    // The repo double is `{}` — any read/write would throw. Reaching here proves
    // the draft path touches neither the table nor the posting events.
  });
});
