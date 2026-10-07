import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException, HttpStatus, InternalServerErrorException } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerApplicantInboxController } from "./payer-applicant-inbox.controller";
import { PayerApplicantInboxQuerySchema } from "./payer-applicant-inbox.dto";

const PAYER_A: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const QUERY = PayerApplicantInboxQuerySchema.parse({});

function makeCtrl() {
  const page = { applicants: [], nextCursor: null };
  const inbox = { list: vi.fn(async () => page) };
  const rateLimit = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const config = { PAYER_REACH_MAX_PER_HOUR: 60 } as unknown as ServerConfig;
  const ctrl = new PayerApplicantInboxController(inbox as never, rateLimit as never, config);
  return { ctrl, inbox, rateLimit, page };
}

/**
 * `GET /payer/reach/applicants` at the HTTP boundary. The ownership, row building and events are
 * proven in payer-applicant-inbox.service.test.ts; this file pins that the controller is
 * HTTP-only — the reach cap FIRST, on the shared `payer_reach` bucket, then one delegation with
 * the SESSION payer, nothing else.
 */
describe("PayerApplicantInboxController — session identity, reach cap before any read", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("is GET payer/reach/applicants behind PayerAuthGuard", () => {
    expect(Reflect.getMetadata(PATH_METADATA, PayerApplicantInboxController)).toBe("payer/reach");
    expect(Reflect.getMetadata(PATH_METADATA, PayerApplicantInboxController.prototype.list)).toBe(
      "applicants",
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, PayerApplicantInboxController)).toEqual([
      PayerAuthGuard,
    ]);
  });

  it("delegates with the SESSION payer id (the query has no payer slot)", async () => {
    await d.ctrl.list(QUERY, PAYER_A, CTX);
    expect(d.inbox.list).toHaveBeenCalledWith(PAYER_A.id, QUERY, CTX);
  });

  it("returns the service's page verbatim (no reshaping in the controller)", async () => {
    await expect(d.ctrl.list(QUERY, PAYER_A, CTX)).resolves.toBe(d.page);
  });

  it("charges the SAME payer_reach bucket as the per-posting list, at PAYER_REACH_MAX_PER_HOUR, one unit", async () => {
    await d.ctrl.list(QUERY, PAYER_A, CTX);
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledOnce();
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id, {
      scope: "payer_reach",
      cap: 60,
    });
  });

  it("the cap runs BEFORE the read", async () => {
    await d.ctrl.list(QUERY, PAYER_A, CTX);
    expect(d.rateLimit.assertWithinHourlyCap.mock.invocationCallOrder[0]!).toBeLessThan(
      d.inbox.list.mock.invocationCallOrder[0]!,
    );
  });

  it("a tripped cap (or a Redis outage, same 429) blocks the read entirely", async () => {
    d.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(
      new HttpException("Too many requests; please try again later", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.ctrl.list(QUERY, PAYER_A, CTX)).rejects.toMatchObject({ status: 429 });
    expect(d.inbox.list).not.toHaveBeenCalled();
  });

  it("never converts a server error into anything else (fail closed)", async () => {
    d.inbox.list.mockRejectedValueOnce(new InternalServerErrorException());
    await expect(d.ctrl.list(QUERY, PAYER_A, CTX)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("takes no data-access dependency: service + cap + config only (CLAUDE.md §4)", () => {
    expect(PayerApplicantInboxController.length).toBe(3);
  });
});
