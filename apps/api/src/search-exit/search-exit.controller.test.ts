import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { BadRequestException, NotFoundException, RequestMethod } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { AppModule } from "../app.module";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { AuthModule } from "../auth/auth.module";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestContext } from "../common/request-context";
import { SetSearchVisibilitySchema } from "./search-exit.dto";
import { SearchExitEnabledGuard } from "./search-exit-enabled.guard";
import { SearchExitController } from "./search-exit.controller";
import { SearchExitModule } from "./search-exit.module";
import { SearchExitRepository } from "./search-exit.repository";
import { SearchExitService } from "./search-exit.service";

/**
 * #2753 item 6 — `workers/me/search-visibility` is HTTP only: the route, the switch's 404 FIRST,
 * then the worker guards, `no-store`, the id from the guard's object, the strict body. The behaviour
 * is the service's (`search-exit.service.test.ts`); the guard set is also pinned in
 * `common/guard-contract.test.ts`.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ctx = { correlationId: "c-2753", requestId: "r-2753" } as RequestContext;

const handler = (method: string): object =>
  (SearchExitController.prototype as unknown as Record<string, object>)[method]!;
const guardNames = (target: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as { name: string }[]).map((g) => g.name);

describe("search-visibility controller — route posture", () => {
  it("is mounted at workers/me/search-visibility", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SearchExitController)).toBe(
      "workers/me/search-visibility",
    );
  });

  it("runs [SearchExitEnabled, WorkerAuth, Consent] IN THAT ORDER at class level, and no route adds one", () => {
    expect(guardNames(SearchExitController)).toEqual([
      "SearchExitEnabledGuard",
      "WorkerAuthGuard",
      "ConsentGuard",
    ]);
    for (const method of ["get", "set"]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(method)), method).toBeUndefined();
    }
  });

  it("routes exactly GET and PUT, both no-store; PUT answers 200", () => {
    const routed = Object.getOwnPropertyNames(SearchExitController.prototype).filter(
      (m) => m !== "constructor" && Reflect.getMetadata(PATH_METADATA, handler(m)) !== undefined,
    );
    expect(routed.sort()).toEqual(["get", "set"]);
    expect(Reflect.getMetadata(METHOD_METADATA, handler("get"))).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, handler("set"))).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler("set"))).toBe(200);
    for (const method of ["get", "set"]) {
      const headers = (Reflect.getMetadata(HEADERS_METADATA, handler(method)) ?? []) as {
        name: string;
        value: string;
      }[];
      const cacheControl = headers.find((h) => h.name.toLowerCase() === "cache-control");
      expect(cacheControl?.value, method).toBe("no-store");
    }
  });

  it("GET takes ONE argument, the guard's worker; PUT adds only the body and the context", () => {
    const args = (method: string) =>
      Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, SearchExitController, method) ?? {}) as Record<
          string,
          unknown
        >,
      ).map((key) => key.split(":")[0]!);
    const read = args("get");
    expect(read).toHaveLength(1);
    expect(read[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
    expect(args("set")).toContain(read[0]);
    expect(args("set")).toHaveLength(3);
  });
});

describe("the switch's guard — off is the 404 of a route that does not exist", () => {
  const http = (method: string, url: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url }) }),
    }) as unknown as ExecutionContext;

  it.each([
    [undefined, "absent"],
    [false, "false"],
  ])("SEARCH_EXIT_ENABLED %s (%s) → Nest's own unmatched-route 404 body", (value, _label) => {
    const guard = new SearchExitEnabledGuard({ SEARCH_EXIT_ENABLED: value } as ServerConfig);
    for (const [method, url] of [
      ["GET", "/workers/me/search-visibility"],
      ["PUT", "/workers/me/search-visibility"],
    ] as const) {
      let thrown: unknown;
      try {
        guard.canActivate(http(method, url));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundException);
      // Byte for byte what Nest's router answers for a path nobody mounted.
      expect((thrown as NotFoundException).getResponse()).toEqual({
        message: `Cannot ${method} ${url}`,
        error: "Not Found",
        statusCode: 404,
      });
    }
  });

  it("on → passes, and the worker guards behind it decide", () => {
    const guard = new SearchExitEnabledGuard({ SEARCH_EXIT_ENABLED: true } as ServerConfig);
    expect(guard.canActivate(http("GET", "/workers/me/search-visibility"))).toBe(true);
  });
});

describe("the id comes from the guard's object ONLY, and the via is the route's", () => {
  function controller() {
    const reply = { visible: false, hidden_since: "2026-11-16T10:00:00.000Z" };
    const svc = {
      visibilityFor: vi.fn(async () => reply),
      setVisibility: vi.fn(async () => reply),
    };
    return { reply, svc, c: new SearchExitController(svc as unknown as SearchExitService) };
  }

  it("GET reads the token's worker", async () => {
    const { svc, c, reply } = controller();
    const worker: AuthenticatedWorker = { id: ID, sid: "s" };
    expect(await c.get(worker)).toBe(reply);
    expect(svc.visibilityFor).toHaveBeenCalledWith(ID);
  });

  it("PUT writes the token's worker, the body's `visible` and via `worker` — never a body id", async () => {
    const { svc, c } = controller();
    const worker: AuthenticatedWorker = { id: ID, sid: "s" };
    await c.set(worker, { visible: false, worker_id: OTHER, via: "monthly_check" } as never, ctx);
    await c.set(worker, { visible: true }, ctx);
    expect(svc.setVisibility.mock.calls).toEqual([
      [ID, false, "worker", ctx],
      [ID, true, "worker", ctx],
    ]);
    expect(JSON.stringify(svc.setVisibility.mock.calls)).not.toContain(OTHER);
  });
});

describe("the PUT body pipe — strict `{ visible: boolean }`", () => {
  const pipe = new ZodValidationPipe(SetSearchVisibilitySchema);

  it.each([true, false])("passes { visible: %s }", (visible) => {
    expect(pipe.transform({ visible })).toEqual({ visible });
  });

  it.each([
    ["a smuggled worker id", { visible: false, worker_id: OTHER }],
    ["a smuggled via", { visible: false, via: "monthly_check" }],
    ["a smuggled consent purpose", { visible: false, purposes: ["employer_sharing"] }],
    ["an empty body", {}],
    ["a string", { visible: "false" }],
    ["a number", { visible: 0 }],
    ["null", { visible: null }],
  ])("refuses %s with a 400", (_name, body) => {
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });
});

describe("the module — a leaf the app mounts", () => {
  const meta = (key: string, target: object): unknown[] =>
    (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

  it("is mounted by the app and mounts the one controller", () => {
    expect(meta("imports", AppModule)).toContain(SearchExitModule);
    expect(meta("controllers", SearchExitModule)).toEqual([SearchExitController]);
  });

  it("provides its service and repository, and imports AuthModule for the worker guards", () => {
    expect(meta("providers", SearchExitModule)).toEqual(
      expect.arrayContaining([SearchExitService, SearchExitRepository]),
    );
    expect(meta("imports", SearchExitModule)).toEqual([AuthModule]);
  });
});
