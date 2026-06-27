import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthGuard } from "./admin-auth.guard";

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
