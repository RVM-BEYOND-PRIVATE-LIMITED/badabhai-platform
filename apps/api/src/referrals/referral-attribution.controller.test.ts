import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { ReferralAttributionController } from "./referral-attribution.controller";
import type { ReferralAttributionService } from "./referral-attribution.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";

const WORKER: AuthenticatedWorker = {
  id: "44444444-4444-4444-8444-444444444444",
} as AuthenticatedWorker;
const CODE = "abcdef012345";
const IP = "203.0.113.7";

function make(outcome: { attributed: boolean; kind: string }) {
  const service = { attribute: vi.fn().mockResolvedValue(outcome) };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn().mockResolvedValue(undefined) };
  const config = { REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR: 20 } as unknown as ServerConfig;
  const ctrl = new ReferralAttributionController(
    service as unknown as ReferralAttributionService,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { ctrl, service, ipRateLimit };
}

describe("ReferralAttributionController — no-oracle + session-scoped id", () => {
  it("returns the SAME neutral {ok:true} when attribution SUCCEEDS", async () => {
    const { ctrl } = make({ attributed: true, kind: "worker" });
    await expect(ctrl.attribute(WORKER, { code: CODE }, IP)).resolves.toEqual({ ok: true });
  });

  it("returns the SAME neutral {ok:true} when attribution is a NO-OP (unknown/self/dup) — no oracle", async () => {
    const { ctrl } = make({ attributed: false, kind: "none" });
    await expect(ctrl.attribute(WORKER, { code: CODE }, IP)).resolves.toEqual({ ok: true });
  });

  it("dispatches the SESSION worker id (not any body id) + the code to the service", async () => {
    const { ctrl, service } = make({ attributed: true, kind: "agency" });
    await ctrl.attribute(WORKER, { code: CODE }, IP);
    expect(service.attribute).toHaveBeenCalledWith(CODE, WORKER.id);
  });

  it("enforces the per-IP hourly cap BEFORE dispatching (fail-closed backstop)", async () => {
    const { ctrl, ipRateLimit } = make({ attributed: true, kind: "worker" });
    await ctrl.attribute(WORKER, { code: CODE }, IP);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("referral_attribute", IP, 20);
  });

  it("a rate-limit breach (429) propagates and SHORT-CIRCUITS attribution (no dispatch)", async () => {
    const { ctrl, service, ipRateLimit } = make({ attributed: true, kind: "worker" });
    ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(new Error("429"));
    await expect(ctrl.attribute(WORKER, { code: CODE }, IP)).rejects.toThrow("429");
    expect(service.attribute).not.toHaveBeenCalled();
  });
});
