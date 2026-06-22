import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerAuthController } from "./payer-auth.controller";

const CTX: RequestContext = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const PAYER: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid-a", role: "employer" };
const req = { ip: "203.0.113.7" } as unknown as Request;

function makeCtrl() {
  const auth = {
    signup: vi.fn(async () => ({ status: "code_sent", resend_in_seconds: 30 })),
    requestLogin: vi.fn(async () => ({ status: "code_sent", resend_in_seconds: 30 })),
    verifyLogin: vi.fn(async () => ({ access_token: "t", token_type: "Bearer" })),
    refresh: vi.fn(async () => ({ access_token: "f", token_type: "Bearer", expires_in_seconds: 1 })),
    logout: vi.fn(async () => undefined),
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { PAYER_AUTH_MAX_PER_IP_PER_HOUR: 20 } as unknown as ServerConfig;
  const ctrl = new PayerAuthController(auth as never, ipRateLimit as never, config);
  return { ctrl, auth, ipRateLimit };
}

describe("PayerAuthController — XB-H per-IP rate limit on the public endpoints", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("signup / login-request / login-verify each enforce the per-IP cap BEFORE delegating", async () => {
    await d.ctrl.signup({ role: "employer", email: "a@b.com", org_name: "X" } as never, req, CTX);
    await d.ctrl.requestLogin({ email: "a@b.com" } as never, req, CTX);
    await d.ctrl.verifyLogin({ email: "a@b.com", code: "123456" } as never, req, CTX);
    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledTimes(3);
    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("payer_auth", "203.0.113.7", 20);
  });

  it("a tripped IP cap blocks signup before it reaches the service", async () => {
    d.ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(new Error("429"));
    await expect(
      d.ctrl.signup({ role: "employer", email: "a@b.com", org_name: "X" } as never, req, CTX),
    ).rejects.toThrow();
    expect(d.auth.signup).not.toHaveBeenCalled();
  });

  it("refresh + logout delegate the SESSION payer (identity from the guard, not the body)", async () => {
    await d.ctrl.refresh(PAYER);
    expect(d.auth.refresh).toHaveBeenCalledWith(PAYER.id, PAYER.sid);
    await d.ctrl.logout(PAYER);
    expect(d.auth.logout).toHaveBeenCalledWith(PAYER.sid);
  });
});
