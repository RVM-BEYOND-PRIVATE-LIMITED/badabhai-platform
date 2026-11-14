import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { describe, expect, it, vi } from "vitest";

import type { TenantKey } from "../payers/payer-tenant-scope";
import type { FeaturePilotRepository } from "./feature-pilot.repository";
import { FEATURE_ROLLOUT_CONFIG, FEATURE_ROLLOUT_KEYS } from "./feature-rollout.keys";
import { FeatureRolloutService } from "./feature-rollout.service";

// A test may build a key from a literal: the brand guards production call sites, not fixtures.
const TENANT = "11111111-1111-4111-8111-111111111111" as TenantKey;

function serviceWith(env: Record<string, string>, isListed: FeaturePilotRepository["isListed"]) {
  const config: ServerConfig = loadServerConfig(env);
  const pilots = { isListed: vi.fn(isListed) };
  return {
    service: new FeatureRolloutService(config, pilots as unknown as FeaturePilotRepository),
    pilots,
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

  it("the repository only reads: no company or route can put itself on a pilot", () => {
    const repository = codeOf(join(SRC, "feature-rollout/feature-pilot.repository.ts"));
    for (const write of [".insert(", ".update(", ".delete(", ".execute("]) {
      expect(repository, write).not.toContain(write);
    }
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
    // #2746 PR 6 — Campus's drive-request feed and decision: `campus_drive_requests` off everywhere
    // → the neutral 404 before any read. NOT the company check: each request owner's pilot place
    // is then read with `isEnabledFor` and the owner's tenant key (`PayerTenantScopeService`).
    "campus-drives/campus-drive-decisions.service.ts",
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
