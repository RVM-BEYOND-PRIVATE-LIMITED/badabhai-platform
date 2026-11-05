import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

/**
 * The environment badge's source (A6, #2576): the API's public health probe, `environment` only,
 * cached in the server process, never throwing.
 */
const stub = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; opts: { schema: z.ZodType; public?: boolean } }>,
  answer: (): Promise<unknown> => Promise.resolve({ environment: "production" }),
}));

vi.mock("./admin-http", () => ({
  adminFetch: (path: string, opts: { schema: z.ZodType; public?: boolean }) => {
    stub.calls.push({ path, opts });
    return stub.answer().then((body) => opts.schema.parse(body));
  },
}));

const { getApiEnvironment, resetApiEnvironmentForTests } = await import("./environment");

beforeEach(() => {
  resetApiEnvironmentForTests();
  stub.calls = [];
  stub.answer = () => Promise.resolve({ environment: "production" });
});

const T0 = 1_000_000;
const MINUTE = 60_000;

describe("getApiEnvironment", () => {
  it("reads the public /health probe — no admin token — and lower-cases the answer", async () => {
    stub.answer = () => Promise.resolve({ environment: " Staging " });
    expect(await getApiEnvironment(T0)).toBe("staging");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.path).toBe("/health");
    expect(stub.calls[0]!.opts.public).toBe(true);
  });

  it("reads `environment` only, whatever shape the checks beside it take", async () => {
    stub.answer = () =>
      Promise.resolve({
        status: "ok",
        environment: "production",
        checks: { database: "up", storage_config: { supabase: "configured", buckets: {} } },
      });
    expect(await getApiEnvironment(T0)).toBe("production");
  });

  it("keeps a good answer for ten minutes, then asks again", async () => {
    await getApiEnvironment(T0);
    await getApiEnvironment(T0 + 9 * MINUTE);
    expect(stub.calls).toHaveLength(1);
    stub.answer = () => Promise.resolve({ environment: "staging" });
    expect(await getApiEnvironment(T0 + 11 * MINUTE)).toBe("staging");
    expect(stub.calls).toHaveLength(2);
  });

  it("never throws: an unreachable or unhealthy probe is null — 'unknown' — kept 30 seconds", async () => {
    stub.answer = () => Promise.reject(new Error("The admin API returned 503."));
    expect(await getApiEnvironment(T0)).toBeNull();
    expect(await getApiEnvironment(T0 + 20_000)).toBeNull();
    expect(stub.calls).toHaveLength(1);
    stub.answer = () => Promise.resolve({ environment: "production" });
    expect(await getApiEnvironment(T0 + 31_000)).toBe("production");
    expect(stub.calls).toHaveLength(2);
  });

  it("a body with no environment is unknown, not a blank badge", async () => {
    stub.answer = () => Promise.resolve({ environment: "  " });
    expect(await getApiEnvironment(T0)).toBeNull();
  });

  it("page loads arriving together share one probe", async () => {
    let release!: (v: unknown) => void;
    stub.answer = () => new Promise((r) => (release = r));
    const a = getApiEnvironment(T0);
    const b = getApiEnvironment(T0);
    release({ environment: "test" });
    expect(await Promise.all([a, b])).toEqual(["test", "test"]);
    expect(stub.calls).toHaveLength(1);
  });
});
