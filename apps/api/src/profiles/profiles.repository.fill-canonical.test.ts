import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { DraftProfileSchema } from "@badabhai/ai-contracts";

import { ProfilesRepository } from "./profiles.repository";

const PROFILE = "55555555-5555-4555-8555-555555555555";
const IDS = {
  canonicalRoleId: "role_cnc_turner_operator",
  canonicalTradeId: "dom_cnc_machining",
};

/** Minimal in-memory `worker_profiles` behind the two Drizzle chains `fillCanonicalIds` uses. */
function makeRepo(seed: Record<string, Record<string, unknown>>) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const row = store.get(PROFILE);
            return row ? [{ ...row }] : [];
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          const row = store.get(PROFILE);
          if (row) store.set(PROFILE, { ...row, ...values });
          return [];
        }),
      })),
    })),
  };
  const repo = new ProfilesRepository(db as never);
  return { repo, store };
}

const blankRow = () => ({
  id: PROFILE,
  canonicalRoleId: null,
  canonicalTradeId: null,
  rawProfile: DraftProfileSchema.parse({}),
});

describe("ProfilesRepository.fillCanonicalIds (#2202)", () => {
  it("fills both blanks and patches the raw_profile snapshot with them", async () => {
    const { repo, store } = makeRepo({ [PROFILE]: blankRow() });
    await expect(repo.fillCanonicalIds(PROFILE, IDS)).resolves.toBe(true);
    const row = store.get(PROFILE)!;
    expect(row.canonicalRoleId).toBe(IDS.canonicalRoleId);
    expect(row.canonicalTradeId).toBe(IDS.canonicalTradeId);
    const raw = row.rawProfile as Record<string, unknown>;
    expect(raw.canonical_role_id).toBe(IDS.canonicalRoleId);
    expect(raw.canonical_trade_id).toBe(IDS.canonicalTradeId);
    // The patched snapshot still parses — a corrupt row must never be written.
    expect(() => DraftProfileSchema.parse(raw)).not.toThrow();
  });

  it("is idempotent: a second fill reports false and changes nothing", async () => {
    const { repo, store } = makeRepo({ [PROFILE]: blankRow() });
    await repo.fillCanonicalIds(PROFILE, IDS);
    const before = { ...store.get(PROFILE)! };
    await expect(repo.fillCanonicalIds(PROFILE, IDS)).resolves.toBe(false);
    expect(store.get(PROFILE)).toEqual(before);
  });

  it("never overwrites ids another road already set", async () => {
    const { repo } = makeRepo({
      [PROFILE]: {
        ...blankRow(),
        canonicalRoleId: "role_welder",
        canonicalTradeId: "dom_welding",
        rawProfile: DraftProfileSchema.parse({
          canonical_role_id: "role_welder",
          canonical_trade_id: "dom_welding",
        }),
      },
    });
    await expect(repo.fillCanonicalIds(PROFILE, IDS)).resolves.toBe(false);
  });

  it("returns false for an unknown profile and for blank ids (fail-closed)", async () => {
    const { repo } = makeRepo({});
    await expect(repo.fillCanonicalIds(PROFILE, IDS)).resolves.toBe(false);
    const { repo: repo2 } = makeRepo({ [PROFILE]: blankRow() });
    await expect(
      repo2.fillCanonicalIds(PROFILE, { canonicalRoleId: "  ", canonicalTradeId: "x" }),
    ).resolves.toBe(false);
  });
});
