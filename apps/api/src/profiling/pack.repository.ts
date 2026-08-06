/**
 * Question-pack reads. DATABASE ACCESS ONLY — the fallback chain, the caching and the pinning
 * decisions all live in `PackRegistryService`, which is where business logic belongs (§4).
 *
 * Everything here is a read of REVIEWED STATIC CONTENT. There is no worker data in these five
 * tables, no tenant scoping to apply, and nothing to authorize: a question pack is the same for
 * every worker by construction. That is why these reads are safe to cache in process.
 */

import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  type Database,
  profilingFamilyBindings,
  questionPackItems,
  questionPackOptions,
  questionPacks,
} from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/** One row of the family-binding table, narrowed to what resolution actually needs. */
export interface FamilyBindingRow {
  readonly familyId: string;
  readonly specificity: number;
}

/** A pack head — the row that says which version is live for a family. */
export interface PackHeadRow {
  readonly packId: string;
  readonly version: number;
  readonly familyId: string;
  readonly locale: string;
  /** Nullable in the schema and currently written by nothing — see `computeContentHash`. */
  readonly contentHash: string | null;
}

export interface PackItemRow {
  readonly itemId: string;
  readonly questionKey: string;
  readonly displayOrder: number;
  readonly promptText: string;
  readonly whyText: string | null;
  readonly retryText: string | null;
  readonly targetKind: string;
  readonly targetField: string | null;
  readonly targetSkillId: string | null;
  readonly answerType: string;
  readonly isMandatory: boolean;
  readonly isCore: boolean;
  readonly maxAsks: number;
  readonly minTurn: number | null;
  readonly maxTurn: number | null;
  readonly askIf: unknown;
  readonly skipIf: unknown;
  readonly parentItemKey: string | null;
}

export interface PackOptionRow {
  readonly itemId: string;
  readonly optionKey: string;
  readonly displayOrder: number;
  readonly labelText: string;
  readonly valueText: string | null;
  readonly valueNumber: number | null;
  readonly valueBool: boolean | null;
  readonly impliesSkillId: string | null;
  readonly isNoneOfAbove: boolean;
}

@Injectable()
export class PackRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Every binding that could match this occupation, in ONE round trip.
   *
   * The alternative — six queries walking the chain until one hits — costs six round trips on a
   * miss, which is the COMMON case for a trade nobody has authored a pack for yet. Sorting by
   * specificity in the caller is free; six sequential awaits on the chat hot path are not.
   *
   * `is_universal` is included unconditionally: it is the floor of the chain, and a universal
   * pack must resolve even for an occupation with no ISCO code at all (an `rvm`-minted row).
   */
  async findBindings(target: {
    jobDomainId: string | null;
    iscoUnitCode: string | null;
  }): Promise<FamilyBindingRow[]> {
    const codes = iscoPrefixes(target.iscoUnitCode);
    const rows = await this.db
      .select({
        familyId: profilingFamilyBindings.familyId,
        specificity: profilingFamilyBindings.specificity,
        jobDomainId: profilingFamilyBindings.jobDomainId,
        unit: profilingFamilyBindings.iscoUnitCode,
        minor: profilingFamilyBindings.iscoMinorCode,
        submajor: profilingFamilyBindings.iscoSubmajorCode,
        major: profilingFamilyBindings.iscoMajorCode,
        isUniversal: profilingFamilyBindings.isUniversal,
      })
      .from(profilingFamilyBindings);

    // Filtered in memory rather than as a six-way OR. The table is one row per family per binding
    // level (~200 families ⇒ low hundreds of rows) and is read once per cache miss, so the query
    // planner has nothing to gain here and the predicate stays readable and unit-testable.
    return rows
      .filter(
        (row) =>
          row.isUniversal ||
          (row.jobDomainId !== null && row.jobDomainId === target.jobDomainId) ||
          (row.unit !== null && row.unit === codes.unit) ||
          (row.minor !== null && row.minor === codes.minor) ||
          (row.submajor !== null && row.submajor === codes.submajor) ||
          (row.major !== null && row.major === codes.major),
      )
      .map((row) => ({ familyId: row.familyId, specificity: row.specificity }));
  }

  /** The ACTIVE pack head for each of these families, in the given locale. */
  async findActivePacks(familyIds: readonly string[], locale: string): Promise<PackHeadRow[]> {
    if (familyIds.length === 0) return [];
    return this.db
      .select({
        packId: questionPacks.packId,
        version: questionPacks.version,
        familyId: questionPacks.familyId,
        locale: questionPacks.locale,
        contentHash: questionPacks.contentHash,
      })
      .from(questionPacks)
      .where(
        and(
          inArray(questionPacks.familyId, [...familyIds]),
          eq(questionPacks.locale, locale),
          eq(questionPacks.status, "active"),
        ),
      );
  }

  /**
   * One specific pack VERSION, by id — never "the active one".
   *
   * That distinction is risk #13: a pack release mid-interview must not change what a worker is
   * being asked, so once `pack_id` + `pack_version` are pinned to the conversation every later
   * turn loads exactly that version, `active` or not.
   */
  async findPackHead(packId: string, version: number): Promise<PackHeadRow | null> {
    const [row] = await this.db
      .select({
        packId: questionPacks.packId,
        version: questionPacks.version,
        familyId: questionPacks.familyId,
        locale: questionPacks.locale,
        contentHash: questionPacks.contentHash,
      })
      .from(questionPacks)
      .where(and(eq(questionPacks.packId, packId), eq(questionPacks.version, version)))
      .limit(1);
    return row ?? null;
  }

  /** A pack's items, in display order. */
  async findItems(packId: string, version: number): Promise<PackItemRow[]> {
    return this.db
      .select({
        itemId: questionPackItems.itemId,
        questionKey: questionPackItems.questionKey,
        displayOrder: questionPackItems.displayOrder,
        promptText: questionPackItems.promptText,
        whyText: questionPackItems.whyText,
        retryText: questionPackItems.retryText,
        targetKind: questionPackItems.targetKind,
        targetField: questionPackItems.targetField,
        targetSkillId: questionPackItems.targetSkillId,
        answerType: questionPackItems.answerType,
        isMandatory: questionPackItems.isMandatory,
        isCore: questionPackItems.isCore,
        maxAsks: questionPackItems.maxAsks,
        minTurn: questionPackItems.minTurn,
        maxTurn: questionPackItems.maxTurn,
        askIf: questionPackItems.askIf,
        skipIf: questionPackItems.skipIf,
        parentItemKey: questionPackItems.parentItemKey,
      })
      .from(questionPackItems)
      .where(and(eq(questionPackItems.packId, packId), eq(questionPackItems.packVersion, version)))
      .orderBy(asc(questionPackItems.displayOrder));
  }

  /** Every option for these items, in display order. One round trip, never one per item. */
  async findOptions(itemIds: readonly string[]): Promise<PackOptionRow[]> {
    if (itemIds.length === 0) return [];
    return this.db
      .select({
        itemId: questionPackOptions.itemId,
        optionKey: questionPackOptions.optionKey,
        displayOrder: questionPackOptions.displayOrder,
        labelText: questionPackOptions.labelText,
        valueText: questionPackOptions.valueText,
        valueNumber: questionPackOptions.valueNumber,
        valueBool: questionPackOptions.valueBool,
        impliesSkillId: questionPackOptions.impliesSkillId,
        isNoneOfAbove: questionPackOptions.isNoneOfAbove,
      })
      .from(questionPackOptions)
      .where(inArray(questionPackOptions.itemId, [...itemIds]))
      .orderBy(asc(questionPackOptions.displayOrder));
  }
}

/**
 * The ISCO prefixes an occupation sits under: unit → minor → sub-major → major.
 *
 * ISCO is hierarchical BY DIGIT PREFIX ("7212" welder ⊂ "721" moulders/welders ⊂ "72" metal
 * trades ⊂ "7" craft), so the whole chain is four substrings of one code. A malformed or absent
 * code yields all-nulls, which matches only the universal binding — the correct floor, not an
 * error.
 */
export function iscoPrefixes(unitCode: string | null): {
  unit: string | null;
  minor: string | null;
  submajor: string | null;
  major: string | null;
} {
  if (!unitCode || !/^[0-9]{4}$/.test(unitCode)) {
    return { unit: null, minor: null, submajor: null, major: null };
  }
  return {
    unit: unitCode,
    minor: unitCode.slice(0, 3),
    submajor: unitCode.slice(0, 2),
    major: unitCode.slice(0, 1),
  };
}
