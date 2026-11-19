import "reflect-metadata";
import { NotFoundException, RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { AdminRolesGuard } from "../admin/admin-roles.guard";
import { CampusServiceGuard } from "../campus-link/campus-service.guard";
import { CAMPUS_LINK_BASE_PATH } from "../campus-link/campus-link.contract";
import { CampusLinkModule } from "../campus-link/campus-link.module";
import { AdminModule } from "../admin/admin.module";
import { AdminEventsRepository } from "../admin/admin-events.repository";
import { AdminEventsService } from "../admin/admin-events.service";
import { FLOW_CHECK_QUEUE } from "../queue/queue.constants";
import { AdminFlowCheckController, AdminFlowCheckQuerySchema } from "./admin-flow-check.controller";
import { CampusApplicationsCheckController } from "./campus-applications-check.controller";
import { FlowCheckEnabledGuard } from "./flow-check.flag";
import { FlowCheckModule } from "./flow-check.module";
import { FLOW_CHECK_CRON_UTC, FlowCheckProcessor } from "./flow-check.processor";
import type { FlowCheckService } from "./flow-check.service";

/** #2890 — the flow check's two routes: guards in order, the switch, the capability, the module. */

const meta = (key: string, target: object): unknown => Reflect.getMetadata(key, target) as unknown;

describe("FlowCheckEnabledGuard", () => {
  it("is a neutral 404 while FLOW_CHECK_ENABLED is off, unset or not exactly true", () => {
    for (const config of [{ FLOW_CHECK_ENABLED: false }, {}, undefined]) {
      const guard = new FlowCheckEnabledGuard(config as Pick<ServerConfig, "FLOW_CHECK_ENABLED">);
      expect(() => guard.canActivate()).toThrow(NotFoundException);
    }
  });

  it("passes when the switch is on", () => {
    expect(new FlowCheckEnabledGuard({ FLOW_CHECK_ENABLED: true }).canActivate()).toBe(true);
  });
});

describe("GET /admin/flow-check", () => {
  it("is guarded auth → switch → roles, and asks read_events", () => {
    expect(meta("path", AdminFlowCheckController)).toBe("admin/flow-check");
    expect(meta("__guards__", AdminFlowCheckController)).toEqual([
      AdminAuthGuard,
      FlowCheckEnabledGuard,
      AdminRolesGuard,
    ]);
    const handler = AdminFlowCheckController.prototype.read;
    expect(meta("method", handler)).toBe(RequestMethod.GET);
    // The capability the roles guard reads (one method-level capability, none on the class).
    const keys = Reflect.getMetadataKeys(handler) as string[];
    const capabilityKey = keys.find((k) => meta(k, handler) === "read_events");
    expect(capabilityKey, `metadata keys: ${keys.join(",")}`).toBeDefined();
  });

  it("takes days 1 to 14, default 14, and nothing else", () => {
    expect(AdminFlowCheckQuerySchema.parse({})).toEqual({ days: 14 });
    expect(AdminFlowCheckQuerySchema.parse({ days: "3" })).toEqual({ days: 3 });
    for (const bad of [{ days: "0" }, { days: "15" }, { days: "1.5" }, { from: "2026-11-01" }]) {
      expect(AdminFlowCheckQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("answers the window, the thresholds in force, the check names and the days", async () => {
    const days = vi.fn(async () => []);
    const controller = new AdminFlowCheckController({
      days,
      thresholds: () => ({ review_wait_hours: 48 }),
    } as unknown as FlowCheckService);
    const body = await controller.read({ days: 5 });
    expect(body).toMatchObject({
      window_hours: 24,
      thresholds: { review_wait_hours: 48 },
      days: [],
    });
    expect(body.checks).toContain("campus_report_missing");
    expect(days).toHaveBeenCalledWith(5, expect.any(Date));
  });
});

describe("PUT /internal/campus/v1/applications-check", () => {
  it("sits behind the Campus credential first, then the switch", () => {
    expect(meta("path", CampusApplicationsCheckController)).toBe(CAMPUS_LINK_BASE_PATH);
    expect(meta("__guards__", CampusApplicationsCheckController)).toEqual([
      CampusServiceGuard,
      FlowCheckEnabledGuard,
    ]);
    const handler = CampusApplicationsCheckController.prototype.report;
    expect(meta("path", handler)).toBe("applications-check");
    expect(meta("method", handler)).toBe(RequestMethod.PUT);
  });

  it("hands the validated body and the Idempotency-Key to the service", async () => {
    const recordCampusReport = vi.fn(async () => ({ recorded: true }));
    const controller = new CampusApplicationsCheckController({
      recordCampusReport,
    } as unknown as FlowCheckService);
    const body = {
      checked_at: "2026-11-20T03:30:00.000+05:30",
      outbox_undelivered: 0,
      missing_on_badabhai: 0,
      not_sent: 0,
      dispatcher_on: true,
    };
    expect(await controller.report(body, "outbox:abc12345")).toEqual({ recorded: true });
    expect(recordCampusReport).toHaveBeenCalledWith(body, "outbox:abc12345");
  });
});

describe("FlowCheckModule", () => {
  it("is a leaf over the admin and Campus modules, with its own spine reader and queue", () => {
    expect(meta("controllers", FlowCheckModule)).toEqual([
      AdminFlowCheckController,
      CampusApplicationsCheckController,
    ]);
    const imports = meta("imports", FlowCheckModule) as unknown[];
    expect(imports).toEqual(expect.arrayContaining([AdminModule, CampusLinkModule]));
    expect(meta("providers", FlowCheckModule)).toEqual(
      expect.arrayContaining([AdminEventsRepository, FlowCheckEnabledGuard, FlowCheckProcessor]),
    );
    expect(FLOW_CHECK_QUEUE).toBe("flow-check");
  });

  it("ticks at 05:00 IST (23:30 UTC), after Campus's 03:30 IST check", () => {
    expect(FLOW_CHECK_CRON_UTC).toBe("30 23 * * *");
  });

  it("puts its alert on the dashboard's breach counter", () => {
    expect(AdminEventsService.BREACH_EVENTS).toContain("flow_check.breached");
  });
});

describe("FlowCheckProcessor", () => {
  it("registers the daily cron and never fails boot when Redis refuses", async () => {
    const upsertJobScheduler = vi.fn(async () => undefined);
    const processor = new FlowCheckProcessor(
      {} as FlowCheckService,
      {
        upsertJobScheduler,
      } as never,
    );
    await processor.onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith("flow-check", {
      pattern: "30 23 * * *",
      tz: "UTC",
    });

    upsertJobScheduler.mockRejectedValueOnce(new Error("down"));
    const warn = vi
      .spyOn((processor as unknown as { logger: { warn: () => void } }).logger, "warn")
      .mockImplementation(() => undefined);
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("runs the service with the tick's time", async () => {
    const run = vi.fn(async () => ({ armed: false as const }));
    const processor = new FlowCheckProcessor({ run } as unknown as FlowCheckService, {} as never);
    expect(await processor.process()).toEqual({ armed: false });
    expect(run).toHaveBeenCalledWith(expect.any(Date));
  });
});
