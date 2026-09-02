import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { FIXTURE_CATALOG, type CatalogIssue } from "@badabhai/matching-catalog";
import { MatchingCatalogService } from "./matching-catalog.service";
import type { MatchingCatalogRepository } from "./matching-catalog.repository";
import { MatchingCatalogController } from "./matching-catalog.controller";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";

const PUBLISHER = "3f1b7a2c-0d4e-4f8a-9b6c-2e5d8a1c7b40";
const clone = () => structuredClone(FIXTURE_CATALOG) as Record<string, unknown>;

function make(overrides: Partial<MatchingCatalogRepository> = {}) {
  const repo = {
    getActive: vi.fn(async () => null),
    getByRevision: vi.fn(async () => null),
    publish: vi.fn(async () => ({
      id: "row-1",
      catalog: {},
      revision: 4,
      isActive: true,
      updatedBy: PUBLISHER,
      createdAt: new Date("2026-09-02T00:00:00Z"),
      updatedAt: new Date("2026-09-02T00:00:00Z"),
    })),
    insertInactive: vi.fn(),
    ...overrides,
  } as unknown as MatchingCatalogRepository;
  return { service: new MatchingCatalogService(repo), repo };
}

/** Pull the named-path issues off a thrown BadRequestException. */
async function issuesFrom(fn: () => Promise<unknown>): Promise<CatalogIssue[]> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BadRequestException) {
      const body = e.getResponse() as { issues?: CatalogIssue[] };
      return body.issues ?? [];
    }
    throw e;
  }
  throw new Error("expected the publish to be REJECTED, but it resolved");
}

// ===========================================================================
// THE INVARIANT: an invalid catalog can never become the active one.
// ===========================================================================
describe("INVARIANT — an invalid catalog never reaches the database", () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make();
  });

  it("1. adjacency edge referencing an unknown role_id — rejected, path named, NOT stored", async () => {
    const catalog = clone();
    (catalog.adjacency as Array<{ to: string }>)[0]!.to = "role_does_not_exist";

    const issues = await issuesFrom(() =>
      ctx.service.publish({ updated_by: PUBLISHER, catalog }),
    );
    expect(issues.some((i) => i.path === "adjacency[0].to" && i.code === "unknown_role")).toBe(true);
    // The point of the whole phase: the repository was never called.
    expect(ctx.repo.publish).not.toHaveBeenCalled();
  });

  it("2. a multiplier of 1.4 — rejected, path named, NOT stored", async () => {
    const catalog = clone();
    (catalog.adjacency as Array<{ multiplier: number }>)[0]!.multiplier = 1.4;

    const issues = await issuesFrom(() =>
      ctx.service.publish({ updated_by: PUBLISHER, catalog }),
    );
    expect(issues.some((i) => i.path === "adjacency[0].multiplier")).toBe(true);
    expect(ctx.repo.publish).not.toHaveBeenCalled();
  });

  it("3. a role with no family — rejected, path named, NOT stored", async () => {
    const catalog = clone();
    delete (catalog.roles as Array<Record<string, unknown>>)[0]!.familyId;

    const issues = await issuesFrom(() =>
      ctx.service.publish({ updated_by: PUBLISHER, catalog }),
    );
    expect(issues.some((i) => i.path === "roles[0].familyId")).toBe(true);
    expect(ctx.repo.publish).not.toHaveBeenCalled();
  });

  it("4. a function value outside the locked enum — rejected, path named, NOT stored", async () => {
    const catalog = clone();
    (catalog.roles as Array<{ functions: string[] }>)[0]!.functions = ["operator", "chief_wizard"];

    const issues = await issuesFrom(() =>
      ctx.service.publish({ updated_by: PUBLISHER, catalog }),
    );
    expect(issues.some((i) => i.path === "roles[0].functions[1]")).toBe(true);
    expect(ctx.repo.publish).not.toHaveBeenCalled();
  });

  it("every rejection carries a path — none is a bare 'invalid catalog'", async () => {
    const catalog = clone();
    (catalog.roles as Array<{ familyId: string }>)[0]!.familyId = "fam_nope";
    (catalog.adjacency as Array<{ to: string }>)[0]!.to = "role_nope";

    const issues = await issuesFrom(() =>
      ctx.service.publish({ updated_by: PUBLISHER, catalog }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const i of issues) {
      expect(i.path).toBeTruthy();
      expect(i.path).not.toBe("(root)");
      expect(i.message.length).toBeGreaterThan(0);
    }
  });

  it("a VALID catalog does reach the repository — the gate is not simply refusing everything", async () => {
    const res = await ctx.service.publish({ updated_by: PUBLISHER, catalog: clone() });
    expect(ctx.repo.publish).toHaveBeenCalledOnce();
    expect(res.revision).toBe(4);
  });
});

// ===========================================================================
// The trap: zero active rows must read as "none", never as the fixture.
// ===========================================================================
describe("getActiveCatalog — zero active rows", () => {
  it("reports active:false when the table has no active row", async () => {
    const { service } = make({ getActive: vi.fn(async () => null) } as never);
    await expect(service.getActiveCatalog()).resolves.toEqual({ active: false });
  });

  it("NEVER substitutes the fixture when nothing is active", async () => {
    const { service } = make({ getActive: vi.fn(async () => null) } as never);
    const res = await service.getActiveCatalog();
    expect(res.active).toBe(false);
    expect(JSON.stringify(res)).not.toContain("role_placeholder");
    expect(res).not.toHaveProperty("catalog");
  });

  it("fails CLOSED: an active row whose stored blob is invalid is not served", async () => {
    // A row edited directly in the database. mc_active_shape_chk only pins the
    // top-level container types, so this shape reaches us.
    const corrupt = clone();
    (corrupt.roles as Array<{ familyId: string }>)[0]!.familyId = "fam_deleted_last_week";
    const { service } = make({
      getActive: vi.fn(async () => ({
        id: "r",
        catalog: corrupt,
        revision: 9,
        isActive: true,
        updatedBy: PUBLISHER,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    } as never);

    await expect(service.getActiveCatalog()).resolves.toEqual({ active: false });
  });

  it("serves a valid active row", async () => {
    const { service } = make({
      getActive: vi.fn(async () => ({
        id: "r",
        catalog: clone(),
        revision: 7,
        isActive: true,
        updatedBy: PUBLISHER,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        updatedAt: new Date("2026-09-01T00:00:00Z"),
      })),
    } as never);

    const res = await service.getActiveCatalog();
    expect(res.active).toBe(true);
    if (!res.active) throw new Error("unreachable");
    expect(res.revision).toBe(7);
    expect(res.catalog.roles.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// R31: both routes gated, at CLASS level so later routes inherit it.
// ===========================================================================
describe("R31 — the catalog routes are not reachable unauthenticated", () => {
  const guards = (Reflect.getMetadata("__guards__", MatchingCatalogController) ??
    []) as unknown[];

  it("the controller carries InternalServiceGuard at class level", () => {
    expect(guards).toContain(InternalServiceGuard);
  });

  it("the guard denies when NO token is configured (fail closed)", () => {
    const guard = new InternalServiceGuard({ INTERNAL_SERVICE_TOKEN: "" } as never);
    expect(() => guard.canActivate(ctxWithHeaders({}))).toThrow(/not configured/i);
  });

  it("the guard denies a request with no token header", () => {
    const guard = new InternalServiceGuard({ INTERNAL_SERVICE_TOKEN: "s3cret-value" } as never);
    expect(() => guard.canActivate(ctxWithHeaders({}))).toThrow(/invalid or missing/i);
  });

  it("the guard denies a wrong token", () => {
    const guard = new InternalServiceGuard({ INTERNAL_SERVICE_TOKEN: "s3cret-value" } as never);
    expect(() =>
      guard.canActivate(ctxWithHeaders({ "x-internal-service-token": "not-it-at-all" })),
    ).toThrow(/invalid or missing/i);
  });

  it("the guard admits the correct token — it is not refusing everything", () => {
    const guard = new InternalServiceGuard({ INTERNAL_SERVICE_TOKEN: "s3cret-value" } as never);
    expect(guard.canActivate(ctxWithHeaders({ "x-internal-service-token": "s3cret-value" }))).toBe(
      true,
    );
  });
});

function ctxWithHeaders(headers: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as never;
}
