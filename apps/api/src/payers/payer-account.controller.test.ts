import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Payer } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAccountDeletedException } from "./payer-account-deleted.exception";
import { PayerAuthGuard, type AuthenticatedPayer } from "./payer-auth.guard";
import type { PayerSessionService } from "./payer-session.service";
import { PayerAccountController } from "./payer-account.controller";
import { PayerAccountService } from "./payer-account.service";
import { PayerMeSchema, PayerUpdateSchema, type PayerUpdateDto } from "./payer-account.dto";
import type { EventsService } from "../events/events.service";
import type { PayerContact, PayersRepository } from "./payers.repository";
import type { PayerTenantScopeService } from "./payer-tenant-scope.service";

/** A no-op EventsService stub for the read-only PROF-1 describes (no event is emitted there). */
function noopEvents(): EventsService {
  return { emit: vi.fn(async () => undefined) } as unknown as EventsService;
}

const CTX: RequestContext = { requestId: "req-1", correlationId: "corr-1" };

const ORG_ID = "33333333-3333-4333-8333-333333333333";

/**
 * #2079 — org-membership stub. Defaults to an active OWNER membership (every payer has a solo
 * org after B5.2). Pass a resolver to model a recruiter / demotion / no membership. The
 * self-view (`GET`/`PATCH /payer/me`, ADR-0053 O-10) reports the same org and, by default, the
 * caller as their own tenant (`off`, or a solo payer in `on`); pass `tenantOf` to model a team
 * member keyed to an anchor, or a tenancy denial (`null`).
 */
function makeOrgs(
  resolve: (
    payerId: string,
  ) => Promise<{ orgId: string; orgRole: "owner" | "recruiter" } | null> = async () => ({
    orgId: ORG_ID,
    orgRole: "owner",
  }),
  tenantOf: (payerId: string) => string | null = (payerId) => payerId,
) {
  return {
    resolveActingOrg: vi.fn(resolve),
    resolveSelfView: vi.fn(async (payerId: string) => {
      const tenantKey = tenantOf(payerId);
      return { org: tenantKey === null ? null : await resolve(payerId), tenantKey };
    }),
  } as unknown as PayerTenantScopeService & {
    resolveActingOrg: ReturnType<typeof vi.fn>;
    resolveSelfView: ReturnType<typeof vi.fn>;
  };
}

/**
 * Horizontal-authz / IDOR build-blocker (ADR-0019 Decision C / LC-1).
 *
 * Proves the `GET /payer/me` slice binds the read to the GUARD principal, so:
 *   1. payer A's token reads payer A's row ONLY (and B's token reads B's, never A's);
 *   2. nothing in the request (body/param/query) can redirect the read — the only
 *      input to the service is the guard-derived id;
 *   3. a forged / absent / tampered token → 401 (neutral) at the guard.
 */

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const FULL_TTL = 30 * 86400;

/** A `payers` row whose decrypted view echoes its id (so we can assert WHICH row). */
function rowFor(id: string): Payer {
  return {
    id,
    role: "employer",
    emailEnc: "enc",
    emailHash: "hash",
    phoneEnc: null,
    phoneHash: null,
    orgNameEnc: "enc",
    status: "active",
    previousStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Payer;
}

/** Repository stub keyed by id: returns the matching row, decrypts to a per-id org. */
function makeRepo() {
  const rows: Record<string, Payer> = { [PAYER_A]: rowFor(PAYER_A), [PAYER_B]: rowFor(PAYER_B) };
  const findById = vi.fn(async (id: string) => rows[id]);
  // ADR-0037 — the guard's per-request lifecycle read. Narrow {role,status} projection;
  // undefined for an unknown id so the guard fails closed exactly as it does in prod.
  const findAuthFacts = vi.fn(async (id: string) =>
    rows[id] ? { role: rows[id]!.role, status: rows[id]!.status } : undefined,
  );
  const decryptContact = vi.fn((row: Payer) => ({
    id: row.id,
    role: row.role,
    status: row.status,
    email: "owner@self.example",
    orgName: `Org-${row.id.slice(0, 4)}`,
    phone: null,
  }));
  return {
    repo: { findById, findAuthFacts, decryptContact } as unknown as PayersRepository,
    findById,
    findAuthFacts,
  };
}

interface GuardReq {
  header: (n: string) => string | undefined;
  payer?: AuthenticatedPayer;
}

function makeGuardCtx(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  const req: GuardReq = {
    header: (n: string) => headers[n.toLowerCase()],
  };
  const res = { setHeader: vi.fn() };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

/** A guard whose session validates ANY bearer token to the given payer id. */
function guardFor(payerId: string | null) {
  const session = {
    // role:null → exercises the ADR-0022 fallback (resolve role from the payers row).
    validateAndTouch: vi.fn(async () =>
      payerId ? { payerId, sid: "sid", remainingSeconds: FULL_TTL, role: null } : null,
    ),
    mint: vi.fn(async () => ({ token: "fresh", expiresInSeconds: FULL_TTL })),
  } as unknown as PayerSessionService;
  // The guard's role fallback reads payers.findById; reuse the same per-id repo stub.
  const { repo } = makeRepo();
  return new PayerAuthGuard(session, config, repo, makeOrgs());
}

/**
 * The principal the `@CurrentPayer` decorator injects = `req.payer`, which the guard
 * (and ONLY the guard) attaches. Reading it from the same `req` the guard mutated is
 * exactly what the decorator does at runtime — and proves the controller's only
 * `payerId` input is the guard-derived one (no request-supplied id path exists).
 */
function currentPayerOf(req: GuardReq): AuthenticatedPayer {
  if (!req.payer) throw new UnauthorizedException("guard did not attach a payer");
  return req.payer;
}

describe("PayerAccountController — horizontal-authz / IDOR (ADR-0019 C / LC-1)", () => {
  it("payer A's token reads ONLY payer A's account (req carries no id to vary)", async () => {
    const guard = guardFor(PAYER_A);
    const { ctx, req } = makeGuardCtx("Bearer payerA.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // role resolves via the ADR-0022 fallback from the (employer) payers row.
    expect(req.payer).toEqual({ id: PAYER_A, sid: "sid", role: "employer" });

    const { repo, findById } = makeRepo();
    const controller = new PayerAccountController(
      new PayerAccountService(repo, noopEvents(), makeOrgs()),
    );
    const result = await controller.me(currentPayerOf(req));

    expect(findById).toHaveBeenCalledExactlyOnceWith(PAYER_A);
    expect(result.id).toBe(PAYER_A);
    expect(result.orgName).toBe(`Org-${PAYER_A.slice(0, 4)}`);
  });

  it("payer B's token can NEVER read payer A — it reads B's own row only", async () => {
    const guard = guardFor(PAYER_B);
    const { ctx, req } = makeGuardCtx("Bearer payerB.token");
    await guard.canActivate(ctx);

    const { repo, findById } = makeRepo();
    const controller = new PayerAccountController(
      new PayerAccountService(repo, noopEvents(), makeOrgs()),
    );
    const result = await controller.me(currentPayerOf(req));

    // The only id reaching the repo is B's (from the guard) — A is unreachable.
    expect(findById).toHaveBeenCalledExactlyOnceWith(PAYER_B);
    expect(findById).not.toHaveBeenCalledWith(PAYER_A);
    expect(result.id).toBe(PAYER_B);
  });

  it("an absent token → 401 at the guard (route never executes)", async () => {
    const guard = guardFor(PAYER_A);
    await expect(guard.canActivate(makeGuardCtx(undefined).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("a forged / tampered token (session rejects) → 401, no row is read", async () => {
    const guard = guardFor(null); // validateAndTouch → null (bad/worker/tampered token)
    const { ctx } = makeGuardCtx("Bearer forged.token");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * ADR-0037 moved this rejection EARLIER, from the service to the guard.
   *
   * Before, a session whose payer row had been deleted sailed through the guard (role
   * resolved to `null`) and every handler had to re-litigate the missing principal; here
   * that surfaced as the service's neutral 404. Now the guard's lifecycle read returns
   * `undefined` and it fails closed before the route executes at all.
   *
   * #1231 CHANGED WHAT IT FAILS CLOSED *WITH*, and only that: 401 → the reserved 410
   * {@link PayerAccountDeletedException}. The rejection is the same, at the same place, for
   * the same reason — but a 401 is what the payer app answers with a SILENT RE-AUTH, so a
   * payer whose row was deleted out of band looped through a login that could never succeed.
   * 410 + `PAYER_ACCOUNT_DELETED` is the one signal the client hard-logs-out on. No oracle is
   * created: the only caller who can reach this is the holder of that session reading their
   * OWN account, so there is no other actor to enumerate.
   */
  it("a valid session whose payer row is gone → 410 at the GUARD (route never executes)", async () => {
    const guard = guardFor("99999999-9999-4999-8999-999999999999");
    const { ctx } = makeGuardCtx("Bearer ghost.token");
    const err = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayerAccountDeletedException);
    expect((err as PayerAccountDeletedException).getStatus()).toBe(HttpStatus.GONE);
  });

  /**
   * The service-level 404 is still the correct answer for a row that vanishes BETWEEN the
   * guard's read and the handler's — a real race, just a much narrower one. Kept so that
   * defence-in-depth is not silently dropped along with the test above.
   */
  it("still 404s neutrally if the row vanishes after the guard admitted the request", async () => {
    const { repo } = makeRepo(); // findById returns undefined for the unknown id
    const controller = new PayerAccountController(
      new PayerAccountService(repo, noopEvents(), makeOrgs()),
    );
    await expect(
      controller.me({ id: "99999999-9999-4999-8999-999999999999", sid: "s1", role: "employer" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PayerAccountController — own contact on GET /payer/me (PROF-1)", () => {
  const SELF: AuthenticatedPayer = { id: PAYER_A, sid: "sid", role: "employer" };

  /** A controller whose repo decrypts to `contact` for the self id (or throws on decrypt). */
  function controllerWith(
    contact: Partial<PayerContact>,
    opts?: { decryptThrows?: boolean },
  ): PayerAccountController {
    const findById = vi.fn(async () => rowFor(PAYER_A));
    const findAuthFacts = vi.fn(async () => ({
      role: "employer" as const,
      status: "active" as const,
    }));
    const decryptContact = vi.fn((): PayerContact => {
      if (opts?.decryptThrows) throw new Error("gcm auth failed");
      return {
        id: PAYER_A,
        role: contact.role ?? "employer",
        status: contact.status ?? "active",
        email: contact.email ?? "owner@self.example",
        orgName: contact.orgName ?? "Org",
        phone: contact.phone ?? null,
      };
    });
    const repo = { findById, findAuthFacts, decryptContact } as unknown as PayersRepository;
    return new PayerAccountController(new PayerAccountService(repo, noopEvents(), makeOrgs()));
  }

  it("returns the caller's OWN decrypted email and a MASKED phoneLast4", async () => {
    const result = await controllerWith({
      email: "boss@acme.example",
      phone: "+91 98765 43210",
    }).me(SELF);
    expect(result.email).toBe("boss@acme.example");
    expect(result.phoneLast4).toBe("3210");
  });

  it("returns phoneLast4 = null when the payer has no phone on file", async () => {
    const result = await controllerWith({ phone: null }).me(SELF);
    expect(result.phoneLast4).toBeNull();
  });

  it("NEVER returns the full phone number — only the last 4 digits", async () => {
    const result = await controllerWith({ phone: "+919876543210" }).me(SELF);
    const json = JSON.stringify(result);
    expect(json).not.toContain("9876543210");
    expect(json).not.toContain("987654");
    expect(result.phoneLast4).toBe("3210");
  });

  it("fails CLOSED on a decrypt error — generic 500, never surfaces ciphertext", async () => {
    await expect(controllerWith({}, { decryptThrows: true }).me(SELF)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("a pending/suspended payer still gets their OWN contact (status is not a gate here)", async () => {
    const result = await controllerWith({ status: "pending", email: "new@acme.example" }).me(SELF);
    expect(result.status).toBe("pending");
    expect(result.email).toBe("new@acme.example");
  });

  it("never logs the raw email or phone while serving the read (no-PII regression)", async () => {
    const sink: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        sink.push(args.map(String).join(" "));
      }),
    );
    await controllerWith({ email: "boss@acme.example", phone: "+919876543210" }).me(SELF);
    const logged = sink.join(" ");
    expect(logged).not.toContain("boss@acme.example");
    expect(logged).not.toContain("9876543210");
    spies.forEach((s) => s.mockRestore());
  });
});

/**
 * PROF-3 — self-edit on `PATCH /payer/me`. Proves:
 *   - a partial update encrypts only the present fields (org/phone), refreshing phoneHash
 *     when phone changes, and returns the freshly-MASKED DTO;
 *   - the `payer.account_updated` event is PII-FREE: `{ payer_id, changed_fields }`, KEYS
 *     only — never the new org-name/phone VALUES;
 *   - the body cannot carry an id/email/role/status or any unknown key (`.strict()` → 400),
 *     an empty body is a 400, and an invalid phone is a 400;
 *   - the write binds to the GUARD principal id (a body `payer_id` is ignored / rejected);
 *   - no raw org-name/phone is ever logged across the update path.
 */
/**
 * #2079 — `GET /payer/me` returns the caller's CURRENT `orgId` / `orgRole`, resolved from
 * `payer_members` on EVERY read (never from the token, never client-supplied). This is the
 * always-current read payer-web's `getOrgRole()` consumes, so a demotion shows on the next read.
 */
describe("PayerAccountController — org role on GET /payer/me (#2079)", () => {
  const SELF: AuthenticatedPayer = { id: PAYER_A, sid: "sid", role: "employer" };

  function controllerWithOrgs(orgs: PayerTenantScopeService) {
    const { repo } = makeRepo();
    return new PayerAccountController(new PayerAccountService(repo, noopEvents(), orgs));
  }

  it("an OWNER reads orgRole:'owner' + their orgId", async () => {
    const orgs = makeOrgs();
    const me = await controllerWithOrgs(orgs).me(SELF);
    expect(me).toMatchObject({ orgId: ORG_ID, orgRole: "owner" });
    // Resolved ONCE, for the GUARD principal only (one membership read serves orgId, orgRole
    // and postingOrgName).
    expect(orgs.resolveSelfView).toHaveBeenCalledExactlyOnceWith(PAYER_A);
    expect(orgs.resolveActingOrg).not.toHaveBeenCalled();
  });

  it("a RECRUITER reads orgRole:'recruiter'", async () => {
    const me = await controllerWithOrgs(
      makeOrgs(async () => ({ orgId: ORG_ID, orgRole: "recruiter" })),
    ).me(SELF);
    expect(me).toMatchObject({ orgId: ORG_ID, orgRole: "recruiter" });
  });

  it("no active membership (removed member) → orgId/orgRole null (least privilege)", async () => {
    const me = await controllerWithOrgs(makeOrgs(async () => null)).me(SELF);
    expect(me.orgId).toBeNull();
    expect(me.orgRole).toBeNull();
  });

  it("a DEMOTED owner reads 'recruiter' on the very next request (no token involved)", async () => {
    let role: "owner" | "recruiter" = "owner";
    const controller = controllerWithOrgs(makeOrgs(async () => ({ orgId: ORG_ID, orgRole: role })));
    expect((await controller.me(SELF)).orgRole).toBe("owner");
    role = "recruiter";
    expect((await controller.me(SELF)).orgRole).toBe("recruiter");
  });

  it("the wire schema is ADDITIVE: every pre-#2079 field is still present; unknown roles rejected", async () => {
    const me = await controllerWithOrgs(makeOrgs()).me(SELF);
    expect(Object.keys(me).sort()).toEqual(
      [
        "email",
        "id",
        "orgId",
        "orgName",
        "orgRole",
        "phoneLast4",
        "postingOrgName",
        "role",
        "status",
      ].sort(),
    );
    expect(PayerMeSchema.safeParse({ ...me, orgRole: "admin" }).success).toBe(false);
  });
});

/**
 * ADR-0053 O-10 (PAY-DB-01 P3) — `GET /payer/me` `postingOrgName`: the org name a posting the
 * caller publishes carries, i.e. the TENANT's. payer-web and payer-app prefill the posting form's
 * `org_label` from it (a Frontend issue), so a teammate's manual posting carries the founder's
 * company name, as the AI chat publish already does.
 */
describe("PayerAccountController — postingOrgName on GET /payer/me (ADR-0053 O-10)", () => {
  const SELF: AuthenticatedPayer = { id: PAYER_A, sid: "sid", role: "employer" };
  /** The anchor a team member is keyed to in `on`. */
  const ANCHOR = PAYER_B;

  function controllerOver(
    orgs: PayerTenantScopeService,
    findOrgName: ReturnType<typeof vi.fn> = vi.fn(),
  ) {
    const { repo } = makeRepo();
    (repo as unknown as { findOrgName: unknown }).findOrgName = findOrgName;
    return {
      controller: new PayerAccountController(new PayerAccountService(repo, noopEvents(), orgs)),
      findOrgName,
    };
  }

  it("a payer who is their own tenant (every payer in `off`) posts under their OWN orgName, with no second read", async () => {
    const { controller, findOrgName } = controllerOver(makeOrgs());
    const me = await controller.me(SELF);
    expect(me.postingOrgName).toBe(me.orgName);
    expect(me.postingOrgName).toBe(`Org-${PAYER_A.slice(0, 4)}`);
    expect(findOrgName).not.toHaveBeenCalled();
  });

  it("a TEAM MEMBER in `on` posts under the FOUNDER's org name, read for the tenant key; their own orgName is unchanged", async () => {
    const { controller, findOrgName } = controllerOver(
      makeOrgs(
        async () => ({ orgId: ORG_ID, orgRole: "recruiter" }),
        () => ANCHOR,
      ),
      vi.fn(async () => "  Anchor Works  "),
    );
    const me = await controller.me(SELF);
    expect(findOrgName).toHaveBeenCalledExactlyOnceWith(ANCHOR);
    expect(me.postingOrgName).toBe("Anchor Works");
    expect(me.orgName).toBe(`Org-${PAYER_A.slice(0, 4)}`);
    expect(me).toMatchObject({ orgId: ORG_ID, orgRole: "recruiter" });
  });

  it("a payer tenancy REFUSES (an `on` denial) reads null, and nothing is read for a tenant", async () => {
    const { controller, findOrgName } = controllerOver(makeOrgs(undefined, () => null));
    const me = await controller.me(SELF);
    expect(me.postingOrgName).toBeNull();
    expect(me.orgId).toBeNull();
    expect(me.orgRole).toBeNull();
    expect(findOrgName).not.toHaveBeenCalled();
  });

  it("fails CLOSED (generic 500) when the founder's name cannot be read or decrypted, never falling back to the member's own", async () => {
    for (const findOrgName of [
      vi.fn(async () => undefined),
      vi.fn(async () => {
        throw new Error("decrypt failed: enc:v1:secret-ciphertext");
      }),
    ]) {
      const { controller } = controllerOver(
        makeOrgs(undefined, () => ANCHOR),
        findOrgName,
      );
      const err = await controller.me(SELF).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(JSON.stringify((err as InternalServerErrorException).getResponse())).not.toMatch(
        /cipher|decrypt|enc:/i,
      );
    }
  });

  it("PATCH /payer/me answers with postingOrgName too (an anchor renaming their org posts under the NEW name)", async () => {
    const { repo } = makeRepo();
    (repo as unknown as { update: unknown }).update = vi.fn(async () => rowFor(PAYER_A));
    (repo as unknown as { decryptContact: unknown }).decryptContact = vi.fn(() => ({
      id: PAYER_A,
      role: "employer",
      status: "active",
      email: "owner@self.example",
      orgName: "Renamed Works",
      phone: null,
    }));
    const controller = new PayerAccountController(
      new PayerAccountService(repo, noopEvents(), makeOrgs()),
    );
    const me = await controller.updateMe(SELF, { orgName: "Renamed Works" }, CTX);
    expect(me.postingOrgName).toBe("Renamed Works");
  });
});

describe("PayerAccountController — self-edit on PATCH /payer/me (PROF-3)", () => {
  const SELF: AuthenticatedPayer = { id: PAYER_A, sid: "sid", role: "employer" };

  /**
   * A repo stub whose `update` records its args and returns a row whose decrypted contact
   * reflects the patch (so the returned DTO can be asserted). `encrypt`/`hashPhone` are spied
   * so we can prove they ran on the NEW values. The decrypted org/phone echo the patch.
   */
  function makeUpdateRepo(current?: { orgName?: string; phone?: string | null }) {
    const encrypt = vi.fn((v: string) => `enc(${v})`);
    const hashPhone = vi.fn((v: string) => `phash(${v})`);
    let stored = {
      orgName: current?.orgName ?? "Old Org",
      phone: current?.phone ?? null,
    } as { orgName: string; phone: string | null };

    const update = vi.fn(async (_id: string, patch: { orgName?: string; phone?: string }) => {
      if (patch.orgName !== undefined) encrypt(patch.orgName);
      if (patch.phone !== undefined) {
        encrypt(patch.phone);
        hashPhone(patch.phone);
      }
      stored = {
        orgName: patch.orgName ?? stored.orgName,
        phone: patch.phone ?? stored.phone,
      };
      return rowFor(_id);
    });

    const decryptContact = vi.fn(
      (row: Payer): PayerContact => ({
        id: row.id,
        role: row.role,
        status: row.status,
        email: "owner@self.example",
        orgName: stored.orgName,
        phone: stored.phone,
      }),
    );

    const repo = { update, decryptContact } as unknown as PayersRepository;
    return { repo, update, encrypt, hashPhone };
  }

  /** The single argument the service hands to `EventsService.emit` (the bit we assert). */
  interface EmittedEvent {
    event_name: string;
    subject: { subject_id?: string };
    payload: { payer_id: string; changed_fields: string[] };
  }

  /** A controller + the emit spy so we can assert the exact event payload. */
  function controllerWith(repo: PayersRepository) {
    const emit = vi.fn(async (_params: EmittedEvent) => undefined);
    const events = { emit } as unknown as EventsService;
    const controller = new PayerAccountController(
      new PayerAccountService(repo, events, makeOrgs()),
    );
    return { controller, emit };
  }

  /** Run the body through the SAME ZodValidationPipe the @Body decorator applies at runtime. */
  function validate(body: unknown): PayerUpdateDto {
    return new ZodValidationPipe(PayerUpdateSchema).transform(body);
  }

  it("orgName-only update encrypts the new org and returns it (phone untouched)", async () => {
    const { repo, update, encrypt, hashPhone } = makeUpdateRepo({ phone: "+919999988888" });
    const { controller } = controllerWith(repo);

    const result = await controller.updateMe(SELF, validate({ orgName: "Acme Industries" }), CTX);

    expect(update).toHaveBeenCalledExactlyOnceWith(PAYER_A, { orgName: "Acme Industries" });
    expect(encrypt).toHaveBeenCalledWith("Acme Industries");
    expect(hashPhone).not.toHaveBeenCalled(); // phone not part of this patch
    expect(result.orgName).toBe("Acme Industries");
    expect(result.phoneLast4).toBe("8888"); // unchanged stored phone, masked
  });

  it("phone-only update re-encrypts AND refreshes the phoneHash on the NEW E.164", async () => {
    const { repo, update, encrypt, hashPhone } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    const result = await controller.updateMe(SELF, validate({ phone: "+919876543210" }), CTX);

    expect(update).toHaveBeenCalledExactlyOnceWith(PAYER_A, { phone: "+919876543210" });
    expect(encrypt).toHaveBeenCalledWith("+919876543210");
    expect(hashPhone).toHaveBeenCalledWith("+919876543210"); // lookup key kept in lockstep
    expect(result.phoneLast4).toBe("3210"); // masked — never the full number
    expect(JSON.stringify(result)).not.toContain("9876543210");
  });

  it("both fields → both encrypted + phoneHash refreshed; DTO reflects both", async () => {
    const { repo, encrypt, hashPhone } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    const result = await controller.updateMe(
      SELF,
      validate({ orgName: "BadaBhai Tools", phone: "+919812345678" }),
      CTX,
    );

    expect(encrypt).toHaveBeenCalledWith("BadaBhai Tools");
    expect(encrypt).toHaveBeenCalledWith("+919812345678");
    expect(hashPhone).toHaveBeenCalledWith("+919812345678");
    expect(result.orgName).toBe("BadaBhai Tools");
    expect(result.phoneLast4).toBe("5678");
  });

  it("emits payer.account_updated with KEYS ONLY — no org-name/phone VALUE in the payload", async () => {
    const { repo } = makeUpdateRepo();
    const { controller, emit } = controllerWith(repo);

    await controller.updateMe(
      SELF,
      validate({ orgName: "Secret Org Name", phone: "+919876543210" }),
      CTX,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("payer.account_updated");
    // The payload is EXACTLY { payer_id, changed_fields } — field KEYS, never values.
    expect(arg.payload).toEqual({
      payer_id: PAYER_A,
      changed_fields: ["org_name", "phone"],
    });
    const payloadJson = JSON.stringify(arg.payload);
    expect(payloadJson).not.toContain("Secret Org Name");
    expect(payloadJson).not.toContain("9876543210");
  });

  it("changed_fields reflects ONLY the present keys (orgName-only → ['org_name'])", async () => {
    const { repo } = makeUpdateRepo();
    const { controller, emit } = controllerWith(repo);

    await controller.updateMe(SELF, validate({ orgName: "Just Org" }), CTX);

    const arg = emit.mock.calls[0]![0];
    expect(arg.payload.changed_fields).toEqual(["org_name"]);
  });

  it("rejects a body payer_id / email / role / status / unknown key (.strict() → 400)", () => {
    for (const body of [
      { payer_id: PAYER_B, orgName: "X1" },
      { email: "new@evil.example", orgName: "X2" },
      { role: "agent", orgName: "X3" },
      { status: "active", orgName: "X4" },
      { orgName: "X5", surprise: true },
    ]) {
      expect(() => validate(body)).toThrow(BadRequestException);
    }
  });

  it("rejects an empty body — 'nothing to update' (documented 400, no silent no-op)", () => {
    expect(() => validate({})).toThrow(BadRequestException);
  });

  it("rejects an invalid phone (not E.164) → 400 neutral field error", () => {
    for (const phone of ["98765", "+0123456789", "not-a-phone", "919876543210"]) {
      expect(() => validate({ phone })).toThrow(BadRequestException);
    }
  });

  it("rejects an orgName outside 2..120 graphemes (and counts emoji as one)", () => {
    expect(() => validate({ orgName: "a" })).toThrow(BadRequestException); // < 2
    expect(() => validate({ orgName: "x".repeat(121) })).toThrow(BadRequestException); // > 120
    // 120 emoji (each a surrogate pair) is exactly 120 by code-point count → OK, NOT > 120.
    expect(() => validate({ orgName: "😀".repeat(120) })).not.toThrow();
    // 121 emoji exceeds the grapheme cap even though .length would be 242.
    expect(() => validate({ orgName: "😀".repeat(121) })).toThrow(BadRequestException);
  });

  it("a body payer_id for ANOTHER payer is ignored — the write binds to the guard principal", async () => {
    // The body carries B's id; .strict() rejects it outright, but to PROVE the binding we
    // validate a clean body and confirm the WRITE uses A's principal id, never B's.
    const { repo, update } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    // Sanity: a body trying to smuggle payer_id is rejected before the service is reached.
    expect(() => validate({ payer_id: PAYER_B, orgName: "Evil" })).toThrow(BadRequestException);

    await controller.updateMe(SELF, validate({ orgName: "Clean" }), CTX);
    expect(update).toHaveBeenCalledExactlyOnceWith(PAYER_A, { orgName: "Clean" });
    expect(update).not.toHaveBeenCalledWith(PAYER_B, expect.anything());
  });

  it("a foreign/unknown principal id (no row) → neutral 404, no event emitted", async () => {
    const update = vi.fn(async () => undefined); // id matches no row
    const repo = { update } as unknown as PayersRepository;
    const { controller, emit } = controllerWith(repo);

    await expect(
      controller.updateMe(SELF, validate({ orgName: "Ghost" }), CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled(); // event-first: only AFTER a successful write
  });

  it("fails CLOSED on a decrypt error after write — generic 500, no ciphertext", async () => {
    const update = vi.fn(async () => rowFor(PAYER_A));
    const decryptContact = vi.fn(() => {
      throw new Error("gcm auth failed");
    });
    const repo = { update, decryptContact } as unknown as PayersRepository;
    const { controller } = controllerWith(repo);

    await expect(
      controller.updateMe(SELF, validate({ orgName: "Acme" }), CTX),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("never logs the raw org-name or phone across the update path (no-PII regression)", async () => {
    const { repo } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    const sink: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        sink.push(args.map(String).join(" "));
      }),
    );
    await controller.updateMe(
      SELF,
      validate({ orgName: "Loud Org Name", phone: "+919876543210" }),
      CTX,
    );
    const logged = sink.join(" ");
    expect(logged).not.toContain("Loud Org Name");
    expect(logged).not.toContain("9876543210");
    spies.forEach((s) => s.mockRestore());
  });
});
