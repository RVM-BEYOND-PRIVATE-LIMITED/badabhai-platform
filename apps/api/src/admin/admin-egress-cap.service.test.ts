import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AdminEgressCapService } from "./admin-egress-cap.service";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function makeRedis(incrResults: Array<number | Error>) {
  let i = 0;
  const incrby = vi.fn(async (_key: string, _by: number) => {
    const r = incrResults[Math.min(i, incrResults.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r as number;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);
  return { incrby, expire };
}

function setup(opts: {
  incrResults?: Array<number | Error>;
  clientThrows?: boolean;
  maxPerHour?: number;
  maxPerDay?: number;
  namespace?: string;
}) {
  const redis = makeRedis(opts.incrResults ?? [1, 1]);
  const queue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };
  const config = {
    ADMIN_IDENTITY_MAX_PER_HOUR: opts.maxPerHour ?? 300,
    ADMIN_IDENTITY_MAX_PER_DAY: opts.maxPerDay ?? 1000,
  } as unknown as ServerConfig;
  const svc = new AdminEgressCapService(
    config,
    queue as unknown as Queue,
    opts.namespace ?? "admin_identity",
    "ADMIN_IDENTITY_MAX_PER_HOUR",
    "ADMIN_IDENTITY_MAX_PER_DAY",
  );
  return { svc, redis };
}

/**
 * The shared per-admin egress cap. Its single-unit behaviour is inherited unchanged from the
 * reveal cap and pinned there; what is new — and what this file is about — is the INCREMENT.
 *
 * A cap that only ever counts requests is not a cap on a bulk disclosure: one `?limit=100`
 * page would hand over a hundred names while spending one unit of budget, which is how a
 * single-subject cap gets bypassed by paging a list.
 */
describe("AdminEgressCapService — charging N units for a disclosure of N subjects", () => {
  it("charges the INCREMENT, not 1, on both windows", async () => {
    const { svc, redis } = setup({ incrResults: [50, 50] });
    await expect(svc.consume(ADMIN_ID, 50)).resolves.toEqual({ ok: true });
    expect(redis.incrby).toHaveBeenNthCalledWith(1, expect.any(String), 50);
    expect(redis.incrby).toHaveBeenNthCalledWith(2, expect.any(String), 50);
  });

  it("a single page CAN exhaust the hour budget — the whole point of the increment", async () => {
    // With a request-counting cap this would be one unit of 300 and would pass. The counter is
    // what Redis returns AFTER the charge, so a 301st name is over a 300 cap.
    const { svc } = setup({ incrResults: [301, 1], maxPerHour: 300 });
    await expect(svc.consume(ADMIN_ID, 100)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("at EXACTLY the cap the disclosure still goes through (`>`, not `>=`)", async () => {
    const { svc } = setup({ incrResults: [300, 1000], maxPerHour: 300, maxPerDay: 1000 });
    await expect(svc.consume(ADMIN_ID, 1)).resolves.toEqual({ ok: true });
  });

  it("an increment of 0 still CHECKS the windows, and passes when there is headroom", async () => {
    // A page whose rows all lack a name discloses nothing, so it must cost nothing — but it
    // must not skip the check either, or an already-over-budget admin would get a free pass on
    // any page that happened to be empty.
    const { svc, redis } = setup({ incrResults: [7, 7] });
    await expect(svc.consume(ADMIN_ID, 0)).resolves.toEqual({ ok: true });
    expect(redis.incrby).toHaveBeenNthCalledWith(1, expect.any(String), 0);
  });

  it("an increment of 0 is still DENIED when the admin is already over the cap", async () => {
    const { svc } = setup({ incrResults: [301, 1], maxPerHour: 300 });
    await expect(svc.consume(ADMIN_ID, 0)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("REFUSES a negative or fractional increment without touching Redis (a refund is a bug)", async () => {
    // A negative INCRBY would hand budget BACK, which is worse than no cap: the caller with the
    // bug is the one whose ceiling rises. Clamping would let it ship silently.
    for (const bad of [-1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { svc, redis } = setup({ incrResults: [1, 1] });
      await expect(svc.consume(ADMIN_ID, bad), String(bad)).resolves.toEqual({
        ok: false,
        window: "hour",
      });
      expect(redis.incrby, String(bad)).not.toHaveBeenCalled();
    }
  });

  it("the NAMESPACE is what separates two caps' budgets", async () => {
    const { svc, redis } = setup({ incrResults: [1, 1], namespace: "some_other_cap" });
    await svc.consume(ADMIN_ID, 3);
    expect(redis.incrby.mock.calls[0]![0]).toContain(`some_other_cap:hour:${ADMIN_ID}:`);
    expect(redis.incrby.mock.calls[1]![0]).toContain(`some_other_cap:day:${ADMIN_ID}:`);
  });

  it("FAILS CLOSED on a Redis outage even for a large increment", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect(svc.consume(ADMIN_ID, 50)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("keys and TTLs carry the opaque admin id ONLY — no surface, no subject, no value", async () => {
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await svc.consume(ADMIN_ID, 2);
    for (const [key] of redis.incrby.mock.calls) {
      expect(key).toMatch(/^admin_identity:(hour|day):aaaaaaaa-0000-4000-8000-000000000001:\d+$/);
    }
    for (const [, ttl] of redis.expire.mock.calls) {
      expect(ttl).toBeGreaterThan(0);
    }
  });
});

/**
 * The Redis-failure LOG. Separated out because the property is not "does it deny" (asserted
 * above) but "what does it say while denying".
 *
 * An ioredis connection error's `message` embeds the connection target, and this deployment's
 * target is a `redis://user:password@host` URL. `reason: ${err.message}` therefore writes a
 * credential into the log stream — from a string this repository never authored, which is why
 * no amount of reading our own source would reveal it.
 */
describe("a Redis failure is logged as a BOUNDED code, never the client's message", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spies = (["error", "warn", "log"] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        for (const a of args) lines.push(typeof a === "string" ? a : JSON.stringify(a));
      }),
    );
    return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  async function logOf(err: Error): Promise<string> {
    const { lines, restore } = capture();
    const svc = new AdminEgressCapService(
      { ADMIN_IDENTITY_MAX_PER_HOUR: 300, ADMIN_IDENTITY_MAX_PER_DAY: 1000 } as unknown as ServerConfig,
      { client: Promise.reject(err) } as unknown as Queue,
      "admin_identity",
      "ADMIN_IDENTITY_MAX_PER_HOUR",
      "ADMIN_IDENTITY_MAX_PER_DAY",
    );
    await svc.consume(ADMIN_ID, 1);
    restore();
    return lines.join("\n");
  }

  it("prefers the errno CODE — the diagnostic an on-call reader actually wants", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:6379"), {
      code: "ECONNREFUSED",
    });
    const line = await logOf(err);
    expect(line).toContain("ECONNREFUSED");
    expect(line).not.toContain("10.0.0.4:6379");
  });

  it("never emits a message-shaped code, and never the message itself", async () => {
    // A URL with credentials, in both of the places a client can put one. Neither may survive.
    const err = Object.assign(
      new Error("NOAUTH Authentication required for redis://admin:s3cr3t@cache.internal:6379"),
      { code: "connect ECONNREFUSED redis://admin:s3cr3t@cache.internal:6379" },
    );
    const line = await logOf(err);
    expect(line).not.toContain("s3cr3t");
    expect(line).not.toContain("cache.internal");
    expect(line).not.toContain("Authentication required");
    // The code was rejected for its shape, so the fallback is the error's NAME.
    expect(line).toContain("reason: Error");
  });

  it("falls back to `unknown` rather than to anything free-form", async () => {
    const err = Object.assign(new Error("boom redis://admin:s3cr3t@cache.internal"), {
      name: "an error occurred at redis://admin:s3cr3t@cache.internal",
    });
    const line = await logOf(err);
    expect(line).toContain("reason: unknown");
    expect(line).not.toContain("s3cr3t");
  });

  it("still names the window and the admin PREFIX — the log stays useful", async () => {
    // The mutation bar's other half: a "reason" that redacted everything would pass every
    // assertion above while making the log worthless. Pin what it must still say.
    const line = await logOf(Object.assign(new Error("x"), { code: "ETIMEDOUT" }));
    expect(line).toContain("admin_identity");
    expect(line).toContain(ADMIN_ID.slice(0, 8));
    expect(line).not.toContain(ADMIN_ID);
    expect(line).toContain("failing closed");
  });
});
