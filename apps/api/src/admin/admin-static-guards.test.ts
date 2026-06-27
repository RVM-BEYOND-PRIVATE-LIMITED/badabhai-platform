import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminEventsController } from "./admin-events.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";

/**
 * STATIC build-blocker guards for the Admin Ops Portal security invariants (ADR-0025
 * must-fix #3 + #4). These convert two conventions into CI gates so a future change cannot
 * silently break them — they are source-text scans, catching the leak at author time.
 *
 *  - MUST-FIX #3 (spine read-only): NO file under admin/** issues a Drizzle
 *    `update(events)` / `delete(events)`. The admin write path emits ONLY via EventsService
 *    (`events.emit(...)`); the admin repository is select-only on `events` (it never touches
 *    the `events` table at all — it touches `admin_users` only).
 *  - MUST-FIX #4 (every privileged route guarded): every NON-public admin route carries
 *    `AdminAuthGuard`; the only public routes are the login request/verify + MFA verify.
 */

const ADMIN_DIR = __dirname;
const SRC_DIR = join(ADMIN_DIR, "..");

/** All non-test .ts files under `dir` (recursive). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const GUARDS_METADATA = "__guards__";
function guardNames(target: object | undefined): string[] {
  if (!target) return [];
  const g = Reflect.getMetadata(GUARDS_METADATA, target) as
    | Array<{ name?: string; constructor?: { name: string } }>
    | undefined;
  return (g ?? []).map((x) => x.name ?? x.constructor?.name ?? "anonymous");
}
function effectiveGuards(ctor: new (...a: never[]) => object, method: string): string[] {
  const cls = guardNames(ctor);
  const fn = guardNames((ctor.prototype as Record<string, object>)[method]);
  return [...new Set([...cls, ...fn])];
}

describe("Admin spine-immutability build-blocker (must-fix #3)", () => {
  it("NO admin file issues update(events) / delete(events) (the spine is append-only)", () => {
    // Match a Drizzle mutation whose target is the `events` table, however imported/aliased
    // (e.g. `.update(events)`, `.delete(events)`, `db.update( events )`).
    const forbidden = /\.(update|delete)\s*\(\s*events\b/;
    const offenders = tsFiles(ADMIN_DIR)
      .filter((f) => forbidden.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC_DIR, f));
    expect(
      offenders,
      `No admin handler/repository may UPDATE or DELETE the events table. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the admin repository never references the `events` table (select-only on admin_users)", () => {
    // The admin repository touches admin_users ONLY — it must not import or query `events`.
    const repo = readFileSync(join(ADMIN_DIR, "admin.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\bevents\b\s*(,|\))/); // not a drizzle target/import of `events`
    expect(repo).toContain("adminUsers");
  });

  it("the admin write path emits via EventsService.emit — never a raw events writer", () => {
    // Every admin event must be created through EventsService; assert the auth service uses it.
    const svc = readFileSync(join(ADMIN_DIR, "admin-auth.service.ts"), "utf8");
    expect(svc).toContain("this.events.emit(");
    // ...and that it emits ONLY the registered admin.* events (session lifecycle).
    expect(svc).toContain("admin.session_started");
    expect(svc).toContain("admin.session_revoked");
  });
});

describe("Admin every-route-guarded build-blocker (must-fix #4)", () => {
  // The ONLY public admin routes — the external untrusted auth boundary (IP-rate-limited).
  const PUBLIC_ROUTES = new Set(["requestLogin", "verifyLogin", "verifyMfa"]);

  // Discover the route handlers on the admin auth controller (its own enumerable methods).
  const proto = AdminAuthController.prototype as unknown as Record<string, unknown>;
  // A Nest route HANDLER carries `path` route metadata (set by @Get/@Post). Private helpers
  // (e.g. assertWithinIpCap) do not — so this enumerates the actual HTTP routes only.
  const routeMethods = Object.getOwnPropertyNames(AdminAuthController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("every NON-public admin route carries AdminAuthGuard; only auth/MFA routes are public", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminAuthController, method);
      if (PUBLIC_ROUTES.has(method)) {
        // A public route must NOT be behind AdminAuthGuard (it is the pre-session boundary).
        expect(guards, `${method} should be public`).not.toContain(AdminAuthGuard.name);
      } else {
        // Any other route MUST be behind the admin session.
        expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      }
    }
  });

  it("the public set is exactly {requestLogin, verifyLogin, verifyMfa} — no unguarded privileged route", () => {
    const unguarded = routeMethods.filter(
      (m) => !effectiveGuards(AdminAuthController, m).includes(AdminAuthGuard.name),
    );
    expect(unguarded.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });
});

describe("ADMIN-2 event-spine routes — guarded + capability-declared (must-fix #4 extended)", () => {
  // Discover the route handlers on the read-only event-spine controller.
  const proto = AdminEventsController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminEventsController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  /** Read the @RequireAdminRole capability declared on a handler (method ∪ class). */
  function capabilityOf(method: string): AdminCapability | undefined {
    const fn = (proto[method] ?? undefined) as object | undefined;
    return (
      (fn && (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, fn) as AdminCapability | undefined)) ??
      (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminEventsController) as
        | AdminCapability
        | undefined)
    );
  }

  it("discovers the six event-spine routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      ["export", "getOne", "list", "metrics", "timeline", "trace"].sort(),
    );
  });

  it("EVERY event-spine route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminEventsController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY event-spine route declares exactly one @RequireAdminRole capability (deny-by-default)", () => {
    for (const method of routeMethods) {
      expect(capabilityOf(method), `${method} must declare a @RequireAdminRole`).toBeDefined();
    }
  });

  it("the five reads require `read_events`; `export` requires the `export` capability (least-privilege)", () => {
    expect(capabilityOf("list")).toBe("read_events");
    expect(capabilityOf("getOne")).toBe("read_events");
    expect(capabilityOf("trace")).toBe("read_events");
    expect(capabilityOf("timeline")).toBe("read_events");
    expect(capabilityOf("metrics")).toBe("read_events");
    expect(capabilityOf("export")).toBe("export");
  });
});

describe("ADMIN-3a entity-action routes — guarded + exactly one capability (must-fix #4 extended)", () => {
  const proto = AdminActionsController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminActionsController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  /** Read the @RequireAdminRole capability declared on a handler (method ∪ class). */
  function capabilityOf(method: string): AdminCapability | undefined {
    const fn = (proto[method] ?? undefined) as object | undefined;
    return (
      (fn && (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, fn) as AdminCapability | undefined)) ??
      (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminActionsController) as
        | AdminCapability
        | undefined)
    );
  }

  it("discovers the nine entity-action routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      [
        "suspendPayer",
        "reinstatePayer",
        "grantCredits",
        "forceClosePosting",
        "flagWorker",
        "unflagWorker",
        "inviteAdmin",
        "changeAdminRole",
        "suspendAdmin",
      ].sort(),
    );
  });

  it("EVERY entity-action route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminActionsController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY entity-action route declares EXACTLY ONE @RequireAdminRole (deny-by-default, one role per route)", () => {
    for (const method of routeMethods) {
      // method-level declaration (the controller has NO class-level @RequireAdminRole, so the
      // capability is the per-route one — exactly one principal+role per route).
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminActionsController) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a @RequireAdminRole at the method level`).toBeDefined();
      expect(onClass, "AdminActionsController must NOT declare a class-level capability").toBeUndefined();
    }
  });

  it("each route declares the EXACT capability for its action (suspend_payer/grant_credits/force_close_posting/flag_worker; manage_admins super-only)", () => {
    expect(capabilityOf("suspendPayer")).toBe("suspend_payer");
    expect(capabilityOf("reinstatePayer")).toBe("suspend_payer");
    expect(capabilityOf("grantCredits")).toBe("grant_credits");
    expect(capabilityOf("forceClosePosting")).toBe("force_close_posting");
    expect(capabilityOf("flagWorker")).toBe("flag_worker");
    expect(capabilityOf("unflagWorker")).toBe("flag_worker");
    // manage_admins is super_admin ONLY (asserted per-role in admin-actions.authz.test.ts).
    expect(capabilityOf("inviteAdmin")).toBe("manage_admins");
    expect(capabilityOf("changeAdminRole")).toBe("manage_admins");
    expect(capabilityOf("suspendAdmin")).toBe("manage_admins");
  });
});
