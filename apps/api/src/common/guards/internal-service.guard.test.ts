import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { InternalServiceGuard, INTERNAL_SERVICE_TOKEN_HEADER } from "./internal-service.guard";

function contextWithHeader(value: string | string[] | undefined): ExecutionContext {
  const headers = value === undefined ? {} : { [INTERNAL_SERVICE_TOKEN_HEADER]: value };
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function guard(token: string | undefined): InternalServiceGuard {
  return new InternalServiceGuard({ INTERNAL_SERVICE_TOKEN: token } as ServerConfig);
}

describe("InternalServiceGuard", () => {
  const TOKEN = "s3cret-ops-token";

  it("allows a request carrying the correct token", () => {
    expect(guard(TOKEN).canActivate(contextWithHeader(TOKEN))).toBe(true);
  });

  it("rejects a wrong token (401)", () => {
    expect(() => guard(TOKEN).canActivate(contextWithHeader("nope"))).toThrow(UnauthorizedException);
  });

  it("rejects a missing token (401)", () => {
    expect(() => guard(TOKEN).canActivate(contextWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it("FAILS CLOSED when no secret is configured — denies even an empty header", () => {
    expect(() => guard(undefined).canActivate(contextWithHeader(""))).toThrow(UnauthorizedException);
    expect(() => guard(undefined).canActivate(contextWithHeader("anything"))).toThrow(
      UnauthorizedException,
    );
  });

  it("rejects a length-different token (constant-time compare short-circuits)", () => {
    expect(() => guard(TOKEN).canActivate(contextWithHeader(TOKEN + "x"))).toThrow(
      UnauthorizedException,
    );
  });

  it("uses the first value when the header arrives as an array", () => {
    expect(guard(TOKEN).canActivate(contextWithHeader([TOKEN, "other"]))).toBe(true);
  });
});
