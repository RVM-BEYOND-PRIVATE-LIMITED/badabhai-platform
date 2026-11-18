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
import { AuthModule } from "../auth/auth.module";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestContext } from "../common/request-context";
import { PushQueueModule } from "../push/push-queue.module";
import { SearchExitModule } from "../search-exit/search-exit.module";
import { WorkerActivityModule } from "../worker-activity/worker-activity.module";
import { AnswerStillLookingSchema } from "./still-looking.dto";
import { StillLookingController } from "./still-looking.controller";
import {
  StillLookingEnabledGuard,
  stillLookingCheckEnabled,
  stillLookingEveryDays,
  stillLookingPushEnabled,
} from "./still-looking.flag";
import { StillLookingModule } from "./still-looking.module";
import { StillLookingRepository } from "./still-looking.repository";
import { StillLookingService } from "./still-looking.service";
import { StillLookingSweepProcessor } from "./still-looking.sweep.processor";

/**
 * #2753 item 5 — `workers/me/still-looking` is HTTP only: the route, the switch's 404 FIRST, then
 * the worker guards, `no-store`, the id from the guard's object, the strict body. The behaviour is
 * the service's (`still-looking.service.test.ts`); the guard set is also pinned in
 * `common/guard-contract.test.ts`.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ctx = { correlationId: "c-2753-5", requestId: "r-2753-5" } as RequestContext;

const handler = (method: string): object =>
  (StillLookingController.prototype as unknown as Record<string, object>)[method]!;
const guardNames = (target: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as { name: string }[]).map((g) => g.name);

describe("still-looking controller — route posture", () => {
  it("is mounted at workers/me/still-looking", () => {
    expect(Reflect.getMetadata(PATH_METADATA, StillLookingController)).toBe(
      "workers/me/still-looking",
    );
  });

  it("runs [StillLookingEnabled, WorkerAuth, Consent] IN THAT ORDER at class level, and no route adds one", () => {
    expect(guardNames(StillLookingController)).toEqual([
      "StillLookingEnabledGuard",
      "WorkerAuthGuard",
      "ConsentGuard",
    ]);
    for (const method of ["get", "answer"]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(method)), method).toBeUndefined();
    }
  });

  it("routes exactly GET and POST, both no-store; POST answers 200", () => {
    const routed = Object.getOwnPropertyNames(StillLookingController.prototype).filter(
      (m) => m !== "constructor" && Reflect.getMetadata(PATH_METADATA, handler(m)) !== undefined,
    );
    expect(routed.sort()).toEqual(["answer", "get"]);
    expect(Reflect.getMetadata(METHOD_METADATA, handler("get"))).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, handler("answer"))).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler("answer"))).toBe(200);
    for (const method of ["get", "answer"]) {
      const headers = (Reflect.getMetadata(HEADERS_METADATA, handler(method)) ?? []) as {
        name: string;
        value: string;
      }[];
      const cacheControl = headers.find((h) => h.name.toLowerCase() === "cache-control");
      expect(cacheControl?.value, method).toBe("no-store");
    }
  });

  it("GET takes ONE argument, the guard's worker; POST adds only the body and the context", () => {
    const args = (method: string) =>
      Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, StillLookingController, method) ?? {}) as Record<
          string,
          unknown
        >,
      ).map((key) => key.split(":")[0]!);
    const read = args("get");
    expect(read).toHaveLength(1);
    expect(read[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
    expect(args("answer")).toContain(read[0]);
    expect(args("answer")).toHaveLength(3);
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
  ])(
    "STILL_LOOKING_CHECK_ENABLED %s (%s) → Nest's own unmatched-route 404 body",
    (value, _label) => {
      const guard = new StillLookingEnabledGuard({
        STILL_LOOKING_CHECK_ENABLED: value,
      } as ServerConfig);
      for (const [method, url] of [
        ["GET", "/workers/me/still-looking"],
        ["POST", "/workers/me/still-looking"],
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
    },
  );

  it("the push switch alone does not open the routes", () => {
    const guard = new StillLookingEnabledGuard({
      STILL_LOOKING_CHECK_ENABLED: false,
      STILL_LOOKING_PUSH_ENABLED: true,
    } as ServerConfig);
    expect(() => guard.canActivate(http("GET", "/workers/me/still-looking"))).toThrow(
      NotFoundException,
    );
  });

  it("on → passes, and the worker guards behind it decide", () => {
    const guard = new StillLookingEnabledGuard({
      STILL_LOOKING_CHECK_ENABLED: true,
    } as ServerConfig);
    expect(guard.canActivate(http("POST", "/workers/me/still-looking"))).toBe(true);
  });
});

describe("the readers — only `true` turns anything on", () => {
  it("the check", () => {
    expect(stillLookingCheckEnabled(undefined)).toBe(false);
    expect(stillLookingCheckEnabled({ STILL_LOOKING_CHECK_ENABLED: false })).toBe(false);
    expect(stillLookingCheckEnabled({ STILL_LOOKING_CHECK_ENABLED: "true" } as never)).toBe(false);
    expect(stillLookingCheckEnabled({ STILL_LOOKING_CHECK_ENABLED: true })).toBe(true);
  });

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("the push: check %s, push %s → %s (both, always)", (check, push, expected) => {
    expect(
      stillLookingPushEnabled({
        STILL_LOOKING_CHECK_ENABLED: check,
        STILL_LOOKING_PUSH_ENABLED: push,
      }),
    ).toBe(expected);
  });

  it("the window: the setting when valid, else the owner's 30", () => {
    expect(stillLookingEveryDays(undefined)).toBe(30);
    expect(stillLookingEveryDays({ STILL_LOOKING_EVERY_DAYS: 45 })).toBe(45);
    expect(stillLookingEveryDays({ STILL_LOOKING_EVERY_DAYS: 7 })).toBe(7);
    expect(stillLookingEveryDays({ STILL_LOOKING_EVERY_DAYS: 3 })).toBe(30);
    expect(stillLookingEveryDays({ STILL_LOOKING_EVERY_DAYS: 7.5 })).toBe(30);
  });
});

describe("the id comes from the guard's object ONLY", () => {
  function controller() {
    const reply = {
      due: false,
      check_id: null,
      availability_needs_answer: false,
      last_active_on: null,
      not_recently_active: false,
    };
    const svc = {
      status: vi.fn(async () => reply),
      answer: vi.fn(async () => reply),
    };
    return { reply, svc, c: new StillLookingController(svc as unknown as StillLookingService) };
  }

  it("GET reads the token's worker", async () => {
    const { svc, c, reply } = controller();
    const worker: AuthenticatedWorker = { id: ID, sid: "s" };
    expect(await c.get(worker)).toBe(reply);
    expect(svc.status).toHaveBeenCalledWith(ID);
  });

  it("POST writes the token's worker and the body's answer — never a body id", async () => {
    const { svc, c } = controller();
    const worker: AuthenticatedWorker = { id: ID, sid: "s" };
    await c.answer(worker, { answer: "not_now", worker_id: OTHER } as never, ctx);
    await c.answer(worker, { answer: "yes" }, ctx);
    expect(svc.answer.mock.calls).toEqual([
      [ID, "not_now", ctx],
      [ID, "yes", ctx],
    ]);
    expect(JSON.stringify(svc.answer.mock.calls)).not.toContain(OTHER);
  });
});

describe("the POST body pipe — strict `{ answer: 'yes' | 'not_now' | 'hired' }`", () => {
  const pipe = new ZodValidationPipe(AnswerStillLookingSchema);

  it.each(["yes", "not_now", "hired"])("passes { answer: %s }", (answer) => {
    expect(pipe.transform({ answer })).toEqual({ answer });
  });

  it.each([
    ["a smuggled worker id", { answer: "yes", worker_id: OTHER }],
    ["a smuggled check id", { answer: "yes", check_id: OTHER }],
    ["a smuggled posting", { answer: "hired", posting_id: OTHER }],
    ["an answer outside the set", { answer: "no" }],
    ["a different case", { answer: "Yes" }],
    ["a spaced answer", { answer: "not now" }],
    ["an empty body", {}],
    ["null", { answer: null }],
  ])("refuses %s with a 400", (_name, body) => {
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });
});

describe("the module — a leaf the app mounts", () => {
  const meta = (key: string, target: object): unknown[] =>
    (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

  it("is mounted by the app and mounts the one controller", () => {
    expect(meta("imports", AppModule)).toContain(StillLookingModule);
    expect(meta("controllers", StillLookingModule)).toEqual([StillLookingController]);
  });

  it("provides its service, repository and sweep, and imports exactly what it calls", () => {
    expect(meta("providers", StillLookingModule)).toEqual([
      StillLookingRepository,
      StillLookingService,
      StillLookingSweepProcessor,
    ]);
    const imports = meta("imports", StillLookingModule);
    for (const mod of [AuthModule, SearchExitModule, WorkerActivityModule, PushQueueModule]) {
      expect(imports).toContain(mod);
    }
    // Plus the sweep's own queue registration; nothing else (no HiresModule: see the service).
    expect(imports).toHaveLength(5);
  });
});
