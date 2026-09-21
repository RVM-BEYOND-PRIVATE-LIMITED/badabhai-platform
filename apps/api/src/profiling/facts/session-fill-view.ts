import type { QuestionPackItem } from "@badabhai/ai-contracts";

import type { AnswerMap } from "../answer-map";
import { projectProfile } from "../answer-map-projector";
import { sessionFactOutcomes, type FactOutcomeStatus } from "./fact-outcomes";
import { WORKER_FACTS, type WorkerFactId } from "./worker-fact.registry";

/**
 * The settled-vs-missing view ONE session's pack can produce — what `/finishing` (and any other
 * net-new-only surface) reads to decide which questions a worker still needs to see.
 *
 * THREE RULES, AND EACH ONE IS A CLAIM ABOUT WHAT A WORKER SEES:
 *
 * 1. **A settled answer that the projector drops counts as MISSING.** The view reports what
 *    actually reaches the profile, not what was merely said. A non-canonical city or a value the
 *    crosswalk refuses is invisible to every downstream reader, so for the purpose of "does the
 *    worker still need to supply this", it is indistinguishable from never having answered — and
 *    showing it as done would leave the profile permanently empty with the worker believing it
 *    filled. `dropped_by_projector` says WHY it is missing, so the surface can phrase it honestly.
 * 2. **A fact settled on ANOTHER ROAD counts as settled here.** This is the cross-road
 *    reconciliation the Phase 1 double-ask limitation was deferred to (owner-accepted): a worker
 *    who filled `languages` on `/finishing` has settled the fact, whether or not this chat
 *    session ever asked it. The caller supplies `storedElsewhere` — this module stays pure.
 * 3. **A chat DECLINE is final for this view.** "Nahi pata" is a complete answer (answer-map.ts),
 *    so a decline is never overridden by a stored value and never re-asked; the view reports it as
 *    declined rather than hiding the fact or showing it as settled-with-a-value.
 */

export interface SessionFillEntry {
  readonly fact: WorkerFactId;
  /** The pack item this fact resolves through in THIS session — the row the surface can key on. */
  readonly questionKey: string;
  readonly status: FactOutcomeStatus;
  /** Where the settlement came from: this chat's answer map, or a store outside this session. */
  readonly source: "chat" | "other_road";
  /** True only when a chat answer was dropped on the way to the profile (rule 1). */
  readonly droppedByProjector: boolean;
  /** Whether the unresolved session item is a CORE question, so the surface can rank the gap. */
  readonly isCore: boolean;
}

export interface SessionFillView {
  readonly entries: readonly SessionFillEntry[];
  /**
   * Facts the worker has ACTUALLY answered somewhere (answered or declined, from either source).
   * Declined is included deliberately: `answer-map.ts` settles it, so re-asking would badger a
   * worker who already said they do not know. This is the set a net-new-only surface filters
   * against; `entries` carries the detail for everything else.
   */
  readonly settled: readonly WorkerFactId[];
}

/**
 * Does the projector carry this answer anywhere at all — a draft field or an attribute row?
 *
 * RUNS THE REAL PROJECTOR rather than restating its rules, so a future carve-out (the `languages`
 * one this programme added) or a future refusal is reflected here automatically instead of the two
 * drifting. `projectProfile` is pure, so this is a computation, not a read.
 */
function projectsToProfile(questionKey: string, answers: AnswerMap): boolean {
  const record = answers[questionKey];
  if (!record) return false;
  const { draft, attributes } = projectProfile([record]);
  return Object.keys(draft).length > 0 || attributes.length > 0;
}

export function buildSessionFillView(
  items: readonly Pick<QuestionPackItem, "question_key" | "target_field" | "is_core">[],
  answers: AnswerMap,
  storedElsewhere: ReadonlySet<WorkerFactId>,
): SessionFillView {
  const entries = sessionFactOutcomes(items, answers).map((outcome): SessionFillEntry => {
    if (outcome.status === "answered") {
      const projects = projectsToProfile(outcome.questionKey, answers);
      return {
        fact: outcome.fact,
        questionKey: outcome.questionKey,
        // Rule 1: an answer the profile cannot carry is missing TO THE PROFILE.
        status: projects ? "answered" : "missing",
        source: "chat",
        droppedByProjector: !projects,
        isCore: outcome.isCore,
      };
    }

    if (outcome.status === "declined") {
      // Rule 3: terminal, whatever any store says.
      return { ...outcome, source: "chat", droppedByProjector: false };
    }

    if (storedElsewhere.has(outcome.fact)) {
      // Rule 2: settled elsewhere lifts BOTH `missing` (never asked here) and `unanswered`.
      return {
        fact: outcome.fact,
        questionKey: outcome.questionKey,
        status: "answered",
        source: "other_road",
        droppedByProjector: false,
        isCore: outcome.isCore,
      };
    }

    return { ...outcome, source: "chat", droppedByProjector: false };
  });

  const settled = entries
    .filter((entry) => entry.status === "answered" || entry.status === "declined")
    .map((entry) => entry.fact);

  return { entries, settled };
}

// ---------------------------------------------------------------------------
// Stored facts, read from `worker_attributes` by the caller (I/O lives in the service).
// ---------------------------------------------------------------------------

/** Every attribute key that IS a fact, strongest alias only — the inverse of the registry map. */
const FACT_BY_ATTRIBUTE_KEY: ReadonlyMap<string, WorkerFactId> = new Map(
  Object.values(WORKER_FACTS).flatMap((definition) =>
    definition.aliases
      .filter((alias) => alias.kind === "attribute_key" && alias.strength === "settles")
      .map((alias) => [alias.name, definition.id] as const),
  ),
);

/** The attribute keys `WorkerAttributesRepository.loadKeys` should be asked for. */
export const STORED_FACT_ATTRIBUTE_KEYS: readonly string[] = [...FACT_BY_ATTRIBUTE_KEY.keys()];

/** The narrow row shape the repository returns; only what the "has a value" rule reads. */
export interface StoredAttributeRow {
  readonly attributeKey: string;
  readonly valueKind: string;
  readonly valueBool?: boolean | null;
  readonly valueText?: string | null;
  /** pg `numeric` arrives as a string — the same reason the repository keeps it unparsed. */
  readonly valueNumber?: number | string | null;
  readonly valueTextList?: readonly string[] | null;
  readonly valueJson?: Record<string, unknown> | null;
}

/**
 * A row counts as settled only when it holds a REAL value. An empty list, a blank string, a
 * `false` boolean or a cleared column is not a filled field — the finishing form's own readers
 * treat them as absence, and so does this.
 */
function hasValue(row: StoredAttributeRow): boolean {
  switch (row.valueKind) {
    case "boolean":
      return row.valueBool === true;
    case "number": {
      const numeric =
        typeof row.valueNumber === "string" ? Number(row.valueNumber) : row.valueNumber;
      return typeof numeric === "number" && Number.isFinite(numeric);
    }
    case "text":
      return typeof row.valueText === "string" && row.valueText.trim().length > 0;
    case "text_list":
      return Array.isArray(row.valueTextList) && row.valueTextList.length > 0;
    case "json":
      return row.valueJson !== null && row.valueJson !== undefined;
    default:
      return false;
  }
}

/** The facts a worker's stored attribute rows already settle. */
export function storedFactsFromAttributeRows(
  rows: readonly StoredAttributeRow[],
): ReadonlySet<WorkerFactId> {
  const facts = new Set<WorkerFactId>();
  for (const row of rows) {
    const fact = FACT_BY_ATTRIBUTE_KEY.get(row.attributeKey);
    if (fact && hasValue(row)) facts.add(fact);
  }
  return facts;
}
