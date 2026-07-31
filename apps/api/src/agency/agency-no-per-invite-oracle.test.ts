import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { AgencyService } from "./agency.service";
import { AgencyInvitesController } from "./agency-invites.controller";
import { AgencyWorkersController } from "./agency-workers.controller";
import { AgencyWorkersService } from "./agency-workers.service";

/**
 * ADR-0022 Amendment 3, condition C10 — NO PER-INVITE READBACK, NOW OR LATER.
 *
 * Batch minting makes "one distinct link per known individual" the natural workflow (that is
 * exactly what a printed QR sheet is for), so the agency privately holds a link→person
 * mapping in its OWN records. That mapping is harmless ONLY while the platform refuses to
 * answer questions keyed on it. A single per-code status/conversion endpoint would convert
 * it into a precise consent oracle about one named person — the exact harm the k-anon floor
 * exists to prevent ("a single named invitee's consent can never be inferred").
 *
 * "Which of my 50 links converted?" is the obvious next product ask. It is ruled out here,
 * in a test, so that adding it is a deliberate, visible act rather than a small feature.
 */

const PAYER_A = "11111111-1111-4111-8111-111111111111";

/** Nest's route metadata for one handler: the path suffix + HTTP verb index. */
function routePath(ctor: new (...args: never[]) => object, method: string): string | undefined {
  const handler = (ctor.prototype as Record<string, object>)[method];
  return handler ? (Reflect.getMetadata("path", handler) as string | undefined) : undefined;
}

/** Every prototype method that carries Nest route metadata. */
function routes(ctor: new (...args: never[]) => object): Array<{ method: string; path: string }> {
  return Object.getOwnPropertyNames(ctor.prototype)
    .filter((m) => m !== "constructor")
    .map((m) => ({ method: m, path: routePath(ctor, m) ?? "" }))
    .filter((r) => r.path !== "");
}

describe("AgencyInvitesController exposes NO per-invite readback (C10)", () => {
  const ROUTES = routes(AgencyInvitesController);

  it("has route metadata to assert against (guards the assertions below)", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(4);
    expect(ROUTES.map((r) => r.method)).toContain("createInviteBatch");
  });

  it("declares NO per-code status / state / conversion / result route", () => {
    const ORACLE = /invites\/[^/]+\/(status|state|conversion|converted|result|detail)/i;
    for (const r of ROUTES) expect(r.path).not.toMatch(ORACLE);
  });

  /**
   * `POST invites/:code/click` is the ONLY per-code route, and it is a WRITE that returns a
   * fixed `{ok:true}` whether the code exists or not — deliberately not an existence oracle.
   * No GET may ever be keyed on a code.
   */
  it("has no READ (GET) route keyed on an invite code", () => {
    for (const r of ROUTES) {
      const verb = Reflect.getMetadata(
        "method",
        (AgencyInvitesController.prototype as unknown as Record<string, object>)[r.method]!,
      );
      if (r.path.includes(":code")) {
        expect(verb).not.toBe(0); // 0 === RequestMethod.GET
      }
    }
  });

  it("returns no array of invite rows from any route (only the batch's mint result)", async () => {
    // The mint result is the ONLY array the agency ever receives, and it is the codes it
    // just created in this very request — not a queryable list of stored invites.
    const emit = vi.fn().mockResolvedValue(undefined);
    let n = 0;
    const invitesRepo = {
      create: vi.fn().mockImplementation((i: { code: string }) => {
        n += 1;
        return Promise.resolve({ id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`, code: i.code });
      }),
    };
    const svc = new AgencyService({} as never, invitesRepo as never, {} as never, { emit } as never);
    const res = await svc.createInviteBatch(PAYER_A, 3, undefined, {
      correlationId: "c",
      requestId: "r",
    } as never);

    for (const inv of res.invites) {
      expect(Object.keys(inv).sort()).toEqual(["agency_invite_id", "code", "link"]);
    }
  });
});

describe("referralsSummary stays AGGREGATE-ONLY with the k-anon floor (C10)", () => {
  /**
   * Arity is the control: a `campaign`/`code` filter parameter is what would turn an
   * aggregate count into a per-person question ("how many of my `ramesh` links converted?").
   */
  it("takes ONLY the session payerId — no campaign/code filter parameter", () => {
    expect(AgencyService.prototype.referralsSummary.length).toBe(1);
    expect(AgencyInvitesController.prototype.referralsSummary.length).toBe(1);
  });

  it("still suppresses every stage count strictly below MIN_BUCKET to 0", async () => {
    const invitesRepo = {
      stageCountsForOwner: vi.fn().mockResolvedValue({ created: 12, clicked: 4, accepted: 1 }),
    };
    const svc = new AgencyService({} as never, invitesRepo as never, {} as never, { emit: vi.fn() } as never);
    const summary = await svc.referralsSummary(PAYER_A);

    expect(summary.minBucket).toBe(AgencyService.MIN_BUCKET);
    expect(summary.created).toBe(12);
    expect(summary.clicked).toBe(0);
    expect(summary.accepted).toBe(0); // one accepted invite can never be resolved to a person
    expect(invitesRepo.stageCountsForOwner).toHaveBeenCalledWith(PAYER_A);
  });
});

describe("GET /payer/agency/workers gains NO referral-linkage field (C10)", () => {
  const EXPECTED_KEYS = ["appliedCount", "lastActiveOn", "profileComplete", "ref", "unlockedCount"];

  it("returns EXACTLY {ref, profileComplete, appliedCount, unlockedCount, lastActiveOn}", async () => {
    const repo = {
      listReferredWithConsent: vi.fn().mockResolvedValue([
        {
          workerId: "99999999-9999-4999-8999-999999999999",
          profileComplete: true,
          appliedCount: 2,
          unlockedCount: 1,
          lastActiveOn: "2026-07-30",
        },
      ]),
    };
    const pii = { hmac: vi.fn().mockReturnValue("0123456789abcdef0123") };
    const svc = new AgencyWorkersService(repo as never, pii as never);
    const { workers } = await svc.listReferred(PAYER_A);

    expect(workers).toHaveLength(1);
    expect(Object.keys(workers[0]!).sort()).toEqual(EXPECTED_KEYS);
    // No invite_code / campaign / invite_id / referral linkage may ever appear here: it
    // would let the agency join its private link→person map onto platform state.
    for (const forbidden of ["invite_code", "inviteCode", "campaign", "invite_id", "inviteId", "code"]) {
      expect(workers[0]).not.toHaveProperty(forbidden);
    }
  });

  it("the workers route takes no parameter at all (nothing to key a question with)", () => {
    expect(AgencyWorkersController.prototype.listReferred.length).toBe(1); // the session payer only
    expect(routePath(AgencyWorkersController, "listReferred")).toBe("workers");
  });
});

describe("The event registry carries NO batch event (C4)", () => {
  it("no agency event name mentions a batch", async () => {
    const registry = (await import("@badabhai/event-schema")) as unknown as {
      EVENT_REGISTRY?: Record<string, unknown>;
    };
    const names = Object.keys(registry.EVENT_REGISTRY ?? {});
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).not.toMatch(/batch/i);
  });
});
