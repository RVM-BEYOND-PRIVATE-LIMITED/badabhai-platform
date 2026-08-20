import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { adminUsers, type AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability, ADMIN_CAPABILITY_MATRIX, can } from "./admin-capabilities";
import { AdminDirectoryController } from "./admin-directory.controller";
import { AdminDirectoryService } from "./admin-directory.service";
import { AdminDirectoryRepository } from "./admin-directory.repository";
import type { AdminIdentityService } from "./admin-identity.service";
import { AdminDirectoryQuerySchema } from "./admin-directory.dto";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";
import type { RequestContext } from "../common/request-context";

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "self-id", role, sid: "s" });
const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };

/** An identity layer that discloses NOTHING unless a test says otherwise. */
function identityStub(
  resolve: AdminIdentityService["resolve"] = vi.fn(async () => null),
): AdminIdentityService {
  return { resolve, isPermitted: vi.fn(() => false) } as unknown as AdminIdentityService;
}

function declaredCapability(method: string): AdminCapability {
  const proto = AdminDirectoryController.prototype as unknown as Record<string, object>;
  const cap = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as
    | AdminCapability
    | undefined;
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(method), handler);
  return {
    getHandler: () => handler,
    getClass: () => AdminDirectoryController,
    switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());

// ---------------------------------------------------------------------------
// authz — the two routes are gated DIFFERENTLY, on purpose
// ---------------------------------------------------------------------------

describe("BP-3 authz — the directory is super_admin ONLY", () => {
  it("the directory declares manage_admins", () => {
    expect(declaredCapability("directory")).toBe("manage_admins");
  });

  it("super_admin may read the directory", () => {
    expect(guard.canActivate(ctxFor("directory", admin("super_admin")))).toBe(true);
  });

  it("ops_admin, support and analyst are DENIED the directory", () => {
    // Who holds admin access and who has no second factor is a map of the platform's
    // softest targets. It is scoped to the role that can act on it, not the read floor.
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor("directory", admin(role))), role).toThrow(
        ForbiddenException,
      );
    }
  });

  it("unauthenticated → 401", () => {
    expect(() => guard.canActivate(ctxFor("directory", undefined))).toThrow(
      UnauthorizedException,
    );
  });
});

describe("BP-3 authz — the capability matrix is the read floor", () => {
  it("declares read_entities and ALL four roles pass", () => {
    expect(declaredCapability("capabilities")).toBe("read_entities");
    for (const role of ROLES) {
      expect(guard.canActivate(ctxFor("capabilities", admin(role))), role).toBe(true);
    }
  });

  it("the two routes declare DIFFERENT capabilities", () => {
    expect(declaredCapability("directory")).not.toBe(declaredCapability("capabilities"));
  });
});

// ---------------------------------------------------------------------------
// the capability matrix must agree with the guard, cell for cell
// ---------------------------------------------------------------------------

describe("the served matrix IS what the guard enforces", () => {
  const svc = new AdminDirectoryService({} as AdminDirectoryRepository, identityStub());

  it("agrees with can() on every cell", () => {
    const { matrix } = svc.capabilityMatrix();
    for (const row of matrix) {
      for (const role of ROLES) {
        expect(row.roles.includes(role), `${role}/${row.capability}`).toBe(
          can(role, row.capability),
        );
      }
    }
  });

  it("covers every capability exactly once", () => {
    const { matrix } = svc.capabilityMatrix();
    const caps = matrix.map((r) => r.capability);
    expect(new Set(caps).size).toBe(caps.length);
    expect([...caps].sort()).toEqual(Object.keys(ADMIN_CAPABILITY_MATRIX).sort());
  });

  it("reports the four roles in privilege order", () => {
    expect(svc.capabilityMatrix().roles).toEqual([
      "super_admin",
      "ops_admin",
      "support",
      "analyst",
    ]);
  });

  it("pins the break-glass rows literally — a derived expectation would survive a bug", () => {
    const { matrix } = svc.capabilityMatrix();
    const row = (c: string) => matrix.find((r) => r.capability === c)!.roles;
    expect(row("manage_admins")).toEqual(["super_admin"]);
    expect(row("toggle_kill_switch")).toEqual(["super_admin"]);
    expect(row("reveal_pii")).toEqual(["super_admin", "support"]);
    expect(row("read_entities")).toEqual(["super_admin", "ops_admin", "support", "analyst"]);
  });
});

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

describe("directory service", () => {
  function repoStub(over: Partial<AdminDirectoryRepository> = {}): AdminDirectoryRepository {
    return {
      list: vi.fn(async () => []),
      countActiveSuperAdmins: vi.fn(async () => 0),
      ...over,
    } as unknown as AdminDirectoryRepository;
  }

  /** The calling admin, as the guard resolved them. `id` is what marks a row as "you". */
  const me = { id: "me-1", role: "super_admin", sid: "s" } as AuthenticatedAdmin;

  it("passes the SESSION admin id through so rows can be marked as self", async () => {
    const list = vi.fn(async () => []);
    await new AdminDirectoryService(repoStub({ list } as never), identityStub()).directory(
      me,
      {} as never,
      CTX,
    );
    expect(list).toHaveBeenCalledWith({ role: undefined, status: undefined }, "me-1");
  });

  it("forwards the role and status filters", async () => {
    const list = vi.fn(async () => []);
    await new AdminDirectoryService(repoStub({ list } as never), identityStub()).directory(
      me,
      { role: "support", status: "active" } as never,
      CTX,
    );
    expect(list).toHaveBeenCalledWith({ role: "support", status: "active" }, "me-1");
  });

  it("counts active super_admins over ALL admins, not the filtered page", async () => {
    // Filtering the table to `support` must not make "how many people hold the keys" read 0.
    const countActiveSuperAdmins = vi.fn(async () => 2);
    const res = await new AdminDirectoryService(
      repoStub({ countActiveSuperAdmins } as never),
      identityStub(),
    ).directory(me, { role: "support" } as never, CTX);
    expect(res.active_super_admins).toBe(2);
    expect(countActiveSuperAdmins).toHaveBeenCalledWith();
  });

  it("merges the disclosed name onto each row, from the `admins` surface", async () => {
    const list = vi.fn(async () => [{ id: "a-1" }, { id: "a-2" }]);
    const resolve = vi.fn(async () => new Map([["a-1", "Divyanshu"]]));
    const res = await new AdminDirectoryService(
      repoStub({ list } as never),
      identityStub(resolve as never),
    ).directory(me, {} as never, CTX);
    expect(resolve).toHaveBeenCalledWith(me, "admins", ["a-1", "a-2"], null, CTX);
    expect(res.admins[0]).toMatchObject({ id: "a-1", name: "Divyanshu" });
    // Disclosed but unset — the invite flow does not collect a name, so this is the common row.
    expect(res.admins[1]).toMatchObject({ id: "a-2", name: null });
  });

  it("leaves rows untouched when identity discloses nothing (no `name` KEY at all)", async () => {
    // A null `name` would claim the name was disclosed and found empty. An absent key is the
    // honest answer for a caller who was shown none.
    const list = vi.fn(async () => [{ id: "a-1" }]);
    const res = await new AdminDirectoryService(
      repoStub({ list } as never),
      identityStub(),
    ).directory(me, {} as never, CTX);
    expect(res.admins[0]).not.toHaveProperty("name");
  });

  it("gates names on read_identity, NOT on the route's manage_admins", async () => {
    // The whole session admin goes to the gate, so the capability it consults is the one the
    // identity service names. Reusing `manage_admins` would make "can manage admins" silently
    // imply "can read identities" the day either grant moves.
    const resolve = vi.fn(async () => null);
    await new AdminDirectoryService(
      repoStub({ list: vi.fn(async () => []) } as never),
      identityStub(resolve as never),
    ).directory(me, {} as never, CTX);
    expect(resolve).toHaveBeenCalledWith(me, "admins", [], null, CTX);
  });
});

// ---------------------------------------------------------------------------
// the query contract + the projection
// ---------------------------------------------------------------------------

describe("query contract", () => {
  it("rejects an unknown parameter rather than ignoring it", () => {
    expect(AdminDirectoryQuerySchema.safeParse({ rol: "support" }).success).toBe(false);
  });

  it("rejects an unknown role or status", () => {
    expect(AdminDirectoryQuerySchema.safeParse({ role: "root" }).success).toBe(false);
    expect(AdminDirectoryQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(AdminDirectoryQuerySchema.safeParse({ role: "analyst" }).success).toBe(true);
  });
});

describe("the directory query never touches a secret or an identity column", () => {
  it("selects no email, name or MFA SECRET column", async () => {
    // `mfa_secret_enc` is the TOTP seed. Returning it would be a permanent second-factor
    // bypass for that account, and the admin would never know.
    const c = captureQueries();
    await new AdminDirectoryRepository(c.db).list({}, "me");
    expectColumnsAbsent(c, ["email_enc", "email_hash", "name_enc", "mfa_secret_enc"]);
  });

  it("this assertion is CAPABLE of failing — the projection really is captured", () => {
    // Guards the guard. The previous local helper swallowed bare columns, which made every
    // "must not be selected" assertion vacuously true. If projections stop being recorded,
    // this fails and the suite above stops being decorative.
    const c = captureQueries();
    c.db.select({ leak: adminUsers.emailEnc } as never);
    expect(c.sql()).toContain("email_enc");
    expect(() => expectColumnsAbsent(c, ["email_enc"])).toThrow(/must never be selected/);
  });

  it("still selects the audit-relevant columns", async () => {
    const c = captureQueries();
    await new AdminDirectoryRepository(c.db).list({}, "me");
    // `mfa_enrolled` is a boolean and safe; it is the seed that is not.
    expect(c.sql()).toContain("mfa_enrolled");
    expect(c.sql()).toContain("last_login_at");
  });

  it("the super-admin count is scoped to role AND status", async () => {
    // Counting every super_admin regardless of status would report a suspended account as
    // holding the keys. The values are BOUND PARAMETERS, not SQL literals — assert on those.
    const c = captureQueries();
    await new AdminDirectoryRepository(c.db).countActiveSuperAdmins();
    expect(c.params).toContain("super_admin");
    expect(c.params).toContain("active");
  });

  it("the role and status filters are bound, not interpolated", async () => {
    const c = captureQueries();
    await new AdminDirectoryRepository(c.db).list({ role: "support", status: "active" }, "me");
    expect(c.params).toContain("support");
    expect(c.params).toContain("active");
  });
});
