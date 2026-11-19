import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole, Database } from "@badabhai/db";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { AdminJobAudienceEnabledGuard } from "../job-postings/admin-job-audience.flag";
import { AdminCampusTradesController } from "./admin-campus-trades.controller";
import { CampusTradesPutSchema } from "./admin-campus-trades.dto";
import type {
  AdminCampusTradesRepository,
  CampusTradeRow,
} from "./admin-campus-trades.repository";
import {
  AdminCampusTradesService,
  CAMPUS_TRADE_LIST_ENTITY_ID,
} from "./admin-campus-trades.service";

/**
 * #2957 — the trades RVM trains (only these may be sent to Campus), without a database: what a
 * replace adds, removes, audits and emits, and who may call it. The admin audience control reading
 * the list is proved against Postgres in `admin-posting-audience.db.test.ts`.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CTX: RequestContext = { correlationId: "c", requestId: "r" } as RequestContext;
const REASON = { reason_code: "other" as const, reason_text: "RVM certifies these trades today" };
const AT = new Date("2026-11-19T10:00:00.000Z");

function build(start: CampusTradeRow[]) {
  let rows = [...start];
  const inserted: unknown[] = [];
  const tx = {
    insert: () => ({ values: async (v: unknown) => void inserted.push(v) }),
  } as unknown as Database;
  const repo = {
    withTransaction: vi.fn(async (work: (t: Database) => Promise<unknown>) => work(tx)),
    all: vi.fn(async () => rows),
    add: vi.fn(async (_tx: Database, key: string, admin: string) => {
      rows = [
        ...rows.filter((r) => r.tradeKey !== key),
        { tradeKey: key, addedByAdminId: admin, addedAt: AT, removedAt: null },
      ];
    }),
    remove: vi.fn(async (_tx: Database, key: string) => {
      rows = rows.map((r) => (r.tradeKey === key ? { ...r, removedAt: AT } : r));
    }),
  };
  const events = { emit: vi.fn(async (_input: unknown) => undefined) };
  const service = new AdminCampusTradesService(
    repo as unknown as AdminCampusTradesRepository,
    events as unknown as EventsService,
  );
  return { service, repo, events, inserted };
}

const row = (tradeKey: string, removed = false): CampusTradeRow => ({
  tradeKey,
  addedByAdminId: ADMIN,
  addedAt: AT,
  removedAt: removed ? AT : null,
});

describe("get — every trade kind, with whether RVM trains it", () => {
  it("lists all kinds; only active rows are taught", async () => {
    const { service } = build([row("cnc_turner"), row("welder", true)]);
    const { trades } = await service.get();
    expect(trades.map((t) => t.trade_key)).toEqual([...TRADE_FORM_KINDS_ALL]);
    expect(trades.filter((t) => t.taught_at_campus).map((t) => t.trade_key)).toEqual([
      "cnc_turner",
    ]);
    expect(trades.find((t) => t.trade_key === "welder")).toMatchObject({
      taught_at_campus: false,
      removed_at: AT.toISOString(),
    });
  });
});

describe("replace — the whole list, audited", () => {
  it("adds the new keys, removes the missing, writes one audit row and one event", async () => {
    const { service, repo, events, inserted } = build([row("cnc_turner"), row("welder")]);
    const result = await service.replace(
      ADMIN,
      { trade_keys: ["cnc_turner", "vmc_milling", "cad_draughtsman"], ...REASON },
      CTX,
    );
    expect(result.added).toEqual(["cad_draughtsman", "vmc_milling"]);
    expect(result.removed).toEqual(["welder"]);
    expect(repo.add).toHaveBeenCalledTimes(2);
    expect(repo.remove).toHaveBeenCalledWith(expect.anything(), "welder", ADMIN);
    expect(inserted).toEqual([
      expect.objectContaining({
        actorId: ADMIN,
        action: "campus_trades_set",
        entityType: "campus_trades",
        entityId: CAMPUS_TRADE_LIST_ENTITY_ID,
        metadata: expect.objectContaining({
          added: ["cad_draughtsman", "vmc_milling"],
          removed: ["welder"],
          trades_after: ["cad_draughtsman", "cnc_turner", "vmc_milling"],
        }),
      }),
    ]);
    const emitted = events.emit.mock.calls[0]![0] as { event_name: string; payload: object };
    expect(emitted.event_name).toBe("admin.action_performed");
    expect(emitted.payload).toEqual({
      admin_id: ADMIN,
      action_code: "campus_trades_set",
      target_type: "campus_trades",
      target_id: CAMPUS_TRADE_LIST_ENTITY_ID,
    });
    expect(result.trades.filter((t) => t.taught_at_campus).map((t) => t.trade_key).sort()).toEqual(
      ["cad_draughtsman", "cnc_turner", "vmc_milling"],
    );
  });

  it("re-adding a removed trade is an add", async () => {
    const { service, repo } = build([row("welder", true)]);
    expect((await service.replace(ADMIN, { trade_keys: ["welder"], ...REASON }, CTX)).added).toEqual(
      ["welder"],
    );
    expect(repo.add).toHaveBeenCalledWith(expect.anything(), "welder", ADMIN);
  });

  it("the same list again writes nothing", async () => {
    const { service, repo, events, inserted } = build([row("cnc_turner")]);
    const result = await service.replace(ADMIN, { trade_keys: ["cnc_turner"], ...REASON }, CTX);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(repo.add).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("an empty list removes every trade: no company job can then go to Campus", async () => {
    const { service } = build([row("cnc_turner")]);
    expect((await service.replace(ADMIN, { trade_keys: [], ...REASON }, CTX)).removed).toEqual([
      "cnc_turner",
    ]);
  });
});

describe("the wire contract", () => {
  it("only known trade kinds, no repeats, a reason, no actor in the body", () => {
    const ok = { trade_keys: ["cnc_turner"], ...REASON };
    expect(CampusTradesPutSchema.safeParse(ok).success).toBe(true);
    expect(CampusTradesPutSchema.safeParse({ ...ok, trade_keys: ["painter"] }).success).toBe(false);
    expect(
      CampusTradesPutSchema.safeParse({ ...ok, trade_keys: ["cnc_turner", "cnc_turner"] }).success,
    ).toBe(false);
    expect(CampusTradesPutSchema.safeParse({ trade_keys: ["cnc_turner"] }).success).toBe(false);
    expect(CampusTradesPutSchema.safeParse({ ...ok, admin_id: ADMIN }).success).toBe(false);
  });
});

describe("routes — behind the switch; reading is the floor, changing is super_admin only", () => {
  const proto = AdminCampusTradesController.prototype as unknown as Record<string, object>;
  const guard = new AdminRolesGuard(new Reflector());
  const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
  const ctxFor = (method: string, who: AuthenticatedAdmin): ExecutionContext => {
    const handler = () => undefined;
    Reflect.defineMetadata(
      ADMIN_CAPABILITY_KEY,
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!),
      handler,
    );
    return {
      getHandler: () => handler,
      getClass: () => AdminCampusTradesController,
      switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
    } as unknown as ExecutionContext;
  };

  it("the switch runs before the roles", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminCampusTradesController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([
      AdminAuthGuard.name,
      AdminJobAudienceEnabledGuard.name,
      AdminRolesGuard.name,
    ]);
  });

  it("get: every role", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.get!)).toBe("read_entities");
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as const) {
      expect(guard.canActivate(ctxFor("get", admin(role)))).toBe(true);
    }
  });

  it("replace: super_admin only", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.replace!)).toBe("manage_campus_trades");
    expect(guard.canActivate(ctxFor("replace", admin("super_admin")))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as const) {
      expect(() => guard.canActivate(ctxFor("replace", admin(role)))).toThrow(ForbiddenException);
    }
  });
});
