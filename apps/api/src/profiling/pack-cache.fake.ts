/**
 * An in-memory stand-in for {@link PackCacheService}, for tests that are about something else.
 *
 * WHY A SHARED FAKE RATHER THAN A `vi.fn()` PER FILE. Three suites construct
 * `PackRegistryService` directly, and every one of them cares about the fallback chain, the
 * pinning rule or the typed option values — not about caching. Handing each its own ad-hoc double
 * would mean three places to update when the cache interface moves, and (worse) three chances for
 * a double to be MORE forgiving than the real thing and hide a bug.
 *
 * IT IS A REAL CACHE, not a null object: `readResolution` returns what `writeResolution` stored,
 * with the same miss-vs-cached-nothing distinction. A double that always missed would make every
 * caching test in `pack-registry.service.test.ts` vacuous — they would pass against an
 * implementation that never cached anything, which is precisely the regression worth catching.
 *
 * EXPIRY IS EXPLICIT, not clock-driven. Redis owns TTLs in production and this fake has no clock,
 * so a test says "the Redis keys have now expired" by calling {@link FakePackCache.expire} rather
 * than by advancing a timer. Modelling it as a no-op instead would make the fake strictly more
 * forgiving than Redis — the in-process tier would expire, fall through to a shared tier that
 * never does, and every "it re-reads the database eventually" test would pass against an
 * implementation that had stopped re-reading it.
 */

import type { QuestionPack } from "@badabhai/ai-contracts";

import { resolutionKey } from "./pack-cache.constants";
import type { CacheLookup, PackCacheService, PackRef } from "./pack-cache.service";

export interface FakePackCache {
  readonly cache: PackCacheService;
  /** Every key written, so a test can assert the shared tier was actually populated. */
  readonly packWrites: string[];
  readonly resolutionWrites: string[];
  /** Force the shared tier to behave as an outage — every read and write throws internally. */
  fail(): void;
  /** Simulate the Redis TTLs firing. `"packs"` expires only content, leaving resolutions warm. */
  expire(what?: "all" | "packs" | "resolutions"): void;
}

export function fakePackCache(): FakePackCache {
  const packs = new Map<string, QuestionPack>();
  const resolutions = new Map<string, PackRef | null>();
  const packWrites: string[] = [];
  const resolutionWrites: string[] = [];
  let broken = false;

  const cache = {
    async readResolution(
      locale: string,
      jobDomainId: string | null,
      iscoUnitCode: string | null,
    ): Promise<CacheLookup<PackRef | null>> {
      // The real service swallows its own errors and reports a miss, so the fake does too —
      // otherwise a test for "Redis is down" would assert against a throw the registry never sees.
      if (broken) return { hit: false };
      const key = resolutionKey(locale, jobDomainId, iscoUnitCode);
      if (!resolutions.has(key)) return { hit: false };
      return { hit: true, value: resolutions.get(key) ?? null };
    },
    async writeResolution(
      locale: string,
      jobDomainId: string | null,
      iscoUnitCode: string | null,
      value: PackRef | null,
    ): Promise<void> {
      if (broken) return;
      const key = resolutionKey(locale, jobDomainId, iscoUnitCode);
      resolutions.set(key, value);
      resolutionWrites.push(key);
    },
    async readPack(packId: string, version: number): Promise<QuestionPack | null> {
      if (broken) return null;
      return packs.get(`${packId}:${version}`) ?? null;
    },
    async writePack(pack: QuestionPack): Promise<void> {
      if (broken) return;
      const key = `${pack.pack_id}:${pack.version}`;
      packs.set(key, pack);
      packWrites.push(key);
    },
  };

  return {
    cache: cache as unknown as PackCacheService,
    packWrites,
    resolutionWrites,
    fail: () => {
      broken = true;
    },
    expire: (what = "all") => {
      if (what !== "resolutions") packs.clear();
      if (what !== "packs") resolutions.clear();
    },
  };
}
