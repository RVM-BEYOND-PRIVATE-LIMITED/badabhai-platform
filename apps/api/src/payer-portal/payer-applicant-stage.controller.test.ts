import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  RequestMethod,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerApplicantStageController } from "./payer-applicant-stage.controller";
import {
  PayerApplicantStagesEnabledGuard,
  applicantStagesEnabled,
} from "./payer-applicant-stages.flag";
import {
  ApplicantStageParamsSchema,
  SetApplicantStageSchema,
  type SetApplicantStageResponseDto,
} from "./payer-applicant-stage.dto";

const PAYER_A: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const WORKER = "33333333-3333-4333-8333-000000000001";
const PARAMS = { jobId: JOB, workerId: WORKER };

function makeCtrl() {
  const out: SetApplicantStageResponseDto = {
    postingId: JOB,
    postingKind: "company_posting",
    workerId: WORKER,
    stage: "shortlist",
    previousStage: "new",
    changed: true,
  };
  const stages = { setStage: vi.fn(async () => out) };
  const rateLimit = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const config = { PAYER_APPLICANT_STAGE_MAX_PER_HOUR: 600 } as unknown as ServerConfig;
  const ctrl = new PayerApplicantStageController(stages as never, rateLimit as never, config);
  return { ctrl, stages, rateLimit, out };
}

/**
 * `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` at the HTTP boundary. Ownership,
 * membership, idempotency and the event are proven in payer-applicant-stages.service.test.ts; this
 * file pins that the controller is HTTP-only — the flag guard after the auth guard, the strict
 * params/body, the write cap FIRST on its own bucket, then one delegation with the SESSION payer.
 */
describe("PayerApplicantStageController — route, guards, cap, delegation", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("is PUT payer/reach/jobs/:jobId/applicants/:workerId/stage, answering 200", () => {
    const handler = PayerApplicantStageController.prototype.setStage;
    expect(Reflect.getMetadata(PATH_METADATA, PayerApplicantStageController)).toBe("payer/reach");
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "jobs/:jobId/applicants/:workerId/stage",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it("guards: PayerAuthGuard FIRST (401 before anything), then the flag guard (404 while off)", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PayerApplicantStageController)).toEqual([
      PayerAuthGuard,
      PayerApplicantStagesEnabledGuard,
    ]);
  });

  it("delegates with the SESSION payer id, the route's ids and the body's stage", async () => {
    await d.ctrl.setStage(PARAMS, { stage: "shortlist" }, PAYER_A, CTX);
    expect(d.stages.setStage).toHaveBeenCalledWith(PAYER_A.id, JOB, WORKER, "shortlist", CTX);
  });

  it("returns the service's answer verbatim", async () => {
    await expect(d.ctrl.setStage(PARAMS, { stage: "shortlist" }, PAYER_A, CTX)).resolves.toBe(
      d.out,
    );
  });

  it("charges its OWN bucket (payer_applicant_stage) at PAYER_APPLICANT_STAGE_MAX_PER_HOUR, one unit, BEFORE the service", async () => {
    await d.ctrl.setStage(PARAMS, { stage: "passed" }, PAYER_A, CTX);
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledOnce();
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id, {
      scope: "payer_applicant_stage",
      cap: 600,
    });
    expect(d.rateLimit.assertWithinHourlyCap.mock.invocationCallOrder[0]!).toBeLessThan(
      d.stages.setStage.mock.invocationCallOrder[0]!,
    );
  });

  it("a tripped cap (or Redis down, the same 429) blocks the write entirely", async () => {
    d.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(
      new HttpException("Too many requests; please try again later", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.ctrl.setStage(PARAMS, { stage: "passed" }, PAYER_A, CTX)).rejects.toMatchObject({
      status: 429,
    });
    expect(d.stages.setStage).not.toHaveBeenCalled();
  });

  it("passes the neutral 404 through, and never converts a server error (fail closed)", async () => {
    d.stages.setStage.mockRejectedValueOnce(new NotFoundException("Job not found"));
    await expect(d.ctrl.setStage(PARAMS, { stage: "passed" }, PAYER_A, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    d.stages.setStage.mockRejectedValueOnce(new InternalServerErrorException());
    await expect(d.ctrl.setStage(PARAMS, { stage: "passed" }, PAYER_A, CTX)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("takes no data-access dependency: service + cap + config only (CLAUDE.md §4)", () => {
    expect(PayerApplicantStageController.length).toBe(3);
  });
});

describe("PayerApplicantStagesEnabledGuard + applicantStagesEnabled — the one flag read", () => {
  it("off (false / unset) → a neutral 404; on → passes", () => {
    for (const value of [false, undefined]) {
      const guard = new PayerApplicantStagesEnabledGuard({
        PAYER_APPLICANT_STAGES_ENABLED: value as boolean,
      });
      expect(() => guard.canActivate()).toThrow(NotFoundException);
    }
    expect(
      new PayerApplicantStagesEnabledGuard({ PAYER_APPLICANT_STAGES_ENABLED: true }).canActivate(),
    ).toBe(true);
  });

  it("the 404 is the bare Nest one (no 'disabled' wording to read as a feature oracle)", () => {
    const guard = new PayerApplicantStagesEnabledGuard({ PAYER_APPLICANT_STAGES_ENABLED: false });
    try {
      guard.canActivate();
      throw new Error("expected a 404");
    } catch (err) {
      expect((err as NotFoundException).getResponse()).toEqual(
        new NotFoundException().getResponse(),
      );
    }
  });

  it("only a literal true turns it on", () => {
    expect(applicantStagesEnabled({ PAYER_APPLICANT_STAGES_ENABLED: true })).toBe(true);
    expect(applicantStagesEnabled({ PAYER_APPLICANT_STAGES_ENABLED: false })).toBe(false);
    expect(applicantStagesEnabled({} as never)).toBe(false);
    expect(applicantStagesEnabled({ PAYER_APPLICANT_STAGES_ENABLED: "true" } as never)).toBe(false);
  });
});

describe("the route's validation (the pipes the decorators run)", () => {
  const params = new ZodValidationPipe(ApplicantStageParamsSchema);
  const body = new ZodValidationPipe(SetApplicantStageSchema);

  it("accepts the two uuids and each of the three stages", () => {
    expect(params.transform(PARAMS)).toEqual(PARAMS);
    for (const stage of ["new", "shortlist", "passed"]) {
      expect(body.transform({ stage })).toEqual({ stage });
    }
  });

  it.each([
    [{ jobId: "not-a-uuid", workerId: WORKER }],
    [{ jobId: JOB, workerId: "not-a-uuid" }],
    [{ jobId: JOB }],
  ])("a malformed or missing route id is a 400 (%j)", (bad) => {
    expect(() => params.transform(bad)).toThrow(BadRequestException);
  });

  it.each([
    [{}],
    [{ stage: "contacted" }],
    [{ stage: "Shortlist" }],
    [{ stage: null }],
    [{ stage: "passed", payer_id: PAYER_A.id }],
    [{ stage: "passed", payerId: PAYER_A.id }],
    [{ stage: "passed", posting_kind: "agency_job" }],
    [{ stage: "passed", note: "good fit" }],
  ])("a body outside { stage: new|shortlist|passed } is a 400 (%j)", (bad) => {
    expect(() => body.transform(bad)).toThrow(BadRequestException);
  });
});

describe("the route's validation is WIRED: both decorators carry their ZodValidationPipe", () => {
  /** The pipes Nest runs for the handler argument of `type` (e.g. BODY, PARAM). */
  function pipesFor(type: RouteParamtypes): unknown[] {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PayerApplicantStageController,
      "setStage",
    ) as Record<string, { pipes: unknown[] }>;
    const entries = Object.entries(args).filter(([k]) => k.startsWith(`${type}:`));
    expect(entries, `exactly one ${RouteParamtypes[type]} argument`).toHaveLength(1);
    return entries[0]![1].pipes;
  }

  it("@Param validates with ApplicantStageParamsSchema (both route ids are uuids)", () => {
    const pipes = pipesFor(RouteParamtypes.PARAM);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toBeInstanceOf(ZodValidationPipe);
    expect(Reflect.get(pipes[0] as object, "schema")).toBe(ApplicantStageParamsSchema);
  });

  it("@Body validates with SetApplicantStageSchema (strict { stage })", () => {
    const pipes = pipesFor(RouteParamtypes.BODY);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toBeInstanceOf(ZodValidationPipe);
    expect(Reflect.get(pipes[0] as object, "schema")).toBe(SetApplicantStageSchema);
  });
});
