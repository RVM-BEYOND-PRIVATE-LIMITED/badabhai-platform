import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { assertPayerOwns, assertOwnedRows, readOwnedById } from "./payer-scope";

const A = "payer-a";
const B = "payer-b";

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
