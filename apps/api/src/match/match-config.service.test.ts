import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import { MatchConfigService } from "./match-config.service";
import type { MatchConfigRepository } from "./match-config.repository";

/**
 * ADR-0036 §8 — "Config, never code". This service is the ONE place apps/api learns a
 * Matching V1 number, so every consumer (reach resolver, feed, apply snapshot, boost
 * supply gate, free-tier grant) inherits whatever it decides.
 *
 * That makes FAIL-CLOSED the property worth the most here. A config service that throws
 * takes the worker feed down over a knob lookup; a config service that serves HALF a
 * broken row ships an ordering nobody signed off, and does it silently — the feed still
 * renders, the counts still add up, and only the men at the bottom of the list know.
 * The three failure shapes below (no row / non-object row / Zod-rejected row) reach the
 * defaults through three DIFFERENT branches and are asserted separately for that reason.
 */

const OPS = "44444444-4444-4444-8444-444444444444";

/** A stored row, `config` deliberately untyped — the point is what the boundary does. */
function storedRow(config: unknown, revision = 5) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    config,
    revision,
    isActive: true,
    updatedBy: OPS,
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    updatedAt: new Date("2026-07-31T00:00:00.000Z"),
  };
}

function make(rowOrThrow?: unknown | Error) {
  const getActive = vi.fn(async () => {
    if (rowOrThrow instanceof Error) throw rowOrThrow;
    return rowOrThrow as never;
  });
  const repo = { getActive } as unknown as MatchConfigRepository;
  const service = new MatchConfigService(repo);
  // Silence the deliberate fail-closed error logs; their CONTENT is asserted separately.
  vi.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  return { service, getActive };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MatchConfigService — the shipped V1 defaults", () => {
  it("serves tier_floor_months = 36 when nothing is configured (the owner's E3 ruling)", async () => {
    // 36 months is the tier-with-floor threshold ratified 2026-07-31: below it a
    // related-skill man stays tier 2. A default that drifted would silently re-order
    // every feed in the product, so it is pinned by VALUE, not by reference.
    const { service } = make(undefined);
    expect((await service.get()).tierFloorMonths).toBe(36);
  });

  it("serves the whole shipped knob set, by value", async () => {
    const { service } = make(undefined);
    expect(await service.get()).toEqual({
      engineVersion: "v1.0",
      monthBucket: 6,
      maxSkillsPerPosting: 3,
      relatedSkillsDefault: "on",
      maxConsecutiveSameCompany: 2,
      applicantQuota: "off",
      tierFloorMonths: 36,
      freeUnlockCredits: 50,
      boostSupplyFloor: 25,
      widenExpiryHours: 720,
    } satisfies MatchConfig);
  });
});

describe("MatchConfigService — FAIL CLOSED, three distinct shapes", () => {
  it("(1) NO ROW → the typed defaults, revision 0, source 'default'", async () => {
    // Legitimate before the D1 seeder runs. Not an error, and not a 500.
    const { service } = make(undefined);
    const active = await service.getActive();
    expect(active.source).toBe("default");
    expect(active.revision).toBe(0);
    expect(active.config).toBe(DEFAULT_MATCH_CONFIG);
  });

  it("(2) MALFORMED ROW (config is not an object) → defaults, but the row's revision", async () => {
    // A jsonb column can hold a string/array/null. This never reaches the field-level
    // schema at all — it dies at the object check — which is why it is its own case.
    for (const junk of ["not-a-config", 42, null, [1, 2, 3], true]) {
      const { service } = make(storedRow(junk, 11));
      const active = await service.getActive();
      expect(active.source, `config=${JSON.stringify(junk)}`).toBe("default");
      expect(active.config).toBe(DEFAULT_MATCH_CONFIG);
      // The REJECTED revision is surfaced, not zeroed: ops need to know which row was
      // thrown away. "revision 11, source default" is the actionable pair.
      expect(active.revision).toBe(11);
    }
  });

  it("(3) ZOD-REJECTED ROW → the WHOLE object falls back; the valid half is NOT kept", async () => {
    // The load-bearing case. The row is a well-formed object whose good fields would
    // parse on their own; one field is garbage. Field-by-field fallback would ship a
    // posting cap of 7 that no one reviewed alongside defaults for everything else.
    const { service } = make(
      storedRow(
        {
          maxSkillsPerPosting: 7, // valid in isolation
          boostSupplyFloor: 99, // valid in isolation
          tierFloorMonths: -12, // INVALID: nonnegative
        },
        7,
      ),
    );
    const active = await service.getActive();
    expect(active.source).toBe("default");
    expect(active.revision).toBe(7);
    expect(active.config.maxSkillsPerPosting).toBe(3); // NOT 7
    expect(active.config.boostSupplyFloor).toBe(25); // NOT 99
    expect(active.config.tierFloorMonths).toBe(36);
    expect(active.config).toBe(DEFAULT_MATCH_CONFIG);
  });

  it("rejects a bad ENUM the same way it rejects a bad number", async () => {
    const { service } = make(storedRow({ relatedSkillsDefault: "sometimes" }, 3));
    const active = await service.getActive();
    expect(active.source).toBe("default");
    expect(active.config.relatedSkillsDefault).toBe("on");
  });

  it("logs the rejected revision LOUDLY (a silent fallback is an invisible outage)", async () => {
    const { service } = make(storedRow({ monthBucket: 0 }, 42));
    const spy = vi.mocked(service["logger"].error);
    await service.getActive();
    expect(spy).toHaveBeenCalledTimes(1);
    // The revision is the only handle ops have on WHICH row to fix.
    expect(String(spy.mock.calls[0]![0])).toContain("42");
  });
});

describe("MatchConfigService — a valid stored row is honoured", () => {
  it("serves the stored values and reports source 'db' + the revision", async () => {
    const { service } = make(
      storedRow(
        { tierFloorMonths: 24, maxSkillsPerPosting: 5, relatedSkillsDefault: "off" },
        12,
      ),
    );
    const active = await service.getActive();
    expect(active.source).toBe("db");
    expect(active.revision).toBe(12);
    expect(active.config.tierFloorMonths).toBe(24);
    expect(active.config.maxSkillsPerPosting).toBe(5);
    expect(active.config.relatedSkillsDefault).toBe("off");
    // Fields the row omitted still come from the typed defaults (partial rows are legal).
    expect(active.config.monthBucket).toBe(6);
  });

  it("a row that GREW a key ahead of this deploy is still served (unknown keys stripped)", async () => {
    // The opposite failure to (3): forward-compatibility. An unrecognised key must not
    // knock a legitimate ops edit back to defaults, or a config rollout would have to
    // be lock-stepped with a deploy.
    const { service } = make(storedRow({ tierFloorMonths: 18, futureKnob: "whatever" }, 13));
    const active = await service.getActive();
    expect(active.source).toBe("db");
    expect(active.config.tierFloorMonths).toBe(18);
    expect(active.config).not.toHaveProperty("futureKnob");
  });

  it("a row that IS the defaults still reports source 'db' (provenance is not inferred)", async () => {
    // The service re-runs the schema to answer "did it fall back?" precisely so this
    // case is distinguishable from a garbage row. Inferring it by value-comparison
    // would report this as `default` and hide a real stored row from ops.
    const { service } = make(storedRow({ ...DEFAULT_MATCH_CONFIG }, 4));
    const active = await service.getActive();
    expect(active.source).toBe("db");
    expect(active.revision).toBe(4);
  });
});

describe("MatchConfigService — a DB outage degrades, it never 500s the feed", () => {
  it("get() swallows a repository throw and serves the typed defaults", async () => {
    const { service } = make(new Error("connection terminated"));
    // Every consumer calls get(); the feed must survive an unreachable config table.
    await expect(service.get()).resolves.toBe(DEFAULT_MATCH_CONFIG);
  });

  it("getActive() still PROPAGATES the throw (the provenance read is not a silent path)", async () => {
    const { service } = make(new Error("connection terminated"));
    await expect(service.getActive()).rejects.toThrow("connection terminated");
  });

  it("a failed load is NOT cached — the next call retries and gets the real row", async () => {
    // If a transient error poisoned the cache, a 1-second blip would pin the whole API
    // to defaults for the rest of the TTL and nobody would know why the feed changed.
    let attempt = 0;
    const getActive = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return storedRow({ tierFloorMonths: 18 }, 2) as never;
    });
    const service = new MatchConfigService({ getActive } as unknown as MatchConfigRepository);
    vi.spyOn(service["logger"], "error").mockImplementation(() => undefined);

    expect(await service.get()).toBe(DEFAULT_MATCH_CONFIG);
    expect((await service.get()).tierFloorMonths).toBe(18);
    expect(getActive).toHaveBeenCalledTimes(2);
  });
});

describe("MatchConfigService — caching", () => {
  it("reads the row ONCE across many calls inside the TTL", async () => {
    const { service, getActive } = make(storedRow({ tierFloorMonths: 18 }, 2));
    for (let i = 0; i < 5; i += 1) expect((await service.get()).tierFloorMonths).toBe(18);
    expect(getActive).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the 30s TTL — an ops edit lands within a page refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const rows = [storedRow({ tierFloorMonths: 36 }, 1), storedRow({ tierFloorMonths: 12 }, 2)];
    let n = 0;
    const getActive = vi.fn(async () => rows[Math.min(n++, 1)] as never);
    const service = new MatchConfigService({ getActive } as unknown as MatchConfigRepository);

    expect((await service.get()).tierFloorMonths).toBe(36);
    vi.setSystemTime(new Date("2026-07-31T00:00:29.000Z"));
    expect((await service.get()).tierFloorMonths).toBe(36); // still inside the TTL
    expect(getActive).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-07-31T00:00:31.000Z"));
    expect((await service.get()).tierFloorMonths).toBe(12); // TTL expired → re-read
    expect(getActive).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the very next call to re-read", async () => {
    const rows = [storedRow({ tierFloorMonths: 36 }, 1), storedRow({ tierFloorMonths: 6 }, 2)];
    let n = 0;
    const getActive = vi.fn(async () => rows[Math.min(n++, 1)] as never);
    const service = new MatchConfigService({ getActive } as unknown as MatchConfigRepository);

    expect((await service.get()).tierFloorMonths).toBe(36);
    service.invalidate();
    expect((await service.get()).tierFloorMonths).toBe(6);
    expect(getActive).toHaveBeenCalledTimes(2);
  });

  it("COALESCES concurrent cold-cache loads into one SELECT", async () => {
    // N simultaneous feed requests on a cold cache must not become N round-trips.
    let release!: (row: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const getActive = vi.fn(() => gate as Promise<never>);
    const service = new MatchConfigService({ getActive } as unknown as MatchConfigRepository);

    const inFlight = [service.get(), service.get(), service.get()];
    release(storedRow({ tierFloorMonths: 9 }, 3));
    const results = await Promise.all(inFlight);

    expect(getActive).toHaveBeenCalledTimes(1);
    for (const cfg of results) expect(cfg.tierFloorMonths).toBe(9);
  });
});
