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
import { BadRequestException, RequestMethod } from "@nestjs/common";
import { updateDisplayPrefsSchema } from "@badabhai/validators";

import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { AdminDisplayPrefsController } from "./admin-display-prefs.controller";
import { DisplayPrefsModule } from "./display-prefs.module";
import type { DisplayPrefsService } from "./display-prefs.service";
import { PayerDisplayPrefsController } from "./payer-display-prefs.controller";
import { WorkerDisplayPrefsController } from "./worker-display-prefs.controller";

/**
 * #2819 — the three `me/display-prefs` controllers are HTTP only: the route, the realm's guard and
 * nothing else, `no-store`, the id from the guard's object, the strict body. The behaviour is the
 * service's (`display-prefs.service.test.ts`); the guard sets are also pinned in
 * `common/guard-contract.test.ts`.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ctx = { correlationId: "c-2819", requestId: "r-2819" } as RequestContext;

type Ctor = new (...args: never[]) => object;

const handler = (ctor: Ctor, method: string): object =>
  (ctor.prototype as Record<string, object>)[method]!;
const guardNames = (target: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as { name: string }[]).map((g) => g.name);

const CONTROLLERS = [
  {
    name: "Worker",
    ctor: WorkerDisplayPrefsController,
    path: "workers/me/display-prefs",
    guards: ["WorkerAuthGuard"],
  },
  {
    name: "Payer",
    ctor: PayerDisplayPrefsController,
    path: "payer/me/display-prefs",
    guards: ["PayerAuthGuard"],
  },
  {
    name: "Admin",
    ctor: AdminDisplayPrefsController,
    path: "admin/me/display-prefs",
    guards: ["AdminAuthGuard"],
  },
] as const;

describe.each(CONTROLLERS)(
  "$name display-prefs controller — route posture",
  ({ ctor, path, guards }) => {
    it(`is mounted at ${path}, a path no existing me route can match`, () => {
      expect(Reflect.getMetadata(PATH_METADATA, ctor)).toBe(path);
    });

    it(`carries exactly [${guards.join(", ")}] at class level, and no route adds one`, () => {
      expect(guardNames(ctor)).toEqual([...guards]);
      for (const method of ["get", "update"]) {
        expect(Reflect.getMetadata(GUARDS_METADATA, handler(ctor, method)), method).toBeUndefined();
      }
    });

    it("routes exactly GET and PATCH, both no-store; PATCH answers 200", () => {
      const routed = Object.getOwnPropertyNames(ctor.prototype).filter(
        (m) =>
          m !== "constructor" && Reflect.getMetadata(PATH_METADATA, handler(ctor, m)) !== undefined,
      );
      expect(routed.sort()).toEqual(["get", "update"]);
      expect(Reflect.getMetadata(METHOD_METADATA, handler(ctor, "get"))).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(METHOD_METADATA, handler(ctor, "update"))).toBe(
        RequestMethod.PATCH,
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(ctor, "update"))).toBe(200);
      for (const method of ["get", "update"]) {
        const headers = (Reflect.getMetadata(HEADERS_METADATA, handler(ctor, method)) ?? []) as {
          name: string;
          value: string;
        }[];
        const cacheControl = headers.find((h) => h.name.toLowerCase() === "cache-control");
        expect(cacheControl?.value, method).toBe("no-store");
      }
    });

    it("GET takes ONE argument, the realm's guard decorator; PATCH adds only the body and the context", () => {
      const args = (method: string) =>
        Object.keys(
          (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctor, method) ?? {}) as Record<string, unknown>,
        ).map((key) => key.split(":")[0]!);
      const read = args("get");
      expect(read).toHaveLength(1);
      expect(read[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
      // The SAME custom decorator on the write: the guard's object, never a path or a query.
      expect(args("update")).toContain(read[0]);
      expect(args("update")).toHaveLength(3);
    });
  },
);

describe("the worker route works BEFORE consent: no ConsentGuard anywhere on it", () => {
  it("neither the class nor a route carries ConsentGuard or ConsentNotRevokedGuard", () => {
    const all = [
      ...guardNames(WorkerDisplayPrefsController),
      ...["get", "update"].flatMap((m) => guardNames(handler(WorkerDisplayPrefsController, m))),
    ];
    expect(all).not.toContain("ConsentGuard");
    expect(all).not.toContain("ConsentNotRevokedGuard");
    expect(all).toEqual(["WorkerAuthGuard"]);
  });

  it("the module mounts the three controllers and nothing else", () => {
    expect(Reflect.getMetadata("controllers", DisplayPrefsModule)).toEqual([
      WorkerDisplayPrefsController,
      PayerDisplayPrefsController,
      AdminDisplayPrefsController,
    ]);
  });
});

describe("the id comes from the guard's object ONLY", () => {
  const service = () => {
    const reply = { theme: "dark" as const, theme_open: true };
    return {
      reply,
      svc: {
        readForWorker: vi.fn(async () => reply),
        writeForWorker: vi.fn(async () => reply),
        readForPayer: vi.fn(async () => reply),
        writeForPayer: vi.fn(async () => reply),
        readForAdmin: vi.fn(async () => reply),
        writeForAdmin: vi.fn(async () => reply),
      },
    };
  };

  it("worker: the service gets the token's worker and a caller built from that same worker", async () => {
    const { svc, reply } = service();
    const controller = new WorkerDisplayPrefsController(svc as unknown as DisplayPrefsService);
    const worker: AuthenticatedWorker = { id: ID, sid: "s" };

    expect(await controller.get(worker)).toBe(reply);
    // A body that also named someone else: the pipe refuses it (below); the handler reads `theme`.
    await controller.update(worker, { theme: "dark", worker_id: OTHER } as never, ctx);

    expect(svc.readForWorker).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({ kind: "worker", workerId: ID }),
    );
    expect(svc.writeForWorker).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({ kind: "worker", workerId: ID }),
      "dark",
      ctx,
    );
    expect(JSON.stringify(svc.writeForWorker.mock.calls)).not.toContain(OTHER);
  });

  it("payer: the service gets the token's login (employer or agent alike) and the body's theme only", async () => {
    const { svc } = service();
    const controller = new PayerDisplayPrefsController(svc as unknown as DisplayPrefsService);
    for (const role of ["employer", "agent"] as const) {
      const payer: AuthenticatedPayer = { id: ID, sid: "s", role };
      await controller.get(payer);
      await controller.update(payer, { theme: "system", payer_id: OTHER } as never, ctx);
      expect(svc.readForPayer).toHaveBeenLastCalledWith(payer);
      expect(svc.writeForPayer).toHaveBeenLastCalledWith(payer, "system", ctx);
    }
    expect(JSON.stringify(svc.writeForPayer.mock.calls)).not.toContain(OTHER);
  });

  it("admin: the service gets the token's admin (any role) and a caller built from that same admin", async () => {
    const { svc } = service();
    const controller = new AdminDisplayPrefsController(svc as unknown as DisplayPrefsService);
    for (const role of ["super_admin", "ops_admin", "support", "analyst"] as const) {
      const admin: AuthenticatedAdmin = { id: ID, role, sid: "s" };
      await controller.get(admin);
      await controller.update(admin, { theme: "system", admin_id: OTHER } as never, ctx);
      expect(svc.readForAdmin).toHaveBeenLastCalledWith(
        admin,
        expect.objectContaining({ kind: "admin", adminId: ID }),
      );
      expect(svc.writeForAdmin).toHaveBeenLastCalledWith(
        admin,
        expect.objectContaining({ kind: "admin", adminId: ID }),
        "system",
        ctx,
      );
    }
    expect(JSON.stringify(svc.writeForAdmin.mock.calls)).not.toContain(OTHER);
  });
});

describe("the PATCH body pipe — the strict shared schema", () => {
  const pipe = new ZodValidationPipe(updateDisplayPrefsSchema);

  it.each(["light", "dark", "system"])("passes { theme: %s }", (theme) => {
    expect(pipe.transform({ theme })).toEqual({ theme });
  });

  it.each([
    ["a smuggled worker id", { theme: "dark", worker_id: OTHER }],
    ["a smuggled payer id", { theme: "dark", payer_id: OTHER }],
    ["a smuggled admin id", { theme: "dark", admin_id: OTHER }],
    ["a smuggled subject", { theme: "dark", subject_kind: "admin", subject_id: OTHER }],
    ["an empty body", {}],
    ["an unknown theme", { theme: "ink" }],
    ["a capitalised theme", { theme: "Dark" }],
  ])("refuses %s with a 400", (_name, body) => {
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });
});
