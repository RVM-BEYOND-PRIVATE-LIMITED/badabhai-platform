import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger, type ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SessionService } from "./session.service";
import { OptionalWorkerAuthGuard } from "./optional-worker-auth.guard";

/**
 * BEHAVIOURAL tests for {@link OptionalWorkerAuthGuard} — the attribution-only sibling of
 * {@link WorkerAuthGuard} that sits on the PUBLIC interview-kit download.
 *
 * ══ WHY THESE RUN AGAINST A REAL SessionService AND A REAL JwtService ══════════════════
 *
 * This guard's entire safety property is that `req.worker` is set from a token whose
 * SIGNATURE was verified and whose session record still exists — because that id becomes
 * `interview_kit.downloaded.worker_id`, an attribution row on the audit spine, written by an
 * UNAUTHENTICATED route. The dangerous change is not "the guard denies too much"; it is
 * swapping `session.validateAndTouch(token)` for anything that merely DECODES. That would
 * mint forged attribution rows from any unsigned JWT a caller cared to paste, and a test
 * whose session double returns null for the literal string `"bad.token"` would stay green
 * through it — the double, not the code, would be doing the verifying.
 *
 * So the tokens below are REAL HS256 JWTs, signed with the right secret, the wrong secret, a
 * different algorithm, or already expired, and the guard is wired to a REAL SessionService
 * over an in-memory Redis. "Bad signature" and "expired" are then facts about the token, not
 * about the fixture, and the decode-only mutation fails these tests.
 *
 * ══ AND WHAT MUST NEVER CHANGE ═════════════════════════════════════════════════════════
 * `canActivate` returns TRUE in every case below. The moment this file can produce a false or
 * a throw, a public route has silently become a private one and every anonymous worker loses
 * access to the interview kit.
 */

const SECRET = "the-worker-jwt-secret-for-this-suite";
const WRONG_SECRET = "a-different-secret-entirely";
const WORKER_ID = "11111111-1111-4111-8111-111111111111";

const CONFIG = {
  SESSION_TTL_DAYS: 30,
  AUTH_ROLLING_TIERS_ENABLED: false,
  AUTH_SESSION_ABSOLUTE_MAX_DAYS: 90,
  AUTH_TIER_WINDOW_DAYS: 60,
  AUTH_REFRESH_TTL_DAYS: 90,
} as unknown as ServerConfig;

/** In-memory Redis double — the string + set commands SessionService.create/validate use. */
function makeRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    client: {
      async set(key: string, value: string, ...rest: unknown[]) {
        if (rest[0] === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) if (store.delete(k) || sets.delete(k)) n += 1;
        return n;
      },
      async expire(key: string) {
        return store.has(key) || sets.has(key) ? 1 : 0;
      },
      async sadd(key: string, ...members: string[]) {
        const s = sets.get(key) ?? new Set<string>();
        members.forEach((m) => s.add(m));
        sets.set(key, s);
        return members.length;
      },
      async srem() {
        return 0;
      },
      async smembers(key: string) {
        return [...(sets.get(key) ?? [])];
      },
    },
  };
}

function setup(secret = SECRET) {
  const redis = makeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const jwt = new JwtService({ secret, signOptions: { algorithm: "HS256" } });
  const session = new SessionService(
    CONFIG,
    jwt,
    { emit: vi.fn().mockResolvedValue({ event_id: "e" }) } as never,
    { encrypt: (v: string) => v, decrypt: (v: string) => v } as never,
    queue,
    { revokeAllForWorker: vi.fn().mockResolvedValue([]) } as never,
    { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
  );
  const validateSpy = vi.spyOn(session, "validateAndTouch");
  return { redis, jwt, session, validateSpy, guard: new OptionalWorkerAuthGuard(session) };
}

/** An ExecutionContext whose request carries the given Authorization header (or none). */
function makeCtx(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  const req: {
    header: (name: string) => string | undefined;
    worker?: { id: string; sid: string; deviceId?: string };
  } = { header: (name: string) => headers[name.toLowerCase()] };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// The invariant: it can only ever allow.
// ---------------------------------------------------------------------------

describe("OptionalWorkerAuthGuard always allows the request", () => {
  const cases: Array<[string, string | undefined]> = [
    ["no Authorization header at all", undefined],
    ["an empty header", ""],
    ["a non-Bearer scheme", "Basic abc"],
    ["Bearer with no token", "Bearer"],
    ["Bearer with only whitespace", "Bearer    "],
    ["a structurally broken token", "Bearer not-a-jwt"],
  ];

  for (const [label, header] of cases) {
    it(`returns true with ${label}, and attaches no worker`, async () => {
      const { guard } = setup();
      const { ctx, req } = makeCtx(header);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.worker).toBeUndefined();
    });
  }

  it("takes NO Redis round trip when there is no bearer token", async () => {
    // An anonymous download is the ordinary case on this route; it must not pay for a session
    // lookup it can never use.
    const { guard, validateSpy } = setup();
    const { ctx } = makeCtx(undefined);
    await guard.canActivate(ctx);
    expect(validateSpy).not.toHaveBeenCalled();

    const nonBearer = setup();
    await nonBearer.guard.canActivate(makeCtx("Basic abc").ctx);
    expect(nonBearer.validateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Attribution: only a VERIFIED, live session produces a worker id.
// ---------------------------------------------------------------------------

describe("attribution comes from a verified session, never from a decoded claim", () => {
  it("a VALID token attaches req.worker (the whole point of the guard)", async () => {
    const { guard, session } = setup();
    const minted = await session.create(WORKER_ID);
    const { ctx, req } = makeCtx(`Bearer ${minted.access.token}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker?.id).toBe(WORKER_ID);
    expect(req.worker?.sid).toBeTruthy();
  });

  it("a device-bound token carries the device id through", async () => {
    const { guard, session } = setup();
    const minted = await session.create(WORKER_ID, "dev-1");
    const { ctx, req } = makeCtx(`Bearer ${minted.access.token}`);
    await guard.canActivate(ctx);
    expect(req.worker?.deviceId).toBe("dev-1");
  });

  it("a token signed with the WRONG SECRET attributes nothing (bad signature)", async () => {
    /**
     * ⚠ THE MUTATION THIS CATCHES. Replacing `validateAndTouch` with a decode-only helper
     * (`jwt.decode`, or a `verifyAsync` with the signature check disabled) would read `sub`
     * off this token and mint a forged `interview_kit.downloaded.worker_id` for anyone who
     * can type a JSON object — from an UNAUTHENTICATED route. The token below is a real,
     * well-formed HS256 JWT whose only defect is the key it was signed with.
     */
    const { guard } = setup();
    const forger = new JwtService({ secret: WRONG_SECRET, signOptions: { algorithm: "HS256" } });
    const forged = await forger.signAsync({ sub: WORKER_ID, sid: "s-forged" });
    const { ctx, req } = makeCtx(`Bearer ${forged}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toBeUndefined();
  });

  it("an EXPIRED token attributes nothing", async () => {
    const { guard, jwt } = setup();
    const expired = await jwt.signAsync({ sub: WORKER_ID, sid: "s-old" }, { expiresIn: "-1s" });
    const { ctx, req } = makeCtx(`Bearer ${expired}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toBeUndefined();
  });

  it("a token signed with a DIFFERENT ALGORITHM attributes nothing (alg is pinned)", async () => {
    const { guard } = setup();
    const other = new JwtService({ secret: SECRET, signOptions: { algorithm: "HS512" } });
    const token = await other.signAsync({ sub: WORKER_ID, sid: "s-alg" });
    const { ctx, req } = makeCtx(`Bearer ${token}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toBeUndefined();
  });

  it("a REVOKED session attributes nothing even though the JWT still verifies", async () => {
    // Signature-valid but the server-side record is gone — a logged-out worker's old token.
    const { guard, session, redis } = setup();
    const minted = await session.create(WORKER_ID);
    redis.store.clear();
    const { ctx, req } = makeCtx(`Bearer ${minted.access.token}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toBeUndefined();
  });

  it("a THROWING session service is served anonymously, and logs no token and no id", async () => {
    // `validateAndTouch` returns null rather than throwing on every known failure, so this is
    // the second wall: an unexpected throw must not 500 a route whose whole contract is that
    // it works without a session.
    const { guard, validateSpy } = setup();
    validateSpy.mockRejectedValueOnce(new Error(`redis exploded for ${WORKER_ID}`));
    const { ctx, req } = makeCtx("Bearer some.opaque.token");

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]![0]);
    // The line is reachable on a PUBLIC route. It carries the error CLASS and nothing else:
    // never the bearer token, never a worker id, never the thrown message (which here
    // deliberately contains one).
    expect(line).not.toContain("some.opaque.token");
    expect(line).not.toContain(WORKER_ID);
    expect(line).toContain("Error");
  });
});

// ---------------------------------------------------------------------------
// The negative space: this file must stay unable to deny.
// ---------------------------------------------------------------------------

describe("it is NOT a security guard and must never become one", () => {
  it("every `return` in the guard is `return true`, and it throws nothing", () => {
    // A SOURCE scan rather than `Function.prototype.toString()`, for the reason
    // `admin-static-guards.test.ts` scans source: the transpiled body is not the thing anyone
    // reviews, and the failure here is silent — a `return false` or a `throw` added to this
    // file turns the public interview-kit route private, and no test of the interview-kit
    // SERVICE would notice.
    const src = readFileSync(join(__dirname, "optional-worker-auth.guard.ts"), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

    const start = src.indexOf("async canActivate");
    // `private static extractBearer`, NOT bare `extractBearer` — the CALL to it is the first
    // line of `canActivate`, so slicing on the bare name yields an empty body and a test that
    // proves nothing. (It did exactly that on the first cut of this file.)
    const end = src.indexOf("private static extractBearer");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const body = src.slice(start, end);
    const returns = [...body.matchAll(/\breturn\s+([^;]+);/g)].map((m) => m[1]!.trim());
    expect(returns.length).toBeGreaterThan(0);
    expect([...new Set(returns)]).toEqual(["true"]);
    expect(body).not.toMatch(/\bthrow\b/);
  });
});
