/**
 * The two cache clocks and the content hash — a LEAF module, imported by both cache tiers and
 * importing neither.
 *
 * IT EXISTS TO BREAK A CYCLE, not to group tidy things. `PackRegistryService` must import
 * `PackCacheService` as a VALUE (Nest reads constructor dependencies from the `design:paramtypes`
 * TypeScript emits, and a type-only import emits `Function` instead of the class — the exact
 * failure `pack-registry.service.ts` already carries a long comment about). The cache service in
 * turn needs the hash function and the TTLs. Leaving those in the registry would make the two
 * files import each other as values, which resolves to `undefined` at whichever end loads second
 * and fails at BOOT rather than in a test.
 */

import { createHash } from "node:crypto";

/**
 * How long a resolved pack's CONTENT stays cached, in both tiers. A pack edit is a deploy-scale
 * event, not a turn.
 *
 * THE TTL IS LOAD-BEARING, however immutable `packId:version` looks — and it looks very immutable.
 * `PackRegistryService`'s header states the rule ("a new version is a new key, so there is no
 * invalidation problem to get wrong"), but that is the authoring DISCIPLINE, not an enforced
 * invariant. `packages/db/src/seed-question-packs.ts` upserts `question_pack` on
 * `(pack_id, version)` and then DELETES AND RE-INSERTS that version's items and options — "the
 * committed file is the whole truth for a pack version". So editing a pack's JSON and re-running
 * `db:seed:packs --apply` without bumping the version rewrites content under a key nothing else
 * expects to change.
 *
 * Caching that forever is the obvious optimisation and it is a trap: a routine re-seed would
 * poison every instance permanently, recoverable only by flushing Redis by hand. This expiry
 * bounds the damage to one TTL, and must not be removed until the seeder refuses to touch a
 * published version.
 */
export const PACK_CACHE_TTL_MS = 900_000;

/** The same bound in the shared tier's units, so the two tiers cannot drift apart. */
export const PACK_CACHE_TTL_SECONDS = PACK_CACHE_TTL_MS / 1000;

/**
 * How long a RESOLUTION — "which pack does this trade get" — stays cached.
 *
 * Much shorter than the content TTL, because it guards a faster-moving fact: which VERSION is
 * `active`. Publishing a pack should reach a running instance in a minute, not a quarter of an
 * hour.
 */
export const PACK_RESOLUTION_TTL_SECONDS = 60;

export const PACK_RESOLUTION_TTL_MS = PACK_RESOLUTION_TTL_SECONDS * 1000;

/**
 * Ceiling on in-process cached packs, evicted oldest-first.
 *
 * The corpus is ~101 packs today and the plan of record specified a cap of 200; the `Map` shipped
 * with none. The TTL alone does not bound it — an entry is only evicted when it is next READ, so a
 * process that resolves many packs and re-reads few holds every one of them until it is asked for
 * again. The cap makes that impossible rather than merely unlikely.
 */
export const PACK_CACHE_MAX_ENTRIES = 200;

/**
 * sha256 over the pack's loaded content, for drift detection.
 *
 * `JSON.stringify` of an array of objects built by `toItem` is stable HERE — and only here —
 * because every object is constructed with literal keys in a fixed order by that one function, and
 * the items arrive ordered by `display_order`. It would NOT be stable over arbitrary objects,
 * which is why callers pass the mapped items rather than the raw rows.
 */
export function computeContentHash(items: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

/**
 * sha256 over an exact string — the integrity check for a cached pack.
 *
 * DELIBERATELY NOT {@link computeContentHash}, and the difference is not cosmetic. That one hashes
 * `JSON.stringify` of live objects, and the objects on either side of a Redis round trip are NOT
 * key-order-identical: the writer holds items built by `toItem` in literal order, while the reader
 * holds items rebuilt by `QuestionPackSchema.parse`, which emits keys in SCHEMA order. Hashing
 * those two produces two different digests for the same pack, so the integrity check would fail
 * every single time and the shared tier would silently never serve anything.
 *
 * Hashing the stored BYTES has no such ambiguity: `JSON.parse` preserves key insertion order and
 * `JSON.stringify` re-emits it, so the string round-trips exactly.
 */
export function hashSerialized(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The resolution cache key, shared by BOTH tiers. `_` stands in for an absent component so the key
 * is always three segments and two different absences can never collide with a real value.
 *
 * ONE DEFINITION, DELIBERATELY. `PackRegistryService` keys its in-process tier with this and
 * `PackCacheService` prefixes it for Redis. Two spellings of the same key would fail no test —
 * they would just make the in-process tier permanently miss on entries the shared tier holds,
 * which presents as "the cache does nothing" and is invisible from either side.
 *
 * ISCO ANCESTRY IS NOT PART OF IT, and must not be: `PackRepository.findBindings` derives the
 * minor, sub-major and major codes from the unit code via `iscoAncestry`, so they are a pure
 * function of what is already here. Adding them would split one entry into one-per-caller for no
 * gain.
 */
export function resolutionKey(
  locale: string,
  jobDomainId: string | null,
  iscoUnitCode: string | null,
): string {
  return `${locale}:${jobDomainId ?? "_"}:${iscoUnitCode ?? "_"}`;
}
