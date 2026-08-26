import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { ADMIN_CAPABILITIES, ADMIN_CAPABILITY_MATRIX, type AdminCapability } from "./admin-capabilities";
import { AdminSkillDiscoveryController } from "./admin-skill-discovery.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";

/**
 * Per-ROLE authz for the migration-0093 SKILL-CANDIDATE REVIEW surface, driving the REAL
 * {@link AdminRolesGuard} with each route's REAL declared capability — read by reflection, never
 * supplied as input. A test that hands the guard the capability it then asserts on proves nothing
 * about the route; it proves the guard can read a string.
 *
 * ── WHAT THIS FILE IS ACTUALLY DEFENDING ────────────────────────────────────────────────
 * Not "all four roles can read". That part is uninteresting — `read_entities` is the ADR-0025 read
 * floor and every admin read surface declares it. This surface is worth its own suite because it
 * is the FIRST in `AdminModule` to put a read and a governed WRITE on the same controller with
 * DIFFERENT capabilities, and the write authors platform vocabulary. Four properties:
 *
 *   1. THE SPLIT HOLDS. The three reads sit on the floor; the decision write sits on
 *      `review_skill_candidates`. `support` and `analyst` may read the whole queue and may NOT
 *      decide. If the write ever slid onto `read_entities`, the review queue would become
 *      writable by every authenticated admin — and the diff that did it could be a single deleted
 *      decorator line, because of property 2.
 *   2. NO CLASS-LEVEL CAPABILITY. `Reflector.getAllAndOverride` falls back to the class, so a
 *      class-level `@RequireAdminRole("read_entities")` would be INHERITED by `decide` and nothing
 *      on the write's own lines would look wrong — the decorator would simply be absent. This is
 *      the single most expensive mistake available on this controller, and it is asserted directly
 *      rather than left to the static-guard scan.
 *   3. EXACTLY ONE CAPABILITY PER ROUTE, AND EXACTLY ONE WRITE ROUTE. The handler inventory is
 *      pinned as an EQUALITY and the verb of every route is pinned, so a second write — an export,
 *      a batch decide, a re-open — cannot arrive without this file failing first. `assertDryRunSafe`
 *      is a rule about a RUN, and a batch route would go around it and around the per-row reviewer
 *      triple at the same time.
 *   4. READING A CANDIDATE CONFERS NOTHING ELSE. `read_entities` stays strictly weaker than the
 *      entity-action capabilities and than `reveal_pii`: a reviewer who can see the phrase "arc
 *      welding" and the wording it was discovered from must not thereby be able to act on any
 *      entity, nor to resolve who said it.
 *
 * No database and no Nest container: the guard is constructed by hand over a real {@link Reflector}
 * and a synthetic {@link ExecutionContext}, exactly as on the sibling surfaces. Nothing here needs
 * the four 0093 tables to exist, which matters — the migration is authored and not applied.
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

function declaredCapability(ctor: new (...a: never[]) => object, method: string): AdminCapability {
  const proto = ctor.prototype as unknown as Record<string, object>;
  const cap =
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as AdminCapability | undefined) ??
    (Reflect.getMetadata(ADMIN_CAPABILITY_KEY, ctor) as AdminCapability | undefined);
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

/** An ExecutionContext whose handler carries the route's REAL declared capability. */
function ctxFor(
  ctor: new (...a: never[]) => object,
  method: string,
  who: AuthenticatedAdmin | undefined,
): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(ctor, method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/**
 * Every method Nest would mount as a route — discovered the way `admin-static-guards.test.ts:
 * 119-153` discovers them (`Reflect.getMetadata("path", ...)`), so a handler that exists but was
 * never enumerated below cannot hide from these assertions.
 */
function routeMethods(ctor: new (...a: never[]) => object): string[] {
  const proto = ctor.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );
}

const verbOf = (ctor: new (...a: never[]) => object, method: string): number => {
  const proto = ctor.prototype as unknown as Record<string, object>;
  return Reflect.getMetadata("method", proto[method]!) as number;
};

const guard = new AdminRolesGuard(new Reflector());

/** Nest's `RequestMethod`. Asserted as the magic numbers, as at admin-static-guards.test.ts:908. */
const GET = 0;
const POST = 1;

const READ_ROUTES = ["list", "metrics", "detail"] as const;
const WRITE_ROUTE = "decide";

/** Who may DECIDE. Read from the matrix rather than transcribed, so this file cannot disagree with it. */
const DECIDERS = ADMIN_CAPABILITY_MATRIX.review_skill_candidates;
const NON_DECIDERS = ROLES.filter((r) => !DECIDERS.includes(r));

describe("the reflection helpers are CAPABLE of failing (no assertion below is vacuous)", () => {
  it("declaredCapability throws when a method carries no @RequireAdminRole", () => {
    // If this ever silently returned something, every "declares X" assertion in this file would be
    // reading a default rather than the route.
    expect(() => declaredCapability(AdminSkillDiscoveryController, "constructor")).toThrow(
      /declares no @RequireAdminRole/,
    );
  });

  it("routeMethods finds routes on a controller that has them, and none on a bare class", () => {
    expect(routeMethods(AdminSkillDiscoveryController).length).toBeGreaterThan(0);
    class Bare {
      notARoute(): void {}
    }
    expect(routeMethods(Bare)).toEqual([]);
  });

  it("the two verb constants really distinguish the routes on this controller", () => {
    // Guards the `GET`/`POST` magic numbers themselves: if both were 0, the "exactly one write"
    // assertions below would pass no matter what verb anything carried.
    expect(GET).not.toBe(POST);
    expect(verbOf(AdminSkillDiscoveryController, "list")).toBe(GET);
    expect(verbOf(AdminSkillDiscoveryController, WRITE_ROUTE)).toBe(POST);
  });

  it("NON_DECIDERS is non-empty — otherwise every denial assertion below is a no-op loop", () => {
    expect(NON_DECIDERS.length).toBeGreaterThan(0);
    expect(DECIDERS.length).toBeGreaterThan(0);
  });
});

describe("0093 review surface — the route inventory, pinned as an equality", () => {
  /**
   * An EQUALITY, not a `toContain`. The point is to fail when a FIFTH route appears — an export,
   * a batch decide, a re-open — because each of those goes around a control this surface depends
   * on: a batch decide bypasses the per-row reviewer triple and `assertDryRunSafe`; a re-open
   * contradicts "terminal means terminal" (the decision was recorded against a specific
   * `corpus_fingerprint`, and re-opening in place silently re-scopes it to a corpus the human
   * never saw); an export turns a review queue into a bulk egress surface with no `export`
   * capability anywhere near it. Updating this list must be a deliberate act with its own
   * allow/deny cases below.
   */
  it("declares EXACTLY three reads and ONE write — no export, no batch, no re-open", () => {
    expect(routeMethods(AdminSkillDiscoveryController).sort()).toEqual(
      [...READ_ROUTES, WRITE_ROUTE].sort(),
    );
  });

  it("the three reads are GETs and the decision is the ONLY non-GET on the surface", () => {
    for (const route of READ_ROUTES) {
      expect(verbOf(AdminSkillDiscoveryController, route), `${route} must be a GET`).toBe(GET);
    }
    expect(verbOf(AdminSkillDiscoveryController, WRITE_ROUTE)).toBe(POST);
    const writes = routeMethods(AdminSkillDiscoveryController).filter(
      (m) => verbOf(AdminSkillDiscoveryController, m) !== GET,
    );
    expect(writes).toEqual([WRITE_ROUTE]);
  });
});

describe("0093 review surface — the capability each route declares", () => {
  for (const route of READ_ROUTES) {
    it(`${route} declares read_entities — the read floor, not a newly minted capability`, () => {
      // Minting one for a READ would break `ADMIN_CAPABILITIES` and its pinned transcriptions for
      // no benefit: these responses carry no identity, no money and no plaintext. The standing
      // decision is to reuse the floor unless a human has ruled otherwise
      // (admin-feedback.authz.test.ts:63-69, CLAUDE.md §16).
      expect(declaredCapability(AdminSkillDiscoveryController, route)).toBe("read_entities");
      expect(ADMIN_CAPABILITIES).toContain("read_entities");
    });
  }

  it("decide declares review_skill_candidates — NOT the read floor, NOT a co-opted write row", () => {
    const cap = declaredCapability(AdminSkillDiscoveryController, WRITE_ROUTE);
    expect(cap).toBe("review_skill_candidates");
    expect(ADMIN_CAPABILITIES).toContain("review_skill_candidates");
    // The co-option that would have "worked": every one of these is entity moderation, money,
    // identity or bulk egress, and reusing any of them would hand vocabulary authorship to
    // whoever holds it — while `GET /admin/me` told the console nothing had changed.
    for (const coopted of [
      "read_entities",
      "flag_worker",
      "suspend_payer",
      "grant_credits",
      "force_close_posting",
      "toggle_kill_switch",
      "reveal_pii",
      "manage_admins",
      "export",
    ]) {
      expect(cap).not.toBe(coopted);
    }
  });

  it("the write's capability is DIFFERENT from every read's on the same controller", () => {
    for (const route of READ_ROUTES) {
      expect(declaredCapability(AdminSkillDiscoveryController, route)).not.toBe(
        declaredCapability(AdminSkillDiscoveryController, WRITE_ROUTE),
      );
    }
  });

  it("every route declares its capability on the METHOD, and the CLASS declares none", () => {
    const proto = AdminSkillDiscoveryController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.list!)).toBe("read_entities");
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.metrics!)).toBe("read_entities");
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.detail!)).toBe("read_entities");
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.decide!)).toBe(
      "review_skill_candidates",
    );
    expect(
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminSkillDiscoveryController),
      "AdminSkillDiscoveryController must NOT declare a class-level capability — Reflector falls " +
        "back to the class, so a class-level read_entities would be inherited by `decide` and " +
        "gate taxonomy authorship on the floor all four roles hold, with nothing wrong on the " +
        "write's own lines",
    ).toBeUndefined();
  });
});

describe("0093 review surface — who may READ the queue", () => {
  for (const route of READ_ROUTES) {
    it(`${route}: ALL four defined roles pass — read_entities is the ADR-0025 read floor`, () => {
      for (const role of ROLES) {
        expect(
          guard.canActivate(ctxFor(AdminSkillDiscoveryController, route, admin(role))),
          `${route} must be readable by ${role}`,
        ).toBe(true);
      }
    });

    it(`${route}: unauthenticated → 401 (fail closed, never a silent allow)`, () => {
      expect(() =>
        guard.canActivate(ctxFor(AdminSkillDiscoveryController, route, undefined)),
      ).toThrow(UnauthorizedException);
    });

    it(`${route}: a principal whose role does NOT hold read_entities is refused`, () => {
      // All four defined roles hold the floor, so the only way to exercise the refusal is an
      // UNKNOWN role — which is also the realistic failure: a stale token, a typo'd seed, or a
      // role added to the enum and forgotten in the matrix. `can()` is deny-by-default. The
      // capability NAMES are in the rogue list on purpose: a role string that happens to equal a
      // capability must not authorize anything (the matrix is keyed by capability, not by role,
      // and a lookup that confused the two would pass every legitimate test).
      for (const rogue of ["root", "viewer", "", "read_entities", "review_skill_candidates"]) {
        const who = { id: "a", role: rogue as AdminRole, sid: "s" };
        expect(() => guard.canActivate(ctxFor(AdminSkillDiscoveryController, route, who))).toThrow(
          ForbiddenException,
        );
      }
    });

    it(`${route}: a null role is refused, not treated as an absent check`, () => {
      const who = { id: "a", role: null as unknown as AdminRole, sid: "s" };
      expect(() => guard.canActivate(ctxFor(AdminSkillDiscoveryController, route, who))).toThrow(
        ForbiddenException,
      );
    });
  }
});

describe("0093 review surface — who may DECIDE (the governed write)", () => {
  it(`only ${DECIDERS.join(" + ")} may decide — the matrix's own allow-set`, () => {
    for (const role of DECIDERS) {
      expect(
        guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, admin(role))),
        `${role} holds review_skill_candidates and must be allowed to decide`,
      ).toBe(true);
    }
  });

  it(`${NON_DECIDERS.join(" and ")} may READ the whole queue but are DENIED the decision`, () => {
    // THE PROPERTY THIS SURFACE EXISTS TO KEEP. A reviewer's screen is visible to every
    // authenticated admin — that is deliberate, because a queue nobody can see is a queue nobody
    // works. Authoring the vocabulary is a different act, and the only thing separating the two is
    // that the routes declare different capabilities.
    for (const role of NON_DECIDERS) {
      for (const route of READ_ROUTES) {
        expect(
          guard.canActivate(ctxFor(AdminSkillDiscoveryController, route, admin(role))),
          `${role} must still be able to ${route}`,
        ).toBe(true);
      }
      expect(
        () => guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, admin(role))),
        `${role} must NOT be able to decide`,
      ).toThrow(ForbiddenException);
    }
  });

  it("decide: unauthenticated → 401, never a silent allow", () => {
    expect(() =>
      guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, undefined)),
    ).toThrow(UnauthorizedException);
  });

  it("decide: an unknown or null role is refused (deny-by-default on the write too)", () => {
    for (const rogue of ["root", "reviewer", "", "review_skill_candidates"]) {
      const who = { id: "a", role: rogue as AdminRole, sid: "s" };
      expect(() =>
        guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, who)),
      ).toThrow(ForbiddenException);
    }
    const nullRole = { id: "a", role: null as unknown as AdminRole, sid: "s" };
    expect(() =>
      guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, nullRole)),
    ).toThrow(ForbiddenException);
  });

  it("the decide allow-set is a STRICT SUBSET of the read allow-set", () => {
    // Stated as a property rather than as two role lists, because the direction is what matters:
    // this capability may only ever narrow who can act relative to who can look. A future widening
    // that let somebody decide a candidate they cannot open would be a screenless write path.
    for (const role of DECIDERS) {
      expect(ADMIN_CAPABILITY_MATRIX.read_entities).toContain(role);
    }
    expect(DECIDERS.length).toBeLessThan(ADMIN_CAPABILITY_MATRIX.read_entities.length);
  });
});

describe("0093 review surface — deciding a candidate NEVER confers acting on an entity", () => {
  /**
   * The separation in the other direction. `review_skill_candidates` and the entity-action
   * capabilities share the same two roles TODAY (`super_admin` + `ops_admin`), which is exactly
   * why they must remain different capabilities: an identical allow-set makes conflating them
   * invisible, right up to the moment one of them needs to narrow — and then every route named for
   * the wrong one moves with it. That is the argument `read_entities` makes against `read_events` in
   * its own docstring (admin-capabilities.ts:19-30).
   */
  const ENTITY_WRITES = [
    "suspendPayer",
    "grantCredits",
    "forceClosePosting",
    "flagWorker",
    "changeAdminRole",
  ] as const;

  for (const method of ENTITY_WRITES) {
    it(`decide and ${method} declare DIFFERENT capabilities, despite overlapping roles`, () => {
      expect(declaredCapability(AdminSkillDiscoveryController, WRITE_ROUTE)).not.toBe(
        declaredCapability(AdminActionsController, method),
      );
    });

    it(`analyst may read the skill queue but is DENIED both decide and ${method}`, () => {
      expect(
        guard.canActivate(ctxFor(AdminSkillDiscoveryController, "list", admin("analyst"))),
      ).toBe(true);
      expect(() =>
        guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, admin("analyst"))),
      ).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(AdminActionsController, method, admin("analyst")))).toThrow(
        ForbiddenException,
      );
    });
  }

  it("support may read every skill-discovery route and perform NO write, here or on entities", () => {
    for (const route of READ_ROUTES) {
      expect(
        guard.canActivate(ctxFor(AdminSkillDiscoveryController, route, admin("support"))),
      ).toBe(true);
    }
    expect(() =>
      guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, admin("support"))),
    ).toThrow(ForbiddenException);
    for (const method of ENTITY_WRITES) {
      expect(() => guard.canActivate(ctxFor(AdminActionsController, method, admin("support")))).toThrow(
        ForbiddenException,
      );
    }
  });
});

describe("0093 review surface — reading a phrase NEVER confers resolving who said it", () => {
  /**
   * `skill_candidate_source.original_text` is the raw wording a phrase was discovered from, and
   * the detail read serves it. It is unattributable by construction (no `worker_id` column on any
   * of the four 0093 tables) and pseudonymized upstream for the `worker_phrase` source type; what
   * stops it becoming an identity surface anyway is that turning anything here back into a person
   * is a DIFFERENT route with a DIFFERENT capability, a default-off flag, a reason code and an
   * audit-before-decrypt. `ops_admin` is the interesting case: it may DECIDE a candidate and still
   * may not reveal a contact.
   */
  it("every skill-discovery route declares a capability different from the contact reveal's", () => {
    const reveal = declaredCapability(AdminPiiRevealController, "revealContact");
    for (const route of [...READ_ROUTES, WRITE_ROUTE]) {
      expect(declaredCapability(AdminSkillDiscoveryController, route)).not.toBe(reveal);
    }
  });

  it("ops_admin may read AND decide, yet is DENIED the contact reveal", () => {
    expect(guard.canActivate(ctxFor(AdminSkillDiscoveryController, "detail", admin("ops_admin")))).toBe(
      true,
    );
    expect(
      guard.canActivate(ctxFor(AdminSkillDiscoveryController, WRITE_ROUTE, admin("ops_admin"))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("ops_admin"))),
    ).toThrow(ForbiddenException);
  });

  it("analyst may read the queue and is DENIED the contact reveal", () => {
    expect(guard.canActivate(ctxFor(AdminSkillDiscoveryController, "detail", admin("analyst")))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("analyst"))),
    ).toThrow(ForbiddenException);
  });
});
