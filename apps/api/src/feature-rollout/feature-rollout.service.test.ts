import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import type { FeaturePilotSubjectsRepository } from "./feature-pilot-subjects.repository";
import type { FeaturePilotRepository } from "./feature-pilot.repository";
import { FEATURE_ROLLOUT_CONFIG, FEATURE_ROLLOUT_KEYS } from "./feature-rollout.keys";
import { FeatureRolloutService } from "./feature-rollout.service";
import * as callerModule from "./rollout-caller";
import { isSealedRolloutCaller, rolloutCaller, type RolloutCaller } from "./rollout-caller";

// A test may build a key from a literal: the brand guards production call sites, not fixtures.
const TENANT = "11111111-1111-4111-8111-111111111111" as TenantKey;

function serviceWith(
  env: Record<string, string>,
  isListed: FeaturePilotRepository["isListed"],
  isSubjectListed: FeaturePilotSubjectsRepository["isListed"] = async () => false,
) {
  const config: ServerConfig = loadServerConfig(env);
  const pilots = { isListed: vi.fn(isListed) };
  const subjects = { isListed: vi.fn(isSubjectListed) };
  return {
    service: new FeatureRolloutService(
      config,
      pilots as unknown as FeaturePilotRepository,
      subjects as unknown as FeaturePilotSubjectsRepository,
    ),
    pilots,
    subjects,
  };
}

describe("FeatureRolloutService — one answer per (feature, company)", () => {
  it.each(FEATURE_ROLLOUT_KEYS)(
    "%s: off by default, and off never reads the pilot list",
    async (feature) => {
      const { service, pilots } = serviceWith({}, async () => true);
      expect(service.isLiveForServiceCaller(feature)).toBe(false);
      expect(await service.isEnabledFor(feature, TENANT)).toBe(false);
      expect(pilots.isListed).not.toHaveBeenCalled();
    },
  );

  it.each(FEATURE_ROLLOUT_KEYS)(
    "%s: on is everyone, without a pilot-list read",
    async (feature) => {
      const { service, pilots } = serviceWith(
        { [FEATURE_ROLLOUT_CONFIG[feature]]: "on" },
        async () => false,
      );
      expect(service.isLiveForServiceCaller(feature)).toBe(true);
      expect(await service.isEnabledFor(feature, TENANT)).toBe(true);
      expect(pilots.isListed).not.toHaveBeenCalled();
    },
  );

  it.each(FEATURE_ROLLOUT_KEYS)("%s: pilot is exactly the listed companies", async (feature) => {
    const listed = serviceWith({ [FEATURE_ROLLOUT_CONFIG[feature]]: "pilot" }, async () => true);
    expect(listed.service.isLiveForServiceCaller(feature)).toBe(true);
    expect(await listed.service.isEnabledFor(feature, TENANT)).toBe(true);
    expect(listed.pilots.isListed).toHaveBeenCalledWith(feature, TENANT);

    const unlisted = serviceWith({ [FEATURE_ROLLOUT_CONFIG[feature]]: "pilot" }, async () => false);
    expect(await unlisted.service.isEnabledFor(feature, TENANT)).toBe(false);
  });

  it("pilot fails CLOSED: a pilot-list read error is 'not enabled', never a throw", async () => {
    const { service } = serviceWith({ JOB_AUDIENCE_ROLLOUT: "pilot" }, async () => {
      throw new Error("connection reset");
    });
    await expect(service.isEnabledFor("job_audience", TENANT)).resolves.toBe(false);
  });

  it("an unknown feature (a cast, a prototype name) reads as off on both questions", async () => {
    const { service, pilots } = serviceWith(
      { JOB_AUDIENCE_ROLLOUT: "on", CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" },
      async () => true,
    );
    for (const unknown of ["payments", "toString", "constructor", "__proto__"]) {
      const feature = unknown as never;
      expect(service.isLiveForServiceCaller(feature), unknown).toBe(false);
      expect(await service.isEnabledFor(feature, TENANT), unknown).toBe(false);
    }
    expect(pilots.isListed).not.toHaveBeenCalled();
  });

  it("each feature reads its own switch", async () => {
    const { service } = serviceWith(
      { JOB_AUDIENCE_ROLLOUT: "on", CAMPUS_DRIVE_REQUESTS_ROLLOUT: "off" },
      async () => true,
    );
    expect(await service.isEnabledFor("job_audience", TENANT)).toBe(true);
    expect(await service.isEnabledFor("campus_drive_requests", TENANT)).toBe(false);
  });
});

describe("the feature keys fit the pilot table", () => {
  it("every key matches fpp_feature_chk (^[a-z][a-z0-9_]{1,63}$)", () => {
    for (const key of FEATURE_ROLLOUT_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
  });
});

// ─── #2820: isThemeOpenFor, one answer per login ─────────────────────────────

/** What the guards attach: `@CurrentWorker()` and `@CurrentAdmin()`. */
const WORKER: AuthenticatedWorker = { id: "22222222-2222-4222-8222-222222222222", sid: "sid-w" };
const ADMIN: AuthenticatedAdmin = {
  id: "33333333-3333-4333-8333-333333333333",
  role: "ops_admin",
  sid: "sid-a",
};
/** A company with a team: COMPANY anchors it and MEMBER is its recruiter. */
const COMPANY = "44444444-4444-4444-8444-444444444444";
const MEMBER = "55555555-5555-4555-8555-555555555555";

/** The payer caller the way #2819's routes build it: through the REAL tenancy resolver. */
async function payerCaller(payerId: string, tenancy: "off" | "on" = "off"): Promise<RolloutCaller> {
  const config = loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: tenancy });
  const scope = await resolverOver(config, [{ anchor: COMPANY, members: [MEMBER] }]).resolve(
    payerId,
  );
  return rolloutCaller.payer(scope);
}

/** Drizzle 0.45's shape: the SQLSTATE sits on `cause`, the message carries the SQL. */
function missingTable(table: string): Error {
  const pg = Object.assign(new Error(`relation "${table}" does not exist`), { code: "42P01" });
  return Object.assign(new Error(`Failed query: select "feature" from "${table}"`), { cause: pg });
}

const UNSEALED =
  "feature rollout: no sealed caller (feature=theme caller=unsealed); treated as off";

describe("isThemeOpenFor — THEME_ROLLOUT, for every kind of login (#2820)", () => {
  afterEach(() => vi.restoreAllMocks());

  const callers = async (): Promise<[string, RolloutCaller][]> => [
    ["worker", rolloutCaller.worker(WORKER)],
    ["company", await payerCaller(COMPANY)],
    ["admin", rolloutCaller.admin(ADMIN)],
  ];

  it.each<Record<string, string>>([{}, { THEME_ROLLOUT: "off" }, { THEME_ROLLOUT: "" }])(
    "off (%j): closed for every login, and no list is read",
    async (env) => {
      const { service, pilots, subjects } = serviceWith(
        env,
        async () => true,
        async () => true,
      );
      for (const [kind, caller] of await callers()) {
        expect(await service.isThemeOpenFor(caller), kind).toBe(false);
      }
      expect(pilots.isListed).not.toHaveBeenCalled();
      expect(subjects.isListed).not.toHaveBeenCalled();
    },
  );

  it("on: open for every login, and no list is read", async () => {
    const { service, pilots, subjects } = serviceWith(
      { THEME_ROLLOUT: "on" },
      async () => false,
      async () => false,
    );
    for (const [kind, caller] of await callers()) {
      expect(await service.isThemeOpenFor(caller), kind).toBe(true);
    }
    expect(pilots.isListed).not.toHaveBeenCalled();
    expect(subjects.isListed).not.toHaveBeenCalled();
  });

  it("pilot, worker: exactly the listed worker, from the worker list only", async () => {
    const listed = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => true,
      async () => true,
    );
    expect(await listed.service.isThemeOpenFor(rolloutCaller.worker(WORKER))).toBe(true);
    expect(listed.subjects.isListed).toHaveBeenCalledWith("theme", "worker", WORKER.id);
    expect(listed.pilots.isListed).not.toHaveBeenCalled();

    const unlisted = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => true,
      async () => false,
    );
    expect(await unlisted.service.isThemeOpenFor(rolloutCaller.worker(WORKER))).toBe(false);
  });

  it("pilot, admin: exactly the listed admin, from the same list under its own kind", async () => {
    const listed = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => true,
      async () => true,
    );
    expect(await listed.service.isThemeOpenFor(rolloutCaller.admin(ADMIN))).toBe(true);
    expect(listed.subjects.isListed).toHaveBeenCalledWith("theme", "admin", ADMIN.id);
    expect(listed.pilots.isListed).not.toHaveBeenCalled();

    const unlisted = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => true,
      async () => false,
    );
    expect(await unlisted.service.isThemeOpenFor(rolloutCaller.admin(ADMIN))).toBe(false);
  });

  it("pilot: the kind is part of the key — an id listed as an admin is not a pilot worker", async () => {
    const shared = "66666666-6666-4666-8666-666666666666";
    const { service } = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => false,
      async (_feature, kind, id) => kind === "admin" && id === shared,
    );
    expect(await service.isThemeOpenFor(rolloutCaller.admin({ ...ADMIN, id: shared }))).toBe(true);
    expect(await service.isThemeOpenFor(rolloutCaller.worker({ ...WORKER, id: shared }))).toBe(
      false,
    );
  });

  it("pilot, company: exactly the listed tenant, from the company list only", async () => {
    const listedTenants = [COMPANY];
    const { service, pilots, subjects } = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async (_feature, tenant) => listedTenants.includes(tenant),
      async () => true,
    );
    expect(await service.isThemeOpenFor(await payerCaller(COMPANY))).toBe(true);
    expect(pilots.isListed).toHaveBeenCalledWith("theme", COMPANY);
    expect(subjects.isListed).not.toHaveBeenCalled();
    const stranger = "77777777-7777-4777-8777-777777777777";
    expect(await service.isThemeOpenFor(await payerCaller(stranger))).toBe(false);
  });

  it("pilot, company team member: inherits the company's place under org tenancy on, not off", async () => {
    const { service, pilots } = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async (_feature, tenant) => tenant === COMPANY,
    );
    // `on`: the member's tenant key IS the company's anchor, so the company's one row covers him.
    expect(await service.isThemeOpenFor(await payerCaller(MEMBER, "on"))).toBe(true);
    expect(pilots.isListed).toHaveBeenLastCalledWith("theme", COMPANY);
    // `off` (today's default): the key is the login itself, so he needs his own row.
    expect(await service.isThemeOpenFor(await payerCaller(MEMBER, "off"))).toBe(false);
    expect(pilots.isListed).toHaveBeenLastCalledWith("theme", MEMBER);
  });

  it("pilot fails CLOSED on a missing table (42P01 on err.cause): false, never a throw, sqlstate and ids only in the log", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service } = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => {
        throw missingTable("feature_pilot_payers");
      },
      async () => {
        throw missingTable("feature_pilot_subjects");
      },
    );
    for (const [kind, caller] of await callers()) {
      await expect(service.isThemeOpenFor(caller), kind).resolves.toBe(false);
    }
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      `feature rollout: pilot list read failed (feature=theme worker=${WORKER.id} sqlstate=42P01); treated as off`,
      // A company goes through `stateFor` (#2747), which logs its own wording; the answer is the
      // same false.
      `feature rollout: pilot list read failed (feature=theme tenant=${COMPANY} sqlstate=42P01); answered unavailable (read as off, except where a caller must refuse)`,
      `feature rollout: pilot list read failed (feature=theme admin=${ADMIN.id} sqlstate=42P01); treated as off`,
    ]);
    for (const line of lines) {
      expect(line).not.toContain("does not exist");
      expect(line).not.toContain("Failed query");
    }
  });

  it("pilot fails CLOSED on any other read error too (no SQLSTATE at all)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service } = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => true,
      async () => {
        throw new Error("connection reset");
      },
    );
    await expect(service.isThemeOpenFor(rolloutCaller.worker(WORKER))).resolves.toBe(false);
    expect(String(warn.mock.calls[0]?.[0])).toContain("sqlstate=none");
  });

  it("reads THEME_ROLLOUT and nothing else: the other switches neither open nor close it", async () => {
    const others = { JOB_AUDIENCE_ROLLOUT: "on", CAMPUS_DRIVE_REQUESTS_ROLLOUT: "on" };
    const closed = serviceWith(
      others,
      async () => true,
      async () => true,
    );
    for (const [kind, caller] of await callers()) {
      expect(await closed.service.isThemeOpenFor(caller), kind).toBe(false);
    }
    const open = serviceWith({ THEME_ROLLOUT: "on" }, async () => true);
    expect(await open.service.isThemeOpenFor(rolloutCaller.worker(WORKER))).toBe(true);
    expect(await open.service.isEnabledFor("job_audience", TENANT)).toBe(false);
  });

  it("a caller of no known kind (only a cast can make one) is closed and reads nothing", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, pilots, subjects } = serviceWith(
      { THEME_ROLLOUT: "pilot" },
      async () => true,
      async () => true,
    );
    const forged = { kind: "payer_user", payerId: COMPANY } as unknown as RolloutCaller;
    await expect(service.isThemeOpenFor(forged)).resolves.toBe(false);
    expect(pilots.isListed).not.toHaveBeenCalled();
    expect(subjects.isListed).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([UNSEALED]);
  });

  it("a SPREAD copy of a real caller (no cast needed) is closed under pilot and on, and reads nothing", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    // Both compile: a spread copies the compile-time seal. Only the run-time record stops them.
    const relabelled: RolloutCaller = {
      ...rolloutCaller.admin(ADMIN),
      kind: "worker",
      workerId: WORKER.id,
    };
    const narrowed = rolloutCaller.admin(ADMIN);
    const retargeted: RolloutCaller =
      narrowed.kind === "admin"
        ? { ...narrowed, adminId: "99999999-9999-4999-8999-999999999999" }
        : narrowed;
    for (const mode of ["pilot", "on"]) {
      const { service, pilots, subjects } = serviceWith(
        { THEME_ROLLOUT: mode },
        async () => true,
        async () => true,
      );
      for (const copy of [relabelled, retargeted]) {
        await expect(service.isThemeOpenFor(copy), mode).resolves.toBe(false);
      }
      expect(pilots.isListed).not.toHaveBeenCalled();
      expect(subjects.isListed).not.toHaveBeenCalled();
      // The real caller it was copied from still answers.
      await expect(service.isThemeOpenFor(narrowed), mode).resolves.toBe(true);
    }
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      UNSEALED,
      UNSEALED,
      UNSEALED,
      UNSEALED,
    ]);
  });

  it.each([null, undefined, "worker", 42, true])(
    "never throws, so a route cannot 500: a %s caller answers false (switch on)",
    async (value) => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const { service } = serviceWith(
        { THEME_ROLLOUT: "on" },
        async () => true,
        async () => true,
      );
      await expect(service.isThemeOpenFor(value as unknown as RolloutCaller)).resolves.toBe(false);
    },
  );
});

describe("a RolloutCaller is built only from what an auth guard attached (#2820)", () => {
  it("each builder copies the guard's id (the company: its resolved tenant key)", async () => {
    expect(rolloutCaller.worker(WORKER)).toMatchObject({ kind: "worker", workerId: WORKER.id });
    expect(rolloutCaller.admin(ADMIN)).toMatchObject({ kind: "admin", adminId: ADMIN.id });
    expect(await payerCaller(MEMBER, "on")).toMatchObject({ kind: "payer", tenantKey: COMPANY });
  });

  it("the seal is module-private: the builders and the read-only check are the only exports", () => {
    expect(Object.keys(callerModule).sort()).toEqual(["isSealedRolloutCaller", "rolloutCaller"]);
    expect(Object.isFrozen(rolloutCaller)).toBe(true);
  });

  it("a built caller is frozen: it cannot be relabelled or retargeted in place", () => {
    const caller = rolloutCaller.worker(WORKER);
    expect(Object.isFrozen(caller)).toBe(true);
    const writable = caller as unknown as { kind: string; workerId: string };
    expect(() => {
      writable.workerId = "99999999-9999-4999-8999-999999999999";
    }).toThrow(TypeError);
    expect(() => {
      writable.kind = "admin";
    }).toThrow(TypeError);
    expect(caller).toMatchObject({ kind: "worker", workerId: WORKER.id });
  });

  it("the check reads the record and adds nothing: only what a builder made passes", () => {
    const real = rolloutCaller.admin(ADMIN);
    expect(isSealedRolloutCaller(real)).toBe(true);
    expect(isSealedRolloutCaller({ ...real })).toBe(false);
    expect(isSealedRolloutCaller(Object.freeze({ ...real }))).toBe(false);
    for (const value of [null, undefined, "admin", 0, {}]) {
      expect(isSealedRolloutCaller(value), String(value)).toBe(false);
    }
  });

  it("a hand-written caller does not compile (typecheck runs over this file)", () => {
    // @ts-expect-error — no `SEALED` key: a body or path id cannot be shaped into a caller.
    const handMade: RolloutCaller = { kind: "worker", workerId: WORKER.id };
    expect(handMade.kind).toBe("worker");
  });
});

// ─── Single reader ───────────────────────────────────────────────────────────

const SRC = join(__dirname, "..");

function prodSources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return prodSources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/**
 * Source without comments, so prose that names a switch is not a read. Only WHOLE-LINE `//`
 * comments are dropped (the T8 rule): stripping from any `//` would also eat code after a URL.
 */
const codeOf = (path: string): string =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const filesMatching = (pattern: RegExp): string[] =>
  prodSources()
    .filter((path) => pattern.test(codeOf(path)))
    .map((path) => relative(SRC, path).replace(/\\/g, "/"))
    .sort();

const filesNaming = (needle: string): string[] =>
  prodSources()
    .filter((path) => codeOf(path).includes(needle))
    .map((path) => relative(SRC, path).replace(/\\/g, "/"))
    .sort();

describe("the rollout switches and the pilot list have ONE reader each", () => {
  it.each(Object.values(FEATURE_ROLLOUT_CONFIG))("%s is named only by the keys file", (field) => {
    expect(filesNaming(field)).toEqual(["feature-rollout/feature-rollout.keys.ts"]);
  });

  it("the switch map is read only by the keys file and the service (no `config[MAP.x]` elsewhere)", () => {
    expect(filesNaming("FEATURE_ROLLOUT_CONFIG")).toEqual([
      "feature-rollout/feature-rollout.keys.ts",
      "feature-rollout/feature-rollout.service.ts",
    ]);
  });

  it("feature_pilot_payers is reached only through FeaturePilotRepository, never by raw SQL", () => {
    expect(filesNaming("featurePilotPayers")).toEqual([
      "feature-rollout/feature-pilot.repository.ts",
    ]);
    expect(filesNaming("feature_pilot_payers")).toEqual([]);
  });

  it.each(["feature-pilot.repository.ts", "feature-pilot-subjects.repository.ts"])(
    "%s only reads: no company, worker, admin or route can put itself on a pilot",
    (file) => {
      const repository = codeOf(join(SRC, "feature-rollout", file));
      expect(repository).toContain(".select(");
      for (const write of [".insert(", ".update(", ".delete(", ".execute("]) {
        expect(repository, write).not.toContain(write);
      }
    },
  );

  // #2820 — the theme switch and its worker / admin list.
  it("THEME_ROLLOUT is in the switch map, so it too is named only by the keys file", () => {
    expect(FEATURE_ROLLOUT_CONFIG.theme).toBe("THEME_ROLLOUT");
    expect(filesNaming("THEME_ROLLOUT")).toEqual(["feature-rollout/feature-rollout.keys.ts"]);
  });

  it("feature_pilot_subjects is reached only through FeaturePilotSubjectsRepository, which only the service uses", () => {
    expect(filesNaming("featurePilotSubjects")).toEqual([
      "feature-rollout/feature-pilot-subjects.repository.ts",
    ]);
    expect(filesNaming("feature_pilot_subjects")).toEqual([]);
    // Test support (built by suites, never compiled into the build) may construct it too.
    const users = filesNaming("FeaturePilotSubjectsRepository").filter(
      (path) => !path.endsWith(".test-support.ts"),
    );
    expect(users).toEqual([
      "feature-rollout/feature-pilot-subjects.repository.ts",
      "feature-rollout/feature-rollout.module.ts",
      "feature-rollout/feature-rollout.service.ts",
    ]);
  });

  it("isSealedRolloutCaller has one caller, the service", () => {
    expect(filesNaming("isSealedRolloutCaller")).toEqual([
      "feature-rollout/feature-rollout.service.ts",
      "feature-rollout/rollout-caller.ts",
    ]);
  });

  it("the theme is asked only through isThemeOpenFor, never as a raw feature key", () => {
    // `isEnabledFor("theme", …)` would answer for a company only, and `isLiveForServiceCaller`
    // for nobody in particular; every app's theme question is the one per-login method.
    expect(filesMatching(/\.(?:isEnabledFor|isLiveForServiceCaller)\(\s*["'`]theme["'`]/)).toEqual(
      [],
    );
  });
});

describe("isLiveForServiceCaller is a SERVICE-caller check, used only where it was reviewed", () => {
  // In `pilot` it is true for every company, so a payer path calling it would skip the pilot
  // list (security review of #2746 PR 2, M1). Each entry here is a reviewed, company-less caller.
  const ALLOWED_CALLERS: readonly string[] = [
    // #2746 PR 5 — Campus's review route: `job_audience` off everywhere → the neutral 404 before
    // any read. NOT the company check: the posting owner's pilot place is then read with
    // `isEnabledFor` and the owner's tenant key (`PayerTenantScopeService`).
    "campus-link/campus-posting-review.service.ts",
  ];

  it("its call sites are exactly the allow-list", () => {
    expect(filesMatching(/\.isLiveForServiceCaller\(/)).toEqual([...ALLOWED_CALLERS].sort());
  });

  it("no payer, unlock or payment path is ever on the allow-list", () => {
    for (const caller of ALLOWED_CALLERS) {
      expect(caller).not.toMatch(/^(payers|payer-portal|unlocks|payments|posting-plans)\//);
    }
  });
});
