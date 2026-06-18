import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { InterviewKitController } from "./interview-kit.controller";
import type { InterviewKitService } from "./interview-kit.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const IP = "203.0.113.9";

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
    await controller.download("cnc_operator", "ops" as never, IP, CTX);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("interview_kit", IP, 30);
    expect(kits.getDownload).toHaveBeenCalledWith("cnc_operator", CTX, { source: "ops" });
  });

  it("a cap rejection blocks the service call", async () => {
    const { controller, kits, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(controller.download("cnc_operator", "ops" as never, IP, CTX)).rejects.toBeTruthy();
    expect(kits.getDownload).not.toHaveBeenCalled();
  });
});
