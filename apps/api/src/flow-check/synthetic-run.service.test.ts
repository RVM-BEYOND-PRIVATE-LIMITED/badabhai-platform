import "reflect-metadata";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { POSTING_TRADES } from "@badabhai/taxonomy";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { RvmStudentApiUnavailableError } from "../campus-link/rvm-student-api.client";
import { StudentNotAvailableError } from "../campus-link/institute-link.service";
import { AdminEventsService } from "../admin/admin-events.service";
import type { EventsService } from "../events/events.service";
import { SyntheticRunController, SyntheticRunEnabledGuard } from "./synthetic-run.controller";
import { SyntheticRunModule } from "./synthetic-run.module";
import { FLOW_SYNTHETIC_RUN_CRON_UTC, SyntheticRunProcessor } from "./synthetic-run.processor";
import {
  SyntheticRunService,
  SyntheticStepRefused,
  failureCodeOf,
  pickTrade,
  type SyntheticRunResult,
} from "./synthetic-run.service";

/** #2967 — the daily synthetic run: codes, trade choice, switch, record, wiring, and its fence. */

const NOW = new Date("2026-11-19T23:00:00.000Z"); // 04:30 IST on the 20th

describe("failureCodeOf", () => {
  it("maps what a step threw to a closed code", () => {
    expect(failureCodeOf(new SyntheticStepRefused("no_campus_trade", "x"))).toBe("no_campus_trade");
    expect(failureCodeOf(new StudentNotAvailableError())).toBe("refused");
    expect(failureCodeOf(new RvmStudentApiUnavailableError("timeout"))).toBe("unavailable");
    expect(failureCodeOf(new NotFoundException())).toBe("not_found");
    expect(failureCodeOf(new ConflictException())).toBe("conflict");
    expect(failureCodeOf(new BadRequestException())).toBe("invalid");
    expect(failureCodeOf(new ServiceUnavailableException())).toBe("unavailable");
    expect(failureCodeOf(Object.assign(new Error("q"), { cause: { code: "57014" } }))).toBe(
      "timeout",
    );
    expect(failureCodeOf(Object.assign(new Error("q"), { cause: { code: "55P03" } }))).toBe(
      "timeout",
    );
    expect(failureCodeOf(new Error("anything"))).toBe("error");
    expect(failureCodeOf("not an error")).toBe("error");
  });
});

describe("pickTrade", () => {
  it("takes the first postable trade on the Campus list, in key order", () => {
    const keys = POSTING_TRADES.slice(0, 2)
      .map((t) => t.roleKind)
      .reverse();
    const picked = pickTrade(["not_a_trade", ...keys]);
    expect(picked.onCampusList).toBe(true);
    expect(picked.trade.roleKind).toBe([...keys].sort()[0]);
  });

  it("with no postable Campus trade, still walks the BadaBhai half on a postable trade", () => {
    for (const keys of [[], ["not_a_trade"]]) {
      const picked = pickTrade(keys);
      expect(picked.onCampusList).toBe(false);
      expect(picked.trade).toBe(POSTING_TRADES[0]);
    }
  });
});

function service(enabled: boolean, result?: SyntheticRunResult) {
  const emit = vi.fn(async () => ({}) as never);
  const emitOnce = vi.fn(async () => ({ event: {} as never, written: true }));
  const svc = new SyntheticRunService(
    {} as never,
    {} as never,
    { FLOW_SYNTHETIC_RUN_ENABLED: enabled } as ServerConfig,
    { emit, emitOnce } as unknown as EventsService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const run = vi.spyOn(svc, "run");
  if (result) run.mockResolvedValue(result);
  const logger = (svc as unknown as { logger: Record<string, (m: string) => void> }).logger;
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  return { svc, run, emit, emitOnce };
}

const PASS: SyntheticRunResult = {
  passed: true,
  stepsPassed: 10,
  failedStep: null,
  failure: null,
  durationMs: 1200,
};
const FAIL: SyntheticRunResult = {
  passed: false,
  stepsPassed: 7,
  failedStep: "applicants_listed",
  failure: "refused",
  durationMs: 900,
};

describe("SyntheticRunService.runAndRecord", () => {
  it("off: returns at once, runs nothing, records nothing", async () => {
    const { svc, run, emit, emitOnce } = service(false);
    expect(await svc.runAndRecord(NOW, "schedule")).toEqual({ armed: false });
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("a pass: one record (every run), no alert", async () => {
    const { svc, emit, emitOnce } = service(true, PASS);
    expect(await svc.runAndRecord(NOW, "schedule")).toEqual({ armed: true, ...PASS });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "flow_check.synthetic_run_recorded",
        actor: { actor_type: "system" },
        subject: { subject_type: "job_posting", subject_id: null },
        payload: {
          day: "2026-11-20",
          trigger: "schedule",
          passed: true,
          steps_passed: 10,
          failed_step: null,
          failure: null,
          duration_ms: 1200,
        },
      }),
    );
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("a failure: the record, and the day's one alert keyed on the IST day", async () => {
    const { svc, emit, emitOnce } = service(true, FAIL);
    await svc.runAndRecord(NOW, "ops");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emitOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "flow_check.synthetic_run_failed",
        idempotencyKey: "flow_check.synthetic_run_failed:2026-11-20",
        payload: expect.objectContaining({
          trigger: "ops",
          passed: false,
          steps_passed: 7,
          failed_step: "applicants_listed",
          failure: "refused",
        }),
      }),
    );
  });

  it("puts its alert on the dashboard's breach counter", () => {
    expect(AdminEventsService.BREACH_EVENTS).toContain("flow_check.synthetic_run_failed");
  });
});

describe("the run-now route and the tick", () => {
  it("POST /flow-check/synthetic-run: the ops token first (401 without), then the switch (404 off)", () => {
    expect(Reflect.getMetadata("path", SyntheticRunController)).toBe("flow-check");
    expect(Reflect.getMetadata("__guards__", SyntheticRunController)).toEqual([
      InternalServiceGuard,
      SyntheticRunEnabledGuard,
    ]);
    expect(Reflect.getMetadata("path", SyntheticRunController.prototype.runNow)).toBe(
      "synthetic-run",
    );
    expect(() =>
      new SyntheticRunEnabledGuard({ FLOW_SYNTHETIC_RUN_ENABLED: false }).canActivate(),
    ).toThrow(NotFoundException);
    expect(new SyntheticRunEnabledGuard({ FLOW_SYNTHETIC_RUN_ENABLED: true }).canActivate()).toBe(
      true,
    );
  });

  it("runs at 04:30 IST and never fails boot on a Redis refusal", async () => {
    expect(FLOW_SYNTHETIC_RUN_CRON_UTC).toBe("0 23 * * *");
    const upsertJobScheduler = vi.fn(async () => undefined);
    const processor = new SyntheticRunProcessor({} as never, { upsertJobScheduler } as never);
    await processor.onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith("flow-synthetic-run", {
      pattern: "0 23 * * *",
      tz: "UTC",
    });
    upsertJobScheduler.mockRejectedValueOnce(new Error("down"));
    vi.spyOn(
      (processor as unknown as { logger: { warn: () => void } }).logger,
      "warn",
    ).mockImplementation(() => undefined);
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("the module is a leaf with its controller and processor", () => {
    expect(Reflect.getMetadata("controllers", SyntheticRunModule)).toEqual([
      SyntheticRunController,
    ]);
    expect(Reflect.getMetadata("providers", SyntheticRunModule)).toEqual(
      expect.arrayContaining([SyntheticRunService, SyntheticRunProcessor]),
    );
  });
});

/**
 * THE FENCE. A rolled-back scope reroutes every query of its async context, and the RVM stub
 * answers inside it. So exactly one file may open one: the synthetic run. A second caller (a
 * request handler, a job) would be a way to make writes vanish or to fake an RVM student.
 */
describe("only the synthetic run opens a rolled-back scope", () => {
  const SRC = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".ts") && !/\.test\.ts$/.test(e)) files.push(full);
    }
  };
  walk(SRC);
  const rel = (f: string) => relative(SRC, f).split(sep).join("/");
  // Read once, at collection: the tree is large and CI is ~20x slower than a laptop.
  const code = files.map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));
  const SCAN_TIMEOUT_MS = 60_000;
  const users = (pattern: RegExp) =>
    code
      .filter((c) => pattern.test(c.text))
      .map((c) => c.file)
      .filter((f) => f !== "database/synthetic-scope.ts");

  it(
    "runRolledBack is called from synthetic-run.service.ts alone",
    () => {
      expect(users(/\brunRolledBack\(/)).toEqual(["flow-check/synthetic-run.service.ts"]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "syntheticStudentFor is read by the RVM client alone",
    () => {
      expect(users(/\bsyntheticStudentFor\(/)).toEqual(["campus-link/rvm-student-api.client.ts"]);
    },
    SCAN_TIMEOUT_MS,
  );

  it("the scan read the tree (a scan of nothing passes vacuously)", () => {
    expect(files.length).toBeGreaterThan(400);
  });
});
