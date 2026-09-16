import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";

import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { WorkerEmploymentController } from "./worker-employment.controller";
import type { WorkerEmploymentService } from "./worker-employment.service";
import { WorkerPreferencesController } from "./worker-preferences.controller";
import type { WorkerPreferencesService } from "./worker-preferences.service";
import { WorkerQualificationsController } from "./worker-qualifications.controller";
import type { WorkerQualificationsService } from "./worker-qualifications.service";

/**
 * THE THREE WORKER SELF-READS (#1504), asserted on route metadata.
 *
 * Guards are pinned in `guard-contract.test.ts`. What is pinned HERE is the rest of the posture that
 * makes returning a worker's own answers — one of them a decrypted employer name — acceptable:
 *
 *   `no-store`       so no cache between the server and the phone keeps the response;
 *   `@CurrentWorker` ONLY, and nothing else, so there is no parameter through which a caller could
 *                    name somebody else — no `:workerId`, no query, no body.
 */

type Ctor = { prototype: object };
const READS: { name: string; ctor: Ctor; method: string; path: string; writer: string }[] = [
  {
    name: "WorkerPreferences",
    ctor: WorkerPreferencesController,
    method: "getMyPreferences",
    path: "me/work-preferences",
    writer: "setMyPreferences",
  },
  {
    name: "WorkerEmployment",
    ctor: WorkerEmploymentController,
    method: "getMyEmployment",
    path: "me/employment",
    writer: "setMyEmployment",
  },
  {
    name: "WorkerQualifications",
    ctor: WorkerQualificationsController,
    method: "getMyQualifications",
    path: "me/qualifications",
    writer: "setMyQualifications",
  },
];

const handler = (ctor: Ctor, method: string) => (ctor.prototype as Record<string, object>)[method]!;

/** The `createParamDecorator` identity of each argument — the part of the key before `:index`. */
const argDecorators = (ctor: Ctor, method: string): string[] =>
  Object.keys(
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctor, method) ?? {}) as Record<string, unknown>,
  ).map((key) => key.split(":")[0]!);

describe("worker self-reads — route posture (#1504)", () => {
  for (const { name, ctor, method, path, writer } of READS) {
    describe(`${name}Controller.${method}`, () => {
      it(`is GET ${path}`, () => {
        expect(Reflect.getMetadata(METHOD_METADATA, handler(ctor, method))).toBe(RequestMethod.GET);
        expect(Reflect.getMetadata(PATH_METADATA, handler(ctor, method))).toBe(path);
      });

      it("sets Cache-Control: no-store", () => {
        const headers = (Reflect.getMetadata(HEADERS_METADATA, handler(ctor, method)) ?? []) as {
          name: string;
          value: string;
        }[];
        const cacheControl = headers.find((h) => h.name.toLowerCase() === "cache-control");
        expect(cacheControl?.value).toBe("no-store");
      });

      it("takes ONE argument, and it is the session's @CurrentWorker", () => {
        const args = argDecorators(ctor, method);
        expect(args).toHaveLength(1);
        expect(args[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
        // The same custom decorator the sibling WRITE uses for the session worker — so it is
        // @CurrentWorker, not some other custom parameter that happens to be alone.
        expect(argDecorators(ctor, writer)).toContain(args[0]);
      });
    });
  }
});

describe("worker self-reads — the controller passes the SESSION id and returns the service result", () => {
  const WORKER: AuthenticatedWorker = { id: "w-1", sid: "s-1" };

  it("preferences", async () => {
    const svc = {
      getForWorker: vi.fn(async () => ({ values: {}, partial: [], dropped_count: 0 })),
    };
    const res = await new WorkerPreferencesController(
      svc as unknown as WorkerPreferencesService,
    ).getMyPreferences(WORKER);
    expect(svc.getForWorker).toHaveBeenCalledWith("w-1");
    expect(res).toEqual({ values: {}, partial: [], dropped_count: 0 });
  });

  it("employment", async () => {
    const svc = { getForWorker: vi.fn(async () => ({ employments: [], unreadable_count: 0 })) };
    await new WorkerEmploymentController(svc as unknown as WorkerEmploymentService).getMyEmployment(
      WORKER,
    );
    expect(svc.getForWorker).toHaveBeenCalledWith("w-1");
  });

  it("qualifications", async () => {
    const svc = {
      getForWorker: vi.fn(async () => ({
        certificates: [],
        educations: [],
        partial: [],
        dropped_count: 0,
      })),
    };
    await new WorkerQualificationsController(
      svc as unknown as WorkerQualificationsService,
    ).getMyQualifications(WORKER);
    expect(svc.getForWorker).toHaveBeenCalledWith("w-1");
  });
});
