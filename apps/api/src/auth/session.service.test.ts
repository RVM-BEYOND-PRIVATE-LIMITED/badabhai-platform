import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SessionService } from "./session.service";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const TTL = 30 * 86400;

function makeRedis() {
  const store = new Map<string, string>();
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    store,
    calls,
    client: {
      async set(key: string, value: string, _mode: string, _sec: number) {
        calls.push(["set", key, value]);
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        calls.push(["get", key]);
        return store.get(key) ?? null;
      },
      async del(...keys: string[]) {
        calls.push(["del", ...keys]);
        let n = 0;
        for (const k of keys) if (store.delete(k)) n += 1;
        return n;
      },
      async expire(key: string, sec: number) {
        calls.push(["expire", key, sec]);
        return store.has(key) ? 1 : 0;
      },
    },
  };
}

/** A JwtService double that records claims and can simulate verify failure. */
function makeJwt(opts: { exp?: number; verifyThrows?: boolean } = {}) {
  let signed: { sub: string; sid: string } | null = null;
  return {
    signAsync: vi.fn(async (claims: { sub: string; sid: string }) => {
      signed = claims;
      return `jwt.${claims.sub}.${claims.sid}`;
    }),
    verifyAsync: vi.fn(async (token: string) => {
      if (opts.verifyThrows) throw new Error("bad signature");
      const [, sub, sid] = token.split(".");
      return { sub, sid, exp: opts.exp ?? Math.floor(Date.now() / 1000) + TTL };
    }),
    get lastSigned() {
      return signed;
    },
  };
}

function setup(jwtOpts: { exp?: number; verifyThrows?: boolean } = {}) {
  const redis = makeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const jwt = makeJwt(jwtOpts);
  const svc = new SessionService(config, jwt as unknown as JwtService, queue);
  return { svc, redis, jwt };
}

describe("SessionService.create", () => {
  it("stores a session record and returns a token + 30d expiry", async () => {
    const { svc, redis, jwt } = setup();
    const res = await svc.create("worker-1");
    expect(res.token).toBeTruthy();
    expect(res.expiresInSeconds).toBe(TTL);
    expect(jwt.lastSigned?.sub).toBe("worker-1");
    const sid = jwt.lastSigned!.sid;
    const stored = redis.store.get(`session:${sid}`)!;
    expect(JSON.parse(stored)).toEqual({ worker_id: "worker-1" });
  });
});

describe("SessionService.validateAndTouch", () => {
  it("returns claims and RESETS the session TTL (sliding)", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    const validated = await svc.validateAndTouch(created.token);
    expect(validated).not.toBeNull();
    expect(validated!.workerId).toBe("worker-1");
    expect(validated!.sid).toBeTruthy();
    // The sliding behavior: an EXPIRE resetting the session key to the full TTL.
    const expireCall = redis.calls.find((c) => c[0] === "expire" && String(c[1]).startsWith("session:"));
    expect(expireCall).toBeDefined();
    expect(expireCall![2]).toBe(TTL);
  });

  it("returns null when the session record is missing (revoked/expired)", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    redis.store.clear(); // simulate the session record gone
    const validated = await svc.validateAndTouch(created.token);
    expect(validated).toBeNull();
  });

  it("returns null when the JWT signature/exp is invalid", async () => {
    const { svc } = setup({ verifyThrows: true });
    const validated = await svc.validateAndTouch("anything");
    expect(validated).toBeNull();
  });
});

describe("SessionService.refresh", () => {
  it("mints a fresh token for a valid session", async () => {
    const { svc, jwt } = setup();
    const created = await svc.create("worker-1");
    const firstSid = jwt.lastSigned!.sid;
    const refreshed = await svc.refresh(created.token);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.expiresInSeconds).toBe(TTL);
    // Same session id is reused (rolling, not a brand-new session).
    expect(jwt.lastSigned!.sid).toBe(firstSid);
    expect(jwt.signAsync).toHaveBeenCalledTimes(2); // create + refresh
  });

  it("returns null when the session is invalid", async () => {
    const { svc } = setup({ verifyThrows: true });
    expect(await svc.refresh("bad")).toBeNull();
  });
});

describe("SessionService.revoke", () => {
  it("deletes the session record", async () => {
    const { svc, redis, jwt } = setup();
    await svc.create("worker-1");
    const sid = jwt.lastSigned!.sid;
    expect(redis.store.has(`session:${sid}`)).toBe(true);
    await svc.revoke(sid);
    expect(redis.store.has(`session:${sid}`)).toBe(false);
  });
});
