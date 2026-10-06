import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { PayerDisclosureController } from "./payer-disclosure.controller";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerRequestDisclosureSchema } from "./payer-disclosure.dto";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";

const PAYER_A: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid-a", role: "employer" };
const PAYER_B: AuthenticatedPayer = { id: "bbbbbbbb-0000-4000-8000-000000000002", sid: "sid-b", role: "employer" };
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const WORKER = "cccccccc-0000-4000-8000-000000000003";
const POSTING = "eeeeeeee-0000-4000-8000-000000000005";

// The ONE distinguishable success body the service returns on a grant; every deny branch
// returns the byte-identical neutral body. The controller never reshapes it.
const NEUTRAL = { ok: false } as const;

function makeCtrl() {
  const disclosures = {
    requestDisclosure: vi.fn(async () => NEUTRAL),
    listByPayer: vi.fn(async () => ({ disclosures: [] })),
  };
  const disclosureRate = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const ctrl = new PayerDisclosureController(disclosures as never, disclosureRate as never);
  return { ctrl, disclosures, disclosureRate };
}

/**
 * XB-A at the payer disclosure boundary: every action is bound to the SESSION payer
 * (`req.payer.id`); the request body never supplies a `payer_id`. Proves a payer cannot
 * request or list another payer's disclosures from the edge — the chokepoint masking +
 * shared cap + consent gate are proven in resume-disclosure.service.test.ts.
 */
describe("PayerDisclosureController — identity from the session, never the body (ADR-0019 XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("request binds payerId to the SESSION payer (the DTO carries no payer_id)", async () => {
    await d.ctrl.request({ worker_id: WORKER, job_posting_id: POSTING }, PAYER_A, CTX);
    expect(d.disclosures.requestDisclosure).toHaveBeenCalledWith(
      { payerId: PAYER_A.id, workerId: WORKER, jobPostingId: POSTING },
      CTX,
      "payer_owned", // #1899: the chokepoint enforces SESSION-payer ownership of the posting
    );
  });

  it("request returns the service body verbatim (no-oracle neutral body is not reshaped)", async () => {
    const out = await d.ctrl.request({ worker_id: WORKER, job_posting_id: null }, PAYER_A, CTX);
    expect(out).toBe(NEUTRAL);
  });

  it("listOwn scopes to the SESSION payer (no query/body payer_id is accepted)", async () => {
    await d.ctrl.listOwn(PAYER_B);
    expect(d.disclosures.listByPayer).toHaveBeenCalledWith(PAYER_B.id);
    expect(d.disclosures.listByPayer).not.toHaveBeenCalledWith(PAYER_A.id);
  });

  it("enforces the per-payer disclosure cap (XB-G) against the SESSION payer before the chokepoint", async () => {
    await d.ctrl.request({ worker_id: WORKER, job_posting_id: null }, PAYER_A, CTX);
    expect(d.disclosureRate.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id);
  });

  it("a tripped per-payer cap (XB-G) blocks the chokepoint (request never reaches the service)", async () => {
    d.disclosureRate.assertWithinHourlyCap.mockRejectedValueOnce(new Error("429"));
    await expect(
      d.ctrl.request({ worker_id: WORKER, job_posting_id: null }, PAYER_A, CTX),
    ).rejects.toThrow();
    expect(d.disclosures.requestDisclosure).not.toHaveBeenCalled();
  });
});

describe("#1899 — a MALFORMED job_posting_id is refused at the boundary (400), never reaching the chokepoint", () => {
  // Syntax, not existence: identical for every caller and database state, so no id oracle.
  // Unknown / foreign WELL-FORMED ids get the chokepoint's neutral body (resume-disclosure.service.test.ts).
  const pipe = new ZodValidationPipe(PayerRequestDisclosureSchema);

  it.each(["not-a-uuid", "", "1; drop table job_postings", 42])("rejects job_posting_id=%j", (id) => {
    expect(() => pipe.transform({ worker_id: WORKER, job_posting_id: id })).toThrow(
      BadRequestException,
    );
  });

  it("accepts an absent or null job_posting_id as null (no reference)", () => {
    expect(pipe.transform({ worker_id: WORKER })).toEqual({ worker_id: WORKER, job_posting_id: null });
  });
});
