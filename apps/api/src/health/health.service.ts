import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { AiService } from "../ai/ai.service";
import { DATABASE } from "../database/database.module";
import {
  ACCOUNT_DELETION_QUEUE,
  ACCOUNT_DELETION_SWEEP_SCHEDULER_ID,
  RESUME_RENDER_QUEUE,
} from "../queue/queue.constants";

/** Per-dependency readiness state surfaced in the /health body. */
export type DependencyStatus = "up" | "down";

/**
 * TD81 — whether the AI answers this API is currently producing can have come from a
 * REAL LLM at all. This is the field TD81 asks for: "make it LOUD … so nobody mistakes
 * it for real". Reachability alone does not answer it — an ai-service that is up with
 * `AI_ENABLE_REAL_CALLS=false` is just as mocked as one that is not deployed.
 *
 *   - `real`    — the ai-service is reachable AND reports `real_calls_enabled: true`.
 *                 READ THE CAVEAT on `HealthChecks.ai_posture` before trusting this.
 *   - `mock`    — NO answer this API returns can have come from a real LLM, either
 *                 because the ai-service is unreachable (the api falls back to its
 *                 in-process TypeScript mock — TD81's exact scenario) or because the
 *                 ai-service is reachable and says real calls are off.
 *   - `unknown` — reachable, but the posture flag was withheld (TD67 locked posture).
 *                 Honest ignorance, never silently downgraded to `mock`.
 */
export type AiPosture = "real" | "mock" | "unknown";

export interface HealthChecks {
  database: DependencyStatus;
  redis: DependencyStatus;
  /**
   * ADR-0031 — is the account-deletion sweep's repeatable job scheduler actually
   * registered in Redis? `up` = the clock that erases post-grace workers exists;
   * `down` = it does not, so DPDP erasure has stopped even though every request path
   * is fine. INFORMATIONAL: it does NOT flip the 200/503 (see health.controller.ts).
   */
  deletion_sweep: DependencyStatus;
  /**
   * TD81 — is the FastAPI ai-service reachable from this process at all? `down` is the
   * literal TD81 condition: the deploy shipped with no `ai-service` at all, so
   * `AI_SERVICE_URL` (default `http://localhost:8000`) resolved to nothing on the box
   * and every AI call silently took the mock fallback. This field stays useful after
   * that is fixed — it is what tells you the service went away again. INFORMATIONAL: it
   * does NOT flip the 200/503 — see the justification in health.controller.ts.
   */
  ai_service: DependencyStatus;
  /**
   * TD81 — the posture above, i.e. real-vs-mocked AI at a glance.
   *
   * CAVEAT, and it is the important one: `real` is a CONFIG-PRESENCE claim with ZERO
   * network I/O to the provider. Upstream it means only "kill switch off AND
   * `AI_ENABLE_REAL_CALLS` true AND `GEMINI_FLASH_API_KEY` non-empty"
   * (apps/ai-service/app/config.py:317-336) — nobody ever asked Gemini whether that key
   * works. A REVOKED, EXPIRED, quota-exhausted or typo'd key still reports `real`, and
   * even with a good key an individual call can still land on the mock via the per-task
   * allowlist, a spend cap, or a fail-closed pseudonymization block. So: `mock` here is
   * PROOF that AI is mocked; `real` is only evidence that nothing in CONFIG forbids a
   * real call. Do not re-read this later as "real AI is verified working" — for that,
   * look at `ai_jobs.real_call` on an actual job.
   */
  ai_posture: AiPosture;
}

/** Cap each probe so a stuck socket can never hang the /health response. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * The dependencies that are actually PROBED. Narrower than `keyof HealthChecks` on
 * purpose: `ai_posture` is DERIVED from the ai_service probe, not probed itself, and
 * must never be passable as a probe name to `runProbe`.
 */
type ProbeName = "database" | "redis" | "deletion_sweep" | "ai_service";

/**
 * Minimal typed view of the one Redis command the probe needs. BullMQ's
 * IRedisClient doesn't declare `ping`, but the runtime client is ioredis which
 * does (same idiom as OtpService's RedisOtpClient).
 */
interface RedisHealthClient {
  ping(): Promise<string>;
}

/**
 * Readiness probes for /health. Each dependency is checked over its EXISTING
 * connection — no new client is opened:
 *   - Postgres: a lightweight `SELECT 1` over the injected Drizzle `Database`
 *     (the pooled postgres.js connection from DatabaseModule).
 *   - Redis: `PING` over the BullMQ ioredis client (`queue.client`), reusing the
 *     same connection the OTP flow uses — do NOT add a second Redis client.
 *   - Deletion sweep (ADR-0031): the repeatable job scheduler is looked up by id
 *     over the account-deletion queue's EXISTING connection.
 *   - AI service (TD81): a GET of the ai-service's own /health through the EXISTING
 *     `AiService` client (global `fetch` + AbortController, the same idiom its POST
 *     helper uses) — do NOT introduce a second HTTP client for one probe.
 *
 * Probes run in parallel and each is wrapped in a short timeout. The underlying
 * error (if any) is logged server-side only; it NEVER leaves this service. The
 * caller receives only `up`/`down` (plus the derived, enum-valued `ai_posture`) so no
 * connection string, host, URL, token, or error detail can leak into the HTTP body.
 * Every check is PII-free by construction — they carry no worker/payer identifiers at
 * all, and the ai_service probe sends no body, so it cannot touch the LLM/PII boundary.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  /**
   * TD81 — the last `<reachability>/<posture>` pair this process logged, so the posture
   * line fires on CHANGE only. /health is polled by the CD gate, the staging smoke and
   * any uptime check, so an unconditional log would emit this every few seconds and
   * become wallpaper — the precise failure mode TD81 is about. On CHANGE it is loud
   * exactly when it matters: process start (the "staging just came up mocked" moment)
   * and every real transition after it.
   */
  private lastLoggedPosture: string | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
    // ADR-0031 — the sweep's own queue handle, for the scheduler-existence probe.
    // Registering the queue reuses the SAME Redis connection (no second client).
    @InjectQueue(ACCOUNT_DELETION_QUEUE) private readonly deletionQueue: Queue,
    // TD81 — the EXISTING ai-service client, injected only for its reachability probe.
    // AiModule is @Global, so this resolves without an import in HealthModule (the
    // DATABASE token arrives the same way). HealthService neither profiles nor sends
    // anything through it; it calls `probeHealth()` and nothing else.
    private readonly ai: AiService,
  ) {}

  /**
   * Probe every dependency in parallel; returns their up/down states, plus the TD81
   * `ai_posture` derived from the ai_service probe (real-vs-mocked AI at a glance).
   */
  async check(): Promise<HealthChecks> {
    const [database, redis, deletionSweep, aiService] = await Promise.all([
      this.runProbe("database", () => this.probeDatabase()),
      this.runProbe("redis", () => this.probeRedis()),
      this.runProbe("deletion_sweep", () => this.probeDeletionSweep()),
      this.probeAiService(),
    ]);
    return {
      database,
      redis,
      deletion_sweep: deletionSweep,
      ai_service: aiService.status,
      ai_posture: aiService.posture,
    };
  }

  /** Lightweight `SELECT 1` over the pooled Drizzle connection. */
  private async probeDatabase(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  /** `PING` over the BullMQ ioredis client (the existing OTP/session connection). */
  private async probeRedis(): Promise<void> {
    const client = (await this.queue.client) as unknown as RedisHealthClient;
    await client.ping();
  }

  /**
   * ADR-0031 — does the deletion sweep's repeatable job scheduler exist?
   *
   * This probes REDIS (the scheduler's real home), not a process-local "did I register
   * it?" flag, on purpose:
   *   - it stays true across replicas (any replica that registered the shared id makes
   *     the sweep live for everyone), and
   *   - it cannot go stale — a scheduler removed out-of-band (Redis flush/eviction, a
   *     manual clean) reads `down` here, where an in-memory flag would keep claiming `up`
   *     forever. That is the dangerous direction, so we do not rely on memory.
   * Missing scheduler → a named, secret-free error so `safeReason` logs a useful tag.
   */
  private async probeDeletionSweep(): Promise<void> {
    const scheduler = await this.deletionQueue.getJobScheduler(ACCOUNT_DELETION_SWEEP_SCHEDULER_ID);
    if (!scheduler) {
      const e = new Error(`job scheduler ${ACCOUNT_DELETION_SWEEP_SCHEDULER_ID} is not registered`);
      e.name = "SchedulerMissingError";
      throw e;
    }
  }

  /**
   * TD81 — is the ai-service reachable, and is the AI it serves REAL or MOCKED?
   *
   * `/health` is the only place an operator looks before trusting an environment, so
   * "reachable" alone would be a half-answer: TD81's register entry names the ai-service
   * simply not being deployed, but an ai-service that IS deployed with
   * `AI_ENABLE_REAL_CALLS=false` (the committed, correct default per CLAUDE.md §2.5) is
   * equally mocked and would otherwise read as a clean `up`.
   *
   * Reuses `runProbe` verbatim — same PROBE_TIMEOUT_MS cap, same never-throws contract,
   * same secret-free `safeReason` log line as the other three. The disclosed flag is
   * captured through a holder rather than returned, because `runProbe` yields only a
   * status; on ANY failure the holder keeps its initial `null` and `derivePosture` takes
   * the `down` branch. The inner `probeHealth(PROBE_TIMEOUT_MS)` gets the SAME budget so
   * the socket is actually aborted, not merely raced past and left dangling.
   */
  private async probeAiService(): Promise<{ status: DependencyStatus; posture: AiPosture }> {
    const probed: { realCallsEnabled: boolean | null } = { realCallsEnabled: null };
    const status = await this.runProbe("ai_service", async () => {
      probed.realCallsEnabled = (await this.ai.probeHealth(PROBE_TIMEOUT_MS)).realCallsEnabled;
    });
    const posture = HealthService.derivePosture(status, probed.realCallsEnabled);
    this.logPostureChange(status, posture);
    return { status, posture };
  }

  /**
   * Map (reachability, disclosed flag) → the posture in the body. See `AiPosture`.
   *
   * `down` ⇒ `mock` rather than `unknown` deliberately: unreachable is not ambiguous.
   * `AiService` degrades EVERY call to its in-process TypeScript mock (or, for the
   * opener/canonicalize paths, to `null`) when the service cannot be reached, so no
   * answer this API returns can have come from an LLM. Calling that `unknown` would
   * understate the one condition TD81 exists to expose.
   */
  private static derivePosture(
    status: DependencyStatus,
    realCallsEnabled: boolean | null,
  ): AiPosture {
    if (status === "down") return "mock";
    if (realCallsEnabled === null) return "unknown"; // TD67 locked posture — withheld
    return realCallsEnabled ? "real" : "mock";
  }

  /**
   * TD81's "make it LOUD" half, in the logs (the body carries the same facts for anyone
   * reading /health). Fires on CHANGE only — see `lastLoggedPosture`. Every branch is
   * secret-free by construction: fixed English plus the two enum values, never the URL,
   * the token, or an error message.
   */
  private logPostureChange(status: DependencyStatus, posture: AiPosture): void {
    const observed = `${status}/${posture}`;
    if (observed === this.lastLoggedPosture) return;
    this.lastLoggedPosture = observed;

    const prefix = `AI POSTURE ai_service=${status} ai_posture=${posture} —`;
    if (posture === "real") {
      // Not a warning, but still worth one line: flipping an environment to real LLM
      // spend is exactly the transition an operator wants stamped in the log.
      this.logger.log(
        `${prefix} the ai-service reports real calls ENABLED. Config-presence only: the ` +
          `provider key has NOT been exercised, so a revoked/expired key still reads real.`,
      );
      return;
    }
    if (posture === "unknown") {
      this.logger.warn(
        `${prefix} the ai-service withholds real_calls_enabled while its AI_INTERNAL_TOKEN ` +
          `is set (TD67), so this API cannot tell real AI from mocked AI. Confirm out of ` +
          `band via the token-gated /ai/spend before trusting AI results from this env.`,
      );
      return;
    }
    this.logger.warn(
      `${prefix} NO answer this API returns can have come from a real LLM (TD81). ` +
        (status === "down"
          ? `The ai-service is unreachable, so every AI call takes the in-process mock fallback.`
          : `The ai-service is reachable but reports real_calls_enabled=false (kill switch, ` +
            `AI_ENABLE_REAL_CALLS, or a missing provider key).`),
    );
  }

  /**
   * Run one probe under a timeout and never throw: any rejection (including the
   * timeout) maps to `down`, with the underlying reason logged server-side only.
   */
  private async runProbe(
    name: ProbeName,
    probe: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    try {
      await this.withTimeout(probe(), name);
      return "up";
    } catch (err) {
      // Log a secret-safe failure tag ONLY — the driver error code (ECONNREFUSED/
      // ETIMEDOUT/…) or the error name. NEVER err.message: a DB/Redis driver could
      // populate it with a connection string / credential (CLAUDE.md §2 — no secrets
      // in logs). The HTTP body already carries only up/down.
      this.logger.warn(`health probe ${name}=down (reason: ${HealthService.safeReason(err)})`);
      return "down";
    }
  }

  /** A non-sensitive failure tag for logs: the error code if present, else its name. */
  private static safeReason(err: unknown): string {
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      return typeof code === "string" && code.length > 0 ? code : err.name;
    }
    return "unknown";
  }

  /** Reject after PROBE_TIMEOUT_MS so a hung dependency can't stall /health. */
  private async withTimeout<T>(work: Promise<T>, name: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${name} probe timed out after ${PROBE_TIMEOUT_MS}ms`);
        e.name = "TimeoutError"; // so safeReason() logs a useful, secret-free tag
        reject(e);
      }, PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
