import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { InterviewKitController } from "./interview-kit.controller";
import type { InterviewKitService } from "./interview-kit.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const IP = "203.0.113.9";
const WORKER_ID = "11111111-1111-4111-8111-111111111111";

/** An anonymous request — no worker attached by the optional guard. */
const anon = () => ({}) as Request;
/** A request the optional guard resolved to a real worker session. */
const authed = (id = WORKER_ID) => ({ worker: { id, sid: "s" } }) as Request;

function make() {
  const kits = { getDownload: vi.fn(async () => ({ url: "https://signed/u?token=x", expires_in: 900 })) };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR: 30 } as ServerConfig;
  const controller = new InterviewKitController(
    kits as unknown as InterviewKitService,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { controller, kits, ipRateLimit };
}

describe("InterviewKitController — per-IP cap first, then delegate", () => {
  it("applies the per-IP cap FIRST, then delegates with the source", async () => {
    const { controller, kits, ipRateLimit } = make();
    await controller.download("cnc_operator", "ops" as never, IP, CTX, anon());
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("interview_kit", IP, 30);
    expect(kits.getDownload).toHaveBeenCalledWith("cnc_operator", CTX, {
      source: "ops",
      workerId: null,
    });
  });

  it("a cap rejection blocks the service call", async () => {
    const { controller, kits, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(
      controller.download("cnc_operator", "ops" as never, IP, CTX, anon()),
    ).rejects.toBeTruthy();
    expect(kits.getDownload).not.toHaveBeenCalled();
  });

  // WA-5 contract lock: the controller adds NO mapping of its own — the documented
  // statuses (429 from the cap, 503 from the service) must reach the client as-is.
  it("the 429 over-cap rejection propagates with its status intact", async () => {
    const { controller, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
    );
    const err = (await controller.download("cnc_operator", "ops" as never, IP, CTX, anon()).then(
      () => null,
      (e: unknown) => e,
    )) as HttpException;
    expect(err.getStatus()).toBe(429);
  });

  it("the service's 503 (renderer/storage unavailable) propagates with its status intact", async () => {
    const { controller, kits } = make();
    (kits.getDownload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ServiceUnavailableException("Interview kit is not available yet; please try again later"),
    );
    const err = (await controller
      .download("cnc_operator", "worker_app" as never, IP, CTX, authed())
      .then(
        () => null,
        (e: unknown) => e,
      )) as ServiceUnavailableException;
    expect(err.getStatus()).toBe(503);
  });
});

/**
 * OPTIONAL worker attribution (admin journey step 7).
 *
 * The property under test is a PAIR, and only the pair is meaningful: the id must be taken
 * from the session when there is one, and the route must still work when there is not. A
 * test for either half alone passes on an implementation that broke the other.
 */
describe("InterviewKitController — the download stays PUBLIC, attribution is optional", () => {
  it("attaches the SESSION's worker id when the optional guard resolved one", async () => {
    const { controller, kits } = make();
    await controller.download("cnc_operator", "worker_app" as never, IP, CTX, authed());
    expect(kits.getDownload).toHaveBeenCalledWith("cnc_operator", CTX, {
      source: "worker_app",
      workerId: WORKER_ID,
    });
  });

  it("serves an ANONYMOUS request with workerId null — no token is not an error", async () => {
    const { controller, kits } = make();
    const out = await controller.download("cnc_operator", "worker_app" as never, IP, CTX, anon());
    expect(out).toBeTruthy();
    expect(kits.getDownload).toHaveBeenCalledWith("cnc_operator", CTX, {
      source: "worker_app",
      workerId: null,
    });
  });

  it("the id can ONLY come from the session — the handler takes no caller-supplied worker id", () => {
    // Structural, not behavioural: the route's parameters are (tradeKey, source, ip, ctx, req).
    // A sixth `@Query('workerId')`/`@Body()` parameter would let any caller forge an
    // attribution row on the audit spine for the price of one unauthenticated GET.
    expect(InterviewKitController.prototype.download.length).toBe(5);
  });
});
