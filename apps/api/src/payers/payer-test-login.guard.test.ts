import { describe, it, expect } from "vitest";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  PayerTestLoginGuard,
  PAYER_TEST_LOGIN_TOKEN_HEADER,
  isSyntheticPayerEmail,
  PAYER_TEST_LOGIN_DOMAIN,
} from "./payer-test-login.guard";

const TOKEN = "a".repeat(32);

function ctx(headers: Record<string, unknown> = {}) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as never;
}
function guard(cfg: Partial<ServerConfig>) {
  return new PayerTestLoginGuard(cfg as ServerConfig);
}

describe("PayerTestLoginGuard", () => {
  it("is a NEUTRAL 404 while disabled — indistinguishable from a route that does not exist", () => {
    const g = guard({ PAYER_TEST_LOGIN_ENABLED: false, PAYER_TEST_LOGIN_TOKEN: TOKEN });
    expect(() => g.canActivate(ctx({ [PAYER_TEST_LOGIN_TOKEN_HEADER]: TOKEN }))).toThrow(
      NotFoundException,
    );
  });

  /**
   * TD67 — the lesson that an empty-string secret must never arm a gate vacuously. Enabled with
   * no token is MORE dangerous than disabled: it looks protected and is not.
   */
  it("refuses to arm vacuously — enabled with a missing or short token is still a 404", () => {
    expect(() =>
      guard({ PAYER_TEST_LOGIN_ENABLED: true, PAYER_TEST_LOGIN_TOKEN: undefined }).canActivate(
        ctx({ [PAYER_TEST_LOGIN_TOKEN_HEADER]: "" }),
      ),
    ).toThrow(NotFoundException);
    expect(() =>
      guard({ PAYER_TEST_LOGIN_ENABLED: true, PAYER_TEST_LOGIN_TOKEN: "short" }).canActivate(
        ctx({ [PAYER_TEST_LOGIN_TOKEN_HEADER]: "short" }),
      ),
    ).toThrow(NotFoundException);
  });

  it("401s a wrong or missing token once armed", () => {
    const g = guard({ PAYER_TEST_LOGIN_ENABLED: true, PAYER_TEST_LOGIN_TOKEN: TOKEN });
    expect(() => g.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(() => g.canActivate(ctx({ [PAYER_TEST_LOGIN_TOKEN_HEADER]: "b".repeat(32) }))).toThrow(
      UnauthorizedException,
    );
  });

  /** The PERMIT row — without it an over-tight gate passes every "does it block X" test. */
  it("ALLOWS the correct token when armed", () => {
    const g = guard({ PAYER_TEST_LOGIN_ENABLED: true, PAYER_TEST_LOGIN_TOKEN: TOKEN });
    expect(g.canActivate(ctx({ [PAYER_TEST_LOGIN_TOKEN_HEADER]: TOKEN }))).toBe(true);
  });
});

describe("isSyntheticPayerEmail", () => {
  it("admits only the reserved .invalid domain", () => {
    expect(isSyntheticPayerEmail(`e2e-1${PAYER_TEST_LOGIN_DOMAIN}`)).toBe(true);
    expect(isSyntheticPayerEmail(`E2E-1${PAYER_TEST_LOGIN_DOMAIN.toUpperCase()}`)).toBe(true);
  });

  /**
   * The whole point: staging runs a REAL email provider, so real payer accounts exist there.
   * A leaked gate token must not become impersonation of a real customer.
   */
  it("refuses real addresses, including look-alikes", () => {
    for (const bad of [
      "someone@gmail.com",
      "ops@badabhai.in",
      "e2e@e2e.badabhai.invalid.attacker.com",
      "e2e@badabhai.invalid",
    ]) {
      expect(isSyntheticPayerEmail(bad)).toBe(false);
    }
  });
});
