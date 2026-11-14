import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { CampusPostForCompanyBodySchema } from "./campus-link.contract";
import { POST_FOR_COMPANY_BODY_EXAMPLE } from "./campus-link.examples";
import { CampusPostingsService } from "./campus-postings.service";

/**
 * #2752 Part E x #2746 PR 5 — WHOSE TENANCY A CAMPUS POST RESOLVES, AND HOW. A Campus call is not
 * the company's own: the owner scope is read with `resolveReadOnly` (no heal, no shadow line), and
 * only an empty answer (tenancy `on`, a company with no org yet or one tenancy denies) falls to
 * `resolve`, which heals the first once and refuses the second.
 */

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const POSTING = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX = { correlationId: "c-1", requestId: "r-1" } as never;

function scopeFor(tenant: string): PayerTenantScope {
  return {
    actorPayerId: tenant,
    tenantKey: tenant as PayerTenantScope["tenantKey"],
    orgId: null,
    orgRole: null,
    mode: "on",
  };
}

function harness(tenancy: {
  resolveReadOnly: (id: string) => Promise<PayerTenantScope | null>;
  resolve: (id: string) => Promise<PayerTenantScope>;
}) {
  const readOnly = vi.fn(tenancy.resolveReadOnly);
  const resolve = vi.fn(tenancy.resolve);
  const createForCampus = vi.fn(async (_scope: PayerTenantScope) => ({ id: POSTING }));
  const repo = {
    withTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
    markCampusCompany: async () => undefined,
    approveAsCreated: async () => undefined,
  };
  const service = new CampusPostingsService(
    repo as never,
    { createOrGet: async () => ({ id: COMPANY, created: true }) } as never,
    { resolveReadOnly: readOnly, resolve } as never,
    { createForCampus } as never,
    {} as never,
    { emit: async () => undefined } as never,
  );
  const body = CampusPostForCompanyBodySchema.parse(POST_FOR_COMPANY_BODY_EXAMPLE);
  return { service, body, readOnly, resolve, createForCampus };
}

describe("CampusPostingsService.postForCompany — the owner scope is read-only first", () => {
  it("uses the read-only scope and never calls resolve (no heal, no shadow line)", async () => {
    const h = harness({
      resolveReadOnly: async (id) => scopeFor(id),
      resolve: async () => {
        throw new Error("resolve must not run");
      },
    });
    const out = await h.service.postForCompany(h.body, CTX);
    expect(out).toEqual({ posting_id: POSTING, company_id: COMPANY, company_created: true });
    expect(h.readOnly).toHaveBeenCalledWith(COMPANY);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.createForCampus.mock.calls[0]?.[0]).toEqual(scopeFor(COMPANY));
  });

  it("falls to resolve only when there is no key (a company with no org yet under `on`)", async () => {
    const h = harness({
      resolveReadOnly: async () => null,
      resolve: async (id) => scopeFor(id),
    });
    await h.service.postForCompany(h.body, CTX);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledWith(COMPANY);
    expect(h.createForCampus.mock.calls[0]?.[0]).toEqual(scopeFor(COMPANY));
  });

  it("creates no posting for a company tenancy denies (resolve's 403 propagates)", async () => {
    const h = harness({
      resolveReadOnly: async () => null,
      resolve: async () => {
        throw new ForbiddenException("denied");
      },
    });
    await expect(h.service.postForCompany(h.body, CTX)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.createForCampus).not.toHaveBeenCalled();
  });

  it("still refuses a company whose tenant is another employer's org", async () => {
    const h = harness({
      resolveReadOnly: async () => scopeFor("cccccccc-0000-4000-8000-000000000003"),
      resolve: async () => {
        throw new Error("resolve must not run");
      },
    });
    await expect(h.service.postForCompany(h.body, CTX)).rejects.toMatchObject({
      code: "COMPANY_NOT_CAMPUS_CREATED",
    });
    expect(h.createForCampus).not.toHaveBeenCalled();
  });
});
