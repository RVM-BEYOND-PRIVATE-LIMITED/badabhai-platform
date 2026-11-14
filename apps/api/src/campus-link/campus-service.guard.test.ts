import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import type { CampusCallAudit, CampusCallAuditRepository } from "./campus-call-audit.repository";
import {
  CampusServiceGuard,
  matchTokenSlot,
  normaliseAddress,
  routeTemplate,
} from "./campus-service.guard";
import { CAMPUS_CALL_ID_HEADER, CAMPUS_SERVICE_TOKEN_HEADER } from "./campus-link.contract";

const TOKEN = "campus-token-live-0123456789abcdef";
const NEXT_TOKEN = "campus-token-next-fedcba9876543210";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const CAMPUS_IP = "203.0.113.7";

interface Setup {
  enabled?: boolean;
  nodeEnv?: ServerConfig["NODE_ENV"];
  hashes?: string[];
  allowedIps?: string[];
  rateLimitError?: unknown;
  refusedAuditError?: unknown;
}

function setup({
  enabled = true,
  nodeEnv = "production",
  hashes = [sha256(TOKEN)],
  allowedIps = [CAMPUS_IP],
  rateLimitError,
  refusedAuditError,
}: Setup = {}) {
  const audits: CampusCallAudit[] = [];
  const audit = {
    record: vi.fn(async (a: CampusCallAudit) => {
      audits.push(a);
    }),
  } as unknown as CampusCallAuditRepository;
  const rateLimit = {
    assertWithinMinuteCap: vi.fn(async (scope: string) => {
      if (scope === "campus_service" && rateLimitError) throw rateLimitError;
      if (scope === "campus_service_refused" && refusedAuditError) throw refusedAuditError;
    }),
  } as unknown as SubjectRateLimit;
  const config = {
    NODE_ENV: nodeEnv,
    CAMPUS_LINK_ENABLED: enabled,
    CAMPUS_SERVICE_TOKEN_SHA256S: hashes,
    CAMPUS_SERVICE_ALLOWED_IPS: allowedIps,
    CAMPUS_SERVICE_MAX_PER_MINUTE: 600,
  } as ServerConfig;
  return { guard: new CampusServiceGuard(config, audit, rateLimit), audits, rateLimit };
}

function call(token: string | undefined, ip: string | undefined = CAMPUS_IP) {
  const headers = token === undefined ? {} : { [CAMPUS_SERVICE_TOKEN_HEADER]: token };
  const responseHeaders: Record<string, string> = {};
  class CampusLinkController {
    ping() {}
  }
  const path = "/internal/campus/v1/ping";
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip, method: "GET", path, originalUrl: path, route: { path } }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          responseHeaders[name] = value;
        },
      }),
    }),
    getClass: () => CampusLinkController,
    getHandler: () => CampusLinkController.prototype.ping,
  } as unknown as ExecutionContext;
  return { context, responseHeaders };
}

describe("CampusServiceGuard", () => {
  it("accepts the right token from an allowed address, audits it and returns the call id", async () => {
    const { guard, audits } = setup();
    const { context, responseHeaders } = call(TOKEN);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: "accepted",
      method: "GET",
      path: "/internal/campus/v1/ping",
      handler: "CampusLinkController.ping",
      tokenSlot: 0,
    });
    expect(responseHeaders[CAMPUS_CALL_ID_HEADER]).toBe(audits[0]?.callId);
  });

  it("answers a neutral 404 with the flag off, before any other check, and writes nothing", async () => {
    const { guard, audits, rateLimit } = setup({ enabled: false });

    const off = guard.canActivate(call(TOKEN).context);
    await expect(off).rejects.toThrow(NotFoundException);
    // Word for word what Nest answers for a route that does not exist: no "disabled" oracle.
    await expect(off).rejects.toThrow("Cannot GET /internal/campus/v1/ping");
    await expect(guard.canActivate(call(undefined, "198.51.100.1").context)).rejects.toThrow(
      NotFoundException,
    );
    expect(audits).toHaveLength(0);
    expect(rateLimit.assertWithinMinuteCap).not.toHaveBeenCalled();
  });

  it("refuses an address off the allow-list with 403, even with the right token, and writes no row", async () => {
    const { guard, audits } = setup();

    const refusal = guard.canActivate(call(TOKEN, "198.51.100.1").context);

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({ response: { code: "ADDRESS_NOT_ALLOWED" } });
    expect(audits).toHaveLength(0);
  });

  it("FAILS CLOSED on an empty allow-list", async () => {
    const { guard } = setup({ allowedIps: [] });
    await expect(guard.canActivate(call(TOKEN).context)).rejects.toThrow(ForbiddenException);
  });

  it("matches an IPv4 peer that arrives in IPv6-mapped form", async () => {
    const { guard } = setup();
    await expect(guard.canActivate(call(TOKEN, `::ffff:${CAMPUS_IP}`).context)).resolves.toBe(true);
  });

  it("matches an IPv6 peer written differently from the configured address", async () => {
    const { guard } = setup({ allowedIps: ["2001:db8::7"] });
    await expect(
      guard.canActivate(call(TOKEN, "2001:0DB8:0000:0000:0000:0000:0000:0007").context),
    ).resolves.toBe(true);
  });

  it("outside development, refuses a loopback or private peer even when it is allow-listed", async () => {
    // With the proxy hop untrusted, every caller presents the proxy's own private address:
    // allow-listing it would admit the whole internet, so such a peer is never Campus.
    const { guard } = setup({ allowedIps: ["127.0.0.1", "172.18.0.1", "::1", CAMPUS_IP] });

    for (const ip of ["127.0.0.1", "::ffff:172.18.0.1", "::1"]) {
      await expect(guard.canActivate(call(TOKEN, ip).context)).rejects.toThrow(ForbiddenException);
    }
    await expect(guard.canActivate(call(TOKEN, CAMPUS_IP).context)).resolves.toBe(true);
  });

  it("in development and tests, accepts an allow-listed loopback peer", async () => {
    const { guard } = setup({ nodeEnv: "development", allowedIps: ["127.0.0.1"] });
    await expect(guard.canActivate(call(TOKEN, "127.0.0.1").context)).resolves.toBe(true);
  });

  it("answers 401 for a missing or wrong token and audits the refusal", async () => {
    const { guard, audits } = setup();

    await expect(guard.canActivate(call(undefined).context)).rejects.toThrow(UnauthorizedException);
    const wrong = guard.canActivate(call("not-the-token").context);
    await expect(wrong).rejects.toThrow(UnauthorizedException);
    await expect(wrong).rejects.toMatchObject({ response: { code: "UNAUTHENTICATED" } });

    expect(audits.map((a) => [a.outcome, a.tokenSlot])).toEqual([
      ["refused_token", null],
      ["refused_token", null],
    ]);
  });

  it("never accepts the shared ops token's header in place of its own", async () => {
    const { guard } = setup();
    const { context } = call(undefined);
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    req.headers["x-internal-service-token"] = TOKEN;

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("stops auditing refusals past their own per-minute budget, and still refuses", async () => {
    const { guard, audits } = setup({
      refusedAuditError: new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
    });

    await expect(guard.canActivate(call("stale-token").context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(audits).toHaveLength(0);
  });

  it("FAILS CLOSED when no token hash is configured", async () => {
    const { guard } = setup({ hashes: [] });
    await expect(guard.canActivate(call(TOKEN).context)).rejects.toThrow(UnauthorizedException);
  });

  it("accepts either token during a rotation and records which slot matched", async () => {
    const { guard, audits } = setup({ hashes: [sha256(TOKEN), sha256(NEXT_TOKEN)] });

    await expect(guard.canActivate(call(TOKEN).context)).resolves.toBe(true);
    await expect(guard.canActivate(call(NEXT_TOKEN).context)).resolves.toBe(true);

    expect(audits.map((a) => a.tokenSlot)).toEqual([0, 1]);
  });

  it("answers 429 RATE_LIMITED over the cap and audits it", async () => {
    const { guard, audits } = setup({
      rateLimitError: new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
    });

    const refusal = guard.canActivate(call(TOKEN).context);

    await expect(refusal).rejects.toMatchObject({
      response: { code: "RATE_LIMITED" },
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(audits.map((a) => a.outcome)).toEqual(["rate_limited"]);
  });

  it("lets an unexpected limiter failure through unchanged rather than calling it a rate limit", async () => {
    const boom = new Error("unexpected");
    const { guard, audits } = setup({ rateLimitError: boom });

    await expect(guard.canActivate(call(TOKEN).context)).rejects.toBe(boom);
    expect(audits).toHaveLength(0);
  });

  it("fails the call when the audit row cannot be written", async () => {
    const failing = new CampusServiceGuard(
      {
        NODE_ENV: "production",
        CAMPUS_LINK_ENABLED: true,
        CAMPUS_SERVICE_TOKEN_SHA256S: [sha256(TOKEN)],
        CAMPUS_SERVICE_ALLOWED_IPS: [CAMPUS_IP],
        CAMPUS_SERVICE_MAX_PER_MINUTE: 600,
      } as ServerConfig,
      {
        record: vi.fn(async () => {
          throw new Error("db down");
        }),
      } as unknown as CampusCallAuditRepository,
      { assertWithinMinuteCap: vi.fn(async () => {}) } as unknown as SubjectRateLimit,
    );

    await expect(failing.canActivate(call(TOKEN).context)).rejects.toThrow("db down");
  });
});

describe("matchTokenSlot", () => {
  const hashes = [sha256(TOKEN), sha256(NEXT_TOKEN)];

  it("returns the slot of the matching hash", () => {
    expect(matchTokenSlot(TOKEN, hashes)).toBe(0);
    expect(matchTokenSlot(NEXT_TOKEN, hashes)).toBe(1);
  });

  it("takes the first value of a repeated header", () => {
    expect(matchTokenSlot([NEXT_TOKEN, "other"], hashes)).toBe(1);
  });

  it("refuses empty, oversized and non-string values without hashing them", () => {
    expect(matchTokenSlot("", hashes)).toBeNull();
    expect(matchTokenSlot("x".repeat(513), hashes)).toBeNull();
    expect(matchTokenSlot(undefined, hashes)).toBeNull();
    expect(matchTokenSlot(42, hashes)).toBeNull();
  });

  it("matches nothing when nothing is configured", () => {
    expect(matchTokenSlot(TOKEN, [])).toBeNull();
  });
});

describe("normaliseAddress", () => {
  it("strips the IPv4-mapped prefix and leaves real IPv6 alone", () => {
    expect(normaliseAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normaliseAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(normaliseAddress("::1")).toBe("::1");
    expect(normaliseAddress(undefined)).toBeNull();
  });
});

describe("routeTemplate", () => {
  it("is the declared route, so a student reference in the path never reaches the audit row", () => {
    expect(routeTemplate({ route: { path: "/internal/campus/v1/students/:student_ref" } })).toBe(
      "/internal/campus/v1/students/:student_ref",
    );
  });

  it("falls back to a marker, never to the concrete path, when no route matched", () => {
    expect(routeTemplate({ route: undefined })).toBe("(unmatched)");
  });
});
