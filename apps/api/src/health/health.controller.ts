import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { HealthService, type HealthChecks } from "./health.service";

/** Structured readiness payload returned for both 200 and 503. */
interface HealthResponse {
  status: "ok" | "error";
  service: "api";
  environment: string;
  timestamp: string;
  checks: HealthChecks;
}

/**
 * Readiness probe. UNAUTHENTICATED by design and emits NO event — it is a probe,
 * not a domain action. It actively checks Postgres + Redis on every call:
 *   - 200 + status "ok"    when BOTH checks are "up".
 *   - 503 + status "error" when EITHER is "down".
 * The body carries only `up`/`down` per dependency — never a connection string,
 * host, error message, or stack. The status code is set via a passthrough
 * Response so the structured body (with `checks`) survives on a 503 too, instead
 * of being re-wrapped by the global exceptions filter.
 *
 * `checks.deletion_sweep` (ADR-0031) is reported but deliberately does NOT gate the
 * status code. READINESS answers "can this process serve requests?" — a dead sweep
 * scheduler does not stop a single request path; every worker/payer route is fine and
 * the DB marker keeps the erasure work list intact, so erasure is DELAYED, not lost.
 * 503-ing on it would (a) fail the CD /health gate and the staging smoke, i.e. treat a
 * background-clock hiccup as platform-down, and (b) in a rotation, pull a healthy API out
 * of service — turning a delayed erasure into a real outage. It is surfaced for
 * DETECTION instead: the field here, the processor's terminal error log, and the alert
 * threshold in docs/observability-runbook.md §7 (SEV2 if it stays down — DPDP erasure
 * has stopped).
 */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly health: HealthService,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const checks = await this.health.check();
    // Gate: hard dependencies only — see the deletion_sweep note above.
    const healthy = checks.database === "up" && checks.redis === "up";

    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: healthy ? "ok" : "error",
      service: "api",
      environment: this.config.NODE_ENV,
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
