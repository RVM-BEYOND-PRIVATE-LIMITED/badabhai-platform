import "reflect-metadata";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Response } from "express";
import type { ServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import type { Queue } from "bullmq";
import { AiService, type AiServiceHealthSnapshot } from "../ai/ai.service";
import { ACCOUNT_DELETION_SWEEP_SCHEDULER_ID } from "../queue/queue.constants";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

const CONFIG = { NODE_ENV: "test" } as never;

/** The ai-service reachable and reporting REAL calls on (the non-default posture). */
const AI_REAL: AiServiceHealthSnapshot = { realCallsEnabled: true };
/** Reachable, but real calls off — the committed default (CLAUDE.md §2.5). */
const AI_MOCKED: AiServiceHealthSnapshot = { realCallsEnabled: false };
/** Reachable, posture WITHHELD — the TD67 locked shape (AI_INTERNAL_TOKEN set). */
const AI_WITHHELD: AiServiceHealthSnapshot = { realCallsEnabled: null };

/** A Response stub that records the status code the controller sets. */
function fakeRes() {
  const res = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number };
}

/**
 * Build a HealthService over mocked DB + queue + ai-service clients.
 *   - `db`: pass a function for `execute` (resolve = up, reject/hang = down).
 *   - `redisPing`: the `client.ping` implementation.
 *   - `getJobScheduler`: the ADR-0031 sweep-scheduler lookup (a record = registered,
 *     `undefined` = the sweep's clock does not exist, reject/hang = probe failed).
 *   - `aiProbe`: the TD81 ai-service `probeHealth` (a snapshot = reachable, reject/hang
 *     = unreachable). Defaults to the REAL posture so the ai-service is not the thing
 *     under test in every unrelated case above.
 */
function setup(opts: {
  dbExecute?: () => Promise<unknown>;
  redisPing?: () => Promise<unknown>;
  getJobScheduler?: () => Promise<unknown>;
  aiProbe?: () => Promise<AiServiceHealthSnapshot>;
}) {
  const dbExecute = opts.dbExecute ?? (async () => [{ "?column?": 1 }]);
  const redisPing = opts.redisPing ?? (async () => "PONG");
  const getJobSchedulerImpl =
    opts.getJobScheduler ?? (async () => ({ key: "account-deletion-sweep", every: "3600000" }));
  const aiProbeImpl = opts.aiProbe ?? (async () => AI_REAL);

  const db = { execute: vi.fn(dbExecute) } as unknown as Database;
  // queue.client is a Promise<ioredis> in BullMQ; ping() lives on the resolved client.
  const pingFn = vi.fn(redisPing);
  const queue = { client: Promise.resolve({ ping: pingFn }) } as unknown as Queue;
  const getJobScheduler = vi.fn(getJobSchedulerImpl);
  const deletionQueue = { getJobScheduler } as unknown as Queue;
  const probeHealth = vi.fn(aiProbeImpl);
  const ai = { probeHealth } as unknown as AiService;

  const service = new HealthService(db, queue, deletionQueue, ai);
  const controller = new HealthController(CONFIG, service);
  return { controller, db, pingFn, getJobScheduler, probeHealth };
}

/** A promise that never resolves — exercises the timeout path. */
const NEVER = () => new Promise<never>(() => {});

describe("HealthController.check — readiness probes", () => {
  it("both up → 200 + status ok + checks up/up", async () => {
    const { controller } = setup({});
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
    expect(body.environment).toBe("test");
    expect(body.checks).toEqual({
      database: "up",
      redis: "up",
      deletion_sweep: "up",
      ai_service: "up",
      ai_posture: "real",
    });
  });

  it("DB down (probe rejects) → 503 + status error + database down, redis up", async () => {
    const { controller } = setup({
      dbExecute: async () => {
        throw new Error("connection refused 127.0.0.1:5432 password=hunter2");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toMatchObject({ database: "down", redis: "up" });
  });

  it("Redis down (client.ping rejects) → 503 + redis down, database up", async () => {
    const { controller } = setup({
      redisPing: async () => {
        throw new Error("ECONNREFUSED redis://localhost:6379");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toMatchObject({ database: "up", redis: "down" });
  });

  it("a hung probe is treated as down (timeout), not a hang → 503", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup({ dbExecute: NEVER });
      const res = fakeRes();
      const promise = controller.check(res);
      // Fast-forward past the 2s probe timeout so the race resolves to down.
      await vi.advanceTimersByTimeAsync(2001);
      const body = await promise;

      expect(res.statusCode).toBe(503);
      expect(body.status).toBe("error");
      expect(body.checks.database).toBe("down");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never leaks a connection string or error detail into the body", async () => {
    const { controller } = setup({
      dbExecute: async () => {
        throw new Error("postgres://user:secret@db.internal:5432/app failed");
      },
      redisPing: async () => {
        throw new Error("redis://:topsecret@cache.internal:6379");
      },
      getJobScheduler: async () => {
        throw new Error("redis://:topsecret@cache.internal:6379 scheduler read failed");
      },
      aiProbe: async () => {
        // TD81: the ai probe reaches the ONE dependency addressed by a URL an operator
        // configures (AI_SERVICE_URL) and authenticated by a bearer (AI_INTERNAL_TOKEN),
        // so it is the likeliest new leak vector. Fail it with both in the message.
        throw new Error("http://ai.internal:8000/health x-ai-internal-token=topsecret refused");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/postgres:\/\//);
    expect(serialized).not.toMatch(/redis:\/\//);
    expect(serialized).not.toMatch(/http:\/\//);
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/5432|6379|8000/);
    // The body carries only the structured up/down checks — no error/host/stack.
    expect(Object.keys(body)).toEqual([
      "status",
      "service",
      "environment",
      "timestamp",
      "checks",
    ]);
    expect(body.checks).toEqual({
      database: "down",
      redis: "down",
      deletion_sweep: "down",
      ai_service: "down",
      ai_posture: "mock",
    });
  });

  // ---- ADR-0031: the deletion-sweep scheduler signal ----

  it("a MISSING sweep scheduler → checks.deletion_sweep down (a dead sweep is DETECTABLE)", async () => {
    // The Blocker-2 failure mode: registration failed (or the scheduler was removed
    // out-of-band), so nothing ticks and overdue erasures accumulate — silently, until here.
    const { controller } = setup({ getJobScheduler: async () => undefined });
    const body = await controller.check(fakeRes());

    expect(body.checks.deletion_sweep).toBe("down");
  });

  it("a dead sweep does NOT 503 the API: dependencies up → still 200/ok, sweep reported down", async () => {
    const { controller } = setup({ getJobScheduler: async () => undefined });
    const res = fakeRes();
    const body = await controller.check(res);

    // Readiness = "can this process serve requests?". A dead background clock delays
    // erasure; it breaks no request path. 503-ing here would fail the CD /health gate and
    // the staging smoke — turning a delayed erasure into a self-inflicted outage.
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({
      database: "up",
      redis: "up",
      deletion_sweep: "down",
      ai_service: "up",
      ai_posture: "real",
    });
  });

  it("probes the SHARED scheduler id — the /health reader can't drift from the processor's writer", async () => {
    const { controller, getJobScheduler } = setup({});
    await controller.check(fakeRes());
    expect(getJobScheduler).toHaveBeenCalledWith(ACCOUNT_DELETION_SWEEP_SCHEDULER_ID);
  });

  it("a hung sweep probe is down, not a hang (the timeout covers it too)", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup({ getJobScheduler: NEVER });
      const res = fakeRes();
      const promise = controller.check(res);
      await vi.advanceTimersByTimeAsync(2001);
      const body = await promise;

      expect(body.checks.deletion_sweep).toBe("down");
      expect(res.statusCode).toBe(200); // still not an outage
    } finally {
      vi.useRealTimers();
    }
  });

  it("the sweep signal is PII-free: no worker id/phone/name in the body or the log", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { controller } = setup({ getJobScheduler: async () => undefined });
      const body = await controller.check(fakeRes());

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/phone|full_?name|worker_id|\+91/i);
      // The probe reports the EXISTENCE of a scheduler — it never reads a worker row, so
      // there is nothing PII-shaped to leak by construction.
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/deletion_sweep=down/);
      expect(logged).toMatch(/SchedulerMissingError/); // the safe name tag
      expect(logged).not.toMatch(/phone|full_?name|\+91/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs only a secret-safe failure tag (the code/name), never the raw error message", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { controller } = setup({
        dbExecute: async () => {
          const e = new Error("postgres://user:secret@db.internal:5432/app failed") as Error & {
            code?: string;
          };
          e.code = "ECONNREFUSED";
          throw e;
        },
      });
      await controller.check(fakeRes());

      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/database=down/);
      expect(logged).toMatch(/ECONNREFUSED/); // the safe code IS logged
      expect(logged).not.toMatch(/postgres:\/\//); // the message is NOT
      expect(logged).not.toMatch(/secret/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---- TD81: the ai-service signal — /health must stop reporting mocked AI as healthy ----

  it("ai-service reachable + real calls ON → ai_service up, ai_posture real", async () => {
    const { controller } = setup({ aiProbe: async () => AI_REAL });
    const body = await controller.check(fakeRes());

    expect(body.checks.ai_service).toBe("up");
    expect(body.checks.ai_posture).toBe("real");
  });

  it("MOCKED-BUT-REACHABLE (real_calls_enabled false) → ai_service up but ai_posture MOCK", async () => {
    // The half of TD81 that reachability alone cannot catch, and the posture of every
    // correctly-configured env today: the ai-service IS deployed and answering, yet
    // AI_ENABLE_REAL_CALLS is false (CLAUDE.md §2.5 default) or the provider key is
    // absent, so every answer is still mocked. `up` alone would read as "real AI".
    const { controller } = setup({ aiProbe: async () => AI_MOCKED });
    const body = await controller.check(fakeRes());

    expect(body.checks.ai_service).toBe("up");
    expect(body.checks.ai_posture).toBe("mock");
  });

  it("ai-service UNREACHABLE → ai_service down and ai_posture MOCK (not 'unknown')", async () => {
    // TD81's literal scenario: nothing serves the FastAPI app, AI_SERVICE_URL points at
    // nothing, and AiService degrades every call to its in-process mock. Unreachable is
    // not ambiguous — no answer this API returns can have come from an LLM.
    const { controller } = setup({
      aiProbe: async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.ai_service).toBe("down");
    expect(body.checks.ai_posture).toBe("mock");
  });

  it("a hung ai-service probe is down, not a hang (the shared 2s timeout covers it)", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup({ aiProbe: NEVER });
      const res = fakeRes();
      const promise = controller.check(res);
      await vi.advanceTimersByTimeAsync(2001);
      const body = await promise;

      expect(body.checks.ai_service).toBe("down");
      expect(body.checks.ai_posture).toBe("mock");
      expect(res.statusCode).toBe(200); // still not an outage — see below
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the SAME 2s budget down to the probe, so the socket is aborted not just raced", async () => {
    const { controller, probeHealth } = setup({});
    await controller.check(fakeRes());
    expect(probeHealth).toHaveBeenCalledWith(2000);
  });

  it("TD67 locked posture (flag withheld) → ai_posture unknown, never silently 'mock'", async () => {
    // With AI_INTERNAL_TOKEN set, the ai-service's tokenless /health returns liveness +
    // service_auth_enabled ONLY. Reporting that as `mock` would tell an operator their
    // AI is mocked about a service that is correctly HARDENED — a false alarm in the one
    // field added to kill false comfort.
    const { controller } = setup({ aiProbe: async () => AI_WITHHELD });
    const body = await controller.check(fakeRes());

    expect(body.checks.ai_service).toBe("up");
    expect(body.checks.ai_posture).toBe("unknown");
  });

  it("mocked AI does NOT 503 the API: hard deps up → still 200/ok with the posture reported", async () => {
    // The deliberate 200/503 choice (see health.controller.ts): the AI path fails SOFT by
    // design and mock-by-default is the CORRECT posture, so a status-code gate would put
    // every correctly-configured env — local dev, CI, this suite — permanently in "error".
    // Loud in the body + loud in the logs; never fatal.
    const { controller } = setup({ aiProbe: async () => AI_MOCKED });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.ai_posture).toBe("mock");
  });

  it("an unreachable ai-service does not 503 either, and does not mask the hard deps", async () => {
    const { controller } = setup({
      aiProbe: async () => {
        throw new Error("boom");
      },
      dbExecute: async () => {
        throw new Error("db down");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    // The 503 here is the DATABASE's, not the ai-service's.
    expect(res.statusCode).toBe(503);
    expect(body.checks).toMatchObject({ database: "down", redis: "up", ai_service: "down" });
  });

  it("is LOUD in the logs when AI is mocked — a WARN naming the posture, secret-free", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { controller } = setup({ aiProbe: async () => AI_MOCKED });
      await controller.check(fakeRes());

      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/AI POSTURE ai_service=up ai_posture=mock/);
      expect(logged).toMatch(/TD81/);
      // Fixed copy + the two enum values only: no URL, no token, no error message.
      expect(logged).not.toMatch(/http:\/\/|x-ai-internal-token|secret/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs the posture on CHANGE only, so an uptime poller cannot turn the signal into wallpaper", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { controller } = setup({ aiProbe: async () => AI_MOCKED });
      await controller.check(fakeRes());
      await controller.check(fakeRes());
      await controller.check(fakeRes());

      const postureLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("AI POSTURE"));
      expect(postureLines).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-logs when the posture actually CHANGES (mock → real)", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      let snapshot = AI_MOCKED;
      const { controller } = setup({ aiProbe: async () => snapshot });
      await controller.check(fakeRes());
      snapshot = AI_REAL;
      await controller.check(fakeRes());

      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /AI POSTURE ai_service=up ai_posture=mock/,
      );
      const info = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(info).toMatch(/AI POSTURE ai_service=up ai_posture=real/);
      // The `real` line must keep saying what it does NOT prove — see HealthChecks.
      expect(info).toMatch(/Config-presence only/);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

/**
 * TD81 — the probe itself, at the wire. It lives on `AiService` (the one HTTP client to
 * the ai-service; a second one would be a second timeout/auth posture to keep in sync)
 * but exists ONLY to serve /health, so its contract is pinned here with the endpoint it
 * feeds. What matters: it never lies about the posture, and it never leaks the URL.
 */
describe("AiService.probeHealth — the /health reachability + posture probe (TD81)", () => {
  const AI_CONFIG = { AI_SERVICE_URL: "http://ai-service:8000" } as unknown as ServerConfig;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("GETs the ai-service's own /health and reads real_calls_enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", service: "ai-service", real_calls_enabled: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await new AiService(AI_CONFIG).probeHealth();

    expect(fetchMock.mock.calls[0]![0]).toBe("http://ai-service:8000/health");
    expect((fetchMock.mock.calls[0]![1] as { method: string }).method).toBe("GET");
    expect(snapshot).toEqual({ realCallsEnabled: true });
  });

  it("reads the mocked posture as false (not as absent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", real_calls_enabled: false }),
      }),
    );
    expect(await new AiService(AI_CONFIG).probeHealth()).toEqual({ realCallsEnabled: false });
  });

  it("tolerates the TD67 LOCKED payload shape → null, not a parse failure", async () => {
    // The hardened ai-service drops real_calls_enabled (and most of the body). A strict
    // schema here would report a correctly-secured service as DOWN.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", service: "ai-service", service_auth_enabled: true }),
      }),
    );
    expect(await new AiService(AI_CONFIG).probeHealth()).toEqual({ realCallsEnabled: null });
  });

  it("does NOT send the AI_INTERNAL_TOKEN — /health is auth-exempt, so the secret stays home", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", real_calls_enabled: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = { ...AI_CONFIG, AI_INTERNAL_TOKEN: "a".repeat(32) } as unknown as ServerConfig;
    await new AiService(config).probeHealth();

    const init = fetchMock.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/x-ai-internal-token|aaaa/i);
  });

  it("treats a non-boolean flag as WITHHELD, never as real", async () => {
    // Defensive: a future shape change on the other side must fail toward `unknown`, and
    // can never accidentally read as `real` and rebuild the TD81 false comfort.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", real_calls_enabled: "true" }),
      }),
    );
    expect(await new AiService(AI_CONFIG).probeHealth()).toEqual({ realCallsEnabled: null });
  });

  it("THROWS on a non-OK response, carrying the status code only — never the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }),
    );

    const err = (await new AiService(AI_CONFIG)
      .probeHealth()
      .then(() => null)
      .catch((e: unknown) => e)) as Error | null;

    expect(err).toBeInstanceOf(Error);
    // The NAME is what HealthService.safeReason logs, so it has to be a useful tag.
    expect(err!.name).toBe("AiServiceUnhealthyError");
    expect(err!.message).toMatch(/502/);
    expect(err!.message).not.toMatch(/http:\/\/|:8000/);
  });

  it("THROWS (never silently degrades) when the service is unreachable — that is the point", async () => {
    // Every other method on AiService swallows this into a mock. This one must not:
    // swallowing it is exactly the silence TD81 records.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" })),
    );
    await expect(new AiService(AI_CONFIG).probeHealth()).rejects.toThrow();
  });
});
