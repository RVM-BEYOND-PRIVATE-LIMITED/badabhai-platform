import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminEventsController } from "./admin-events.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminKillSwitchController } from "./admin-kill-switch.controller";
import { AdminEntitiesController } from "./admin-entities.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminDirectoryController } from "./admin-directory.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminWorkerJourneyController } from "./admin-worker-journey.controller";
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

  it("EXACTLY ONE non-test file under admin/** reads the spine (the single-reader invariant)", () => {
    // The invariant `AdminEventsRepository`'s header and `AdminEventsService`'s header both
    // state — "`events` has exactly one admin reader" — had no build-blocker until now: the
    // scan above enforces IMMUTABILITY (`update(events)`/`delete(events)`), not single-reader,
    // so the property rested on a comment. It is what makes the immutability scan cheap to keep
    // true (one class to audit, not every class that grows an aggregate), and BP-5 is exactly
    // the pressure that would have broken it — the dashboard wanted its own `from(events)`.
    //
    // COMMENTS ARE STRIPPED FIRST: three files under admin/** discuss `from(events)` in prose
    // (this is the documentation explaining why they must not do it), and a scan that matched
    // its own rationale would be a test nobody could make pass.
    const readers = tsFiles(ADMIN_DIR)
      .filter((f) => {
        const code = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        return /\.from\s*\(\s*events\s*\)/.test(code);
      })
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"));
    expect(
      readers,
      `exactly one admin file may read \`events\`. Readers: ${readers.join(", ")}`,
    ).toEqual(["admin/admin-events.repository.ts"]);
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

  it("discovers the ten entity-action routes (no route silently dropped)", () => {
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
        // ADR-0038 — the lost-TOTP-device recovery path. Without it a lost phone was a
        // PERMANENT lockout: clear() had zero callers and setMfaEnrolled was only ever
        // called with true.
        "resetAdminMfa",
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
    // ADR-0038 — resetting someone's second factor is an admin-management act, so it sits
    // under the SAME super_admin-only capability. A weaker one (say ops_admin) would let a
    // lower-privileged role strip MFA off a super_admin, which inverts the whole hierarchy.
    expect(capabilityOf("resetAdminMfa")).toBe("manage_admins");
  });
});

describe("ADMIN-3b PII-reveal route — guarded + exactly one `reveal_pii` capability (must-fix #4 extended)", () => {
  const proto = AdminPiiRevealController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminPiiRevealController.prototype).filter(
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
      (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminPiiRevealController) as
        | AdminCapability
        | undefined)
    );
  }

  it("discovers exactly the one reveal route (single-subject, no list/bulk route, Control 6)", () => {
    expect(routeMethods.sort()).toEqual(["revealContact"]);
  });

  it("the reveal route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    const guards = effectiveGuards(AdminPiiRevealController, "revealContact");
    expect(guards).toContain(AdminAuthGuard.name);
    expect(guards).toContain(AdminRolesGuard.name);
  });

  it("the reveal route declares EXACTLY ONE @RequireAdminRole('reveal_pii') at the method level (one role per route)", () => {
    const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.revealContact as object) as
      | AdminCapability
      | undefined;
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminPiiRevealController) as
      | AdminCapability
      | undefined;
    expect(onMethod).toBe("reveal_pii");
    expect(onClass, "AdminPiiRevealController must NOT declare a class-level capability").toBeUndefined();
    expect(capabilityOf("revealContact")).toBe("reveal_pii");
  });

  it("the reveal route sets Cache-Control: no-store on its handler (Control 8 — plaintext out of any cache)", () => {
    // Nest's @Header(...) stores response headers as route metadata under "__headers__".
    const headers = (Reflect.getMetadata("__headers__", proto.revealContact as object) ??
      []) as Array<{ name: string; value: string }>;
    const cacheControl = headers.find((h) => h.name.toLowerCase() === "cache-control");
    expect(cacheControl?.value).toBe("no-store");
  });
});

describe("ADMIN-3c kill-switch routes — guarded + toggle_kill_switch + SAFE-DIRECTION only (must-fix #4 extended, OQ-6)", () => {
  const proto = AdminKillSwitchController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminKillSwitchController.prototype).filter(
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
      (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminKillSwitchController) as
        | AdminCapability
        | undefined)
    );
  }

  it("discovers EXACTLY the two routes — a status READ + a pause-intent record (no enable/resume/toggle route, §2 #5)", () => {
    // The safe-direction guarantee is STRUCTURAL: the only routes are a read and a pause-intent
    // record. There is no enable/resume/activate route by construction (enabling stays env-gated).
    expect(routeMethods.sort()).toEqual(["requestPause", "status"].sort());
    for (const m of routeMethods) {
      expect(m.toLowerCase()).not.toMatch(/enable|resume|activate|toggle/);
    }
  });

  it("BOTH kill-switch routes carry AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminKillSwitchController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("BOTH routes declare EXACTLY ONE @RequireAdminRole('toggle_kill_switch') (super_admin break-glass, deny-by-default)", () => {
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminKillSwitchController) as
      | AdminCapability
      | undefined;
    expect(onClass, "AdminKillSwitchController must NOT declare a class-level capability").toBeUndefined();
    for (const method of routeMethods) {
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a method-level @RequireAdminRole`).toBeDefined();
      expect(capabilityOf(method)).toBe("toggle_kill_switch");
    }
  });
});

describe("BP-1 entity-read routes — guarded, read-only, and read_entities-scoped (must-fix #4 extended)", () => {
  const proto = AdminEntitiesController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminEntitiesController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  function capabilityOf(method: string): AdminCapability | undefined {
    const fn = (proto[method] ?? undefined) as object | undefined;
    return (
      (fn && (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, fn) as AdminCapability | undefined)) ??
      (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminEntitiesController) as
        | AdminCapability
        | undefined)
    );
  }

  it("discovers the eight entity-read routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      [
        "listWorkers",
        "getWorker",
        "listPayers",
        "getPayer",
        "getPayerCredits",
        "listJobPostings",
        "getJobPosting",
        "listApplications",
      ].sort(),
    );
  });

  it("EVERY entity-read route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminEntitiesController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY entity-read route declares method-level @RequireAdminRole('read_entities')", () => {
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminEntitiesController) as
      | AdminCapability
      | undefined;
    expect(onClass, "AdminEntitiesController must NOT declare a class-level capability").toBeUndefined();
    for (const method of routeMethods) {
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a method-level @RequireAdminRole`).toBeDefined();
      expect(capabilityOf(method)).toBe("read_entities");
    }
  });

  it("the surface is READ-ONLY by construction — every route is a GET, none is a write verb", () => {
    // Nest stores the HTTP verb as route metadata under "method" (RequestMethod.GET === 0).
    // Structural, not conventional: a POST/PATCH/DELETE added to this controller would bypass
    // AdminActionsService and therefore mutate system-of-record state with NO
    // `admin.action_performed` audit — the exact failure the admin design exists to prevent.
    for (const method of routeMethods) {
      const verb = Reflect.getMetadata("method", proto[method] as object) as number;
      expect(verb, `${method} must be a GET (this controller is read-only)`).toBe(0);
    }
  });

  it("the repository issues no write against ANY table (read-only data access)", () => {
    // The spine guard above covers `events`. This is the wider promise for BP-1: the entity
    // repository never writes anything at all.
    const repo = readFileSync(join(ADMIN_DIR, "admin-entities.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
  });

  it("the repository never projects a PII column (the faceless contract, enforced on source)", () => {
    // The projection is the boundary, so pin it where it is written. These identifiers are the
    // encrypted/hashed/raw PII columns on `workers` and `payers`; none may appear in a select
    // list here. A future `select()` with no projection would return them silently — that is
    // why the whole-row form is banned on the next line rather than just these names.
    const repo = readFileSync(join(ADMIN_DIR, "admin-entities.repository.ts"), "utf8");
    const source = repo
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");
    for (const forbidden of [
      "phoneE164",
      "phoneHash",
      "fullName",
      "emailEnc",
      "emailHash",
      "phoneEnc",
      "orgNameEnc",
      "photoStorageKey:", // the boolean is fine; projecting the key under its own name is not
      "paymentRef",
    ]) {
      expect(source, `admin-entities.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // No unprojected `select()` — that form returns every column, PII included.
    expect(source).not.toMatch(/\.select\(\s*\)/);
  });
});

describe("BP-2 finance routes — guarded, read-only, and free of external references", () => {
  const proto = AdminFinanceController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminFinanceController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers the three finance routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(["ledger", "orders", "summary"].sort());
  });

  it("EVERY finance route carries AdminAuthGuard AND AdminRolesGuard", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminFinanceController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY finance route declares method-level @RequireAdminRole('read_entities')", () => {
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminFinanceController) as
      | AdminCapability
      | undefined;
    expect(onClass, "AdminFinanceController must NOT declare a class-level capability").toBeUndefined();
    for (const method of routeMethods) {
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a method-level @RequireAdminRole`).toBe("read_entities");
    }
  });

  it("the surface is READ-ONLY by construction — every route is a GET", () => {
    // A write here would move money with no `admin.action_performed` audit. Grants go
    // through AdminActionsService, which emits one.
    for (const method of routeMethods) {
      expect(Reflect.getMetadata("method", proto[method] as object) as number).toBe(0);
    }
  });

  it("the finance repository issues no write against any table", () => {
    const repo = readFileSync(join(ADMIN_DIR, "admin-finance.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(repo).not.toMatch(/\.select\(\s*\)/); // never an unprojected whole-row read
  });

  it("the finance repository never projects an EXTERNAL reference or a secret", () => {
    // These originate outside this codebase (a gateway, or a caller), so their contents are
    // the one thing we cannot vouch for. Nothing on the screens needs them.
    // Strip comment lines before scanning: this file NAMES the forbidden fields in prose,
    // and matching its own documentation would be a test that can never pass.
    const src = readFileSync(join(ADMIN_DIR, "admin-finance.repository.ts"), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      "",
    );
    for (const forbidden of ["paymentRef", "providerPaymentRef", "providerOrderId", "idempotencyKey"]) {
      expect(src, `admin-finance.repository must not project ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the payments posture is derived from the SHARED config helper, not a second flag read", () => {
    // Two independent readings of PAYMENTS_ENABLE_REAL would be two sources of truth about
    // whether money is real — the Finance screen and the kill-switch screen could disagree.
    const svc = readFileSync(join(ADMIN_DIR, "admin-finance.service.ts"), "utf8");
    expect(svc).toContain("areRealPaymentsEnabled");
    expect(svc).toContain("realPaymentsBlockedReason");
    expect(svc).not.toMatch(/config\.PAYMENTS_ENABLE_REAL/);
  });
});

describe("BP-3 administration routes — guarded, read-only, and secret-free", () => {
  const proto = AdminDirectoryController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminDirectoryController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers the two administration routes", () => {
    expect(routeMethods.sort()).toEqual(["capabilities", "directory"].sort());
  });

  it("BOTH routes carry AdminAuthGuard AND AdminRolesGuard", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminDirectoryController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("the directory is manage_admins; the matrix is read_entities (deliberately different)", () => {
    const capOf = (m: string) =>
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[m] as object) as AdminCapability;
    expect(capOf("directory")).toBe("manage_admins");
    expect(capOf("capabilities")).toBe("read_entities");
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminDirectoryController),
      "must NOT declare a class-level capability",
    ).toBeUndefined();
  });

  it("the surface is READ-ONLY by construction — every route is a GET", () => {
    for (const method of routeMethods) {
      expect(Reflect.getMetadata("method", proto[method] as object) as number).toBe(0);
    }
  });

  it("the directory repository issues no write and never projects a secret or identity", () => {
    const repo = readFileSync(join(ADMIN_DIR, "admin-directory.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(repo).not.toMatch(/\.select\(\s*\)/);
    const src = repo.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    // `mfaSecretEnc` is the TOTP seed: returning it is a permanent second-factor bypass.
    for (const forbidden of ["emailEnc", "emailHash", "nameEnc", "mfaSecretEnc"]) {
      expect(src, `admin-directory.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("the served matrix is DERIVED via can(), not read off the constant a second way", () => {
    // Reading ADMIN_CAPABILITY_MATRIX directly would let this route and the guard diverge
    // if the lookup ever gained a rule (a deny-list, a role hierarchy).
    const svc = readFileSync(join(ADMIN_DIR, "admin-directory.service.ts"), "utf8");
    expect(svc).toContain("can(role, capability)");
  });
});

describe("BP-5 dashboard route — guarded, read-only, and off the cost WRITER", () => {
  const proto = AdminDashboardController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminDashboardController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers exactly the one summary route", () => {
    expect(routeMethods.sort()).toEqual(["summary"]);
  });

  it("the route carries AdminAuthGuard AND AdminRolesGuard", () => {
    const guards = effectiveGuards(AdminDashboardController, "summary");
    expect(guards).toContain(AdminAuthGuard.name);
    expect(guards).toContain(AdminRolesGuard.name);
  });

  it("declares method-level @RequireAdminRole('read_entities') — live state + money, like finance", () => {
    // Chosen by the DATA: one block reads the event spine, the rest is live system-of-record
    // state and `platform_ai_cost_totals`. Same call the finance aggregates make (asserted a
    // few describes up), and the allow-sets are identical today, so nothing a role can do moves.
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminDashboardController) as
      | AdminCapability
      | undefined;
    expect(onClass, "AdminDashboardController must NOT declare a class-level capability").toBeUndefined();
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.summary as object)).toBe(
      "read_entities",
    );
  });

  it("the surface is READ-ONLY by construction — the route is a GET", () => {
    expect(Reflect.getMetadata("method", proto.summary as object) as number).toBe(0);
  });

  it("the dashboard repository issues no write against any table", () => {
    const repo = readFileSync(join(ADMIN_DIR, "admin-dashboard.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(repo).not.toMatch(/\.select\(\s*\)/); // never an unprojected whole-row read
  });

  it("the admin module NEVER imports the AI cost-totals WRITER", () => {
    // `AiCostTotalsRepository` owns `accrue()` and is deliberately unexported from `AiModule`:
    // one writer bound to one `ai.cost_recorded` row is the guarantee. Importing it anywhere
    // under admin/** would put a class that can MOVE a spend total into the admin injector, and
    // the next person who needs "adjust a number" would find it already wired.
    //
    // COMMENTS ARE STRIPPED FIRST. Two files under admin/** NAME the writer in prose — this is
    // exactly the documentation explaining why they must not use it — and a scan that matched
    // its own rationale would be a test nobody could ever make pass.
    const offenders = tsFiles(ADMIN_DIR)
      .filter((f) => {
        const code = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        return /AiCostTotalsRepository|ai-cost-totals\.repository/.test(code);
      })
      .map((f) => relative(SRC_DIR, f));
    expect(offenders, `admin must read the totals through its OWN repository`).toEqual([]);
  });

  it("the platform total is read from platform_ai_cost_totals, never the worker/session tables", () => {
    // The bug the three-table design exists to prevent: `worker_ai_cost_totals` cannot see
    // payer-side spend (`skill_embedding` on a posting write, `job_posting_chat_turn`), so a
    // total summed from it silently undercounts while looking complete. Asserted on SOURCE as
    // well as on the rendered FROM clause (admin-dashboard.repository.test.ts) because this
    // catches a read added later with no shape test of its own.
    const src = readFileSync(join(ADMIN_DIR, "admin-dashboard.repository.ts"), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      "",
    );
    expect(src).toContain("platformAiCostTotals");
    expect(src).not.toContain("workerAiCostTotals");
    expect(src).not.toContain("sessionAiCostTotals");
  });
});

/**
 * Phase 6 worker-journey routes — guarded, read-only, and TRANSCRIPT-FREE.
 *
 * The last of those is why this block is longer than its siblings. `chat_messages.body_text`
 * and `voice_notes.transcript_text` hold the worker's own words UNMASKED (pseudonymization
 * happens transiently at the LLM-call boundary and never on the way into those rows), so a
 * projection added here would be a materially larger PII exposure than anything the admin
 * portal does today — and it would look exactly like ordinary, helpful code in a diff.
 *
 * A SOURCE SCAN is the right layer for that, because the SQL-shape tests only see the queries
 * a test happens to call, while this sees every line in the file.
 */
describe("Phase 6 journey routes — guarded, read-only, and transcript-free", () => {
  const proto = AdminWorkerJourneyController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminWorkerJourneyController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers the three journey routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      ["getChatSession", "getJourneySummary", "listChatSessions"].sort(),
    );
  });

  it("EVERY journey route carries AdminAuthGuard AND AdminRolesGuard", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminWorkerJourneyController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY journey route declares a METHOD-level @RequireAdminRole('read_entities')", () => {
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminWorkerJourneyController) as
      | AdminCapability
      | undefined;
    expect(
      onClass,
      "AdminWorkerJourneyController must NOT declare a class-level capability",
    ).toBeUndefined();
    for (const method of routeMethods) {
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a method-level @RequireAdminRole`).toBe(
        "read_entities",
      );
    }
  });

  it("the surface is READ-ONLY by construction — every route is a GET", () => {
    for (const method of routeMethods) {
      expect(Reflect.getMetadata("method", proto[method] as object) as number).toBe(0);
    }
  });

  it("the journey repository issues no write against any table", () => {
    const repo = readFileSync(join(ADMIN_DIR, "admin-worker-journey.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(repo).not.toMatch(/\.select\(\s*\)/); // never an unprojected whole-row read
  });

  it("the journey repository NEVER projects raw worker text (the build-blocker)", () => {
    // Comment lines are stripped first: this file and the repository both NAME these columns
    // in prose explaining why they are absent, and matching that would be unfixable.
    const src = readFileSync(join(ADMIN_DIR, "admin-worker-journey.repository.ts"), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

    for (const forbidden of [
      // The two unmasked transcript columns. THE reason this test exists.
      "bodyText",
      "transcriptText",
      "transcriptEnglish",
      // The four typed answer VALUE columns on `worker_pack_answer`.
      "answerText",
      "answerNumber",
      "answerBool",
      "answerOptionKeys",
      // The worker's verbatim words inside the answer map.
      "value_raw",
      // Identity PII on `workers`.
      "phoneE164",
      "phoneHash",
      "fullName",
      // Reduced-to-boolean only — projecting the value under its own key is what is banned.
      "photoStorageKey:",
      "voiceNoteId:",
      "errorMessage:",
      // The whole jsonb blob: it CONTAINS the answer map. Only `-> 'ask_counts'` and the
      // status lateral may touch it, and neither renders as a bare projection key.
      "conversationState:",
    ]) {
      expect(src, `admin-worker-journey.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("the journey DTO names no transcript field (the CONTRACT, not just the query)", () => {
    const src = readFileSync(join(ADMIN_DIR, "admin-worker-journey.dto.ts"), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    for (const forbidden of ["body_text", "transcript_text", "answer_text", "value_raw"]) {
      expect(src, `the journey response type must not declare ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });
});
