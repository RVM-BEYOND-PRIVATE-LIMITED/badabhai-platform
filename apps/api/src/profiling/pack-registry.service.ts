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

import { createHash } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
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
import type { PackItemRow, PackOptionRow, PackRepository } from "./pack.repository";

/** How long a resolved pack stays in process. A pack edit is a deploy-scale event, not a turn. */
export const PACK_CACHE_TTL_MS = 900_000;

interface CacheEntry {
  readonly pack: QuestionPack;
  readonly expiresAt: number;
}

@Injectable()
export class PackRegistryService {
  private readonly logger = new Logger(PackRegistryService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly repo: PackRepository,
  ) {}

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
    const bindings = await this.repo.findBindings({
      jobDomainId: occupation?.job_domain_id ?? null,
      iscoUnitCode: occupation?.isco_unit_code ?? null,
    });
    if (bindings.length === 0) return null;

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
      if (!resolved) return null;

      const head = headByFamily.get(resolved.familyId);
      const pack = head ? await this.load(head.packId, head.version, now) : null;
      if (pack) return pack;

      remaining = remaining.filter((binding) => binding.familyId !== resolved.familyId);
    }
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

  private async load(packId: string, version: number, now: number): Promise<QuestionPack | null> {
    const key = `${packId}:${version}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.pack;

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

    this.cache.set(key, { pack: parsed.data, expiresAt: now + PACK_CACHE_TTL_MS });
    return parsed.data;
  }
}

/**
 * sha256 over the pack's loaded content, for drift detection.
 *
 * `JSON.stringify` of an array of objects built by {@link toItem} is stable HERE — and only here
 * — because every object is constructed with literal keys in a fixed order by that one function,
 * and the items arrive ordered by `display_order`. It would NOT be stable over arbitrary objects,
 * which is why this takes the mapped items rather than the raw rows.
 */
export function computeContentHash(items: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
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
 */
function toOption(row: PackOptionRow): unknown {
  const value =
    row.valueText ??
    (row.valueNumber !== null ? String(row.valueNumber) : null) ??
    (row.valueBool !== null ? String(row.valueBool) : null);
  return {
    option_key: row.optionKey,
    label_text: row.labelText,
    value,
    implies_skill_id: row.impliesSkillId,
    is_none_of_above: row.isNoneOfAbove,
  } satisfies Record<keyof QuestionPackOption, unknown>;
}
