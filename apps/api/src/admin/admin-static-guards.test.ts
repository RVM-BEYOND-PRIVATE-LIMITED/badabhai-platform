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
import { AdminFeedbackController } from "./admin-feedback.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminDirectoryController } from "./admin-directory.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminWorkerJourneyController } from "./admin-worker-journey.controller";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { type AdminCapability } from "./admin-capabilities";
import { ADMIN_ENTITIES_PAGE_MAX, ADMIN_IDENTITY_PAGE_MAX } from "./admin-entities.dto";
import { ADMIN_IDENTITY_MAX_SUBJECTS } from "./admin-identity.service";

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

/**
 * NAMES (owner ruling 2026-08-18, reversing ADR-0025 Decision 4) — the identity egress.
 *
 * The ruling reopened a door the faceless contract had welded shut, so the build-blockers below
 * exist to keep it a DOOR rather than a hole: exactly one file may read a name column, exactly
 * one may decrypt one, and neither may grow a way to SEARCH by name. A source scan is the right
 * layer, because the SQL-shape tests only see the queries a test happens to call while this sees
 * every line in the file.
 */
describe("identity reads — one reader, one decrypter, and no name search", () => {
  const IDENTITY_REPO = "admin-identity.repository.ts";

  /** Non-comment source of a file under admin/**. */
  function code(file: string): string {
    return readFileSync(join(ADMIN_DIR, file), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  }

  it("EXACTLY ONE non-test file under admin/** reads a name column (the single-reader invariant)", () => {
    // The faceless projections in `admin-entities.repository.ts` and
    // `admin-directory.repository.ts` are held to their promises by the scans elsewhere in this
    // file. This is the other half: the name columns those scans forbid must have exactly ONE
    // home, or the next surface that wants a name adds a second projection and there is nothing
    // left to audit. COMMENTS ARE STRIPPED FIRST — several files under admin/** name these
    // columns in prose explaining why they do not select them.
    const readers = tsFiles(ADMIN_DIR)
      .filter((f) => {
        const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        return /workers\.fullName|payers\.orgNameEnc|adminUsers\.nameEnc/.test(src);
      })
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"));
    expect(
      readers,
      `exactly one admin file may project a name column. Readers: ${readers.join(", ")}`,
    ).toEqual([`admin/${IDENTITY_REPO}`]);
  });

  /**
   * The at-rest column names, as POSTGRES spells them. The camelCase scans above anchor on the
   * Drizzle property, which is the form a projection USUALLY takes — and is exactly the form a
   * raw `sql` template does not use. `admin-entities.repository.ts` and
   * `admin-dashboard.repository.ts` both already prefer `sql` for a projection when it suits
   * them (`hasPhoto`, nine cost aggregates), so the idiom that slips past a camelCase scan is
   * the house idiom, not an exotic one.
   */
  const RAW_PII_COLUMNS = [
    "full_name",
    "org_name_enc",
    "name_enc",
    "mfa_secret_enc",
    "phone_e164",
    "phone_hash",
    "email_enc",
    "email_hash",
    "phone_enc",
  ];

  /** Every `sql\`…\`` / `sql<T>\`…\`` template literal in a source file. */
  function sqlTemplates(src: string): string[] {
    return [...src.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)].map((m) => m[1]!);
  }

  it("NO raw `sql` template under admin/** names a PII column (the camelCase scans' blind spot)", () => {
    // MEASURED, not assumed: adding
    //   `.select({ id: sql<string>\`id\`, token: sql<string|null>\`full_name\` }).from(workers)`
    // to `admin-dashboard.repository.ts` — the file the scan below calls the highest-risk one —
    // passed all 77 guards and all 917 admin tests before this test existed. The entity
    // repository survives the same mutation only because of its RUNTIME SQL-capture test
    // (`admin-entities.repository.test.ts`), which no other repository has and which by
    // construction only sees the queries a test happens to call.
    //
    // Scoped to `sql` TEMPLATES rather than to file text, because `full_name` is also the DTO
    // field name on `AdminWorkerListItem` — `admin-entities.dto.ts` and `admin-entities.service.ts`
    // both carry it legitimately, and a blanket text scan would fail on the response contract the
    // ruling asked for. A column name inside a SQL template has no such second meaning.
    const offenders: string[] = [];
    for (const file of tsFiles(ADMIN_DIR)) {
      const src = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      for (const tpl of sqlTemplates(src)) {
        for (const col of RAW_PII_COLUMNS) {
          if (tpl.includes(col)) {
            offenders.push(`${relative(SRC_DIR, file).replace(/\\/g, "/")}: ${col}`);
          }
        }
      }
    }
    expect(
      offenders,
      `a raw SQL template may not name a PII column. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("...and that raw-SQL rule is CAPABLE of failing on the exact shape it exists to stop", () => {
    // Prove the extractor sees both template forms, and does not fire on a DTO field name that
    // merely looks like a column.
    expect(sqlTemplates("sql<string | null>`full_name`")).toEqual(["full_name"]);
    expect(sqlTemplates("sql`select full_name from workers`")).toEqual([
      "select full_name from workers",
    ]);
    expect(sqlTemplates("const x = { full_name: names.get(id) ?? null };")).toEqual([]);
  });

  it("the decrypt ALLOW-LIST is exactly three files — matched on `.decrypt(`, not on a count", () => {
    // Decryption is the moment PII exists in this process, so the set of places it can happen is
    // pinned as a SET rather than a number. The whole list, and why each is in it:
    //   admin-identity.service  — names, at the response boundary, after the audit row commits
    //   admin-pii-reveal.service— one worker phone, on the reason-gated + flagged route
    //   admin-mfa.store         — the admin's OWN TOTP seed, for verification. Authentication,
    //                             not disclosure: the plaintext never leaves the comparison.
    // A fourth entry has to be a deliberate edit to this list, reviewed as one.
    //
    // TWO THINGS THIS DELIBERATELY IS NOT:
    //  - NOT a COUNT (`toHaveLength(3)` / `<= 3`). A count cannot tell "the identity service was
    //    added" from "the reveal service was replaced by something else", and a `<=` form would
    //    silently admit a fourth the day one of the three stopped decrypting.
    //  - NOT anchored on the RECEIVER name (`pii.decrypt(`). All three happen to call the
    //    injected service `pii` today, so that anchor passes — and would keep passing for a
    //    fourth file that named its dependency `crypto`, `piiCrypto`, or destructured it. The
    //    method call is the invariant; the variable it hangs off is a naming convention.
    //
    // AND NOT ONLY THE METHOD FORM. `apps/api/src/common/crypto.ts` re-exports `decryptPii` and
    // `decryptPiiWithKeyring` as FREE FUNCTIONS, and `SERVER_CONFIG.PII_ENCRYPTION_KEY` is
    // injectable anywhere — so `decryptPii(token, key)` decrypts with no receiver and therefore
    // no leading dot. MEASURED: a new admin file containing exactly that call passed all 77
    // guards before this clause was added. A `.decrypt(`-only anchor proves the RECEIVER was
    // generalised, which was never the hole.
    const DECRYPT_CALL = /\.decrypt\s*\(|\bdecryptPii(?:WithKeyring)?\s*\(/;
    const decrypters = tsFiles(ADMIN_DIR)
      .filter((f) => {
        const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        return DECRYPT_CALL.test(src);
      })
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"))
      .sort();
    expect(decrypters).toEqual(
      [
        "admin/admin-identity.service.ts",
        "admin/admin-mfa.store.ts",
        "admin/admin-pii-reveal.service.ts",
      ].sort(),
    );
  });

  it("...and that allow-list pattern is CAPABLE of failing on a receiver-free decrypt", () => {
    // Prove the widened anchor actually buys something. The receiver cases were the original
    // rationale; the FREE-FUNCTION cases are the ones a real mutation walked through.
    const pattern = /\.decrypt\s*\(|\bdecryptPii(?:WithKeyring)?\s*\(/;
    expect(pattern.test("return this.pii.decrypt(token);")).toBe(true);
    expect(pattern.test("return this.crypto.decrypt(token);")).toBe(true);
    expect(pattern.test("return piiCrypto.decrypt (token);")).toBe(true);
    // The shape that shipped past the previous anchor: no receiver, no dot.
    expect(pattern.test("return decryptPii(token, key);")).toBe(true);
    expect(pattern.test("return decryptPiiWithKeyring(token, keyring);")).toBe(true);
    expect(pattern.test("const { decryptPii } = crypto; decryptPii (t, k);")).toBe(true);
    // ...and does not fire on prose-free code that merely mentions the word, or on the ENCRYPT
    // half — writing a name is not a disclosure and no admin file should be blocked for it.
    expect(pattern.test("const decrypted = false;")).toBe(false);
    expect(pattern.test("return encryptPii(name, key);")).toBe(false);
  });

  it("the identity repository issues no write against any table", () => {
    expect(code(IDENTITY_REPO)).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(code(IDENTITY_REPO)).not.toMatch(/\.select\(\s*\)/); // never an unprojected read
  });

  it("the identity repository projects NO other PII column", () => {
    // It is one id-keyed lookup per table, and each of those tables carries something worse than
    // a name next to it: `phone_e164`/`phone_hash` on workers, four ciphertext columns on
    // payers, and `mfa_secret_enc` — the TOTP seed — on admin_users.
    const src = code(IDENTITY_REPO);
    for (const forbidden of [
      "phoneE164",
      "phoneHash",
      "emailEnc",
      "emailHash",
      "phoneEnc",
      "mfaSecretEnc",
      "photoStorageKey",
    ]) {
      expect(src, `admin-identity.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("EVERY select in the identity repository projects EXACTLY `{id, nameCipher}` — nothing else", () => {
    // The forbidden-list test above is the NEGATIVE half and it can only ever catch the columns
    // somebody thought to name. This is the positive half, and it is the one that holds: the
    // shape is pinned, so a column added here fails whether or not anyone predicted it — a
    // `phoneHash`, a `status`, a `createdAt`, a column that does not exist yet.
    //
    // It also pins the COUNT of projections at three, one per surface, so a fourth lookup cannot
    // arrive without this list being edited.
    const src = code(IDENTITY_REPO);
    const selects = [...src.matchAll(/\.select\(\s*\{([^}]*)\}\s*\)/g)].map((m) =>
      [...m[1]!.matchAll(/(\w+)\s*:/g)].map((k) => k[1]!).sort(),
    );
    expect(selects, "the identity repository must have exactly one select per surface").toHaveLength(
      3,
    );
    for (const keys of selects) {
      expect(keys, `a select projects ${keys.join(", ")}`).toEqual(["id", "nameCipher"]);
    }
  });

  it("...and that projection rule is CAPABLE of failing (a third column is caught)", () => {
    // The rule above is a regex over source, so prove it fires on the exact shape it exists to
    // stop rather than trusting that it would.
    const parse = (s: string) =>
      [...s.matchAll(/\.select\(\s*\{([^}]*)\}\s*\)/g)].map((m) =>
        [...m[1]!.matchAll(/(\w+)\s*:/g)].map((k) => k[1]!).sort(),
      );
    expect(parse(".select({ id: workers.id, nameCipher: workers.fullName })")).toEqual([
      ["id", "nameCipher"],
    ]);
    expect(
      parse(".select({ id: workers.id, nameCipher: workers.fullName, phoneHash: workers.phoneHash })"),
    ).toEqual([["id", "nameCipher", "phoneHash"]]);
  });

  it("the identity repository never SEARCHES by name, and never joins", () => {
    // `WHERE full_name ILIKE ...` would turn an ops console into "find me every worker called
    // X" — a person-discovery tool. It is impossible today (the column is non-deterministic AES
    // ciphertext), which is exactly why a plaintext or hashed sibling must never be added later.
    const src = code(IDENTITY_REPO);
    for (const search of [/\bilike\b/i, /\bto_tsquery\b/i, /\bsimilar\s+to\b/i, /\blike\s*\(/i]) {
      expect(src, "admin-identity.repository must not search a name").not.toMatch(search);
    }
    for (const join of ["innerJoin", "leftJoin", "rightJoin", "fullJoin"]) {
      expect(src, `admin-identity.repository must not ${join}`).not.toContain(join);
    }
  });

  it("the ENTITY and DIRECTORY repositories are still the faceless ones", () => {
    // The ruling added names to those SCREENS, not to those queries. If a future change moves a
    // name column back into either projection, the single-reader assertion above fails — this is
    // the same claim stated positively, so the failure names the file a reviewer must look at.
    for (const file of ["admin-entities.repository.ts", "admin-directory.repository.ts"]) {
      const src = code(file);
      expect(src, `${file} must not project a name`).not.toMatch(
        /fullName|orgNameEnc|nameEnc/,
      );
    }
  });

  /**
   * The route handlers whose response can carry a decrypted name — DERIVED from the source
   * rather than listed, because a hand-kept list is exactly what a new name-bearing route gets
   * left off. A service method that calls `this.identity.resolve(` is a name-bearing read, and
   * both controllers delegate to their service 1:1 by method name.
   */
  function nameBearingHandlers(serviceFile: string): string[] {
    const src = code(serviceFile);
    // Split on the top-level `async name(` markers this codebase's formatting guarantees, and
    // keep the ones whose body reaches the identity layer.
    const parts = src.split(/\n {2}(?:private |protected |public )?async (?=\w+[(<])/);
    return parts
      .slice(1)
      .map((chunk) => ({ name: /^(\w+)/.exec(chunk)?.[1] ?? "", chunk }))
      .filter(({ chunk }) => /this\.identity\.resolve\s*\(/.test(chunk))
      .map(({ name }) => name)
      .sort();
  }

  /** The `Cache-Control` value Nest will set on a handler, or undefined. */
  function cacheControlOf(ctor: { prototype: object }, method: string): string | undefined {
    const headers = (Reflect.getMetadata(
      "__headers__",
      (ctor.prototype as Record<string, object>)[method]!,
    ) ?? []) as Array<{ name: string; value: string }>;
    return headers.find((h) => h.name.toLowerCase() === "cache-control")?.value;
  }

  it("EXACTLY TWO non-test files reach the identity layer (the no-store derivation's own input)", () => {
    // `nameBearingHandlers` derives METHODS from source, which is the right shape — but it is
    // only ever CALLED with two hardcoded filenames, so the derivation is wrapped in exactly the
    // hand-kept list its own header says a hand-kept list is what a new route gets left off.
    //
    // MEASURED: a new `admin-lookup.service.ts` calling `this.identity.resolve(` plus a wired
    // `@Get("lookup")` controller with NO `@Header("Cache-Control", "no-store")`, no page clamp
    // and `ids` taken straight off a query string passed all 77 guards, all 917 admin tests and
    // `tsc --noEmit`. `admin.module.boot.test.ts` uses `toContain`, so registering it was
    // additive too. This closes that: a third caller of the identity layer now fails HERE, and
    // whoever adds it must extend the no-store derivation below in the same edit.
    const callers = tsFiles(ADMIN_DIR)
      .filter((f) => {
        const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        return /this\.identity\.resolve\s*\(/.test(src);
      })
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"))
      .sort();
    expect(
      callers,
      `a new name-bearing service must be added to the no-store derivation below. Callers: ${callers.join(", ")}`,
    ).toEqual(["admin/admin-directory.service.ts", "admin/admin-entities.service.ts"].sort());
  });

  it("the DERIVED name-bearing handler set is exactly the five reads the ruling names", () => {
    // Pinned so the derivation cannot go vacuously empty. If it did, the no-store test below
    // would pass over an empty set and prove nothing — the failure mode that makes a derived
    // assertion worse than a hardcoded one instead of better.
    expect(nameBearingHandlers("admin-entities.service.ts")).toEqual([
      "getPayer",
      "getWorker",
      "listPayers",
      "listWorkers",
    ]);
    expect(nameBearingHandlers("admin-directory.service.ts")).toEqual(["directory"]);
  });

  it("EVERY name-bearing route sets Cache-Control: no-store (the reveal route's Control 8)", () => {
    // Same header, same assertion shape, and the same reason as
    // `POST /admin/workers/:id/reveal-contact`: a response body that may contain decrypted PII
    // must not land in a shared proxy cache, a browser disk cache, or a bfcache entry that
    // outlives the session. DERIVED from which service methods resolve a name, so a name added
    // to a sixth route fails HERE rather than shipping a cacheable page of names.
    for (const method of nameBearingHandlers("admin-entities.service.ts")) {
      expect(cacheControlOf(AdminEntitiesController, method), `${method} must be no-store`).toBe(
        "no-store",
      );
    }
    for (const method of nameBearingHandlers("admin-directory.service.ts")) {
      expect(cacheControlOf(AdminDirectoryController, method), `${method} must be no-store`).toBe(
        "no-store",
      );
    }
  });

  it("the FACELESS entity routes are unchanged — no-store is not sprayed across the controller", () => {
    // The header is a claim about the BODY. Putting it on routes that carry no identity would
    // make it decorative, and the next reviewer could no longer read its presence as "this
    // response may contain PII".
    for (const method of ["getPayerCredits", "listJobPostings", "getJobPosting", "listApplications"]) {
      expect(cacheControlOf(AdminEntitiesController, method), `${method} carries no name`).toBeUndefined();
    }
    expect(cacheControlOf(AdminDirectoryController, "capabilities")).toBeUndefined();
  });

  it("a NAME-BEARING page is clamped to 50, and the clamp equals the service's own bound", () => {
    // Two constants that must never drift: a page clamp ABOVE the service bound would mean a
    // permitted admin silently gets NO names (the service refuses the whole set) rather than a
    // smaller page of them — a control degrading into an outage.
    expect(ADMIN_IDENTITY_PAGE_MAX).toBe(50);
    expect(ADMIN_IDENTITY_PAGE_MAX).toBe(ADMIN_IDENTITY_MAX_SUBJECTS);
    // ...and it really is HALF the faceless ceiling, which is what the ruling asked for.
    expect(ADMIN_ENTITIES_PAGE_MAX).toBe(100);
    expect(ADMIN_IDENTITY_PAGE_MAX).toBeLessThan(ADMIN_ENTITIES_PAGE_MAX);
  });

  it("both name-bearing LIST reads route their page size through the clamp", () => {
    // The clamp is one helper, so the failure this catches is a list read that goes straight to
    // `dto.limit` — which is what the original code did, and what a new list read would copy.
    const src = code("admin-entities.service.ts");
    const parts = src.split(/\n {2}(?:private |protected |public )?async (?=\w+[(<])/).slice(1);
    for (const list of ["listWorkers", "listPayers"]) {
      const chunk = parts.find((p) => p.startsWith(list))!;
      expect(chunk, `${list} must clamp`).toContain("this.effectiveLimit(admin, dto.limit)");
      expect(chunk, `${list} must not pass the raw dto.limit to the repository`).not.toContain(
        "dto.limit + 1",
      );
    }
  });

  it("the identity SERVICE gates on read_identity, not on a route capability", () => {
    // The check cannot be a second decorator (`@RequireAdminRole` sets exactly one capability
    // per route, asserted throughout this file), so it lives in the service — where a scan is
    // the only thing standing between it and being quietly dropped in a refactor.
    const svc = code("admin-identity.service.ts");
    expect(svc).toContain(`can(admin.role, "read_identity")`);
  });
});

describe("#997 feedback route — guarded, read-only, and read_entities-scoped", () => {
  const proto = AdminFeedbackController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminFeedbackController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers EXACTLY the one list route (no detail read, no export, no write)", () => {
    // Structural, not conventional. This is the one admin surface carrying worker-authored
    // free text, so every route added to it widens a PII egress — the assertion exists so
    // that widening has to be a deliberate edit here, not a side effect of adding a method.
    expect(routeMethods.sort()).toEqual(["list"]);
  });

  it("the feedback route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    const guards = effectiveGuards(AdminFeedbackController, "list");
    expect(guards).toContain(AdminAuthGuard.name);
    expect(guards).toContain(AdminRolesGuard.name);
  });

  it("the capability is declared at the METHOD level and is exactly read_entities", () => {
    // Method-level, because a class-level declaration is inherited by every route added
    // later — including one that should have been gated harder.
    const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.list as object) as
      | AdminCapability
      | undefined;
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminFeedbackController) as
      | AdminCapability
      | undefined;
    expect(onMethod).toBe("read_entities");
    expect(onClass, "AdminFeedbackController must NOT declare a class-level capability").toBeUndefined();
  });

  it("the surface is READ-ONLY by construction — the route is a GET", () => {
    expect(Reflect.getMetadata("method", proto.list as object) as number).toBe(0);
  });

  it("the repository issues no write against any table (feedback is append-only)", () => {
    // Feedback is written once, by the worker's own submission, transactionally paired with
    // its `feedback.submitted` event. A write here would mutate system-of-record state with
    // no audit trail — and there is nothing to mutate: the table has no status column.
    const repo = readFileSync(join(ADMIN_DIR, "admin-feedback.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(repo).not.toMatch(/\.select\(\s*\)/); // never an unprojected whole-row read
  });

  it("the repository never joins `workers` and never searches the message body", () => {
    // The two ways this read could quietly stop being what it says it is. A join to `workers`
    // is how an opaque `worker_id` becomes a name; an `ilike` / full-text predicate over
    // `message` turns an ops screen into "find every worker who typed a phone number".
    // Comment lines are stripped first: both files NAME the forbidden constructs in prose,
    // and matching their own documentation would be a test that can never pass.
    const src = readFileSync(join(ADMIN_DIR, "admin-feedback.repository.ts"), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      "",
    );
    for (const forbidden of ["innerJoin", "leftJoin", "rightJoin", "fullJoin", "workers"]) {
      expect(src, `admin-feedback.repository must not reference ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    for (const search of [/\bilike\b/i, /\bto_tsquery\b/i, /\bsimilar\s+to\b/i]) {
      expect(src, "admin-feedback.repository must not search the message body").not.toMatch(
        search,
      );
    }
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

  it("the dashboard repository never projects a NAME column either", () => {
    // The dashboard is COUNTS — the one admin repository that joins across workers, payers and
    // postings, and therefore the easiest place to slide "and the five newest worker names" into
    // a summary card. It has no `AdminIdentityService`, no capability check, no egress cap and
    // no audit row, so a name reaching it would be an UNGATED disclosure on the console's
    // landing page. Named here as well as in the single-reader scan above so the failure points
    // at this file rather than at an aggregate list of readers.
    const src = readFileSync(join(ADMIN_DIR, "admin-dashboard.repository.ts"), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      "",
    );
    for (const forbidden of ["fullName", "orgNameEnc", "nameEnc", "phoneE164", "phoneHash", "emailEnc"]) {
      expect(src, `admin-dashboard.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // ...and the same columns as POSTGRES spells them. The list above anchors on the Drizzle
    // property; this file already prefers a raw `sql` template for nine of its projections, and
    // a `sql<string|null>\`full_name\`` here was measured to pass every guard in this file. The
    // repo-wide `sql`-template scan in the identity block covers this too — restated here so the
    // failure names the file rather than an aggregate.
    for (const forbidden of ["full_name", "org_name_enc", "name_enc", "phone_e164", "email_enc"]) {
      expect(src, `admin-dashboard.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
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
    ]) {
      expect(src, `admin-worker-journey.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    // The whole jsonb blob gets its own rule, because the `"<key>:"` form above is defeated by
    // one rename: `state: chatSessions.conversationState` projects the entire answer map — and
    // every `value_raw` in it — while containing no `conversationState:` substring at all.
    //
    // So match the COLUMN REFERENCE and require that it be immediately consumed by an
    // extraction or a null test. `${chatSessions.conversationState} -> 'ask_counts'` and
    // `${chatSessions.conversationState} IS NOT NULL` pass; any other use — under any alias —
    // fails. Comment lines are already stripped from `src`.
    const bareConversationState =
      /chatSessions\.conversationState(?!\s*\}\s*(->|IS\s+NOT\s+NULL))/i;
    expect(
      bareConversationState.test(src),
      "admin-worker-journey.repository must never project `conversation_state` itself — it " +
        "holds the answer map, whose records carry the worker's verbatim words. Only " +
        "`-> 'ask_counts'`, the status lateral, and an IS NOT NULL test may touch it.",
    ).toBe(false);
  });

  it("...and that conversation_state rule is CAPABLE of failing (an ALIASED projection is caught)", () => {
    // The rule above is the one a rename defeats, so prove it fires on the exact shape the
    // `"conversationState:"` literal it replaced could not see.
    const bareConversationState =
      /chatSessions\.conversationState(?!\s*\}\s*(->|IS\s+NOT\s+NULL))/i;
    expect(bareConversationState.test("state: chatSessions.conversationState,")).toBe(true);
    expect(bareConversationState.test("conversationState: chatSessions.conversationState,")).toBe(
      true,
    );
    // ...and does NOT fire on the two forms the repository legitimately uses.
    expect(
      bareConversationState.test("sql`${chatSessions.conversationState} -> 'ask_counts'`"),
    ).toBe(false);
    expect(
      bareConversationState.test("sql<boolean>`${chatSessions.conversationState} IS NOT NULL`"),
    ).toBe(false);
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
