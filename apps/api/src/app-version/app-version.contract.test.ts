import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Controller,
  Delete,
  Get,
  Module,
  Patch,
  Post,
  Put,
  type INestApplication,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import type { AppReleasePolicyRow } from "@badabhai/db";

import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { EventsService } from "../events/events.service";
import { AppConfigController } from "./app-config.controller";
import { AppVersionRepository } from "./app-version.repository";
import { AppVersionService } from "./app-version.service";
import { MinAppBuildGuard } from "./min-app-build.guard";
import { AppVersionModule } from "./app-version.module";

/**
 * #3048 — the CONTRACT the apps build against (#3049), over real HTTP: the real global guard
 * (registered under `APP_GUARD`, as `AppVersionModule` does), the real public controller, the
 * real service and the production exception filter. Only the table is faked.
 *
 * Done-when, from the issue:
 *   - with minimum 0 nothing changes for any client;
 *   - with a minimum above a test build, a write from that build gets 426 and a read still works.
 */

@Controller("probe")
class ProbeController {
  @Get() read(): { ok: true } {
    return { ok: true };
  }
  @Post() create(): { ok: true } {
    return { ok: true };
  }
  @Put() replace(): { ok: true } {
    return { ok: true };
  }
  @Patch() change(): { ok: true } {
    return { ok: true };
  }
  @Delete() remove(): { ok: true } {
    return { ok: true };
  }
}

const AT = new Date("2026-11-25T10:00:00.000Z");
function seedRows(): AppReleasePolicyRow[] {
  const rows: AppReleasePolicyRow[] = [];
  for (const app of ["worker", "payer"]) {
    for (const platform of ["android", "ios"]) {
      rows.push({
        app,
        platform,
        minSupportedBuild: 0,
        latestBuild: 0,
        storeUrl: null,
        messageKey: "update_default",
        updatedBy: null,
        updatedAt: AT,
      });
    }
  }
  return rows;
}

let rows: AppReleasePolicyRow[] = seedRows();
let readFails = false;
const repo = {
  all: async (): Promise<AppReleasePolicyRow[]> => {
    if (readFails) throw Object.assign(new Error("connection reset"), { code: "08006" });
    return rows;
  },
};
const events = { emit: async (): Promise<void> => undefined };

@Module({
  controllers: [AppConfigController, ProbeController],
  providers: [
    { provide: AppVersionRepository, useValue: repo },
    { provide: EventsService, useValue: events },
    AppVersionService,
    { provide: APP_GUARD, useClass: MinAppBuildGuard },
  ],
})
class HarnessModule {}

let app: INestApplication;
let base: string;
let service: AppVersionService;

beforeAll(async () => {
  app = await NestFactory.create(HarnessModule, { logger: false });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  service = app.get(AppVersionService);
});

afterAll(async () => {
  await app.close();
});

/** Set a row's numbers and drop the service's 30-second cache (a real admin set clears it too). */
function setPolicy(appName: string, platform: string, over: Partial<AppReleasePolicyRow>): void {
  rows = rows.map((r) => (r.app === appName && r.platform === platform ? { ...r, ...over } : r));
  (service as unknown as { cachedRows: unknown; cachedAt: unknown }).cachedRows = null;
  (service as unknown as { cachedRows: unknown; cachedAt: unknown }).cachedAt = null;
}

beforeEach(() => {
  rows = seedRows();
  readFails = false;
  setPolicy("worker", "android", {});
});

const worker = (build: string, platform = "android"): Record<string, string> => ({
  "x-app-name": "worker",
  "x-app-platform": platform,
  "x-app-build-number": build,
});

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null }> {
  const res = await fetch(`${base}${path}`, { method, headers });
  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    cacheControl: res.headers.get("cache-control"),
  };
}

describe("the module registers the guard globally", () => {
  it("AppVersionModule provides MinAppBuildGuard under APP_GUARD and the public controller", () => {
    const providers = Reflect.getMetadata("providers", AppVersionModule) as unknown[];
    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: MinAppBuildGuard });
    expect(Reflect.getMetadata("controllers", AppVersionModule)).toEqual([AppConfigController]);
  });
});

describe("GET /app-config — the apps' start-up check", () => {
  it("answers the seed for each app and platform: minimum 0, nothing set", async () => {
    for (const a of ["worker", "payer"]) {
      for (const p of ["android", "ios"]) {
        const res = await call("GET", `/app-config?app=${a}&platform=${p}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          app: a,
          platform: p,
          min_supported_build: 0,
          latest_build: 0,
          store_url: null,
          message_key: "update_default",
        });
      }
    }
  });

  it("is cacheable for five minutes", async () => {
    const res = await call("GET", "/app-config?app=worker&platform=android");
    expect(res.cacheControl).toBe("public, max-age=300");
  });

  it("answers the owner's numbers once set", async () => {
    setPolicy("payer", "ios", {
      minSupportedBuild: 7,
      latestBuild: 9,
      storeUrl: "https://apps.apple.com/app/id1",
    });
    const res = await call("GET", "/app-config?app=payer&platform=ios");
    expect(res.body).toMatchObject({ min_supported_build: 7, latest_build: 9 });
    expect(res.body.store_url).toBe("https://apps.apple.com/app/id1");
  });

  it("refuses a missing or unknown app or platform with 400; an extra parameter is ignored", async () => {
    for (const q of [
      "",
      "?app=worker",
      "?platform=ios",
      "?app=admin&platform=ios",
      "?app=worker&platform=web",
    ]) {
      expect((await call("GET", `/app-config${q}`)).status, q).toBe(400);
    }
    expect((await call("GET", "/app-config?app=worker&platform=ios&_=123")).status).toBe(200);
  });

  it("answers 503 when the policy cannot be read (the apps then let the user in)", async () => {
    readFails = true;
    const res = await call("GET", "/app-config?app=worker&platform=android");
    expect(res.status).toBe(503);
  });
});

describe("with every minimum at 0 (the seed) nothing changes for any client", () => {
  it("every method answers with and without the app headers", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect((await call(method, "/probe")).status, method).toBeLessThan(300);
      expect((await call(method, "/probe", worker("1"))).status, method).toBeLessThan(300);
      expect((await call(method, "/probe", worker("0"))).status, method).toBeLessThan(300);
    }
  });
});

describe("with a minimum above a test build", () => {
  beforeEach(() => {
    setPolicy("worker", "android", {
      minSupportedBuild: 50,
      latestBuild: 52,
      storeUrl: "https://play.google.com/store/apps/details?id=in.badabhai.worker",
    });
  });

  it("a write from that build gets 426 with the same config GET /app-config answers", async () => {
    const config = (await call("GET", "/app-config?app=worker&platform=android")).body;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(method, "/probe", worker("49"));
      expect(res.status, method).toBe(426);
      expect(res.body.statusCode).toBe(426);
      expect(res.body.error).toEqual({
        code: "APP_UPDATE_REQUIRED",
        message: "This app version is no longer supported. Update the app to continue.",
        config,
      });
      expect(res.body.path).toBe("/probe");
    }
    expect(config).toEqual({
      app: "worker",
      platform: "android",
      min_supported_build: 50,
      latest_build: 52,
      store_url: "https://play.google.com/store/apps/details?id=in.badabhai.worker",
      message_key: "update_default",
    });
  });

  it("a read from that build still works", async () => {
    expect((await call("GET", "/probe", worker("49"))).status).toBe(200);
    expect((await call("HEAD", "/probe", worker("49"))).status).toBe(200);
    expect(
      (await call("GET", "/app-config?app=worker&platform=android", worker("49"))).status,
    ).toBe(200);
  });

  it("a write from the minimum build or above passes", async () => {
    expect((await call("POST", "/probe", worker("50"))).status).toBe(201);
    expect((await call("POST", "/probe", worker("51"))).status).toBe(201);
  });

  it("the minimum is per app and per platform", async () => {
    expect((await call("POST", "/probe", worker("49", "ios"))).status).toBe(201);
    expect(
      (
        await call("POST", "/probe", {
          "x-app-name": "payer",
          "x-app-platform": "android",
          "x-app-build-number": "49",
        })
      ).status,
    ).toBe(201);
  });

  it("header values are read case- and space-insensitively", async () => {
    const res = await call("POST", "/probe", {
      "x-app-name": " Worker ",
      "x-app-platform": "ANDROID",
      "x-app-build-number": " 49 ",
    });
    expect(res.status).toBe(426);
  });

  it("a request that does not name a build is never blocked (web apps, apps installed today)", async () => {
    const cases: Record<string, string>[] = [
      {},
      // The worker app installed today sends only its commit stamp.
      { "x-app-build": "c25eb72" },
      { "x-app-name": "worker", "x-app-platform": "android" },
      { "x-app-platform": "android", "x-app-build-number": "1" },
      { "x-app-name": "worker", "x-app-build-number": "1" },
      { ...worker("abc") },
      { ...worker("-1") },
      { ...worker("1.5") },
      { ...worker("99999999999") },
      { "x-app-name": "agent", "x-app-platform": "android", "x-app-build-number": "1" },
      { "x-app-name": "worker", "x-app-platform": "web", "x-app-build-number": "1" },
    ];
    for (const headers of cases) {
      expect((await call("POST", "/probe", headers)).status, JSON.stringify(headers)).toBe(201);
    }
  });

  it("fails OPEN: an unreadable policy never blocks a write", async () => {
    readFails = true;
    expect((await call("POST", "/probe", worker("1"))).status).toBe(201);
  });
});
