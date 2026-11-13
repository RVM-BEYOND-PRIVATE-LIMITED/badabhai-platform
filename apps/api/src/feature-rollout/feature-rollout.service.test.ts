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
      expect(service.mode(feature)).toBe("off");
      expect(service.isLiveAnywhere(feature)).toBe(false);
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
      expect(service.isLiveAnywhere(feature)).toBe(true);
      expect(await service.isEnabledFor(feature, TENANT)).toBe(true);
      expect(pilots.isListed).not.toHaveBeenCalled();
    },
  );

  it.each(FEATURE_ROLLOUT_KEYS)("%s: pilot is exactly the listed companies", async (feature) => {
    const listed = serviceWith({ [FEATURE_ROLLOUT_CONFIG[feature]]: "pilot" }, async () => true);
    expect(listed.service.isLiveAnywhere(feature)).toBe(true);
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

/** Source without comments, so prose that names a switch is not a read. */
const codeOf = (path: string): string =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

const filesNaming = (needle: string): string[] =>
  prodSources()
    .filter((path) => codeOf(path).includes(needle))
    .map((path) => relative(SRC, path).replace(/\\/g, "/"))
    .sort();

describe("the rollout switches and the pilot list have ONE reader each", () => {
  it.each(Object.values(FEATURE_ROLLOUT_CONFIG))("%s is named only by the keys file", (field) => {
    expect(filesNaming(field)).toEqual(["feature-rollout/feature-rollout.keys.ts"]);
  });

  it("feature_pilot_payers is read only through FeaturePilotRepository", () => {
    expect(filesNaming("featurePilotPayers")).toEqual([
      "feature-rollout/feature-pilot.repository.ts",
    ]);
  });
});
