import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { NotFoundException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { TestLoginGuard, TEST_LOGIN_TOKEN_HEADER } from "./test-login.guard";

const TOKEN = "s".repeat(32); // a valid >=32-char gate secret

/** Build an ExecutionContext whose request carries the given raw headers. */
function makeCtx(headers: Record<string, unknown> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(over: Partial<ServerConfig> = {}): TestLoginGuard {
  const config = {
    TEST_LOGIN_ENABLED: false,
    TEST_LOGIN_TOKEN: undefined,
    ...over,
  } as ServerConfig;
  return new TestLoginGuard(config);
}

describe("TestLoginGuard (D-3 — gated test-login mint seam)", () => {
  it("DISABLED (the default) → a NEUTRAL 404, even with the correct token header", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: false, TEST_LOGIN_TOKEN: TOKEN });
    expect(() => guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: TOKEN }))).toThrow(
      NotFoundException,
    );
    // Neutral: the SAME 404 with no header at all (no oracle the seam exists).
    expect(() => guard.canActivate(makeCtx())).toThrow(NotFoundException);
  });

  it("enabled but NO token configured → the same neutral 404 (defense-in-depth; boot guard normally forbids this)", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: undefined });
    expect(() => guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: "anything" }))).toThrow(
      NotFoundException,
    );
  });

  it("enabled but a SHORT configured token → neutral 404 (never arm vacuously, TD67)", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: "short" });
    expect(() => guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: "short" }))).toThrow(
      NotFoundException,
    );
  });

  it("enabled + MISSING header → 401 (neutral message, no token echo)", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: TOKEN });
    try {
      guard.canActivate(makeCtx());
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(JSON.stringify((err as UnauthorizedException).getResponse())).not.toContain(TOKEN);
    }
  });

  it("enabled + WRONG token → 401, and the response never echoes either value (no oracle)", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: TOKEN });
    const wrong = "w".repeat(32);
    try {
      guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: wrong }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const body = JSON.stringify((err as UnauthorizedException).getResponse());
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(wrong);
    }
  });

  it("enabled + a DIFFERENT-LENGTH wrong token → the same 401 (HMAC compare — no length throw/short-circuit)", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: TOKEN });
    expect(() => guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: "x" }))).toThrow(
      UnauthorizedException,
    );
  });

  it("enabled + the RIGHT token → passes", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: TOKEN });
    expect(guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: TOKEN }))).toBe(true);
  });

  it("a non-string header value (array smuggling) is handled — first element compared", () => {
    const guard = makeGuard({ TEST_LOGIN_ENABLED: true, TEST_LOGIN_TOKEN: TOKEN });
    expect(guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: [TOKEN] }))).toBe(true);
    expect(() =>
      guard.canActivate(makeCtx({ [TEST_LOGIN_TOKEN_HEADER]: [{ evil: true }] })),
    ).toThrow(UnauthorizedException);
  });
});
