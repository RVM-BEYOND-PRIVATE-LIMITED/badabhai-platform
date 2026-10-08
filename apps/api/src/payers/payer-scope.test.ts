import "reflect-metadata";
import { beforeAll, describe, it, expect, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { assertPayerOwns, assertOwnedRows, readOwnedById } from "./payer-scope";
import type { TenantKey } from "./payer-tenant-scope";
import { ownTenantKey, resolverOver } from "./payer-tenant-scope.test-support";

const A = "payer-a";
const B = "payer-b";
/** A teammate of A's org (ADR-0053): in mode `on` they act under A's tenant key. */
const M = "payer-m";

/** Tenant keys come from the REAL resolver (the only constructor), never a cast. */
let KEY_A!: TenantKey;
let KEY_M_ON!: TenantKey;
beforeAll(async () => {
  KEY_A = await ownTenantKey(A);
  const on = resolverOver({ PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig, [
    { anchor: A, members: [M] },
  ]);
  KEY_M_ON = (await on.resolve(M)).tenantKey;
});

describe("payer tenant-isolation chokepoint (ADR-0019 Decision C) — horizontal authz", () => {
  it("assertPayerOwns allows a payer's own row", () => {
    expect(() => assertPayerOwns(KEY_A, A)).not.toThrow();
  });

  it("assertPayerOwns BLOCKS cross-tenant access (payer A → payer B's row) with 403", () => {
    expect(() => assertPayerOwns(KEY_A, B)).toThrow(ForbiddenException);
  });

  it("assertPayerOwns fails closed on an empty tenant key", async () => {
    // The resolver never mints an empty key from a real session; this pins the guard anyway.
    const empty = await ownTenantKey("");
    expect(() => assertPayerOwns(empty, A)).toThrow(ForbiddenException);
  });

  it("assertOwnedRows throws if ANY row in a list belongs to another payer", () => {
    expect(() => assertOwnedRows(KEY_A, [{ payerId: A }, { payerId: A }])).not.toThrow();
    expect(() => assertOwnedRows(KEY_A, [{ payerId: A }, { payerId: B }])).toThrow(
      ForbiddenException,
    );
  });

  describe("readOwnedById — the single-resource read chokepoint", () => {
    it("returns the row when it belongs to the authenticated payer", async () => {
      const fetch = vi.fn().mockResolvedValue({ payerId: A, secret: "a-data" });
      await expect(readOwnedById(KEY_A, fetch)).resolves.toEqual({ payerId: A, secret: "a-data" });
    });

    it("THROWS 403 when the fetched row belongs to another payer (IDOR blocked)", async () => {
      // payer A requests a resource id that actually belongs to payer B.
      const fetch = vi.fn().mockResolvedValue({ payerId: B, secret: "b-data" });
      await expect(readOwnedById(KEY_A, fetch)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("returns undefined (neutral not-found) when the row does not exist — no oracle", async () => {
      const fetch = vi.fn().mockResolvedValue(undefined);
      await expect(readOwnedById(KEY_A, fetch)).resolves.toBeUndefined();
    });
  });

  describe("ADR-0053 §5.2 rule 6 — the comparison is the row's tenant column against the TENANT key", () => {
    it("a teammate's key (mode on) is the anchor's: they pass on the org's row, as the anchor does", async () => {
      expect(KEY_M_ON).toBe(A);
      expect(() => assertPayerOwns(KEY_M_ON, A)).not.toThrow();
      await expect(readOwnedById(KEY_M_ON, async () => ({ payerId: A }))).resolves.toEqual({
        payerId: A,
      });
    });

    it("…and fail on a row their own login wrote under itself (born-where, O-2) — the key is not the login", () => {
      expect(() => assertPayerOwns(KEY_M_ON, M)).toThrow(ForbiddenException);
      expect(() => assertOwnedRows(KEY_M_ON, [{ payerId: M }])).toThrow(ForbiddenException);
    });
  });
});
