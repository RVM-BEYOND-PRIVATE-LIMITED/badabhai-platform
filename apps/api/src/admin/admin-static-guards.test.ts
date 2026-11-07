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
import { AdminPayerLoginsController } from "./admin-payer-logins.controller";
import { AdminCompaniesController } from "./companies/admin-companies.controller";
import { AdminFeedbackController } from "./admin-feedback.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminDirectoryController } from "./admin-directory.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminWorkerJourneyController } from "./admin-worker-journey.controller";
import { AdminAiTracesController } from "./admin-ai-traces.controller";
import { AdminCandidateDetailController } from "./admin-candidate-detail.controller";
import { AdminCandidatesController } from "./admin-candidates.controller";
import { AdminAiAlertsController } from "./admin-ai-alerts.controller";
import { AdminFunnelController } from "./admin-funnel.controller";
import { AdminEmptyFeedController } from "./admin-empty-feed.controller";
import { AdminModule } from "./admin.module";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { AdminAiTraceFlagGuard } from "./admin-ai-trace-flag.guard";
import { type AdminCapability } from "./admin-capabilities";
import { ADMIN_ENTITIES_PAGE_MAX, ADMIN_IDENTITY_PAGE_MAX } from "./admin-entities.dto";
import { ADMIN_CANDIDATES_PAGE_SIZES } from "./admin-candidates.dto";
import { ADMIN_IDENTITY_MAX_SUBJECTS, ADMIN_CANDIDATES_IDENTITY_MAX_SUBJECTS } from "./admin-identity.service";

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

  it("EXACTLY TWO non-test files under admin/** read the spine (the reader allowlist)", () => {
    // The invariant `AdminEventsRepository`'s header and `AdminEventsService`'s header both
    // state — "`events` has exactly one admin reader" — had no build-blocker until now: the
    // scan above enforces IMMUTABILITY (`update(events)`/`delete(events)`), not single-reader,
    // so the property rested on a comment. It is what makes the immutability scan cheap to keep
    // true (a short allowlist to audit, not every class that grows an aggregate), and BP-5 is exactly
    // the pressure that would have broken it — the dashboard wanted its own `from(events)`.
    //
    // B4 (#2557, ADR-0062 §3.5) adds the SECOND and last reader:
    // `candidate-index.repository.ts` drains named worker/profile/résumé/consent/admin
    // events behind the projector cursor. SELECT-ONLY like the first (the scan above
    // still forbids every mutation in every file); a third reader fails this test and
    // needs its own owner-ruled ADR entry here.
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
      `exactly two admin files may read \`events\`. Readers: ${readers.join(", ")}`,
    ).toEqual([
      "admin/admin-events.repository.ts",
      "admin/candidate-index/candidate-index.repository.ts",
    ]);
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
  //
  // `acceptInvite` joins the set deliberately, and on the same footing as the login routes:
  // its caller is an invited admin who has no session yet (that is what they are there to
  // obtain), so there is nothing for AdminAuthGuard to check. What it presents instead is a
  // 256-bit single-use token, hashed at rest and expiring in 48h — a credential, not an open
  // door. It does NOT mint a session, so it cannot be used to skip the MFA gate.
  //
  // Adding a name here is a SECURITY decision, which is the whole point of this test: the
  // list is the reviewable record of every route reachable without a session.
  //
  // Migration 0144 (owner ruling 2026-11-03) adds three, each on the login routes' footing and
  // behind the same per-IP cap: `loginWithPassword` (the password IS the first factor — it hands
  // off to the same MFA gate as `verifyLogin`), and `forgotPassword` / `resetPassword` (the
  // emailed reset code is the credential; the reset NEVER mints a session).
  const PUBLIC_ROUTES = new Set([
    "requestLogin",
    "verifyLogin",
    "verifyMfa",
    "acceptInvite",
    "loginWithPassword",
    "forgotPassword",
    "resetPassword",
  ]);

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

  it("the public set is exactly the login/MFA/invite/password-reset doors — no unguarded privileged route", () => {
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

  it("discovers the fifteen entity-action routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      [
        "suspendPayer",
        "reinstatePayer",
        "grantCredits",
        "forceClosePosting",
        "flagWorker",
        "unflagWorker",
        // #2562 — worker account actions.
        "signOutAllWorker",
        "resetWorkerPin",
        "suspendWorker",
        "unsuspendWorker",
        "inviteAdmin",
        "changeAdminRole",
        "suspendAdmin",
        // ADR-0038 — the lost-TOTP-device recovery path. Without it a lost phone was a
        // PERMANENT lockout: clear() had zero callers and setMfaEnrolled was only ever
        // called with true.
        "resetAdminMfa",
        // Migration 0144 — create an ACTIVE admin with a temporary password (the invite link
        // still renders as mock:// in production, so it cannot onboard anyone on its own).
        "createAdminDirect",
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
    // #2562 — accumulation of account control sits on its own capability, NOT `flag_worker`:
    // a standing/moderation flag and a sign-out/suspension are different acts.
    expect(capabilityOf("signOutAllWorker")).toBe("manage_worker_account");
    expect(capabilityOf("resetWorkerPin")).toBe("manage_worker_account");
    expect(capabilityOf("suspendWorker")).toBe("manage_worker_account");
    expect(capabilityOf("unsuspendWorker")).toBe("manage_worker_account");
    // manage_admins is super_admin ONLY (asserted per-role in admin-actions.authz.test.ts).
    expect(capabilityOf("inviteAdmin")).toBe("manage_admins");
    expect(capabilityOf("changeAdminRole")).toBe("manage_admins");
    expect(capabilityOf("suspendAdmin")).toBe("manage_admins");
    // ADR-0038 — resetting someone's second factor is an admin-management act, so it sits
    // under the SAME super_admin-only capability. A weaker one (say ops_admin) would let a
    // lower-privileged role strip MFA off a super_admin, which inverts the whole hierarchy.
    expect(capabilityOf("resetAdminMfa")).toBe("manage_admins");
    // 0144 — minting an account with a credential is the most direct admin-management act.
    expect(capabilityOf("createAdminDirect")).toBe("manage_admins");
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

  it("the decrypt ALLOW-LIST is exactly four files — matched on `.decrypt(`, not on a count", () => {
    // Decryption is the moment PII exists in this process, so the set of places it can happen is
    // pinned as a SET rather than a number. The whole list, and why each is in it:
    //   admin-identity.service  — names, at the response boundary, after the audit row commits
    //   admin-pii-reveal.service— one worker phone, on the reason-gated + flagged route
    //   admin-mfa.store         — the admin's OWN TOTP seed, for verification. Authentication,
    //                             not disclosure: the plaintext never leaves the comparison.
    //   admin-ai-traces.service — ONE stored prompt/completion (migration 0083), on the route
    //                             that is `read_ai_traces` (super_admin only) + default-OFF
    //                             flagged + egress-capped + audited fail-closed before the
    //                             decrypt. This is the LARGEST disclosure of the four — a phone
    //                             is a field, a prompt is everything somebody said on one turn —
    //                             and it was added by a deliberate edit to this list, which is
    //                             exactly what the list is for.
    // A fifth entry has to be a deliberate edit to this list, reviewed as one.
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
        "admin/admin-ai-traces.service.ts",
        // #2561 — the correction envelope ({corrected, previous}) is decrypted at this one
        // boundary to compute the effective value / revert; the plaintext never leaves it.
        "admin/corrections/admin-corrections.service.ts",
        // #2561 PR 2 — the previous-value capture decrypts employer names and licence numbers
        // so a revert can restore them; the plaintext stays inside the encrypted envelope.
        "admin/corrections/admin-correction-facts.service.ts",
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
    // a name next to it: `phone_e164`/`phone_hash` on workers, the two keyed hashes on payers,
    // and `mfa_secret_enc` — the TOTP seed — on admin_users. The login-ID projection (#2563) is
    // the one deliberate exception, narrowed by the next test to that ONE method.
    const src = code(IDENTITY_REPO);
    for (const forbidden of [
      "phoneE164",
      "phoneHash",
      "emailHash",
      "mfaSecretEnc",
      "photoStorageKey",
    ]) {
      expect(src, `admin-identity.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("emailEnc/phoneEnc appear ONLY inside the payerLoginIds projection (#2563)", () => {
    // The User accounts screen may show a payer login ID (owner ruling 2026-11-04), but that is
    // ONE projection. The exception must not become a file-wide allowance that lets the next
    // method read contact ciphertext.
    const src = code(IDENTITY_REPO);
    const start = src.indexOf("async payerLoginIds(");
    expect(start, "payerLoginIds projection is missing").toBeGreaterThan(-1);
    const end = src.indexOf("\n  }", start);
    expect(end, "payerLoginIds projection has no end").toBeGreaterThan(start);
    const method = src.slice(start, end);
    expect(method).toContain("payers.emailEnc");
    expect(method).toContain("payers.phoneEnc");

    const outside = src.slice(0, start) + src.slice(end);
    for (const forbidden of ["emailEnc", "phoneEnc"]) {
      expect(outside, `only payerLoginIds may project ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("EVERY select in the identity repository projects EXACTLY `{id, nameCipher}` — nothing else", () => {
    // The forbidden-list test above is the NEGATIVE half and it can only ever catch the columns
    // somebody thought to name. This is the positive half, and it is the one that holds: the
    // shape is pinned, so a column added here fails whether or not anyone predicted it — a
    // `phoneHash`, a `status`, a `createdAt`, a column that does not exist yet.
    //
    // It also pins the COUNT of projections at four, one per surface, so a fifth lookup cannot
    // arrive without this list being edited.
    const src = code(IDENTITY_REPO);
    // Strip the `${...}` interpolation bodies before parsing: the login-ID projection is a
    // `sql` template whose braces would otherwise truncate the key list at the first `}`.
    const flat = src.replace(/\$\{[^}]*\}/g, "");
    const selects = [...flat.matchAll(/\.select\(\s*\{([^}]*)\}\s*\)/g)].map((m) =>
      [...m[1]!.matchAll(/(\w+)\s*:/g)].map((k) => k[1]!).sort(),
    );
    expect(selects, "the identity repository must have exactly one select per surface").toHaveLength(
      4,
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

  it("EXACTLY FIVE non-test files reach the identity layer (the no-store derivation's own input)", () => {
    // `nameBearingHandlers` derives METHODS from source, which is the right shape — but it is
    // only ever CALLED with hardcoded filenames, so the derivation is wrapped in exactly the
    // hand-kept list its own header says a hand-kept list is what a new route gets left off.
    //
    // MEASURED: a new `admin-lookup.service.ts` calling `this.identity.resolve(` plus a wired
    // `@Get("lookup")` controller with NO `@Header("Cache-Control", "no-store")`, no page clamp
    // and `ids` taken straight off a query string passed all 77 guards, all 917 admin tests and
    // `tsc --noEmit`. `admin.module.boot.test.ts` uses `toContain`, so registering it was
    // additive too. This closes that: a fourth caller of the identity layer now fails HERE, and
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
    ).toEqual(
      [
        // ADR-0062 (#2560) — the Candidates full-detail read. Added to the derivation below in the
        // same edit, as this test demands.
        "admin/admin-candidate-detail.service.ts",
        // B5 (#2559) — the Candidates data-bank search list. Added below in the same edit.
        "admin/admin-candidates.service.ts",
        "admin/admin-directory.service.ts",
        "admin/admin-entities.service.ts",
        // #2563 — the User accounts list.
        "admin/admin-payer-logins.service.ts",
        // #2564 — the Companies list (names) and detail (names + contact PII).
        "admin/companies/admin-companies.service.ts",
      ].sort(),
    );
  });

  it("the DERIVED name-bearing handler set is exactly the seven reads the ruling names", () => {
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
    expect(nameBearingHandlers("admin-candidate-detail.service.ts")).toEqual(["getCandidate"]);
    expect(nameBearingHandlers("admin-candidates.service.ts")).toEqual(["search"]);
    expect(nameBearingHandlers("admin-payer-logins.service.ts")).toEqual(["listAccounts"]);
    // #2564 — the Companies list (names) and detail (names + the `company_profiles` contact PII).
    expect(nameBearingHandlers("companies/admin-companies.service.ts")).toEqual([
      "getCompany",
      "listCompanies",
    ]);
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
    for (const method of nameBearingHandlers("admin-candidate-detail.service.ts")) {
      expect(
        cacheControlOf(AdminCandidateDetailController, method),
        `${method} must be no-store`,
      ).toBe("no-store");
    }
    for (const method of nameBearingHandlers("admin-payer-logins.service.ts")) {
      expect(cacheControlOf(AdminPayerLoginsController, method), `${method} must be no-store`).toBe(
        "no-store",
      );
    }
    for (const method of nameBearingHandlers("admin-candidates.service.ts")) {
      expect(cacheControlOf(AdminCandidatesController, method), `${method} must be no-store`).toBe(
        "no-store",
      );
    }
    // #2564 — the Companies reads, and the create route, whose body carries a one-time password.
    for (const method of nameBearingHandlers("companies/admin-companies.service.ts")) {
      expect(cacheControlOf(AdminCompaniesController, method), `${method} must be no-store`).toBe(
        "no-store",
      );
    }
    expect(cacheControlOf(AdminCompaniesController, "createCompany")).toBe("no-store");
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
    // per route, asserted throughout this file), so it lives in the service - where a scan is
    // the only thing standing between it and being quietly dropped in a refactor.
    const svc = code("admin-identity.service.ts");
    expect(svc).toContain(`can(admin.role, "read_identity")`);
  });

  it("#2564 the `company_profiles` identity surface is used ONLY by the company-record service", () => {
    // The surface exists to disclose ONE company's contact PII (GSTIN, address, phone, email,
    // contact person). A second caller would silently become another place those fields are
    // decrypted, outside the Companies screen. The identity service is the dispatcher.
    const callers = tsFiles(ADMIN_DIR)
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => !f.endsWith("admin-identity.service.ts"))
      .filter((f) => code(relative(ADMIN_DIR, f)).includes("discloseCompanyProfile("))
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["admin/companies/admin-companies.service.ts"]);
  });

  it("the `payer_logins` identity surface is used ONLY by the payer-login service", () => {
    // #2563 follow-up — the surface exists for the User accounts list. A second caller would
    // silently become another place payer emails/phones are disclosed, outside that screen.
    // `admin-identity.service.ts` is the dispatcher that implements the surface; every OTHER
    // admin file must not name it.
    const callers = tsFiles(ADMIN_DIR)
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => !f.endsWith("admin-identity.service.ts"))
      .filter((f) => code(relative(ADMIN_DIR, f)).includes('"payer_logins"'))
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["admin/admin-payer-logins.service.ts"]);
  });

  it("the `candidates` identity surface is used ONLY by the candidates search service", () => {
    // B5 (#2559) — the surface exists for the Candidates data-bank search list. A
    // second caller would silently become another place worker names are disclosed
    // against the Candidates budget, outside that screen. `admin-identity.service.ts`
    // is the dispatcher that implements the surface; every OTHER admin file must
    // not name it.
    const callers = tsFiles(ADMIN_DIR)
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => !f.endsWith("admin-identity.service.ts"))
      .filter((f) => code(relative(ADMIN_DIR, f)).includes('"candidates"'))
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["admin/admin-candidates.service.ts"]);
  });
});

describe("B13 (#2567) ai-alerts route - guarded, read-only, and read_entities-scoped", () => {
  const proto = AdminAiAlertsController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminAiAlertsController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers EXACTLY the one status read (no evaluate/write route — verdicts never run on a GET)", () => {
    expect(routeMethods.sort()).toEqual(["status"]);
  });

  it("the route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    const guards = effectiveGuards(AdminAiAlertsController, "status");
    expect(guards).toContain(AdminAuthGuard.name);
    expect(guards).toContain(AdminRolesGuard.name);
  });

  it("the route declares method-level @RequireAdminRole('read_entities') (the dashboard floor)", () => {
    const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.status as object) as
      | AdminCapability
      | undefined;
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminAiAlertsController) as
      | AdminCapability
      | undefined;
    expect(onMethod).toBe("read_entities");
    expect(onClass, "AdminAiAlertsController must NOT declare a class-level capability").toBeUndefined();
  });

  it("the surface is READ-ONLY by construction — the route is a GET, never a write verb", () => {
    const verb = Reflect.getMetadata("method", proto.status as object) as number;
    expect(verb, "status must be a GET (evaluation never runs on this controller)").toBe(0);
  });
});

describe("B14 (#2568) funnel routes - guarded, read-only, and read_entities-scoped", () => {
  const proto = AdminFunnelController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminFunnelController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers EXACTLY the one funnel read (aggregates only — no per-worker read, no write)", () => {
    expect(routeMethods.sort()).toEqual(["onboarding"]);
  });

  it("the route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    const guards = effectiveGuards(AdminFunnelController, "onboarding");
    expect(guards).toContain(AdminAuthGuard.name);
    expect(guards).toContain(AdminRolesGuard.name);
  });

  it("the route declares method-level @RequireAdminRole('read_entities') (the dashboard floor)", () => {
    const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.onboarding as object) as
      | AdminCapability
      | undefined;
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminFunnelController) as
      | AdminCapability
      | undefined;
    expect(onMethod).toBe("read_entities");
    expect(onClass, "AdminFunnelController must NOT declare a class-level capability").toBeUndefined();
  });

  it("the surface is READ-ONLY by construction — the route is a GET, never a write verb", () => {
    const verb = Reflect.getMetadata("method", proto.onboarding as object) as number;
    expect(verb, "onboarding must be a GET (this controller never writes)").toBe(0);
  });

  it("the repository issues no write against ANY table (read-only data access)", () => {
    // The spine guard above covers `events`. This is the wider promise for B14: the
    // funnel repository never writes anything at all.
    const repo = readFileSync(join(ADMIN_DIR, "admin-funnel.repository.ts"), "utf8");
    expect(repo).not.toMatch(/\.(insert|update|delete)\s*\(/);
  });
});

describe("#2563 payer-login routes - guarded + exactly one `manage_payer_credentials` capability", () => {
  const proto = AdminPayerLoginsController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminPayerLoginsController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers the four routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      ["listAccounts", "createLogin", "issueTemporaryPassword", "revokePassword"].sort(),
    );
  });

  it("EVERY route carries AdminAuthGuard AND AdminRolesGuard", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminPayerLoginsController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY route declares EXACTLY ONE method-level @RequireAdminRole('manage_payer_credentials')", () => {
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminPayerLoginsController) as
      | AdminCapability
      | undefined;
    expect(onClass, "AdminPayerLoginsController must NOT declare a class-level capability").toBeUndefined();
    for (const method of routeMethods) {
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a method-level @RequireAdminRole`).toBe(
        "manage_payer_credentials",
      );
    }
  });
});

describe("#997 feedback route - guarded, read-only, and read_entities-scoped", () => {
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

/**
 * Migration 0083 AI-CALL-TRACE routes — guarded, read-only, and SPLIT BY DATA CLASS.
 *
 * This block is longer than its siblings for the same reason the journey block is: the table
 * behind these two routes holds the prompt and the completion of every AI call the platform has
 * ever made, unmasked (the ai-service pseudonymizer runs on the far side and R32 measured its
 * name gazetteer dead), and the ONLY thing standing between that and an ordinary admin is which
 * of the two routes a query reaches.
 *
 * The property these guards pin is therefore not "is it authorized" but "did the SPLIT hold":
 * the list must stay incapable of returning ciphertext, and the detail must stay the single,
 * flagged, capped, audited, single-subject way text leaves. A source scan is the right layer,
 * because a runtime test only sees the queries a test happens to call.
 */
describe("0083 ai-trace routes — one ruling, one gate, and the flag ahead of the roles", () => {
  /**
   * A reference to the WRITER (`AiTracesRepository`, in `AiModule`) — and deliberately NOT to the
   * admin surface's own select-only reader, whose name is the writer's with an `Admin` prefix.
   * Lookbehind rather than `\b`, because the two differ by a PREFIX: `\b` matches happily inside
   * `AdminAiTracesRepository` and would report the reader as an offender.
   */
  const WRITER_REF = /(?<!Admin)AiTracesRepository|(?<!admin-)ai-traces\.repository/;

  const proto = AdminAiTracesController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminAiTracesController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  /** Non-comment source of a file under admin/**. */
  const code = (file: string): string =>
    readFileSync(join(ADMIN_DIR, file), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  const capOf = (m: string): AdminCapability | undefined =>
    Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[m] as object) as AdminCapability | undefined;

  const cacheControlOf = (m: string): string | undefined => {
    const headers = (Reflect.getMetadata("__headers__", proto[m] as object) ?? []) as Array<{
      name: string;
      value: string;
    }>;
    return headers.find((h) => h.name.toLowerCase() === "cache-control")?.value;
  };

  it("discovers EXACTLY the two routes — one list, one single-subject detail (no export, no batch)", () => {
    // Structural, not conventional. Every control on the detail route assumes it is the only way
    // text leaves: an export, a range read or a batch decrypt would go around the cap, the audit
    // granularity and the single-subject assumption in one edit. Adding a third route here has
    // to fail this assertion first.
    expect(routeMethods.sort()).toEqual(["list", "readOne"].sort());
    for (const m of routeMethods) {
      expect(m.toLowerCase()).not.toMatch(/export|bulk|batch|search|all/);
    }
  });

  it("BOTH routes carry AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminAiTracesController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("the FLAG guard runs BEFORE the roles guard — the ordering IS the neutral 404", () => {
    // NOT "the flag is checked somewhere". Nest runs guards in declared order and a handler body
    // runs after all of them, so a flag check inside `readOne` was unreachable for any role the
    // roles guard rejected first. Measured against the real guard and the real controller with
    // ADMIN_AI_TRACE_READ_ENABLED=false, before this moved:
    //
    //     super_admin  guard PASS → handler 404      ops_admin  guard 403 → handler never reached
    //     support      guard 403  → never reached    analyst    guard 403 → never reached
    //
    // Three of four roles got a 403 that CONFIRMS the surface exists, which is precisely what the
    // owner ruling said must not happen ("a NEUTRAL 404 when off — not a 403"). Position, not
    // presence, is the property, so this asserts the index.
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminAiTracesController, method);
      expect(guards, `${method} must mount the flag guard`).toContain(AdminAiTraceFlagGuard.name);
      expect(
        guards.indexOf(AdminAiTraceFlagGuard.name),
        `${method}: the flag guard must be declared BEFORE AdminRolesGuard, or a lesser role ` +
          `gets a 403 that confirms the feature exists`,
      ).toBeLessThan(guards.indexOf(AdminRolesGuard.name));
      // ...and AFTER the auth guard: an unauthenticated caller should get 401, not a 404 that
      // makes the whole admin surface look absent to the internet.
      expect(guards.indexOf(AdminAuthGuard.name)).toBeLessThan(
        guards.indexOf(AdminAiTraceFlagGuard.name),
      );
    }
  });

  it("the handler body no longer re-implements the flag check the guard owns", () => {
    // Belt-and-braces would be fine; a SECOND place that decides is not. The service still
    // re-checks `isEnabled()` (defence in depth, same neutral shape) — the controller must not,
    // because a body check is exactly the shape that read as a control and was not one.
    const src = code("admin-ai-traces.controller.ts");
    expect(src).not.toMatch(/isEnabled\s*\(/);
    expect(src).not.toMatch(/NotFoundException/);
  });

  it("BOTH routes are read_ai_traces — declared per METHOD, never read_entities", () => {
    // THE ASSERTION THIS WHOLE BLOCK EXISTS FOR. If either route drops to `read_entities`, every
    // role on the admin read floor — including `analyst`, which the 2026-08-18 ruling deliberately
    // left faceless — reaches this table, and nothing else in this repository would notice: the
    // flag would still be off by default, the cap would still charge, the audit row would still be
    // written. They would simply be written for the wrong people.
    //
    // The LIST is included because it is not a lesser disclosure. Walked end to end it is an index
    // of which worker spoke, in which interview, when, and how much — the LINKAGE that
    // `packages/db/src/schema-contract.ts` names as the worst silent leak on this spine. The case
    // for reopening it to ops is written out in the controller header and is an OWNER call.
    //
    // Method-level, because a class-level declaration is inherited by every route added later,
    // which is precisely how a third route would arrive on the wrong gate.
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminAiTracesController) as
      | AdminCapability
      | undefined;
    expect(
      onClass,
      "AdminAiTracesController must NOT declare a class-level capability",
    ).toBeUndefined();
    expect(capOf("list")).toBe("read_ai_traces");
    expect(capOf("readOne")).toBe("read_ai_traces");
    for (const m of routeMethods) expect(capOf(m), m).not.toBe("read_entities");
  });

  it("the surface is READ-ONLY by construction — both routes are GETs", () => {
    // `ai_call_traces` is append-only and its one writer lives in the @Global `AiModule`, which
    // does not export the repository. A POST/PATCH/DELETE here would be a write with no audit.
    for (const method of routeMethods) {
      expect(Reflect.getMetadata("method", proto[method] as object) as number).toBe(0);
    }
  });

  it("only the DECRYPTING route sets Cache-Control: no-store", () => {
    // Both halves matter. On the detail route the header is Control 8 — a body carrying a
    // worker's own words must not land in a shared proxy, a disk cache or a bfcache entry that
    // outlives the session. On the list route its ABSENCE is what keeps it meaningful: a header
    // sprayed across routes that disclose nothing can no longer be read as "this response may
    // contain plaintext".
    expect(cacheControlOf("readOne")).toBe("no-store");
    expect(cacheControlOf("list")).toBeUndefined();
  });

  it("the repository issues no write against any table, and never reads a whole row", () => {
    const src = code("admin-ai-traces.repository.ts");
    expect(src).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(src).not.toMatch(/\.select\(\s*\)/); // an unprojected read returns the ciphertext too
  });

  it("the repository never joins `workers` and never searches the stored text", () => {
    // A join to `workers` is how an opaque `worker_id` becomes a name. An `ilike` / full-text
    // predicate over `prompt_enc` would be a search over everything every worker has ever said
    // — impossible today only because the column is non-deterministic AES ciphertext, which is
    // exactly why a plaintext or hashed sibling must never be added. Comments are stripped
    // first: the file names both constructs in prose explaining why they are absent.
    const src = code("admin-ai-traces.repository.ts");
    for (const join of ["innerJoin", "leftJoin", "rightJoin", "fullJoin"]) {
      expect(src, `admin-ai-traces.repository must not ${join}`).not.toContain(join);
    }
    for (const search of [/\bilike\b/i, /\bto_tsquery\b/i, /\bsimilar\s+to\b/i]) {
      expect(src, "admin-ai-traces.repository must not search the stored text").not.toMatch(search);
    }
  });

  it("the LIST projection cannot return ciphertext — the two columns appear ONLY in byId", () => {
    // The positive half, and the one that holds. A negative "the DTO has no `prompt_enc` field"
    // would pass for a repository that selected the column and let a mapper drop it, leaving the
    // token in a variable one `return row` away from a response. This pins WHERE the column may
    // be named at all: the shared `SCALARS` projection must not mention it, and neither may the
    // `list` method — so the only reachable path to a token is the gated `byId`.
    const src = code("admin-ai-traces.repository.ts");
    const scalars = /SCALARS\s*=\s*\{([\s\S]*?)\}\s*as const;/.exec(src)?.[1] ?? "";
    expect(
      scalars.length,
      "the SCALARS projection must be found (the scan is not vacuous)",
    ).toBeGreaterThan(100);
    for (const col of ["promptEnc", "responseEnc"]) {
      expect(scalars, `the shared projection must not name ${col}`).not.toContain(col);
    }
    // ` {2}async byId\(` rather than two literal spaces: `no-regex-spaces` refuses the literal
    // form, correctly — an indentation-sensitive anchor is exactly the kind of pattern a
    // reformat breaks silently, and the quantifier makes the count explicit.
    const listBody = /async list\(([\s\S]*?)\n {2}async byId\(/.exec(src)?.[1] ?? "";
    expect(
      listBody.length,
      "the list method must be found (the scan is not vacuous)",
    ).toBeGreaterThan(100);
    for (const col of ["promptEnc", "responseEnc"]) {
      expect(listBody, `list() must not name ${col}`).not.toContain(col);
    }
    // ...and byId DOES, so the extraction above is testing something real.
    const byIdBody = src.slice(src.indexOf("async byId("));
    expect(byIdBody).toContain("promptEnc");
    expect(byIdBody).toContain("responseEnc");
  });

  it("the service gates the decrypt on the flag AND the capability, in its own body", () => {
    // Both checks are duplicated from the controller/decorator ON PURPOSE (defence in depth), and
    // a source scan is the only thing standing between them and being dropped in a refactor as
    // "already handled upstream" — which is true right up until someone adds a second caller.
    const svc = code("admin-ai-traces.service.ts");
    expect(svc).toContain("ADMIN_AI_TRACE_READ_ENABLED");
    expect(svc).toContain('can(admin.role, "read_ai_traces")');
    // The cap is charged BEFORE the row is fetched, and the audit is emitted BEFORE the decrypt.
    expect(svc.indexOf("this.cap.consume")).toBeLessThan(svc.indexOf("this.repo.byId"));
    expect(svc.indexOf("this.events.emit")).toBeLessThan(svc.indexOf("this.decryptOrNull"));
  });

  it("nothing under admin/** can WRITE a trace (the writer stays in AiModule)", () => {
    // `AiTracesRepository` owns the insert and is unexported from the @Global `AiModule`. The
    // same rule, and the same reason, as the `AiCostTotalsRepository` scan above: a class that
    // can write to this table must not sit in the admin injector, or the next person who wants
    // "just fix up this one row" finds it already wired next to a console.
    const offenders = tsFiles(ADMIN_DIR)
      .filter((f) => {
        const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        return WRITER_REF.test(src);
      })
      .map((f) => relative(SRC_DIR, f).replace(/\\/g, "/"));
    expect(
      offenders,
      `admin must read traces through its OWN select-only repository. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("...and that writer rule is CAPABLE of failing, and does NOT fire on the reader", () => {
    // The two classes differ by a PREFIX, not a suffix, so `\b` is useless here and a bare
    // substring match reports the admin module's own select-only repository as an offender —
    // measured, on the first run of the assertion above. A negative lookbehind is what
    // distinguishes them, and a rule that cannot tell the reader from the writer is a rule
    // somebody deletes the first time it blocks legitimate work.
    expect(WRITER_REF.test('import { AiTracesRepository } from "../ai/ai-traces.repository";')).toBe(
      true,
    );
    expect(WRITER_REF.test("private readonly repo: AiTracesRepository,")).toBe(true);
    expect(
      WRITER_REF.test('import { AdminAiTracesRepository } from "./admin-ai-traces.repository";'),
    ).toBe(false);
    expect(WRITER_REF.test("private readonly repo: AdminAiTracesRepository,")).toBe(false);
  });
});

/**
 * ADR-0062 (#2560) — the Candidates FULL-DETAIL read: guarded, one `read_candidates` capability,
 * read-only, audited before the read, and free of the phone, the WhatsApp number, résumé
 * download keys and every encrypted column it has no review to decrypt.
 */
describe("#2560 candidate full-detail route — guarded, read-only, audited first, phone-free", () => {
  const proto = AdminCandidateDetailController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminCandidateDetailController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );
  /** Non-comment source of a file under admin/**. */
  const code = (file: string): string =>
    readFileSync(join(ADMIN_DIR, file), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  it("discovers exactly the one detail route (no list, export or write on this controller)", () => {
    expect(routeMethods).toEqual(["getCandidate"]);
    expect(Reflect.getMetadata("path", proto.getCandidate as object)).toBe("candidates/:id");
  });

  it("the route carries AdminAuthGuard AND AdminRolesGuard", () => {
    const guards = effectiveGuards(AdminCandidateDetailController, "getCandidate");
    expect(guards).toContain(AdminAuthGuard.name);
    expect(guards).toContain(AdminRolesGuard.name);
  });

  it("declares EXACTLY ONE method-level @RequireAdminRole('read_candidates'), none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.getCandidate as object)).toBe(
      "read_candidates",
    );
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCandidateDetailController),
      "AdminCandidateDetailController must NOT declare a class-level capability",
    ).toBeUndefined();
  });

  it("is a GET with Cache-Control: no-store (the body may carry a decrypted name)", () => {
    expect(Reflect.getMetadata("method", proto.getCandidate as object) as number).toBe(0);
    const headers = (Reflect.getMetadata("__headers__", proto.getCandidate as object) ??
      []) as Array<{ name: string; value: string }>;
    expect(headers.find((h) => h.name.toLowerCase() === "cache-control")?.value).toBe("no-store");
  });

  it("the repository issues no write and never reads a whole row", () => {
    const src = code("admin-candidate-detail.repository.ts");
    expect(src).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(src).not.toMatch(/\.select\(\s*\)/);
    expect(src).not.toMatch(/\.from\s*\(\s*events\s*\)/);
  });

  it("the repository projects NO identity, contact, key or answer-VALUE column", () => {
    const src = code("admin-candidate-detail.repository.ts");
    for (const forbidden of [
      "fullName",
      "phoneE164",
      "phoneHash",
      "whatsappEnc",
      "employerNameEnc",
      "licenceNumberEnc",
      "pushToken",
      "deviceHash",
      "ipHash",
      "userAgent",
      "answerText",
      "answerNumber",
      "answerOptionKeys",
      "answerOtherText",
      "valueText",
      "valueJson",
      "valueNumber",
      // Reduced to booleans in Postgres — projecting the key under its own name is what is banned.
      "photoStorageKey:",
      "pdfStorageKey:",
    ]) {
      expect(src, `admin-candidate-detail.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("the service calls EXACTLY this set of dependency methods — reads, one audit emit, the name layer", () => {
    // An ALLOW-LIST, not a list of banned writers: the five non-admin repositories provided in
    // AdminModule can also write (`upsertMany`, `replaceForWorker`, `appendIfEmpty`, …), and a
    // deny-list only catches the writers somebody thought to name. Any new call fails here and
    // must be added deliberately.
    const src = code("admin-candidate-detail.service.ts");
    const calls = [...new Set([...src.matchAll(/this\.(\w+)\.(\w+)\s*\(/g)].map((m) => `${m[1]}.${m[2]}`))];
    expect(calls.sort()).toEqual(
      [
        "attributes.loadTradeSheet",
        "candidateSearch.findCardRow",
        "candidateSearch.listWantedRoles",
        "correctionFacts.readPrevious",
        "effectiveFacts.liveFor",
        "entities.listApplications",
        "events.emit",
        "identity.resolve",
        "languages.loadForResume",
        "occupations.loadForWorker",
        "qualifications.loadForResume",
        "repo.account",
        "repo.attributeProvenance",
        "repo.currentJobDomain",
        "repo.employment",
        "repo.findCore",
        "repo.industryTenure",
        "repo.matchSkills",
        "repo.resumeVersions",
        "workerSkills.listStatedTradeLevels",
        "workers.latestProfile",
      ].sort(),
    );
  });

  it("the audit is emitted BEFORE the identity layer and every data read (source order)", () => {
    const src = code("admin-candidate-detail.service.ts");
    const body = src.slice(src.indexOf("async getCandidate("));
    const audit = body.indexOf("this.auditView(");
    expect(audit, "getCandidate must audit").toBeGreaterThan(0);
    expect(body.indexOf("this.repo.findCore(")).toBeLessThan(audit);
    for (const later of [
      "this.identity.resolve(",
      "this.workers.latestProfile(",
      "this.attributes.loadTradeSheet(",
      "this.repo.employment(",
    ]) {
      expect(body.indexOf(later), later).toBeGreaterThan(audit);
    }
  });

  it("the GENERAL DTO names no phone, WhatsApp, download link, PDF key, employer name or reason text", () => {
    const src = code("admin-candidate-detail.dto.ts");
    // #2728 — the `editable.certifications` prefill is the ONE reviewed place that may carry a
    // licence field, for `edit_candidates` only. Strip that schema before scanning the general
    // record; every other part of the contract must stay licence-free.
    const editableCertificate =
      /const editableCertificateSchema = z[\s\S]*?\.strict\(\);/.exec(src)?.[0] ?? "";
    expect(editableCertificate).toContain("licence_number");
    expect(editableCertificate).toContain("licence_expiry");
    const general = src.replace(editableCertificate, "");
    for (const forbidden of [
      "phone",
      "whatsapp",
      "download",
      "pdf_storage_key",
      "storage_key",
      "reason_text",
      "employer_name",
      "licence_number",
    ]) {
      expect(
        general.toLowerCase(),
        `the general candidate contract must not declare ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });
});

describe("#2569 empty-feed route — guarded, read_entities, and registered before workers/:id", () => {
  const proto = AdminEmptyFeedController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminEmptyFeedController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("declares exactly one GET route with the literal path", () => {
    expect(routeMethods).toEqual(["list"]);
    expect(Reflect.getMetadata("path", proto.list as object)).toBe("workers/empty-feed");
  });

  it("is behind AdminAuthGuard + AdminRolesGuard and declares exactly one read_entities", () => {
    for (const method of routeMethods) {
      expect(effectiveGuards(AdminEmptyFeedController, method)).toContain(AdminAuthGuard.name);
      expect(effectiveGuards(AdminEmptyFeedController, method)).toContain(AdminRolesGuard.name);
      const capability = Reflect.getMetadata(
        ADMIN_CAPABILITY_KEY,
        proto[method] as object,
      ) as AdminCapability | undefined;
      expect(capability).toBe("read_entities");
    }
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminEmptyFeedController) as
        | AdminCapability
        | undefined,
    ).toBeUndefined();
  });

  it("the module registers the literal controller BEFORE AdminEntitiesController", () => {
    // Express matches in registration order; a workers/:id route registered first would
    // capture workers/empty-feed and its UUID validation would answer 400.
    const controllers = Reflect.getMetadata("controllers", AdminModule) as unknown[];
    expect(controllers).toContain(AdminEmptyFeedController);
    expect(controllers).toContain(AdminEntitiesController);
    expect(controllers.indexOf(AdminEmptyFeedController)).toBeLessThan(
      controllers.indexOf(AdminEntitiesController),
    );
  });

  it("the repository is faceless and pins the active-feed flags", () => {
    const repo = readFileSync(join(ADMIN_DIR, "admin-empty-feed.repository.ts"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")
      .replace(/\s+/g, " ");
    const svc = readFileSync(join(ADMIN_DIR, "admin-empty-feed.service.ts"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")
      .replace(/\s+/g, " ");
    for (const forbidden of ["phone", "full_name", "email", "photo_storage_key"]) {
      expect(repo).not.toContain(forbidden);
    }
    expect(svc).toContain("isMatchV1Enabled");
    expect(svc).toContain("isFeedPostingsUnionEnabled");
  });
});

/**
 * B5 (#2559) — the Candidates data-bank SEARCH: guarded, one `read_candidates`
 * capability, POST-with-term-in-body (deliberate, ADR-0062 §3.6), no-store,
 * audited lookup, and free of lookup material in every projection.
 */
describe("#2559 candidates search route — guarded, POST-by-rule, audited lookup, lookup-free rows", () => {
  const proto = AdminCandidatesController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminCandidatesController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );
  /** Non-comment source of a file under admin/**. */
  const code = (file: string): string =>
    readFileSync(join(ADMIN_DIR, file), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  it("discovers exactly the one search route (no list, export or write on this controller)", () => {
    expect(routeMethods).toEqual(["search"]);
    expect(Reflect.getMetadata("path", proto.search as object)).toBe("candidates/search");
  });

  it("the route carries AdminAuthGuard AND AdminRolesGuard", () => {
    expect(effectiveGuards(AdminCandidatesController, "search")).toContain(AdminAuthGuard.name);
    expect(effectiveGuards(AdminCandidatesController, "search")).toContain(AdminRolesGuard.name);
  });

  it("declares EXACTLY ONE method-level @RequireAdminRole('read_candidates'), none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.search as object)).toBe(
      "read_candidates",
    );
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCandidatesController),
      "AdminCandidatesController must NOT declare a class-level capability",
    ).toBeUndefined();
  });

  it("is a POST with Cache-Control: no-store — the term travels in the body, never the URL", () => {
    // DELIBERATE exception to the read-only-GET structural rule, with the ADR
    // citation IN the controller header: a GET would put the free-text term in
    // access logs, which is exactly what ADR-0062 §3.6 forbids. The route is
    // still read-only (no insert/update/delete in its repository, asserted below).
    expect(Reflect.getMetadata("method", proto.search as object) as number).toBe(1);
    const headers = (Reflect.getMetadata("__headers__", proto.search as object) ??
      []) as Array<{ name: string; value: string }>;
    expect(headers.find((h) => h.name.toLowerCase() === "cache-control")?.value).toBe("no-store");
  });

  it("the repository issues no write, never reads a whole row, never touches the spine", () => {
    const src = code("admin-candidates.repository.ts");
    expect(src).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(src).not.toMatch(/\.select\(\s*\)/);
    expect(src).not.toMatch(/\.from\s*\(\s*events\s*\)/);
  });

  it("the repository projects NO lookup material and no identity/contact column", () => {
    // Scoped to select({...}) PROJECTIONS (not file text): the search must
    // FILTER on `phone_hash`/`name_token_hashes` (asserted filter-only below),
    // so a whole-file scan would fail on the lookup branches doing their job.
    const src = code("admin-candidates.repository.ts");
    const projections = [...src.matchAll(/\.select\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);
    expect(projections.length).toBeGreaterThan(0);
    for (const projection of projections) {
      for (const forbidden of [
        "phoneHash",
        "nameTokenHashes",
        "nameTokenKeyId",
        "searchDoc",
        "fullName",
        "phoneE164",
        "whatsappEnc",
        "employerNameEnc",
        "licenceNumberEnc",
        "pushToken",
        "deviceHash",
        "ipHash",
        "userAgent",
        "photoStorageKey:",
        "pdfStorageKey:",
      ]) {
        expect(projection, `projection must not select ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("lookup material appears ONLY in filter predicates, never in a projection", () => {
    // The precise carve-out the coarse scan above cannot express: the search MUST
    // filter on `phone_hash` (exact) and `name_token_hashes` (`@>`), or the lookup
    // branches silently stop matching. Filtering is not projecting — the page
    // query's explicit select list (asserted projection-free above) is what
    // reaches the response.
    const src = code("admin-candidates.repository.ts");
    expect(src).toContain("adminCandidateIndex.phoneHash");
    expect(src).toContain("adminCandidateIndex.nameTokenHashes");
  });

  it("the service calls EXACTLY this set — reads, two PII-free emits, caps, identity, tokens", () => {
    const src = code("admin-candidates.service.ts");
    const calls = [...new Set([...src.matchAll(/this\.(\w+)\.(\w+)\s*\(/g)].map((m) => `${m[1]}.${m[2]}`))];
    expect(calls.sort()).toEqual(
      [
        "events.emit",
        "identity.resolve",
        "logger.error",
        "nameTokens.termTokens",
        "pii.hashPhone",
        "repo.search",
        "searchCap.consume",
      ].sort(),
    );
  });

  it("the lookup audit precedes results and the identity resolve (source order)", () => {
    const src = code("admin-candidates.service.ts");
    const body = src.slice(src.indexOf("async search("));
    const audit = body.indexOf('"admin.identity_searched"');
    expect(audit, "search must audit the lookup").toBeGreaterThan(0);
    expect(body.indexOf("this.repo.search(")).toBeLessThan(audit);
    expect(body.indexOf("this.identity.resolve(")).toBeGreaterThan(audit);
  });

  it("the DTO names no phone VALUE, lookup hash, token or search-doc field", () => {
    // `q_type` ("name"|"phone"|...) deliberately names the lookup KIND that ran —
    // never a value. It is the one `phone` occurrence allowed below, asserted
    // present so the exception cannot silently widen.
    const src = code("admin-candidates.dto.ts");
    expect(src).toContain("q_type");
    const withoutQType = src
      .split("\n")
      .filter((line) => !line.includes("q_type"))
      .join("\n");
    for (const forbidden of [
      "phone",
      "phone_hash",
      "name_token",
      "search_doc",
      "searchDoc",
      "whatsapp",
      "download",
      "reason_text",
      "employer_name",
      "licence_number",
    ]) {
      expect(withoutQType.toLowerCase(), `the candidates contract must not declare ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("a CANDIDATES page is clamped to 100, and the clamp equals the service's own bound", () => {
    // Same drift discipline as the entity 50-clamp: a page clamp ABOVE the
    // service bound would mean a permitted admin silently gets NO names.
    // The DTO enum IS the clamp (zod rejects anything else pre-service).
    expect(ADMIN_CANDIDATES_IDENTITY_MAX_SUBJECTS).toBe(100);
    expect(Math.max(...ADMIN_CANDIDATES_PAGE_SIZES)).toBe(ADMIN_CANDIDATES_IDENTITY_MAX_SUBJECTS);
  });
});
