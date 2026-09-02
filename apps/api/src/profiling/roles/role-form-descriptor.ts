/**
 * ONE ROLE, DECLARED ONCE — the type every form-capable trade is written against.
 *
 * THE PROBLEM THIS SOLVES. `trade-form-router.ts:39` promises that "adding the second trade is a
 * row, not a branch", and the engine really is built that way: the Flutter client walks a
 * server-supplied screen list, the sheet renderer switches on `format` and never on trade, and
 * the search box is computed from the option count. All of that is true.
 *
 * What was not true is "a row". Adding CNC turning touched ELEVEN hand-maintained tables in
 * eleven files — `TRADE_FORM_KINDS`, `TRADE_FORM_ROUTES`, `TRADE_FORM_OFFERS`,
 * `TRADE_KIND_BY_PACK`, `TRADE_RESUME_MAPS`, `WORKSHOP_MACHINES`, `TRADE_TEST`,
 * `CAPABILITY_TERMS`, the pack-attribute skill map, and two blocks of TTS text — none of which
 * knows the others exist. At one trade that is tidy. At twenty-one it is twenty-one chances to
 * add ten of eleven rows and ship a trade that detects but has no sheet, or renders but never
 * routes, with nothing failing.
 *
 * So the ROLE becomes the declaration and those tables become derivations of it. A role is
 * described here once; `role-registry.ts` collects the descriptions and every table that used to
 * be authored is computed. Adding role twenty-two is one file plus one line in the registry.
 *
 * ── WHAT A ROLE IS, IN THE OWNER'S WORDS AND IN THIS CODEBASE'S ──────────────────────────────
 *
 * The role taxonomy calls the unit a ROLE and gives each one a LEVEL LADDER — Operator → Setter →
 * Setter-cum-Programmer → Programmer. Every rung is the SAME role: a man who says "CNC setter"
 * and a man who says "CNC operator" get the same form and the same sheet, and the rung itself is
 * an attribute that prints in the headline ("CNC Turner — Setter-cum-Programmer"). This file
 * keeps that shape: one descriptor per role, with the ladder as data on it.
 *
 * That word collides with the codebase's existing `fam_*` "family", which is the unit of
 * CONVERSATION that owns one question pack. They line up one-to-one — one role, one family, one
 * pack, one form kind — so the descriptor carries all three ids and the collision stops being
 * ambiguous rather than being renamed.
 */

/**
 * Which roles COMPETE for the same worker, and therefore veto each other's handover.
 *
 * NOT A TAXONOMY, A CONFLICT SCOPE — see {@link conflictTermsFor}. Two roles are in one cluster
 * when handing a worker the wrong one of them would ask eighteen wrong questions: a turner and a
 * miller both stand at a machine tool cutting metal to a drawing, and the forms are genuinely
 * different. A turner and a cook are not in that relationship and gain nothing from vetoing each
 * other.
 *
 * IT IS DELIBERATELY NOT THE ROLLOUT BATCH. The taxonomy groups Conventional Machinist under
 * "metal fabrication" and CNC Turner under the launch wedge, but the two collide hard on the word
 * "lathe" — so batching and vetoing are two different questions and get two different fields.
 */
export const ROLE_CLUSTERS = ["machining", "design", "fabrication", "polymer"] as const;
export type RoleCluster = (typeof ROLE_CLUSTERS)[number];

/**
 * The evidence that routes a worker to this role's form, in the three tiers
 * `trade-form-router.ts` already defines and this file does not get to reinterpret.
 *
 * The tiers exist because `signals.py` deleted its `<machine> + <function>` mapping after it
 * FABRICATED A SPECIALISATION: a man who runs a lathe has told you about a machine, not about
 * which of the four occupations built around that machine is his.
 */
export interface RoleDetectionTerms {
  /**
   * Names the occupation itself — "turner", "turning". Routes on its own, because a worker who
   * says one has claimed the specialisation.
   */
  readonly occupationTerms: readonly string[];
  /**
   * Names only the equipment — "lathe", "khraad". Routes ONLY when retrieval independently
   * pinned this role's family, so the machine word is corroboration rather than the whole case.
   */
  readonly machineTerms: readonly string[];
  /**
   * Names a RUNG of this role's level ladder — "setter", "programmer", "senior fitter".
   *
   * ROUTES LIKE A MACHINE TERM, AND FOR A SHARPER VERSION OF THE SAME REASON. The owner's ruling
   * is that every rung belongs to the same role profile, so "CNC turning setter" must reach the
   * turning form rather than being treated as a separate occupation. But a BARE rung is the most
   * ambiguous word in the whole vocabulary — "setter" is a rung of CNC Turner, CNC Machining
   * Centre, CNC Grinding and Press Operator alike, and "programmer" of three more. Routing on one
   * alone would pick whichever role happened to sit first in the registry, which is a coin toss
   * wearing a table's clothing.
   *
   * So a rung corroborates a family pin and never carries a route by itself, and the rung the
   * worker claimed is captured as a pack answer that prints in the headline.
   *
   * EXCLUDED FROM CONFLICT DERIVATION — see {@link conflictTermsFor}. These words are shared
   * vocabulary BY DESIGN, so treating another role's rung as a veto would make "CNC turning
   * setter" veto itself.
   */
  readonly levelTerms: readonly string[];
  /**
   * Conflicts this role needs that its cluster does not supply.
   *
   * TWO KINDS LIVE HERE, both real. The first is a competing trade we do not model at all:
   * turning is vetoed by "edm" and "wire cut" because a wire-cut operator is a distinct job whose
   * worker must keep talking, and the role taxonomy explicitly leaves that trade out of scope.
   * The second is a genuine cross-cluster rival — Tool & Die Maker against Mould / Die Maker
   * (Plastics), which sit in different clusters and share a tool room, an EDM and half a
   * vocabulary.
   */
  readonly extraConflictTerms?: readonly string[];
}

/** How a role's fresher block is labelled, when the role has one. */
export interface RoleFresherVocabulary {
  /** Workshop-machine slug → the English printed on the sheet. */
  readonly workshopMachines: Readonly<Record<string, string>>;
  /** Trade-test status slug → the printed clause. A status with no entry prints nothing. */
  readonly tradeTest: Readonly<Record<string, string>>;
}

export interface RoleFormDescriptor {
  /**
   * The form kind — the value that crosses the wire to the client, is stored on the session, and
   * is the closed set `chat.dto.ts` and `trade-form.dto.ts` validate against.
   */
  readonly kind: string;
  /** The question pack this role's form is built from, e.g. `qp_cnc_turning`. */
  readonly packId: string;
  /** The profiling family that owns that pack, e.g. `fam_cnc_turning`. */
  readonly familyId: string;
  readonly cluster: RoleCluster;
  /**
   * Whether this role's form actually exists yet.
   *
   * ROLES ARE DECLARED BEFORE THEY ARE ENABLED, and that is the point rather than an accident of
   * staging. Conflict terms are derived from the OTHER roles in a cluster, so those roles have to
   * be describable before their forms are built — otherwise enabling turning first would leave it
   * with no rival to be vetoed by, and a worker who said "vmc" would be handed eighteen turning
   * questions. Declaring all of them up front means the veto is complete on day one and each
   * batch flips a boolean rather than editing everybody else's conflict list.
   *
   * A disabled role therefore contributes its VOCABULARY and nothing else: no form kind, no
   * offer, no route of its own.
   */
  readonly formEnabled: boolean;
  /**
   * The role's English name, as the sheet and the handover card print it.
   *
   * ONE SOURCE FOR BOTH. The offer copy the worker reads ("CNC turner profile detected") and the
   * headline the employer reads are the same noun, and letting them drift is how a worker gets
   * told they are one thing and shown another.
   */
  readonly displayName: string;
  /**
   * The role's name as it appears INSIDE the worker-facing sentence, e.g. "CNC turner" in
   * "CNC turner profile detected".
   *
   * SEPARATE FROM `displayName` BECAUSE THE CASING IS DIFFERENT AND BOTH ARE RIGHT. The sheet is
   * a document and prints a title-cased job title; the handover card is a sentence spoken to the
   * worker, and "CNC Turner profile detected" reads like a form field rather than like someone
   * talking. The shipped copy is the sentence-cased one and the Flutter contract test pins it
   * byte-for-byte, so deriving the card from `displayName` would silently rewrite copy that has
   * already been reviewed.
   */
  readonly offerName: string;
  /**
   * The level ladder from the role taxonomy, lowest rung first.
   *
   * PRINTED, NOT INFERRED. Every reference resume leads with `{Role} — {Level}`: "CNC Turner —
   * Setter-cum-Programmer", "Fitter — Senior Fitter", "Welder — Certified Welder". The rung is a
   * fact the worker states, so it is captured by the pack and rendered; this list is what the
   * pack's level question offers and what {@link RoleDetectionTerms.levelTerms} is written from.
   */
  readonly levelLadder: readonly string[];
  readonly detection: RoleDetectionTerms;
  /**
   * The pack question whose answer is this role's own tenure claim.
   *
   * WHY THE SHEET NEEDS IT (#1377). A worker can be handed the form on their very first message,
   * so the universal interview's `experience_years` question may never be asked at all — while
   * the form's own gate question ("Turning ka kitna tajurba hai?") is answered every single time
   * and was then read by nothing. The headline's years figure falls back to this.
   */
  readonly tenureQuestionKey: string;
  readonly fresher?: RoleFresherVocabulary;
}

/** Every rung, machine word and occupation word this role answers to. */
function vocabularyOf(descriptor: RoleFormDescriptor): readonly string[] {
  return [...descriptor.detection.occupationTerms, ...descriptor.detection.machineTerms];
}

/**
 * The words that VETO a handover to `descriptor`, derived from the roles it competes with.
 *
 * WHY THIS IS DERIVED AND NOT AUTHORED. The shipped turner row hand-lists thirteen conflict
 * terms, every one of them another machining role's name for itself. Hand-maintaining that
 * across twenty-one roles is four hundred and twenty ordered pairs, and the failure mode is
 * silent in the worst direction: forget that the new grinding role should veto turning and every
 * grinder who says "cnc turning aur grinding dono" is handed the turning form and asked about
 * tailstocks.
 *
 * SCOPED TO THE CLUSTER, NOT THE WHOLE REGISTRY. Deriving across all twenty-one roles would give
 * each one roughly a hundred veto words, and a turner who mentions in passing that they also do a
 * bit of fitting would never reach a form at all. Conflict means "names a COMPETING
 * specialisation" — competition is real inside a cluster and mostly imaginary across them, and
 * the pairs where it is real across a boundary are declared explicitly.
 *
 * LEVEL TERMS ARE NOT CONFLICTS. They are shared across roles on purpose; treating another role's
 * "setter" as a veto would make "CNC turning setter" veto itself.
 *
 * SELF-EXCLUSION IS BY VALUE, NOT BY ROLE. "Lathe" belongs to both CNC Turner and Conventional
 * Machinist, so removing "every term of my own" rather than "every term of the other roles"
 * is what stops each of them vetoing itself on a word they share.
 */
export function conflictTermsFor(
  descriptor: RoleFormDescriptor,
  all: readonly RoleFormDescriptor[],
): readonly string[] {
  const own = new Set(vocabularyOf(descriptor));
  const rivals = all
    .filter((other) => other.kind !== descriptor.kind && other.cluster === descriptor.cluster)
    .flatMap(vocabularyOf)
    .filter((term) => !own.has(term));
  // Extras are NOT filtered against `own`: a role that declares its own word as a conflict has
  // made a mistake we want to see, not one to silently repair. `assertRegistryIsCoherent` says so.
  return [...new Set([...rivals, ...(descriptor.detection.extraConflictTerms ?? [])])];
}

/**
 * A tuple zod will accept as an enum, or a loud failure at module load.
 *
 * `z.enum` needs `[string, ...string[]]` and `Array.prototype.map` yields `string[]`, so the
 * narrowing has to happen somewhere. It happens HERE, once, with the emptiness actually checked —
 * a bare cast would turn "every role got disabled" into a zod schema that accepts nothing and
 * rejects every form request at runtime, which is a long way from where the mistake was made.
 */
export function nonEmptyTuple<T>(values: readonly T[], what: string): readonly [T, ...T[]] {
  if (values.length === 0) throw new Error(`${what} is empty — at least one entry is required`);
  return values as unknown as readonly [T, ...T[]];
}

/**
 * Everything about the registry that must be true for the derived tables to mean anything.
 *
 * RUN AT MODULE LOAD, not only in tests. A duplicate `packId` between two roles makes
 * `TRADE_KIND_BY_PACK` silently drop one of them and that role's sheet renders under the other
 * role's name — a defect that no test of either role alone would catch, and that would reach a
 * worker's résumé. Failing at boot is the cheap version of finding out.
 */
export function assertRegistryIsCoherent(all: readonly RoleFormDescriptor[]): void {
  const seen = new Map<string, string>();
  for (const [field, pick] of [
    ["kind", (d: RoleFormDescriptor) => d.kind],
    ["packId", (d: RoleFormDescriptor) => d.packId],
    ["familyId", (d: RoleFormDescriptor) => d.familyId],
  ] as const) {
    seen.clear();
    for (const descriptor of all) {
      const value = pick(descriptor);
      const owner = seen.get(value);
      if (owner !== undefined) {
        throw new Error(`${field} ${value} is claimed by both ${owner} and ${descriptor.kind}`);
      }
      seen.set(value, descriptor.kind);
    }
  }

  for (const descriptor of all) {
    // A role that vetoes itself can never hand over, and the symptom — "detection just stopped
    // working for this trade" — points nowhere near the extra term that caused it.
    const own = new Set(vocabularyOf(descriptor));
    const selfVeto = (descriptor.detection.extraConflictTerms ?? []).filter((t) => own.has(t));
    if (selfVeto.length > 0) {
      throw new Error(`${descriptor.kind} lists its own term(s) as conflicts: ${selfVeto.join(", ")}`);
    }
    // An enabled role with no occupation term can only ever be reached by corroboration, which
    // means a worker who names it outright is not routed. That is always an authoring slip.
    if (descriptor.formEnabled && descriptor.detection.occupationTerms.length === 0) {
      throw new Error(`${descriptor.kind} is form-enabled but names no occupation terms`);
    }
  }
}
