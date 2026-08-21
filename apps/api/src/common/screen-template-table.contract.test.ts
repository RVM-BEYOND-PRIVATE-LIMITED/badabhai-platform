import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { WORKER_APP_SCREEN_TEMPLATES } from "@badabhai/types";

import { resolveScreenTemplate } from "./screen-context";

/**
 * THE DIVERGENCE GATE FOR THE SCREEN ALLOWLIST.
 *
 * ── THE FAILURE THIS EXISTS TO MAKE IMPOSSIBLE ──────────────────────────────────────────
 * `resolveScreenTemplate` answers with a constant from `WORKER_APP_SCREEN_TEMPLATES` or `null`,
 * which is what keeps client-chosen bytes out of the `worker_feedback` row, the
 * `feedback.submitted` event and the API log (CLAUDE.md §2). An allowlist buys that guarantee
 * with a maintenance obligation, and the obligation has exactly one failure mode:
 *
 *   the app adds a screen → this table does not know it → that screen reports "unknown" FOREVER
 *   → every test stays green, no error is logged on the write path, and the only evidence is a
 *   gap in an admin list nobody is auditing.
 *
 * A silent, permanent loss of telemetry is not something to leave to a code-review habit,
 * especially across a language boundary where the two halves ship from different teams
 * (CLAUDE.md §5/§6). So the route table is READ FROM THE APP and checked here: adding a screen
 * to `router.dart` without adding it to `@badabhai/types` reddens CI in the PR that does it.
 *
 * ── WHY IT READS THE DART RATHER THAN A HAND-KEPT LIST ──────────────────────────────────
 * A second hand-written copy of the routes would drift in exactly the way this test exists to
 * catch. `router.dart` is the app's own source of truth; the `Routes` class constants in it are
 * what every `context.go(...)` call site navigates by, so a stale constant BREAKS THE APP and
 * cannot sit there unnoticed. That is what makes them safe to treat as authoritative rather than
 * re-deriving full paths from the `GoRoute` nesting, which would need a Dart parser and would
 * be fragile in the direction that produces false reds — the kind of test that gets deleted.
 *
 * ── AND WHY IT DOES NOT MODIFY THE APP ──────────────────────────────────────────────────
 * This is a backend test about the SERVER's allowlist. It only reads. Frontend/mobile changes
 * belong to the frontend owner (CLAUDE.md §5).
 *
 * ⚠ A MISSING FILE IS A FAILURE, NOT A SKIP. If the app moves, this test must go red and be
 * repointed — silently passing because the contract could not be found is the same silent hole
 * in a different place.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const ROUTER_DART = join(REPO_ROOT, "apps", "worker-app", "lib", "router.dart");

const routerSource = readFileSync(ROUTER_DART, "utf8");

/**
 * `static const String jobDetail = '/jobs/detail';` → `/jobs/detail`.
 *
 * `\s*` across the `=` because the formatter wraps long declarations onto the next line
 * (`appliedJobs` is one) — a regex that assumed one line would silently under-count, which is
 * the failure this whole file is about.
 */
const ROUTE_CONSTANTS: readonly string[] = [
  ...routerSource.matchAll(/static const String \w+\s*=\s*'([^']*)'/g),
].map((m) => m[1]!);

/**
 * Every `path:` argument of a `GoRoute`, as written: either `Routes.<name>` or a string literal.
 * Used as a COUNT and as a set of literals — see the tests for why each is checked separately.
 */
const ROUTE_PATH_ARGUMENTS: readonly string[] = [
  ...routerSource.matchAll(/\bpath:\s*(?:Routes\.(\w+)|'([^']*)')/g),
].map((m) => m[1] ?? m[2]!);

/** The relative sub-paths, which are meaningless without the parent they hang off. */
const RELATIVE_SUBPATHS: readonly string[] = [
  ...routerSource.matchAll(/\bpath:\s*'([^'/][^']*)'/g),
].map((m) => m[1]!);

describe("the screen table is the worker app's route table", () => {
  /**
   * The sanity check that makes every other assertion here meaningful. A regex that stopped
   * matching — a formatter change, a rename, a move to a different declaration style — would
   * otherwise turn this whole file into a suite that asserts things about an empty list and
   * passes.
   */
  it("actually parsed router.dart", () => {
    expect(routerSource.length).toBeGreaterThan(1000);
    expect(ROUTE_CONSTANTS.length).toBeGreaterThan(20);
    expect(ROUTE_PATH_ARGUMENTS.length).toBeGreaterThan(20);
    expect(ROUTE_CONSTANTS).toContain("/profile/settings/devices");
  });

  /**
   * ⚠ THE ASSERTION THAT CATCHES A NEW SCREEN. Every route the app declares must be a screen the
   * server can resolve — either exactly (a static route) or with one segment appended (the two
   * constants that are prefixes: `/jobs/detail` + `/<jobId>`, `/profile/kit/detail` +
   * `/<tradeKey>`).
   *
   * The probe segment is deliberately a word rather than a uuid: this is testing that the TABLE
   * knows the route, not that the resolver recognises id shapes — it no longer has any.
   */
  it("resolves every route the app declares", () => {
    const unresolvable = ROUTE_CONSTANTS.filter(
      (route) =>
        resolveScreenTemplate(route) === null &&
        resolveScreenTemplate(`${route === "/" ? "" : route}/probe-segment`) === null,
    );
    expect(
      unresolvable,
      "the worker app declares a route WORKER_APP_SCREEN_TEMPLATES does not know — feedback " +
        "from that screen will be recorded as 'unknown screen' forever. Add it to the table in " +
        "packages/types/src/index.ts.",
    ).toEqual([]);
  });

  /**
   * The other direction: a template nothing in the app declares. Harmless to privacy and NOT
   * harmless to trust — an allowlist with invented entries is one nobody can read as "these are
   * the app's screens", and the next person widening it has no way to tell a real route from a
   * leftover. `/i/:id` is the one legitimate exception: it is declared inline in the route tree
   * because nothing in the app navigates to it (the platform delivers the deep link), so it has
   * no `Routes` constant to match against.
   */
  it("contains no screen the app does not have", () => {
    const declared = new Set(ROUTE_CONSTANTS);
    const orphans = WORKER_APP_SCREEN_TEMPLATES.filter((template) => {
      if (template === "/i/:id") return false;
      if (declared.has(template)) return false;
      // A dynamic template is declared as its parent constant, without the parameter.
      return !declared.has(template.slice(0, -"/:id".length));
    });
    expect(orphans).toEqual([]);
  });

  /**
   * ⚠ THE ARM THAT COVERS WHAT THE TWO ABOVE CANNOT SEE: a nested sub-route added WITHOUT a
   * `Routes` constant. `'search'`, `'edit'`, `'devices'` and the two `'detail/:x'` are declared
   * as relative literals inside their parent's `routes:` list; a sixth added the same way would
   * be a new screen that no `Routes` constant mentions, so neither coverage check above would
   * notice it.
   *
   * Deriving its absolute path would mean parsing the `GoRoute` nesting. Pinning the SET instead
   * is not a derivation and does not pretend to be — it is a change detector, and a change to
   * this list is precisely the event that needs a human to check the server's table. Every entry
   * here today has a `Routes` constant carrying its absolute form, which is what the coverage
   * assertions consume.
   */
  it("pins the nested sub-routes declared without a Routes constant", () => {
    expect([...RELATIVE_SUBPATHS].sort()).toEqual(
      [
        "applied", // → Routes.appliedJobs   '/profile/applied'
        "detail/:jobId", // → Routes.jobDetail     '/jobs/detail'  + '/<jobId>'
        "detail/:tradeKey", // → Routes.kitDetail     '/profile/kit/detail' + '/<tradeKey>'
        "devices", // → Routes.devices       '/profile/settings/devices'
        "edit", // → Routes.resumeEdit    '/resume/edit'
        "kit", // → Routes.kit           '/profile/kit'
        "search", // → Routes.jobSearch     '/jobs/search'
        "settings", // → Routes.settings      '/profile/settings'
      ].sort(),
    );
  });

  /**
   * AND THE COUNT. The app declares exactly one `GoRoute` per screen and the table holds exactly
   * one entry per screen, so the two numbers move together or something is wrong.
   *
   * What it catches that the set checks above cannot: a screen DELETED from the route tree while
   * its `Routes` constant stays behind (an orphan template, still declared, no longer reachable),
   * and a second `GoRoute` declared against an existing constant. Both leave every set identical.
   */
  it("declares exactly as many routes as the table has screens", () => {
    expect(ROUTE_PATH_ARGUMENTS.length).toBe(WORKER_APP_SCREEN_TEMPLATES.length);
  });
});
