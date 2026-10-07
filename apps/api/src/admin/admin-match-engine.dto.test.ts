import { describe, expect, it } from "vitest";
import {
  ENGINE_RECENT_WORKERS_DEFAULT,
  EnginePostingParamsSchema,
  EngineRecentWorkersQuerySchema,
  EngineWorkerParamsSchema,
} from "./admin-match-engine.dto";

const ID = "5eeded00-0001-4a00-8000-000000000001";

describe("Engine view DTOs", () => {
  it("accept a uuid and reject anything else (neutral 400 before any read)", () => {
    expect(EngineWorkerParamsSchema.parse({ workerId: ID })).toEqual({ workerId: ID });
    expect(EnginePostingParamsSchema.parse({ postingId: ID })).toEqual({ postingId: ID });
    for (const bad of ["", "5eeded00", "1 OR 1=1", `${ID}x`]) {
      expect(EngineWorkerParamsSchema.safeParse({ workerId: bad }).success).toBe(false);
      expect(EnginePostingParamsSchema.safeParse({ postingId: bad }).success).toBe(false);
    }
  });

  it("are strict: no extra params", () => {
    expect(EngineWorkerParamsSchema.safeParse({ workerId: ID, extra: 1 }).success).toBe(false);
    expect(EngineRecentWorkersQuerySchema.safeParse({ recent: "5", name: "x" }).success).toBe(
      false,
    );
  });

  it("bound `recent` to 1..50 with a default of 20", () => {
    expect(EngineRecentWorkersQuerySchema.parse({}).recent).toBe(ENGINE_RECENT_WORKERS_DEFAULT);
    expect(EngineRecentWorkersQuerySchema.parse({ recent: "50" }).recent).toBe(50);
    expect(EngineRecentWorkersQuerySchema.safeParse({ recent: "51" }).success).toBe(false);
    expect(EngineRecentWorkersQuerySchema.safeParse({ recent: "0" }).success).toBe(false);
    expect(EngineRecentWorkersQuerySchema.safeParse({ recent: "2.5" }).success).toBe(false);
  });
});
