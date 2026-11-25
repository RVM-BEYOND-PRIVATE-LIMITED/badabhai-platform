import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { AppReleasePolicyRow, Database } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { AppReleasePolicyWrite, AppVersionRepository } from "./app-version.repository";
import { AppVersionService } from "./app-version.service";

/**
 * #3048 — the minimum supported app build, without a database: the guard's read (fail open, 0
 * blocks nobody), the 30-second cache, the admin list, and what a set writes and emits. The HTTP
 * contract is `app-version.contract.test.ts`.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CTX: RequestContext = { correlationId: "c", requestId: "r" } as RequestContext;
const AT = new Date("2026-11-25T10:00:00.000Z");

const row = (app: string, platform: string, over: Partial<AppReleasePolicyRow> = {}) =>
  ({
    app,
    platform,
    minSupportedBuild: 0,
    latestBuild: 0,
    storeUrl: null,
    messageKey: "update_default",
    updatedBy: null,
    updatedAt: AT,
    ...over,
  }) satisfies AppReleasePolicyRow;

const SEED = [
  row("worker", "android"),
  row("worker", "ios"),
  row("payer", "android"),
  row("payer", "ios"),
];

function build(start: AppReleasePolicyRow[] = SEED) {
  let rows = [...start];
  const repo = {
    withTransaction: vi.fn(async (work: (t: Database) => Promise<unknown>) => work({} as Database)),
    all: vi.fn(async () => rows),
    findForUpdate: vi.fn(
      async (_tx: Database, app: string, platform: string) =>
        rows.find((r) => r.app === app && r.platform === platform) ?? null,
    ),
    update: vi.fn(
      async (
        _tx: Database,
        app: string,
        platform: string,
        input: AppReleasePolicyWrite & { updatedBy: string },
      ) => {
        const next = row(app, platform, input);
        rows = rows.map((r) => (r.app === app && r.platform === platform ? next : r));
        return next;
      },
    ),
  };
  const events = { emit: vi.fn(async (_input: unknown) => undefined) };
  const service = new AppVersionService(
    repo as unknown as AppVersionRepository,
    events as unknown as EventsService,
  );
  return { service, repo, events };
}

const RAISE: AppReleasePolicyWrite = {
  minSupportedBuild: 42,
  latestBuild: 45,
  storeUrl: "https://play.google.com/store/apps/details?id=in.badabhai.worker",
  messageKey: "update_default",
};

describe("blockingConfigFor — the guard's read", () => {
  it("the seed (minimum 0) blocks nobody", async () => {
    const { service } = build();
    expect(await service.blockingConfigFor("worker", "android")).toBeNull();
  });

  it("a missing row blocks nobody", async () => {
    const { service } = build([]);
    expect(await service.blockingConfigFor("payer", "ios")).toBeNull();
  });

  it("a raised minimum answers the public view for that app and platform only", async () => {
    const { service } = build([
      ...SEED.slice(1),
      row("worker", "android", { minSupportedBuild: 9, latestBuild: 9 }),
    ]);
    expect(await service.blockingConfigFor("worker", "android")).toEqual({
      app: "worker",
      platform: "android",
      min_supported_build: 9,
      latest_build: 9,
      store_url: null,
      message_key: "update_default",
    });
    expect(await service.blockingConfigFor("worker", "ios")).toBeNull();
  });

  it("fails OPEN: a read error answers no minimum", async () => {
    const { service, repo } = build([
      row("worker", "android", { minSupportedBuild: 9, latestBuild: 9 }),
    ]);
    repo.all.mockRejectedValueOnce(new Error("connection reset"));
    expect(await service.blockingConfigFor("worker", "android")).toBeNull();
  });

  it("caches the table for 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const { service, repo } = build();
      await service.blockingConfigFor("worker", "android");
      await service.getConfig("payer", "ios");
      expect(repo.all).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await service.blockingConfigFor("worker", "android");
      expect(repo.all).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getConfig — the public read", () => {
  it("a read error is a 503 (the apps let the user in)", async () => {
    const { service, repo } = build();
    repo.all.mockRejectedValueOnce(new Error("connection reset"));
    await expect(service.getConfig("worker", "android")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe("getAll — the admin list", () => {
  it("names all four app and platform rows, in a fixed order", async () => {
    const { service } = build([
      row("payer", "ios", { updatedBy: ADMIN, minSupportedBuild: 3, latestBuild: 3 }),
    ]);
    const { policies } = await service.getAll();
    expect(policies.map((p) => `${p.app}/${p.platform}`)).toEqual([
      "worker/android",
      "worker/ios",
      "payer/android",
      "payer/ios",
    ]);
    expect(policies[3]).toMatchObject({ min_supported_build: 3, updated_by: ADMIN });
    expect(policies[0]).toMatchObject({
      min_supported_build: 0,
      updated_by: null,
      updated_at: null,
    });
  });
});

describe("set — one app and platform, audited by the event", () => {
  it("writes the row and emits app_version.policy_changed with the old and new builds", async () => {
    const { service, repo, events } = build();
    const result = await service.set(ADMIN, "worker", "android", RAISE, CTX);
    expect(result.changed).toBe(true);
    expect(result.policy).toMatchObject({
      app: "worker",
      platform: "android",
      min_supported_build: 42,
      latest_build: 45,
      updated_by: ADMIN,
    });
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
    const emitted = events.emit.mock.calls[0]![0] as {
      event_name: string;
      payload: object;
      actor: object;
      tx: unknown;
    };
    expect(emitted.event_name).toBe("app_version.policy_changed");
    expect(emitted.actor).toEqual({ actor_type: "admin", actor_id: ADMIN });
    expect(emitted.tx).toBeDefined();
    expect(emitted.payload).toEqual({
      app: "worker",
      platform: "android",
      old_min_supported_build: 0,
      new_min_supported_build: 42,
      old_latest_build: 0,
      new_latest_build: 45,
      store_url: RAISE.storeUrl,
      message_key: "update_default",
      updated_by_admin_id: ADMIN,
    });
  });

  it("a set that changes nothing writes nothing and emits nothing", async () => {
    const { service, repo, events } = build();
    const result = await service.set(
      ADMIN,
      "payer",
      "ios",
      { minSupportedBuild: 0, latestBuild: 0, storeUrl: null, messageKey: "update_default" },
      CTX,
    );
    expect(result.changed).toBe(false);
    expect(repo.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a set clears the cache, so the guard sees the new minimum at once", async () => {
    const { service, repo } = build();
    expect(await service.blockingConfigFor("worker", "android")).toBeNull();
    await service.set(ADMIN, "worker", "android", RAISE, CTX);
    expect(await service.blockingConfigFor("worker", "android")).toMatchObject({
      min_supported_build: 42,
    });
    expect(repo.all).toHaveBeenCalledTimes(2);
  });

  it("a missing seed row is a 404; a missing table is a 503", async () => {
    const { service } = build([]);
    await expect(service.set(ADMIN, "worker", "android", RAISE, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    (service as unknown as { repo: { withTransaction: unknown } }).repo = {
      withTransaction: async () => {
        throw { code: "42P01" };
      },
    } as never;
    await expect(service.set(ADMIN, "worker", "android", RAISE, CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
