/**
 * Question-pack resolution: occupation → family → pack, with the six-level fallback chain.
 *
 * TWO DIFFERENT QUESTIONS, and conflating them is the bug this service exists to prevent:
 *
 * - {@link resolveForOccupation} — "which pack should this conversation use?" Asked ONCE, when
 *   the occupation is pinned. Walks the chain and takes the most specific hit.
 * - {@link loadPinned} — "load the pack this conversation is already using." Asked on EVERY
 *   later turn, and it must never re-resolve: a pack release mid-interview would otherwise change
 *   the questions under a worker halfway through answering them (risk #13).
 *
 * CACHING is safe here and nowhere else in the chat path: packs are reviewed static content with
 * no worker data in them, identical for every worker by construction. The cache is keyed on
 * `packId:version`, which is immutable — a new version is a new key, so there is no invalidation
 * problem to get wrong.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  QuestionPackSchema,
  type OccupationPin,
  type QuestionPack,
  type QuestionPackItem,
  type QuestionPackOption,
} from "@badabhai/ai-contracts";

import { resolveFamily } from "@badabhai/db";

import { SERVER_CONFIG } from "../config/config.module";
import { isValidPredicate } from "./predicate";
import { PackCacheService, type CacheLookup, type PackRef } from "./pack-cache.service";
import {
  computeContentHash,
  resolutionKey,
  PACK_CACHE_MAX_ENTRIES,
  PACK_CACHE_TTL_MS,
  PACK_RESOLUTION_TTL_MS,
} from "./pack-cache.constants";
import type { PackItemRow, PackOptionRow } from "./pack.repository";
// A VALUE import, and it has to be. `PackRepository` is constructor-injected below, and Nest
// reads that dependency from the `design:paramtypes` TypeScript emits for the decorator. For a
// TYPE-ONLY import there is no value at runtime, so the compiler emits `Function` instead of the
// class and Nest resolves the dependency to nothing:
//
//     Nest can't resolve dependencies of PackRegistryService (SERVER_CONFIG, ?)
//
// It stayed latent through all of Phase 5 because this module is dark — nothing imported it, so
// the container never built it, every unit test hand-constructs `new PackRegistryService(...)`,
// and `profiling.module.boot.test.ts` asserts on `@Module` METADATA rather than on a compiled
// container (the runner does not emit `design:paramtypes` at all, so it cannot do otherwise).
// The first thing to import this module found it instantly, at boot, in CI.
import { PackRepository } from "./pack.repository";

/**
 * Re-exported so the many existing importers of `PACK_CACHE_TTL_MS` and `computeContentHash` keep
 * working — both now live in `pack-cache.constants`, a leaf module that exists to keep this file
 * and `PackCacheService` from importing each other as values. See that file's header.
 */
export { PACK_CACHE_TTL_MS, computeContentHash } from "./pack-cache.constants";

/** A cached pack, with the instant it goes stale. */
interface CacheEntry {
  readonly pack: QuestionPack;
  readonly expiresAt: number;
}

/** A resolution the chain has already worked out, with the instant it goes stale. */
interface ResolutionEntry {
  readonly ref: PackRef | null;
  readonly expiresAt: number;
}

@Injectable()
export class PackRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PackRegistryService.name);
  /**
   * L1 for pack CONTENT. Insertion-ordered `Map`, expiring and capped — see
   * {@link PACK_CACHE_TTL_MS} and {@link PACK_CACHE_MAX_ENTRIES}.
   */
  private readonly cache = new Map<string, CacheEntry>();
  /** L1 for RESOLUTIONS, which do expire. Keyed exactly as the Redis tier keys them. */
  private readonly resolutions = new Map<string, ResolutionEntry>();

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly repo: PackRepository,
    // The SHARED tier. In front of it sit the two `Map`s above; behind it, Postgres. Every method
    // on it fails open, so this class needs no error handling around it — a Redis outage costs
    // the queries it was saving and nothing else.
    private readonly packCache: PackCacheService,
  ) {}

  /**
   * R2 — SAY SO AT BOOT IF THE PACKS ARE NOT SEEDED.
   *
   * The packs live in git and reach a database only via `db:seed:packs --apply`, which runs in
   * CI's e2e job and on NO deploy path. An environment that migrated but never seeded looks
   * completely healthy: `/health` is green, the process serves traffic, and every worker's very
   * first turn resolves no pack and gets the unavailable line — forever, silently. The failure
   * presents as "the orchestrator is broken", which is the wrong thing to go and debug.
   *
   * LOGS AT ERROR, NEVER THROWS, and both halves are deliberate. An unseeded database must not
   * stop the process from starting — that would take down every unrelated route (auth, payer
   * portal, resumes) over one missing seed, and it would make the container crash-loop instead of
   * telling anyone what is wrong. ERROR is what reaches an operator; a throw is what hides the
   * message inside a restart loop.
   *
   * FIRE-AND-FORGET, so a slow or unreachable database cannot delay `listen`. Copied deliberately
   * from `OccupationIndexService.onModuleInit`, which already does exactly this for the
   * occupation catalogue — the identical failure mode one table over.
   */
  onModuleInit(): void {
    void this.assertUniversalPackSeeded();
  }

  private async assertUniversalPackSeeded(): Promise<void> {
    try {
      const universal = await this.loadUniversal(Date.now());
      if (universal === null) {
        this.logger.error(
          `NO UNIVERSAL QUESTION PACK for locale "${this.config.PROFILING_PACK_LOCALE}". Every ` +
            `interview will fail closed to the unavailable reply. Run ` +
            `\`pnpm --filter @badabhai/db db:seed:packs --apply\` against this database, then ` +
            `\`db:verify:packs\`. (A locale mismatch presents identically: the packs are seeded ` +
            `as "hi-IN", and PROFILING_PACK_LOCALE is free-form, so "hi" or "hi_IN" matches zero ` +
            `rows with no other error.)`,
        );
        return;
      }
      this.logger.log(
        `universal pack ready: ${universal.pack_id} v${universal.version} ` +
          `(${universal.items.length} items, locale ${universal.locale})`,
      );
    } catch (error) {
      // A boot-time probe must never become a way to fail boot. The database being unreachable
      // right now is a different (and louder) problem than the packs being unseeded.
      this.logger.error(
        `universal pack check could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Resolve the pack for a freshly pinned occupation, walking the chain from most specific to
   * universal.
   *
   * Returns `null` only when even the UNIVERSAL pack is missing, which is a seeding failure
   * rather than a normal outcome — `db:verify:packs` fails the build on it. The caller closes the
   * interview with `no_pack` rather than degrading to no questions at all.
   */
  async resolveForOccupation(
    occupation: OccupationPin | null,
    now: number,
  ): Promise<QuestionPack | null> {
    const jobDomainId = occupation?.job_domain_id ?? null;
    const iscoUnitCode = occupation?.isco_unit_code ?? null;

    // THE CACHED ANSWER, AND WHY IT IS RE-VERIFIED RATHER THAN TRUSTED WHOLE.
    //
    // A hit gives us the pack this chain landed on last time. Loading it can still come back
    // null — a version deleted, or a row edited into something the contract rejects — and in that
    // case the cached answer is simply wrong. Falling through to the full walk is the only safe
    // response: returning null here would hand a worker `no_pack` on the strength of a stale
    // entry, when the live chain would have fallen through to their parent family's pack. A cache
    // may cost a query; it may never cost an interview.
    const locale = this.config.PROFILING_PACK_LOCALE;
    const l1Key = resolutionKey(locale, jobDomainId, iscoUnitCode);
    const l1 = this.resolutions.get(l1Key);
    let cached: CacheLookup<PackRef | null>;
    if (l1 && l1.expiresAt > now) {
      cached = { hit: true, value: l1.ref };
    } else {
      cached = await this.packCache.readResolution(locale, jobDomainId, iscoUnitCode);
      // PROMOTE AN L2 HIT INTO L1. Without this the in-process tier is only ever populated by the
      // instance that WALKED the chain, so every other instance pays a Redis round trip on every
      // turn forever — most of the cost this change exists to remove, reintroduced one layer down.
      if (cached.hit) this.rememberResolutionLocally(l1Key, cached.value, now);
    }
    if (cached.hit) {
      if (cached.value === null) return null;
      const pack = await this.load(cached.value.packId, cached.value.version, now);
      if (pack) return pack;
      this.logger.warn(
        `cached resolution ${cached.value.packId}:${cached.value.version} no longer loads; ` +
          `re-walking the chain`,
      );
    }

    const bindings = await this.repo.findBindings({ jobDomainId, iscoUnitCode });
    if (bindings.length === 0) {
      // DELIBERATELY NOT CACHED, and this is the one negative that must not be.
      //
      // A healthy database always has at least the `is_universal` binding, so zero rows means
      // either an unseeded database or — the dangerous case — a re-seed in flight:
      // `seed-question-packs.ts` runs `db.delete(profilingFamilyBindings)` and re-inserts,
      // OUTSIDE a transaction. A read landing in that window sees nothing.
      //
      // Caching it would take a millisecond-wide gap in an operator's `db:seed:packs --apply` and
      // turn it into a fleet-wide `no_pack` outage lasting a full resolution TTL, for every worker
      // on the platform. Re-running the query is cheap; the alternative is an incident.
      //
      // AND IT SAYS SO OUT LOUD, which it did not. This branch is the single point every
      // unseeded-database interview passes through, and it used to return null in silence: the
      // engine then served the universal tail (`nextQuestion` falls through to it whenever
      // `packs.occupation` is null), the worker answered eight generic questions instead of their
      // trade's, and the only visible symptom was a thin profile — with nothing in any log,
      // event or metric naming the cause. It cost a screenshot-driven investigation to find, on a
      // condition the process can state exactly.
      //
      // WARN, NOT ERROR, and never a throw: an interview on the universal pack alone is degraded,
      // not broken, and the worker still reaches a profile. The point is that an operator can
      // now grep for it instead of inferring it from question text.
      this.logger.warn(
        `no family bindings for job_domain=${jobDomainId ?? "-"} isco=${iscoUnitCode ?? "-"} ` +
          `locale=${locale}; this interview gets the UNIVERSAL pack only (no trade questions). ` +
          `A healthy database always has the is_universal binding, so this is almost always an ` +
          `unseeded database — run 'pnpm db:seed:packs --apply' and verify with 'db:verify:packs'`,
      );
      return null;
    }

    const heads = await this.repo.findActivePacks(
      [...new Set(bindings.map((b) => b.familyId))],
      this.config.PROFILING_PACK_LOCALE,
    );
    const headByFamily = new Map(heads.map((head) => [head.familyId, head]));

    // WHICH LEVEL WINS IS `resolveFamily`'S CALL, not this service's.
    //
    // That function lives in `@badabhai/db` beside `RESOLVE_FAMILY_SQL`, and a parity test pins
    // the two to the same six levels and the same slicing — so the interview and the
    // `db:verify:packs` deploy gate cannot come to different conclusions about which family owns a
    // trade. Re-deriving the chain here would give up exactly that guarantee, and did: this
    // service's own ISCO slicing rejected 3- and 2-digit codes that Postgres `left()` accepts, so
    // a short code resolved to the universal pack in the engine and to a real family in the gate.
    //
    // THE LOOP IS THE FALL-THROUGH. `resolveFamily` answers "which family", once. A family with a
    // binding but no ACTIVE pack must not abort the chain — Phase 6 lands 200 families
    // incrementally, so half-authored is the NORMAL state — so a family that cannot produce a
    // usable pack is removed and the question is asked again of what remains. Bounded by the six
    // binding levels; `remaining` strictly shrinks each pass.
    let remaining = bindings;
    const key = {
      jobDomainId: occupation?.job_domain_id ?? "",
      iscoUnitCode: occupation?.isco_unit_code ?? null,
    };
    while (remaining.length > 0) {
      const resolved = resolveFamily(remaining, key);
      if (!resolved) break;

      const head = headByFamily.get(resolved.familyId);
      const pack = head ? await this.load(head.packId, head.version, now) : null;
      if (pack) {
        await this.remember(jobDomainId, iscoUnitCode, { packId: pack.pack_id, version: pack.version }, now);
        return pack;
      }

      remaining = remaining.filter((binding) => binding.familyId !== resolved.familyId);
    }
    // THE CHAIN RAN AND PRODUCED NOTHING — cached as the definite answer it is. This is the
    // normal outcome for a trade whose family is unauthored AND whose universal pack is missing;
    // it is also the expensive one, because it is the path that walked every level.
    //
    // NOTE the `break` above rather than the `return null` this loop used to carry: an exhausted
    // chain and an unresolvable one are the same answer, and both deserve the same entry.
    await this.remember(jobDomainId, iscoUnitCode, null, now);
    return null;
  }

  /**
   * The active pack a FAMILY owns, with no fallback chain.
   *
   * DELIBERATELY NOT A FALL-THROUGH. `resolveForOccupation` answers "what would this worker be
   * asked", and falling through to a parent family is the right answer there. This answers "what
   * does THIS family own", which ops tooling and the pack-authoring loop need in order to see
   * that a family has no pack yet — a question a fall-through would silently answer with somebody
   * else's pack.
   *
   * Returns `null` when the family has no active pack in the configured locale. That is a normal
   * state during Phase 6 authoring, not an error.
   */
  async loadForFamily(familyId: string, now: number): Promise<QuestionPack | null> {
    const heads = await this.repo.findActivePacks([familyId], this.config.PROFILING_PACK_LOCALE);
    const head = heads[0];
    return head ? this.load(head.packId, head.version, now) : null;
  }

  /**
   * The UNIVERSAL pack — the tail every interview runs, whatever trade the worker is in.
   *
   * Resolved through the same chain with no occupation, which can only match the `is_universal`
   * binding. Sharing the path rather than a bespoke query means the universal pack is loaded,
   * validated and cached exactly like any other, so it cannot be the one pack whose defects go
   * unnoticed.
   */
  async loadUniversal(now: number): Promise<QuestionPack | null> {
    return this.resolveForOccupation(null, now);
  }

  /**
   * Load the EXACT pinned version. Never re-resolves, never falls back to `active`.
   *
   * A miss here means the pinned version was deleted mid-interview, which the schema's `restrict`
   * FKs make very hard. It returns null rather than quietly substituting the current active
   * version — answering question 7 of a pack the worker was never asked questions 1–6 of is worse
   * than closing the interview.
   */
  async loadPinned(packId: string, version: number, now: number): Promise<QuestionPack | null> {
    return this.load(packId, version, now);
  }

  /**
   * A pack, from the nearest tier that has it: this process, then Redis, then Postgres.
   *
   * BOTH CACHES EXPIRE, on the same clock — see {@link PACK_CACHE_TTL_MS} for why that is
   * deliberate rather than leftover, and what breaks if a future change "optimises" it away.
   */
  private async load(packId: string, version: number, now: number): Promise<QuestionPack | null> {
    const key = `${packId}:${version}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.pack;

    // L2, and the tier that makes a cold instance cheap. A deploy, a restart or a scale-out used
    // to mean every worker mid-interview paid four queries to rebuild a pack that another
    // instance already had in memory.
    const shared = await this.packCache.readPack(packId, version);
    if (shared) {
      this.rememberPack(key, shared, now);
      return shared;
    }

    const head = await this.repo.findPackHead(packId, version);
    if (!head) return null;

    const itemRows = await this.repo.findItems(packId, version);
    const optionRows = await this.repo.findOptions(itemRows.map((row) => row.itemId));
    const optionsByItem = new Map<string, PackOptionRow[]>();
    for (const option of optionRows) {
      const list = optionsByItem.get(option.itemId);
      if (list) list.push(option);
      else optionsByItem.set(option.itemId, [option]);
    }

    const items = itemRows.map((row) => toItem(row, optionsByItem.get(row.itemId) ?? []));
    // DERIVED FROM WHAT WAS ACTUALLY LOADED, not read from the column.
    //
    // `question_pack.content_hash` is nullable and, as of this writing, NOTHING WRITES IT — so
    // trusting the column would make `content_hash` (a REQUIRED contract field) null for every
    // pack in the database and drop all of them at validation. Computing it here also gives the
    // value a stronger meaning than a stored string has: it describes the object this loader
    // built, so a mismatch against a stored hash is real drift and is reported as such.
    const contentHash = computeContentHash(items);
    if (head.contentHash && head.contentHash !== contentHash) {
      // Loud, but NOT fatal. A stale hash column means the seeder and the database disagree
      // about the pack's content; the DATABASE is what a live interview reads either way, so
      // refusing to serve would turn an observability defect into an outage.
      this.logger.warn(
        `question pack ${packId}:${version} content drift — stored hash ${head.contentHash} ` +
          `does not match the loaded content ${contentHash}; serving the database's version`,
      );
    }

    const candidate = {
      pack_id: head.packId,
      version: head.version,
      family_id: head.familyId,
      locale: head.locale,
      status: "active",
      content_hash: contentHash,
      items,
    };

    // VALIDATED ON THE WAY OUT OF THE DATABASE, not merely on the way in. `db:verify:packs` gates
    // authoring, but a row can be edited by hand, restored from an older dump, or written by a
    // migration nobody ran the verifier after — and this is the object a live interview reads. A
    // pack that fails here is DROPPED, which the caller degrades to the next chain level.
    const parsed = QuestionPackSchema.safeParse(candidate);
    if (!parsed.success) {
      this.logger.error(
        `question pack ${key} failed contract validation and was dropped; ` +
          `paths=[${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}]`,
      );
      return null;
    }

    this.rememberPack(key, parsed.data, now);
    // Populate the shared tier LAST, and only with a pack that survived validation — never with
    // the raw candidate. Redis must not become a way to distribute a malformed pack to every
    // instance that has not read the database yet.
    await this.packCache.writePack(parsed.data);
    return parsed.data;
  }

  /**
   * Put a pack in the in-process tier, evicting the oldest entry once the cap is reached.
   *
   * INSERTION-ORDER EVICTION, not true LRU. `Map` preserves insertion order and
   * `keys().next().value` is the oldest key, so this is FIFO — and for this workload the two are
   * indistinguishable: the working set is the handful of packs the instance's live interviews are
   * pinned to, the corpus is ~101 packs against a cap of 200, and the cap exists to bound a
   * pathological process rather than to optimise a hit rate. Promoting on read would buy nothing
   * measurable and would make every cache HIT a write.
   */
  private rememberPack(key: string, pack: QuestionPack, now: number): void {
    if (this.cache.size >= PACK_CACHE_MAX_ENTRIES && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { pack, expiresAt: now + PACK_CACHE_TTL_MS });
  }

  /**
   * Record which pack a trade resolves to, in BOTH tiers.
   *
   * Written through rather than left to the shared tier alone: `loadUniversal` runs on every turn
   * of every interview, and a Redis round trip per turn to answer a question this process just
   * answered is most of the cost this change exists to remove.
   */
  private async remember(
    jobDomainId: string | null,
    iscoUnitCode: string | null,
    ref: PackRef | null,
    now: number,
  ): Promise<void> {
    const locale = this.config.PROFILING_PACK_LOCALE;
    this.rememberResolutionLocally(resolutionKey(locale, jobDomainId, iscoUnitCode), ref, now);
    await this.packCache.writeResolution(locale, jobDomainId, iscoUnitCode, ref);
  }

  /**
   * Put a resolution in the in-process tier, bounded the same way the content tier is.
   *
   * CAPPED AND SWEPT, because a `Map` keyed on `(locale, jobDomainId, iscoUnitCode)` is keyed on
   * WORKER INPUT in a way the content map is not: there are thousands of `job_domain` rows and
   * every distinct one a worker resolves mints an entry. Expiry alone does not bound it — an entry
   * is only dropped when that exact key is next read, and the long tail of trades never is. The
   * sweep is what makes a lapsed entry actually free its memory rather than merely stop being
   * served.
   */
  private rememberResolutionLocally(key: string, ref: PackRef | null, now: number): void {
    if (this.resolutions.size >= PACK_CACHE_MAX_ENTRIES) {
      for (const [candidate, entry] of this.resolutions) {
        if (entry.expiresAt <= now) this.resolutions.delete(candidate);
      }
      // Still full of live entries — drop the oldest, exactly as the content tier does.
      if (this.resolutions.size >= PACK_CACHE_MAX_ENTRIES) {
        const oldest = this.resolutions.keys().next().value;
        if (oldest !== undefined) this.resolutions.delete(oldest);
      }
    }
    this.resolutions.set(key, { ref, expiresAt: now + PACK_RESOLUTION_TTL_MS });
  }
}

/**
 * The three answer types the DATABASE permits that the FROZEN CONTRACT does not.
 *
 * A REAL DIVERGENCE, not a hypothetical: migration 0069's `qpi_answer_type_chk` accepts
 * `'city' | 'salary' | 'duration'` alongside the contract's five, so a reviewer can author a
 * perfectly legal pack row that `QuestionPackItemSchema` rejects — which would drop the ENTIRE
 * pack and leave that trade with no interview at all.
 *
 * Mapped rather than dropped, and mapped to the INPUT AFFORDANCE each one implies, because
 * `answer_type` is a client rendering hint: what the answer actually becomes is decided by
 * `target_field`, which selects the normalizer in `answer-capture.ts`. Nothing is lost.
 *
 * The alternative — widening `ANSWER_TYPES` — is a change to the Phase 0 frozen contract, which
 * is a joint PR mirrored in `contracts.py` and `oie.keys.json`. Logged as the narrower fix if the
 * two owners would rather the vocabularies simply agreed.
 */
const ANSWER_TYPE_ALIASES: Readonly<Record<string, string>> = {
  city: "text",
  salary: "number",
  duration: "number",
};

/**
 * A row → the contract's item.
 *
 * `ask_if` / `skip_if` arrive as raw jsonb and are the ONE field on this path that a live
 * interview evaluates as logic. They are validated against `PredicateSchema` and dropped to
 * `null` when malformed — an unevaluatable condition must mean "no condition", never a hard
 * failure that ends the interview and never a condition the evaluator has to guess at.
 */
function toItem(row: PackItemRow, options: readonly PackOptionRow[]): unknown {
  return {
    question_key: row.questionKey,
    display_order: row.displayOrder,
    prompt_text: row.promptText,
    why_text: row.whyText,
    retry_text: row.retryText,
    target_kind: row.targetKind,
    target_field: row.targetField,
    target_skill_id: row.targetSkillId,
    answer_type: ANSWER_TYPE_ALIASES[row.answerType] ?? row.answerType,
    is_mandatory: row.isMandatory,
    is_core: row.isCore,
    max_asks: row.maxAsks,
    min_turn: row.minTurn,
    max_turn: row.maxTurn,
    ask_if: isValidPredicate(row.askIf) ? row.askIf : null,
    skip_if: isValidPredicate(row.skipIf) ? row.skipIf : null,
    parent_item_key: row.parentItemKey,
    options: options.map(toOption),
  } satisfies Record<keyof QuestionPackItem, unknown>;
}

/**
 * A row → the contract's option.
 *
 * THREE TYPED VALUE COLUMNS, ONE CONTRACT FIELD. The column that is non-null is the answer of
 * record; when all three are null the chip's LABEL is the value, which is why `value` is nullable
 * rather than defaulted here — `answer-capture.ts` owns that fallback, and duplicating it would
 * give two files one rule.
 *
 * THE TYPE IS THE POINT, AND IT USED TO BE THROWN AWAY HERE. `String()` on the boolean and the
 * number turned `value_bool: true` into the five characters `"true"`, and every layer downstream
 * of this line decides what to do by looking at the value's SHAPE — `classifyAttributeValue`
 * picks `worker_attributes.value_text` over `value_bool`, so the matcher's own inventory query
 * cannot see the row; the review screen renders the worker their answer as `true` rather than
 * `Haan`; and `relocation_willingness` is `z.boolean()` on the draft, so `WorkerProfileDraftSchema`
 * THROWS in the extraction job for a worker who tapped "Haan, jaa sakta hoon". Four options in the
 * shipped corpus carry `value_bool` and they cover both destinations.
 *
 * `??` rather than a truthiness chain, deliberately: `value_bool: false` and `value_number: 0` are
 * answers, and every other operator here would silently fall through them to the label.
 */
function toOption(row: PackOptionRow): unknown {
  const value: unknown = row.valueText ?? row.valueNumber ?? row.valueBool ?? null;
  return {
    option_key: row.optionKey,
    label_text: row.labelText,
    value,
    implies_skill_id: row.impliesSkillId,
    is_none_of_above: row.isNoneOfAbove,
  } satisfies Record<keyof QuestionPackOption, unknown>;
}
