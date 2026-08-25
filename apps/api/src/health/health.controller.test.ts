import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Response } from "express";
import type { ServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import type { Queue } from "bullmq";
import { AiService, type AiServiceHealthSnapshot } from "../ai/ai.service";
import { ACCOUNT_DELETION_SWEEP_SCHEDULER_ID } from "../queue/queue.constants";
import { HealthController } from "./health.controller";
import { HealthService, resolveBuildId, UNKNOWN_BUILD } from "./health.service";

/**
 * Storage fully wired — the default for every test NOT specifically about
 * storage_config, so the ai_service/deletion_sweep/database/redis suites above stay
 * exactly as they were (this field is additive, orthogonal to everything else here).
 */
const STORAGE_CONFIGURED = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
  RESUMES_BUCKET: "worker-resumes",
  WORKER_PHOTOS_BUCKET: "worker-profile-photos",
  VOICE_NOTES_BUCKET: "worker-voice-notes",
  INTERVIEW_KIT_BUCKET: "interview-kits",
  WORKER_FEEDBACK_ATTACHMENTS_BUCKET: "worker-feedback-attachments",
  RESUME_RENDER_ENABLED: true,
};

/** The expected `storage_config` body for the STORAGE_CONFIGURED fixture above. */
const STORAGE_CONFIG_UP = {
  supabase: "configured",
  buckets: {
    resumes: true,
    photos: true,
    voice_notes: true,
    interview_kit: true,
    feedback_attachments: true,
  },
  resume_render_enabled: true,
  armed_without_credentials: false,
};

const CONFIG = { NODE_ENV: "test", ...STORAGE_CONFIGURED } as never;

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
 *   - `config`: the storage-config-presence fixture. Defaults to STORAGE_CONFIGURED so
 *     storage_config is not the thing under test in every unrelated case above either.
 */
function setup(opts: {
  dbExecute?: () => Promise<unknown>;
  redisPing?: () => Promise<unknown>;
  getJobScheduler?: () => Promise<unknown>;
  aiProbe?: () => Promise<AiServiceHealthSnapshot>;
  config?: unknown;
}) {
  const dbExecute = opts.dbExecute ?? (async () => [{ "?column?": 1 }]);
  const redisPing = opts.redisPing ?? (async () => "PONG");
  const getJobSchedulerImpl =
    opts.getJobScheduler ?? (async () => ({ key: "account-deletion-sweep", every: "3600000" }));
  const aiProbeImpl = opts.aiProbe ?? (async () => AI_REAL);
  const config = (opts.config ?? { NODE_ENV: "test", ...STORAGE_CONFIGURED }) as never;

  const db = { execute: vi.fn(dbExecute) } as unknown as Database;
  // queue.client is a Promise<ioredis> in BullMQ; ping() lives on the resolved client.
  const pingFn = vi.fn(redisPing);
  const queue = { client: Promise.resolve({ ping: pingFn }) } as unknown as Queue;
  const getJobScheduler = vi.fn(getJobSchedulerImpl);
  const deletionQueue = { getJobScheduler } as unknown as Queue;
  const probeHealth = vi.fn(aiProbeImpl);
  const ai = { probeHealth } as unknown as AiService;

  const service = new HealthService(db, queue, deletionQueue, ai, config);
  const controller = new HealthController(CONFIG, service);
  return { controller, db, pingFn, getJobScheduler, probeHealth };
}

/** A promise that never resolves — exercises the timeout path. */
const NEVER = () => new Promise<never>(() => {});

describe("HealthController.check — readiness probes", () => {
  // Build identity (#965) comes from the RAW env, so the RUNNER's environment must never
  // decide what the body says. Absent by default for every case here; the #965 suite at the
  // bottom stubs it per test. Without this, a CI box that happened to export GIT_COMMIT_SHA
  // could put a 40-hex string into the no-leak assertions below (which reject `6379`/`8000`)
  // and flake them.
  beforeEach(() => {
    vi.stubEnv("GIT_COMMIT_SHA", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      storage_config: STORAGE_CONFIG_UP,
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
    // The body carries only the structured up/down checks plus the public build id —
    // no error/host/stack.
    expect(Object.keys(body)).toEqual([
      "status",
      "service",
      "environment",
      "build",
      "timestamp",
      "checks",
    ]);
    expect(body.checks).toEqual({
      database: "down",
      redis: "down",
      deletion_sweep: "down",
      ai_service: "down",
      ai_posture: "mock",
      storage_config: STORAGE_CONFIG_UP,
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
      storage_config: STORAGE_CONFIG_UP,
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

  // ---- storage_config: worker photo upload / resume download config-presence signal ----
  //
  // A real incident (a deployed box with no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
  // WORKER_PHOTOS_BUCKET wired) went undetected because /health said nothing about
  // Storage. This is a PURE config read — no probe, no network call — so every case
  // here drives it purely through the `config` fixture, never through a mocked probe.

  it("fully wired storage → supabase configured, every bucket true, render enabled", async () => {
    const { controller } = setup({});
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config).toEqual(STORAGE_CONFIG_UP);
  });

  it("Supabase creds entirely absent (the reported incident) → supabase not_configured", async () => {
    const { controller } = setup({
      config: { NODE_ENV: "test", ...STORAGE_CONFIGURED, SUPABASE_URL: undefined },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.supabase).toBe("not_configured");
  });

  it("only the service-role key missing → still not_configured (BOTH vars required)", async () => {
    const { controller } = setup({
      config: {
        NODE_ENV: "test",
        ...STORAGE_CONFIGURED,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.supabase).toBe("not_configured");
  });

  it("empty-string is treated as absent, same as undefined (docker-compose pass-through shape)", async () => {
    const { controller } = setup({
      config: { NODE_ENV: "test", ...STORAGE_CONFIGURED, SUPABASE_URL: "" },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.supabase).toBe("not_configured");
  });

  it("WORKER_PHOTOS_BUCKET unset (the empty-default bucket) → buckets.photos false, others unaffected", async () => {
    const { controller } = setup({
      config: { NODE_ENV: "test", ...STORAGE_CONFIGURED, WORKER_PHOTOS_BUCKET: "" },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.buckets).toEqual({
      resumes: true,
      photos: false,
      voice_notes: true,
      interview_kit: true,
      feedback_attachments: true,
    });
  });

  it("WORKER_FEEDBACK_ATTACHMENTS_BUCKET unset → buckets.feedback_attachments false only", async () => {
    // #1191 — the dormant state this line exists for. The shipped worker app degrades honestly
    // on the mint's 503 (it drops the image and still submits the text), so an unprovisioned
    // bucket looks exactly like a working one from every surface except this one.
    const { controller } = setup({
      config: {
        NODE_ENV: "test",
        ...STORAGE_CONFIGURED,
        WORKER_FEEDBACK_ATTACHMENTS_BUCKET: "",
      },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.buckets.feedback_attachments).toBe(false);
    expect(body.checks.storage_config.buckets.photos).toBe(true);
    expect(body.checks.storage_config.buckets.resumes).toBe(true);
  });

  it("VOICE_NOTES_BUCKET unset → buckets.voice_notes false only", async () => {
    const { controller } = setup({
      config: { NODE_ENV: "test", ...STORAGE_CONFIGURED, VOICE_NOTES_BUCKET: "" },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.buckets.voice_notes).toBe(false);
    expect(body.checks.storage_config.buckets.resumes).toBe(true);
  });

  it("RESUME_RENDER_ENABLED false → resume_render_enabled false in the body", async () => {
    const { controller } = setup({
      config: { NODE_ENV: "test", ...STORAGE_CONFIGURED, RESUME_RENDER_ENABLED: false },
    });
    const body = await controller.check(fakeRes());

    expect(body.checks.storage_config.resume_render_enabled).toBe(false);
  });

  it("a completely unconfigured (local dev / CI) box → not_configured + every optional bucket false, still 200/ok", async () => {
    // The gate this field must NOT trip: an env that legitimately has no Storage wiring
    // (local dev, CI, a fresh box before devops provisions the bucket) must stay green.
    const { controller } = setup({
      config: {
        NODE_ENV: "test",
        SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        RESUMES_BUCKET: "worker-resumes", // schema default — always non-empty
        WORKER_PHOTOS_BUCKET: "",
        VOICE_NOTES_BUCKET: "",
        INTERVIEW_KIT_BUCKET: "interview-kits", // schema default — always non-empty
        RESUME_RENDER_ENABLED: false,
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.storage_config).toEqual({
      supabase: "not_configured",
      buckets: {
        resumes: true,
        photos: false,
        voice_notes: false,
        interview_kit: true,
        feedback_attachments: false,
      },
      resume_render_enabled: false,
      // TRUE even here, and the 200 above is what proves the scoping works: the two
      // schema-defaulted buckets DO arm this box, so the fact is reported honestly — but
      // `NODE_ENV=test` means the controller does not gate on it. Exactly the local-dev
      // and CI shape that must never go red. See the #793 gate suite below.
      armed_without_credentials: true,
    });
  });

  it("does NOT gate 200/503 even when EVERYTHING storage-related is unconfigured and hard deps are down", async () => {
    // Mirrors the mocked-AI/dead-sweep precedent: the 503 here must stay the DATABASE's.
    const { controller } = setup({
      dbExecute: async () => {
        throw new Error("db down");
      },
      config: {
        NODE_ENV: "test",
        SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        RESUMES_BUCKET: "worker-resumes",
        WORKER_PHOTOS_BUCKET: "",
        VOICE_NOTES_BUCKET: "",
        INTERVIEW_KIT_BUCKET: "interview-kits",
        RESUME_RENDER_ENABLED: false,
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(503);
    expect(body.checks.storage_config.supabase).toBe("not_configured");
  });

  // ---- #793: a DEPLOYED box that armed Storage without credentials gates the deploy ----
  //
  // THE INCIDENT. The worker app, in release against the deployed base URL, loaded chat,
  // jobs, profile and auth — and resume download plus photo upload failed for every worker.
  // `/health` was green throughout, so the CD gate (`curl -sf .../health`) and the staging
  // smoke both passed a box on which every Storage request was already guaranteed to 503.
  // #796 made Storage VISIBLE in the body; visible is not gating, so the class of failure
  // the issue named ("this class of failure passes health") still passed.
  //
  // MOST OF THIS SUITE IS GREEN ROWS ON PURPOSE. A gate is only worth having if it is safe
  // to leave in, and this one sits on the path that decides whether a deploy is allowed to
  // finish. The cases it must NOT trip — a bare laptop, CI, a fresh box, a fully wired box
  // — outnumber the one it must, because those are what would get it deleted the first time
  // it blocked legitimate work.
  describe("the armed-without-credentials gate", () => {
    /** A box that has been told to store things, with nowhere to store them. */
    const ARMED_NO_CREDS = {
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      RESUMES_BUCKET: "worker-resumes",
      WORKER_PHOTOS_BUCKET: "worker-profile-photos",
      VOICE_NOTES_BUCKET: "",
      INTERVIEW_KIT_BUCKET: "interview-kits",
      RESUME_RENDER_ENABLED: true,
    };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("RED: a production box with buckets armed and no credentials → 503", async () => {
      // The literal #793 shape. `isDevEnv()` reads the RAW env, so this is what actually
      // decides the branch — not the parsed `config.NODE_ENV`.
      vi.stubEnv("NODE_ENV", "production");
      const { controller } = setup({ config: { NODE_ENV: "production", ...ARMED_NO_CREDS } });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(503);
      expect(body.status).toBe("error");
      expect(body.checks.storage_config.armed_without_credentials).toBe(true);
      // The hard deps are FINE — this 503 is the storage state's alone, which is the whole
      // claim. Without this the test would pass on any unrelated failure.
      expect(body.checks.database).toBe("up");
      expect(body.checks.redis).toBe("up");
    });

    it("RED: render armed alone is enough, with every optional bucket empty", async () => {
      // RESUME_RENDER_ENABLED arms the render→upload path independently of the optional
      // buckets, and RESUMES_BUCKET carries a schema default — so "no buckets configured"
      // is not the same as "nothing armed".
      vi.stubEnv("NODE_ENV", "production");
      const { controller } = setup({
        config: {
          NODE_ENV: "production",
          SUPABASE_URL: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          RESUMES_BUCKET: "worker-resumes",
          WORKER_PHOTOS_BUCKET: "",
          VOICE_NOTES_BUCKET: "",
          INTERVIEW_KIT_BUCKET: "",
          RESUME_RENDER_ENABLED: true,
        },
      });
      const res = fakeRes();

      await controller.check(res);
      expect(res.statusCode).toBe(503);
    });

    it("GREEN: the same armed-without-credentials box in DEV stays 200", async () => {
      // REQUIRED FOR CORRECTNESS, not politeness. docker-compose.yml — the dev-laptop file
      // — ships RESUME_RENDER_ENABLED "true" with SUPABASE_URL empty, so this exact state
      // is the DEFAULT on every `compose up`. Gating it would red-line local dev.
      vi.stubEnv("NODE_ENV", "development");
      const { controller } = setup({ config: { NODE_ENV: "development", ...ARMED_NO_CREDS } });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(200);
      // Still REPORTED — the fact does not change, only whether it gates.
      expect(body.checks.storage_config.armed_without_credentials).toBe(true);
    });

    it("GREEN: the same box under NODE_ENV=test stays 200 — the e2e job runs here", async () => {
      vi.stubEnv("NODE_ENV", "test");
      const { controller } = setup({ config: { NODE_ENV: "test", ...ARMED_NO_CREDS } });
      const res = fakeRes();

      await controller.check(res);
      expect(res.statusCode).toBe(200);
    });

    it("GREEN: a production box that armed NOTHING stays 200 — dormant is not broken", async () => {
      // The state staging is in today after #803 (render off) and before devops provisions
      // anything. An empty bucket means that leg is DORMANT BY DESIGN; promising nothing and
      // delivering nothing is consistent, and gating it would repeat the ai_service mistake.
      vi.stubEnv("NODE_ENV", "production");
      const { controller } = setup({
        config: {
          NODE_ENV: "production",
          SUPABASE_URL: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          RESUMES_BUCKET: "",
          WORKER_PHOTOS_BUCKET: "",
          VOICE_NOTES_BUCKET: "",
          INTERVIEW_KIT_BUCKET: "",
          RESUME_RENDER_ENABLED: false,
        },
      });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(200);
      expect(body.checks.storage_config.armed_without_credentials).toBe(false);
    });

    it("GREEN: a production box that is fully wired stays 200", async () => {
      // The state #793 asks the owner to reach. Arming is only a problem WITHOUT credentials.
      vi.stubEnv("NODE_ENV", "production");
      const { controller } = setup({ config: { NODE_ENV: "production", ...STORAGE_CONFIGURED } });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(200);
      expect(body.checks.storage_config.armed_without_credentials).toBe(false);
    });

    it("gates on an UNSET NODE_ENV — isDevEnv is fail-closed, so a mangled env is not exempt", async () => {
      // A box whose NODE_ENV never got set must not silently inherit the dev exemption.
      vi.stubEnv("NODE_ENV", undefined);
      const { controller } = setup({ config: { NODE_ENV: "production", ...ARMED_NO_CREDS } });
      const res = fakeRes();

      await controller.check(res);
      expect(res.statusCode).toBe(503);
    });

    it("still leaks nothing when it gates — the 503 body carries booleans, not values", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const { controller } = setup({
        config: {
          NODE_ENV: "production",
          ...ARMED_NO_CREDS,
          WORKER_PHOTOS_BUCKET: "super-secret-bucket-name",
        },
      });
      const body = await controller.check(fakeRes());

      expect(JSON.stringify(body)).not.toMatch(/super-secret-bucket-name/);
    });
  });

  it("never leaks the actual URL, service-role key, or bucket name — booleans/enum only", async () => {
    const { controller } = setup({});
    const body = await controller.check(fakeRes());

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/project\.supabase\.co/);
    expect(serialized).not.toMatch(/service-role-key-value/);
    expect(serialized).not.toMatch(
      /worker-resumes|worker-profile-photos|worker-voice-notes|interview-kits/,
    );
  });

  // ---- #965: WHICH BUILD is answering? ----
  //
  // /health answered "am I up?" and never "what am I?", so a debugging session could be —
  // and was — spent on code that was not deployed. The image bakes the short git sha in at
  // build time (`ARG GIT_COMMIT_SHA` → `ENV GIT_COMMIT_SHA`, apps/api/Dockerfile) and this
  // is where it surfaces.
  //
  // MOST OF THIS SUITE IS ABOUT THE FIELD BEING ABSENT, because that is the case that can
  // actually hurt: an observability nicety that 500s the readiness endpoint (or refuses to
  // boot) is far worse than no build id at all — it would take the CD health gate, the
  // staging smoke and the uptime check down with it. And empty is the LIKELY shape of
  // absent, not a hypothetical: a GitHub Actions `build-args:` line naming a var that does
  // not exist resolves to the empty string, so Docker receives `--build-arg GIT_COMMIT_SHA=`
  // and the container gets the variable PRESENT-AND-EMPTY.
  describe("the build identity field", () => {
    it("reports the sha baked into the image, and changes nothing else", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", "a1b2c3d");
      const { controller } = setup({});
      const res = fakeRes();
      const body = await controller.check(res);

      expect(body.build).toBe("a1b2c3d");
      // Purely additive: the status code and the gate are untouched by this field.
      expect(res.statusCode).toBe(200);
      expect(body.status).toBe("ok");
    });

    it("carries a FULL 40-char sha verbatim — the field is not silently truncated", async () => {
      const full = "0123456789abcdef0123456789abcdef01234567";
      vi.stubEnv("GIT_COMMIT_SHA", full);
      const { controller } = setup({});

      expect((await controller.check(fakeRes())).build).toBe(full);
    });

    it("accepts the tag-shaped id the deploy actually pins (`sha-a1b2c3d`)", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", "sha-a1b2c3d");
      const { controller } = setup({});

      expect((await controller.check(fakeRes())).build).toBe("sha-a1b2c3d");
    });

    it("UNSET → the string 'unknown' — the key is present, never omitted, never null", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", undefined);
      const { controller } = setup({});
      const body = await controller.check(fakeRes());

      // All three matter to a consumer: it must be able to read the key unconditionally
      // and always get a string back.
      expect(Object.keys(body)).toContain("build");
      expect(typeof body.build).toBe("string");
      expect(body.build).toBe("unknown");
    });

    it("EMPTY → 'unknown', and does NOT throw — the build-args trap, exactly", async () => {
      // `--build-arg GIT_COMMIT_SHA=` — the variable arrives present-and-empty. A schema
      // that rejected "" here would turn a missing build id into a failed request; this
      // asserts the endpoint answers normally instead.
      vi.stubEnv("GIT_COMMIT_SHA", "");
      const { controller } = setup({});
      const res = fakeRes();
      const body = await controller.check(res);

      expect(body.build).toBe("unknown");
      expect(res.statusCode).toBe(200);
      expect(body.status).toBe("ok");
    });

    it("WHITESPACE-only → 'unknown' (a shell-mangled arg is still no build id)", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", "   ");
      const { controller } = setup({});

      expect((await controller.check(fakeRes())).build).toBe("unknown");
    });

    it("is present on a 503 too — you need the build id MOST when the box is unhealthy", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", "deadbee");
      const { controller } = setup({
        dbExecute: async () => {
          throw new Error("db down");
        },
      });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(503);
      expect(body.build).toBe("deadbee");
    });

    it("an ABSENT build id does not degrade an unhealthy response either — still 503, still a string", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", "");
      const { controller } = setup({
        dbExecute: async () => {
          throw new Error("db down");
        },
      });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(503);
      expect(body.status).toBe("error");
      expect(body.build).toBe("unknown");
    });

    it("never gates the status code: a build id can neither rescue nor break the gate", async () => {
      // The precedent every other informational field here follows. Storage armed without
      // credentials on a production box still 503s WITH a perfectly good build id.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GIT_COMMIT_SHA", "a1b2c3d");
      const { controller } = setup({
        config: {
          NODE_ENV: "production",
          SUPABASE_URL: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          RESUMES_BUCKET: "worker-resumes",
          WORKER_PHOTOS_BUCKET: "worker-profile-photos",
          VOICE_NOTES_BUCKET: "",
          INTERVIEW_KIT_BUCKET: "interview-kits",
          RESUME_RENDER_ENABLED: true,
        },
      });
      const res = fakeRes();
      const body = await controller.check(res);

      expect(res.statusCode).toBe(503);
      expect(body.build).toBe("a1b2c3d");
    });

    it("adds NOTHING but the sha — no branch, no host, no image digest, no env dump", async () => {
      vi.stubEnv("GIT_COMMIT_SHA", "a1b2c3d");
      const { controller } = setup({});
      const body = await controller.check(fakeRes());

      expect(Object.keys(body)).toEqual([
        "status",
        "service",
        "environment",
        "build",
        "timestamp",
        "checks",
      ]);
      expect(body.build).toBe("a1b2c3d");
    });
  });
});

/**
 * The normalization rule on its own (#965). Everything above proves the field reaches the
 * body; this proves the ONE property the whole design rests on — it cannot throw, for any
 * input, so a bad build id can never take down boot or /health.
 */
describe("resolveBuildId — empty is unset, and nothing throws", () => {
  it("returns a well-formed id unchanged", () => {
    expect(resolveBuildId("a1b2c3d")).toBe("a1b2c3d");
    expect(resolveBuildId("v1.2.3")).toBe("v1.2.3");
  });

  it("trims surrounding whitespace rather than reporting a padded id", () => {
    expect(resolveBuildId("  a1b2c3d\n")).toBe("a1b2c3d");
  });

  it("maps every flavour of 'absent' to the same 'unknown'", () => {
    expect(resolveBuildId(undefined)).toBe(UNKNOWN_BUILD);
    expect(resolveBuildId("")).toBe(UNKNOWN_BUILD);
    expect(resolveBuildId("\t \n")).toBe(UNKNOWN_BUILD);
  });

  it("refuses to echo a control character or a newline into a public HTTP body", () => {
    expect(resolveBuildId("abc\ndef")).toBe(UNKNOWN_BUILD);
    expect(resolveBuildId("<script>")).toBe(UNKNOWN_BUILD);
  });

  it("is length-bounded — a runaway env value cannot bloat the readiness body", () => {
    expect(resolveBuildId("a".repeat(64))).toBe("a".repeat(64));
    expect(resolveBuildId("a".repeat(65))).toBe(UNKNOWN_BUILD);
  });

  it("never throws, whatever arrives", () => {
    for (const raw of [undefined, "", " ", "\u0000", "a".repeat(10_000), "../../etc/passwd"]) {
      expect(() => resolveBuildId(raw)).not.toThrow();
      expect(typeof resolveBuildId(raw)).toBe("string");
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

/**
 * #965 — the ci.yml -> Dockerfile -> runtime seam for `GIT_COMMIT_SHA`.
 *
 * Static, mirroring apps/ai-service/tests/test_health_build_id.py's equivalent, because the
 * alternative is building the API image (apt + WeasyPrint + a full monorepo install) in a
 * unit suite. These two lines are the ENTIRE supply chain for this value: the container has
 * no .git and the service never shells out to git. Lose either one and /health silently
 * reverts to "unknown" forever — which is indistinguishable from a correctly-behaving
 * service that simply was not handed a sha. That is precisely the "feature dead while CI
 * stays green" failure this issue exists to end, and apps/api is the service most often
 * being debugged when the question "which build is this?" gets asked.
 */
describe("the GIT_COMMIT_SHA build seam in apps/api/Dockerfile", () => {
  const dockerfile = readFileSync(resolvePath(__dirname, "../../Dockerfile"), "utf-8");
  const lines = dockerfile.split("\n").map((l) => l.trim());

  it("declares the ARG and promotes it to ENV", () => {
    // Without the ENV the arg evaporates when the build ends and never reaches runtime.
    expect(lines).toContain("ARG GIT_COMMIT_SHA");
    expect(lines).toContain("ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA");
  });

  it("declares both in the RUNTIME stage, after its FROM", () => {
    // An ARG belongs to the stage it is declared in. Declared above a FROM it belongs to no
    // stage and expands to nothing here; declared in the BUILDER stage it would reach
    // `pnpm build` but never the running container.
    const runtimeFrom = lines.indexOf("FROM node:22-bookworm-slim AS runtime");
    const arg = lines.indexOf("ARG GIT_COMMIT_SHA");
    const env = lines.indexOf("ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA");

    expect(runtimeFrom).toBeGreaterThanOrEqual(0);
    expect(runtimeFrom).toBeLessThan(arg);
    expect(arg).toBeLessThan(env);
  });
});
