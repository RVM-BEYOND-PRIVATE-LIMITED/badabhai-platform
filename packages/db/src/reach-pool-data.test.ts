import { describe, it, expect } from "vitest";
import {
  makeRng,
  pickWeighted,
  reachSeedUuid,
  REACH_SEED_PREFIX,
  REACH_CITIES,
  REACH_TRADES,
} from "./reach-pool-data";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("makeRng — deterministic seeded PRNG (never Math.random)", () => {
  it("same seed → identical sequence", () => {
    const a = makeRng(1337);
    const b = makeRng(1337);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds → different sequences", () => {
    const a = Array.from({ length: 20 }, makeRng(1).next);
    const b = Array.from({ length: 20 }, makeRng(2).next);
    expect(a).not.toEqual(b);
  });

  it("emits floats in [0, 1)", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("normalizes a non-finite seed deterministically (fail-safe, still reproducible)", () => {
    const a = Array.from({ length: 10 }, makeRng(Number.NaN).next);
    const b = Array.from({ length: 10 }, makeRng(0).next);
    expect(a).toEqual(b);
  });
});

describe("pickWeighted — stable, one draw per pick", () => {
  it("same seed → same selection sequence", () => {
    const items = ["a", "b", "c"];
    const weights = [0.5, 0.3, 0.2];
    const r1 = makeRng(7);
    const r2 = makeRng(7);
    const s1 = Array.from({ length: 30 }, () => pickWeighted(items, weights, r1));
    const s2 = Array.from({ length: 30 }, () => pickWeighted(items, weights, r2));
    expect(s1).toEqual(s2);
  });

  it("respects the weights (heavier item appears more often)", () => {
    const rng = makeRng(99);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 5000; i++) {
      counts[pickWeighted(["a", "b"], [0.9, 0.1], rng) as "a" | "b"]++;
    }
    expect(counts.a).toBeGreaterThan(counts.b * 3);
  });

  it("throws on empty items (fail-closed)", () => {
    expect(() => pickWeighted([], [], makeRng(1))).toThrow();
  });
});

describe("reachSeedUuid — namespaced, stable, v4-shaped", () => {
  it("is a deterministic function of (kind, index)", () => {
    expect(reachSeedUuid("worker", 0)).toBe(reachSeedUuid("worker", 0));
    expect(reachSeedUuid("worker", 41)).toBe(reachSeedUuid("worker", 41));
  });

  it("carries the reach-seed namespace prefix (flags it as a seed row)", () => {
    expect(reachSeedUuid("worker", 5).startsWith(REACH_SEED_PREFIX)).toBe(true);
    expect(reachSeedUuid("payer", 5).startsWith(REACH_SEED_PREFIX)).toBe(true);
  });

  it("is a valid v4-shaped UUID for every kind + a range of indices", () => {
    const kinds = [
      "worker",
      "profile",
      "consent",
      "payer",
      "credits",
      "capacity",
      // ADR-0027 B5.x Inc 2: the per-payer solo org + owner member (the wallet org_id source).
      "org",
      "member",
      "posting",
      "plan",
      "job",
    ] as const;
    for (const kind of kinds) {
      for (const i of [0, 1, 99, 4095, 65535, 99999]) {
        expect(reachSeedUuid(kind, i), `${kind}#${i}`).toMatch(UUID_RE);
      }
    }
  });

  it("never collides across kinds or indices (unique namespacing)", () => {
    const ids = new Set<string>();
    // Include the ADR-0027 B5.x Inc 2 org + member kinds — their tag ranges must stay disjoint
    // from payer/credits/capacity so the seeded solo-org id never clashes with a payer-scoped row.
    const kinds = [
      "worker",
      "profile",
      "consent",
      "payer",
      "credits",
      "capacity",
      "org",
      "member",
      "posting",
      "plan",
      "job",
    ] as const;
    for (const kind of kinds) {
      for (let i = 0; i < 600; i++) {
        const id = reachSeedUuid(kind, i);
        expect(ids.has(id), `dup ${id}`).toBe(false);
        ids.add(id);
      }
    }
  });

  it("throws on an unknown kind (runtime guard)", () => {
    expect(() => reachSeedUuid("bogus" as Parameters<typeof reachSeedUuid>[0], 0)).toThrow();
  });
});

describe("reach reference data", () => {
  it("has the 10 manufacturing-hub cities with finite centroids", () => {
    expect(REACH_CITIES).toHaveLength(10);
    for (const c of REACH_CITIES) {
      expect(Number.isFinite(c.lat)).toBe(true);
      expect(Number.isFinite(c.lng)).toBe(true);
      expect(c.lat).toBeGreaterThan(8); // India latitude band sanity
      expect(c.lat).toBeLessThan(35);
    }
  });

  it("covers all 7 canonical taxonomy roles with non-uniform weights", () => {
    expect(REACH_TRADES).toHaveLength(7);
    const roleIds = new Set(REACH_TRADES.map((t) => t.roleId));
    for (const r of [
      "role_cnc_turner_operator",
      "role_vmc_operator",
      "role_hmc_operator",
      "role_cnc_setter_operator",
      "role_cnc_programmer",
      "role_cam_programmer",
      "role_cnc_grinding_operator",
    ]) {
      expect(roleIds.has(r), `missing ${r}`).toBe(true);
    }
    // Non-uniform: the common trades clearly outweigh the rare ones (thin supply).
    const weights = REACH_TRADES.map((t) => t.weight);
    expect(Math.max(...weights)).toBeGreaterThan(Math.min(...weights) * 3);
  });
});
