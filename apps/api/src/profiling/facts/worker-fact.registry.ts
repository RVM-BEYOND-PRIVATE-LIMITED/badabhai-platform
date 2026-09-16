import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { ROLE_FORM_DESCRIPTORS } from "../roles/role-registry";

/**
 * ═══ THE WORKER FACT REGISTRY — ONE NAME PER FACT, EVERY SPELLING OF IT ═══
 *
 * THE DEFECT THIS EXISTS FOR (#1503). One fact about a worker is spelled differently on every
 * surface that touches it: `salary_expected` in the interview, `salary_expected_max` on the
 * preferences page; `education` as a pack key, `education_level` as its target field,
 * `worker_education` as the qualifications page's table; `shift_preference` in the universal pack
 * and `shift` in the page's DTO. `f455bb36` appended the universal pack to every trade form and
 * nothing noticed that five of its eight questions were already owned by the pages served three
 * screens later — because no table said those spellings were ONE fact. Every duplicate was a
 * different string.
 *
 * DATA ONLY, AND DELIBERATELY SO. No resolver, no settled-state read and no ownership table yet —
 * those are the #1504 and #1505 changes, and each consumes this rather than re-deriving it. What
 * this file owns is the vocabulary, and `worker-fact.registry.test.ts` holds it EXHAUSTIVE against
 * the shipped corpus, the RFS crosswalk and `PREFERENCE_KEYS`, so a new spelling cannot land
 * without being named here.
 *
 * STRENGTH IS PART OF THE ALIAS, NOT OF THE FACT. A yes/no "do you do night work?" on a driving
 * pack is evidence about a shift preference; it is not the preference. Treating it as one would let
 * a driving-pack "no" suppress the shift question on the page that actually owns it. So every alias
 * declares whether it SETTLES the fact or is only a PREFILL HINT, and only a settling alias may
 * ever count toward "this fact is already asked" (critique-2, #1503).
 */

/** Every fact the platform asks a worker about more than one way. Closed; extend by review. */
export const WORKER_FACT_IDS = [
  "trade",
  "experience",
  "current_city",
  "preferred_locations",
  "shift",
  "salary_expected",
  "education",
  "availability",
  "certifications",
  "work_history",
  "languages",
  "documents_ready",
  "job_type",
  "relocation",
  "accommodation",
] as const;

export type WorkerFactId = (typeof WORKER_FACT_IDS)[number];

/**
 * `settles` — an answer through this alias IS the fact, in the fact's own value space.
 * `prefill_hint` — evidence about the fact that may seed a page, and must never settle it.
 */
export type FactAliasStrength = "settles" | "prefill_hint";

/**
 * WHERE a spelling lives. The kinds are distinct namespaces on distinct surfaces, but the registry
 * test holds every NAME unique across facts regardless of kind — one string meaning two facts is
 * the ambiguity this file exists to remove.
 */
export type FactAliasKind =
  /** `question_pack_item.question_key`. */
  | "pack_question_key"
  /** `question_pack_item.target_field` — an RFS field id or an attribute key. */
  | "target_field"
  /** `worker_attributes.attribute_key`. */
  | "attribute_key"
  /** A column on `workers`. */
  | "worker_column"
  /** A table whose rows ARE the fact. */
  | "table"
  /** A field of a marker page's PUT DTO. */
  | "marker_dto_field";

export interface FactAlias {
  readonly kind: FactAliasKind;
  readonly name: string;
  readonly strength: FactAliasStrength;
}

export interface WorkerFactDefinition {
  readonly id: WorkerFactId;
  readonly aliases: readonly FactAlias[];
}

const settles = (kind: FactAliasKind, name: string): FactAlias => ({
  kind,
  name,
  strength: "settles",
});
const hint = (kind: FactAliasKind, name: string): FactAlias => ({
  kind,
  name,
  strength: "prefill_hint",
});

/**
 * THE ALIAS TABLE.
 *
 * `experience` HAS NO TENURE KEYS LISTED HERE, and that is not an omission: each role's tier
 * question is named by its descriptor's `tenureQuestionKey`, and restating twenty-one of them here
 * would be a second list free to drift from the registry. {@link factMatchesForPackItem} reads the
 * descriptors directly.
 */
export const WORKER_FACTS: Readonly<Record<WorkerFactId, WorkerFactDefinition>> = {
  trade: {
    id: "trade",
    aliases: [settles("pack_question_key", "primary_trade"), settles("target_field", "trade")],
  },
  experience: {
    id: "experience",
    aliases: [
      settles("pack_question_key", "experience_years"),
      settles("target_field", "experience_years"),
    ],
  },
  current_city: {
    id: "current_city",
    aliases: [
      settles("pack_question_key", "current_city"),
      settles("target_field", "current_city"),
      settles("worker_column", "workers.current_city"),
    ],
  },
  preferred_locations: {
    id: "preferred_locations",
    aliases: [
      settles("pack_question_key", "preferred_locations"),
      settles("target_field", "preferred_locations"),
      settles("attribute_key", "preferred_locations"),
      settles("marker_dto_field", "preferred_cities"),
    ],
  },
  shift: {
    id: "shift",
    aliases: [
      settles("pack_question_key", "shift_preference"),
      settles("target_field", "shift_preference"),
      settles("attribute_key", "shift_preference"),
      settles("marker_dto_field", "shift"),
      // YES/NO, NOT A PREFERENCE. "Do you work shifts?" and "do you work nights?" on fourteen
      // plant packs and two driving packs say something about shifts and do not answer "which
      // shift do you want".
      hint("pack_question_key", "shift_work"),
      hint("target_field", "shift_work"),
      hint("pack_question_key", "night_work"),
      hint("target_field", "night_work"),
    ],
  },
  salary_expected: {
    id: "salary_expected",
    aliases: [
      settles("pack_question_key", "salary_expected"),
      settles("target_field", "salary_expected"),
      // THE BAND'S UPPER END, AND THE PAGE'S ONLY KEY (owner ruling 2026-09-15). The worker reads
      // both as "how much do you want a month"; that they store different ends of one band is
      // why they are one fact rather than two.
      settles("attribute_key", "salary_expected_max"),
      settles("marker_dto_field", "salary_expected_max"),
    ],
  },
  education: {
    id: "education",
    aliases: [
      settles("pack_question_key", "education"),
      settles("target_field", "education_level"),
      settles("attribute_key", "education_credential"),
      settles("table", "worker_education"),
      settles("marker_dto_field", "educations"),
      // COMPONENTS OF A CREDENTIAL, NOT THE CREDENTIAL. A council or a year says nothing about how
      // far the worker studied.
      hint("attribute_key", "education_council"),
      hint("attribute_key", "education_year"),
      hint("attribute_key", "education_institute"),
    ],
  },
  availability: {
    id: "availability",
    aliases: [settles("pack_question_key", "availability"), settles("target_field", "availability")],
  },
  certifications: {
    id: "certifications",
    aliases: [
      settles("target_field", "certifications"),
      settles("table", "worker_certificates"),
      settles("marker_dto_field", "certificates"),
      // "Do you hold a certificate?" — a yes/no, not the certificate.
      hint("pack_question_key", "certification"),
    ],
  },
  work_history: {
    id: "work_history",
    aliases: [
      settles("target_field", "work_history"),
      settles("table", "worker_employment"),
      settles("marker_dto_field", "employments"),
    ],
  },
  languages: {
    id: "languages",
    aliases: [
      settles("target_field", "languages"),
      settles("attribute_key", "languages"),
      settles("marker_dto_field", "languages"),
      // "Do you speak the customer's language?" on a waiter pack — a yes/no, not a language list.
      hint("pack_question_key", "language_spoken"),
    ],
  },
  documents_ready: {
    id: "documents_ready",
    aliases: [
      settles("attribute_key", "documents_ready"),
      settles("marker_dto_field", "documents_ready"),
    ],
  },
  job_type: {
    id: "job_type",
    aliases: [settles("attribute_key", "job_type"), settles("marker_dto_field", "job_type")],
  },
  relocation: {
    id: "relocation",
    aliases: [
      settles("pack_question_key", "relocation"),
      settles("target_field", "relocation_willingness"),
      settles("attribute_key", "relocation_willingness"),
      settles("marker_dto_field", "willing_to_relocate"),
    ],
  },
  accommodation: {
    id: "accommodation",
    aliases: [
      settles("attribute_key", "accommodation_needed"),
      settles("marker_dto_field", "accommodation_needed"),
    ],
  },
};

/**
 * Spellings that LOOK like a worker fact and are not one — named so the exhaustiveness test can
 * tell a considered exclusion from a forgotten alias.
 */
export const NOT_A_WORKER_FACT: Readonly<Record<string, string>> = {
  // RFS crosswalk fields.
  skills: "capability, resolved per trade by the skill canonicaliser — not one fact",
  tools_equipment: "capability, split into machines and controllers — not one fact",
  salary_current: "what the worker earns today, not what he asks for; no page owns it",
  education_field: "the trade or stream of a credential (an ITI's 'Machinist'), not its level",
  // Pack question keys.
  city_knowledge: "a driver knowing a city's roads — not where the worker lives or wants to work",
};

/** The page types a trade form serves as markers rather than questions. */
export type MarkerScreenType = "preferences" | "qualifications" | "employment";

/**
 * Which facts each MARKER page owns (owner ruling 2026-09-15: "résumé facts live on the pages that
 * OWN them — never extra question screens").
 *
 * PREFERENCES IS READ OFF `worker-preferences.service.ts`'s writes, not off its vocabulary alone:
 * the education components are still accepted there for the finishing form (#1447) but the trade
 * form's marker no longer asks them, and the fact itself is owned by the qualifications page.
 */
export const MARKER_OWNED_FACTS: Readonly<Record<MarkerScreenType, readonly WorkerFactId[]>> = {
  preferences: [
    "preferred_locations",
    "shift",
    "salary_expected",
    "languages",
    "documents_ready",
    "job_type",
    "relocation",
    "accommodation",
  ],
  qualifications: ["education", "certifications"],
  employment: ["work_history"],
};

export interface FactMatch {
  readonly fact: WorkerFactId;
  readonly strength: FactAliasStrength;
}

/** Every declared role's tier question — derived from the descriptors, never restated. */
const TENURE_QUESTION_KEYS: ReadonlySet<string> = new Set(
  ROLE_FORM_DESCRIPTORS.map((descriptor) => descriptor.tenureQuestionKey),
);

/**
 * Every distinct fact a pack item's `question_key` or `target_field` names, strongest first.
 *
 * A SINGLE ITEM SHOULD NAME ONE FACT, and this returns all of them anyway so the registry test can
 * report a conflict by name instead of this function silently picking one.
 */
export function factMatchesForPackItem(
  item: Pick<QuestionPackItem, "question_key" | "target_field">,
): FactMatch[] {
  const found = new Map<WorkerFactId, FactAliasStrength>();
  const note = (fact: WorkerFactId, strength: FactAliasStrength) => {
    // A settling spelling of the item wins over a hinting one for the same fact.
    if (found.get(fact) !== "settles") found.set(fact, strength);
  };

  for (const definition of Object.values(WORKER_FACTS)) {
    for (const alias of definition.aliases) {
      const matchesKey = alias.kind === "pack_question_key" && alias.name === item.question_key;
      const matchesField = alias.kind === "target_field" && alias.name === item.target_field;
      if (matchesKey || matchesField) note(definition.id, alias.strength);
    }
  }
  // THE TIER QUESTION IS THE FORM'S EXPERIENCE ASK. It is not years (#1413) — it is a rung — but it
  // is the question a worker on a trade form answers "how long have you done this" with, so a
  // second years question beside it is the duplicate #1503 reported.
  if (TENURE_QUESTION_KEYS.has(item.question_key)) note("experience", "settles");

  return [...found.entries()]
    .map(([fact, strength]) => ({ fact, strength }))
    .sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "settles" ? -1 : 1));
}

/**
 * The one fact a pack item is about, or null when it is about none.
 *
 * FAILS CLOSED ON AMBIGUITY. An item naming two facts is a registry defect, and guessing which it
 * meant would decide what a worker is or is not asked on a coin toss. The exhaustiveness test makes
 * this unreachable for the shipped corpus.
 */
export function factForPackItem(
  item: Pick<QuestionPackItem, "question_key" | "target_field">,
): FactMatch | null {
  const matches = factMatchesForPackItem(item);
  if (matches.length > 1) {
    throw new Error(
      `pack item ${item.question_key} names ${matches.length} worker facts ` +
        `(${matches.map((match) => match.fact).join(", ")}) — fix worker-fact.registry.ts`,
    );
  }
  return matches[0] ?? null;
}
