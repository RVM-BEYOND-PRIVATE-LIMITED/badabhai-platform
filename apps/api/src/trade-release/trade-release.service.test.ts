import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { Database, TradeReleaseRow } from "@badabhai/db";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { TradeReleaseRepository } from "./trade-release.repository";
import { TradeReleaseService } from "./trade-release.service";

/**
 * #3002 — the per-trade release switch, without a database: what the readers answer, the
 * 30-second cache, the fail-closed reads, and what a set writes and emits. The seeded 16 live
 * kinds are proved against Postgres in `trade-release.db.test.ts`.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CTX: RequestContext = { correlationId: "c", requestId: "r" } as RequestContext;
const AT = new Date("2026-11-24T10:00:00.000Z");

const row = (roleKind: string, over: Partial<TradeReleaseRow> = {}): TradeReleaseRow => ({
  roleKind,
  postingEnabled: true,
  formEnabled: false,
  updatedBy: null,
  updatedAt: AT,
  ...over,
});

function build(start: TradeReleaseRow[]) {
  let rows = [...start];
  const repo = {
    withTransaction: vi.fn(async (work: (t: Database) => Promise<unknown>) => work({} as Database)),
    all: vi.fn(async () => rows),
    find: vi.fn(
      async (_tx: Database, kind: string) => rows.find((r) => r.roleKind === kind) ?? null,
    ),
    upsert: vi.fn(
      async (
        _tx: Database,
        input: {
          roleKind: string;
          postingEnabled: boolean;
          formEnabled: boolean;
          updatedBy: string;
        },
      ) => {
        const next = row(input.roleKind, {
          postingEnabled: input.postingEnabled,
          formEnabled: input.formEnabled,
          updatedBy: input.updatedBy,
        });
        rows = [...rows.filter((r) => r.roleKind !== input.roleKind), next];
        return next;
      },
    ),
  };
  const events = { emit: vi.fn(async (_input: unknown) => undefined) };
  const service = new TradeReleaseService(
    repo as unknown as TradeReleaseRepository,
    events as unknown as EventsService,
  );
  return { service, repo, events };
}

describe("readers — what a company may post, and what is live", () => {
  it("a seeded live kind posts; a kind with no row is off everywhere", async () => {
    const { service } = build([row("cnc_turner")]);
    expect(await service.isPostingEnabled("cnc_turner")).toBe(true);
    expect(await service.isFormEnabled("cnc_turner")).toBe(false);
    expect(await service.isPostingEnabled("gear_cutting_operator")).toBe(false);
    expect(await service.isFormEnabled("gear_cutting_operator")).toBe(false);
  });

  it("reads fail closed and log the kind only: a read error answers off", async () => {
    const { service, repo } = build([row("cnc_turner")]);
    repo.all.mockRejectedValueOnce(new Error("connection reset"));
    expect(await service.isPostingEnabled("cnc_turner")).toBe(false);
    expect(await service.isFormEnabled("cnc_turner")).toBe(false);
  });

  it("caches the table for 30 seconds; a set clears it", async () => {
    vi.useFakeTimers();
    try {
      const { service, repo } = build([row("cnc_turner")]);
      expect(await service.isPostingEnabled("cnc_turner")).toBe(true);
      expect(await service.isPostingEnabled("welder")).toBe(false);
      expect(repo.all).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(await service.isPostingEnabled("cnc_turner")).toBe(true);
      expect(repo.all).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await service.isPostingEnabled("cnc_turner")).toBe(true);
      expect(repo.all).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getAll names every trade kind, released or not", async () => {
    const { service } = build([row("cnc_turner", { updatedBy: ADMIN })]);
    const { releases } = await service.getAll();
    expect(releases.map((r) => r.role_kind)).toEqual([...TRADE_FORM_KINDS_ALL]);
    expect(releases.find((r) => r.role_kind === "cnc_turner")).toMatchObject({
      posting_enabled: true,
      form_enabled: false,
      updated_by: ADMIN,
    });
    expect(releases.find((r) => r.role_kind === "gear_cutting_operator")).toMatchObject({
      posting_enabled: false,
      form_enabled: false,
      updated_by: null,
    });
  });
});

describe("set — one trade's flags, audited by the event", () => {
  it("writes the row and emits trade_release.changed with the admin", async () => {
    const { service, repo, events } = build([]);
    const result = await service.set(
      ADMIN,
      { roleKind: "gear_cutting_operator", postingEnabled: true, formEnabled: false },
      CTX,
    );
    expect(result.changed).toBe(true);
    expect(result.release).toMatchObject({
      role_kind: "gear_cutting_operator",
      posting_enabled: true,
      form_enabled: false,
      updated_by: ADMIN,
    });
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
    const emitted = events.emit.mock.calls[0]![0] as { event_name: string; payload: object };
    expect(emitted.event_name).toBe("trade_release.changed");
    expect(emitted.payload).toEqual({
      role_kind: "gear_cutting_operator",
      posting_enabled: true,
      form_enabled: false,
      updated_by_admin_id: ADMIN,
    });
  });

  it("a set that changes nothing writes nothing and emits nothing", async () => {
    const { service, repo, events } = build([row("cnc_turner")]);
    const result = await service.set(
      ADMIN,
      { roleKind: "cnc_turner", postingEnabled: true, formEnabled: false },
      CTX,
    );
    expect(result.changed).toBe(false);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a set clears the cache, so the reader sees the new flags at once", async () => {
    const { service, repo } = build([]);
    expect(await service.isPostingEnabled("gear_cutting_operator")).toBe(false);
    expect(repo.all).toHaveBeenCalledTimes(1);
    await service.set(
      ADMIN,
      { roleKind: "gear_cutting_operator", postingEnabled: true, formEnabled: false },
      CTX,
    );
    expect(await service.isPostingEnabled("gear_cutting_operator")).toBe(true);
    expect(repo.all).toHaveBeenCalledTimes(2);
  });

  it("a missing table is a 503", async () => {
    const { service } = build([]);
    (service as unknown as { repo: { withTransaction: unknown } }).repo = {
      withTransaction: async () => {
        throw { code: "42P01" };
      },
    } as never;
    await expect(
      service.set(ADMIN, { roleKind: "cnc_turner", postingEnabled: true, formEnabled: true }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
