import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import {
  assertPayerOwns,
  assertOwnedRows,
  readOwnedById,
  assertOrgOwns,
  assertOwnedRowsByOrg,
  readOwnedByIdOrg,
} from "./payer-scope";

const A = "payer-a";
const B = "payer-b";
const ORG_A = "org-a";
const ORG_B = "org-b";

describe("payer tenant-isolation chokepoint (ADR-0019 Decision C) — horizontal authz", () => {
  it("assertPayerOwns allows a payer's own row", () => {
    expect(() => assertPayerOwns(A, A)).not.toThrow();
  });

  it("assertPayerOwns BLOCKS cross-tenant access (payer A → payer B's row) with 403", () => {
    expect(() => assertPayerOwns(A, B)).toThrow(ForbiddenException);
  });

  it("assertPayerOwns fails closed on a missing/empty authenticated id", () => {
    expect(() => assertPayerOwns("", A)).toThrow(ForbiddenException);
  });

  it("assertOwnedRows throws if ANY row in a list belongs to another payer", () => {
    expect(() => assertOwnedRows(A, [{ payerId: A }, { payerId: A }])).not.toThrow();
    expect(() => assertOwnedRows(A, [{ payerId: A }, { payerId: B }])).toThrow(ForbiddenException);
  });

  describe("readOwnedById — the single-resource read chokepoint", () => {
    it("returns the row when it belongs to the authenticated payer", async () => {
      const fetch = vi.fn().mockResolvedValue({ payerId: A, secret: "a-data" });
      await expect(readOwnedById(A, fetch)).resolves.toEqual({ payerId: A, secret: "a-data" });
    });

    it("THROWS 403 when the fetched row belongs to another payer (IDOR blocked)", async () => {
      // payer A requests a resource id that actually belongs to payer B.
      const fetch = vi.fn().mockResolvedValue({ payerId: B, secret: "b-data" });
      await expect(readOwnedById(A, fetch)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("returns undefined (neutral not-found) when the row does not exist — no oracle", async () => {
      const fetch = vi.fn().mockResolvedValue(undefined);
      await expect(readOwnedById(A, fetch)).resolves.toBeUndefined();
    });
  });
});

describe("ORG tenant-isolation chokepoint (ADR-0027 B5.x) — horizontal authz on org_id", () => {
  it("assertOrgOwns allows a caller's own org row", () => {
    expect(() => assertOrgOwns(ORG_A, ORG_A)).not.toThrow();
  });

  it("assertOrgOwns BLOCKS cross-org access (org A → org B's row) with 403", () => {
    expect(() => assertOrgOwns(ORG_A, ORG_B)).toThrow(ForbiddenException);
  });

  it("assertOrgOwns fails closed on a NULL row org_id (an org-less/seed row is owned by no org)", () => {
    expect(() => assertOrgOwns(ORG_A, null)).toThrow(ForbiddenException);
  });

  it("assertOrgOwns fails closed on a missing/empty authenticated org id", () => {
    expect(() => assertOrgOwns("", ORG_A)).toThrow(ForbiddenException);
  });

  it("assertOwnedRowsByOrg throws if ANY row belongs to another org OR is org-less", () => {
    expect(() => assertOwnedRowsByOrg(ORG_A, [{ orgId: ORG_A }, { orgId: ORG_A }])).not.toThrow();
    expect(() => assertOwnedRowsByOrg(ORG_A, [{ orgId: ORG_A }, { orgId: ORG_B }])).toThrow(
      ForbiddenException,
    );
    expect(() => assertOwnedRowsByOrg(ORG_A, [{ orgId: ORG_A }, { orgId: null }])).toThrow(
      ForbiddenException,
    );
  });

  describe("readOwnedByIdOrg — the org-scoped single-resource read chokepoint", () => {
    it("returns the row when it belongs to the authenticated org", async () => {
      const fetch = vi.fn().mockResolvedValue({ orgId: ORG_A, secret: "a-data" });
      await expect(readOwnedByIdOrg(ORG_A, fetch)).resolves.toEqual({ orgId: ORG_A, secret: "a-data" });
    });

    it("THROWS 403 when the fetched row belongs to another org (cross-org IDOR blocked)", async () => {
      const fetch = vi.fn().mockResolvedValue({ orgId: ORG_B, secret: "b-data" });
      await expect(readOwnedByIdOrg(ORG_A, fetch)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("THROWS 403 when the fetched row is org-less (null org_id)", async () => {
      const fetch = vi.fn().mockResolvedValue({ orgId: null, secret: "seed" });
      await expect(readOwnedByIdOrg(ORG_A, fetch)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("returns undefined (neutral not-found) when the row does not exist — no oracle", async () => {
      const fetch = vi.fn().mockResolvedValue(undefined);
      await expect(readOwnedByIdOrg(ORG_A, fetch)).resolves.toBeUndefined();
    });
  });
});
