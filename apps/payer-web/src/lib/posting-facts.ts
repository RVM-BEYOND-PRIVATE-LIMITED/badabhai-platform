import type { MatchSkillWire } from "./contracts";
import { tradeLabel } from "./agency-view";
import { parseWholeNumber } from "./job-card-form";
import { jobRoleLabel } from "./job-roles";

/**
 * "ALSO IN YOUR POSTING — NOT ON THE WORKER'S CARD": what a form collected that the worker's
 * swipe card does not draw, as the list shown under the preview. Built from the form's CURRENT
 * values (live), one builder per posting kind so company create and edit list the same things.
 * Labels only — a role kind or a skill id is never echoed raw (an unknown one is "Not set").
 */

/** One line of "Also in your posting — not written on the worker's card". */
export interface PostingFact {
  label: string;
  /** The value, or null when the payer has not set it (drawn as a muted "Not set"). */
  value: string | null;
  /** Optional one-line note under the value (e.g. where a worker DOES read it). */
  note?: string;
}

// One line in the 24rem rail ("…when they open the posting." wrapped and pushed the agency
// editor's Save below a 900px fold), and the entity is a posting, never a job (F36).
const DESCRIPTION_NOTE = "Workers read this in the full posting.";

/** The match skills' labels, in the picked order; an id missing from the vocabulary is skipped. */
function skillLabels(ids: readonly string[], vocabulary: readonly MatchSkillWire[]): string | null {
  const labels = ids
    .map((id) => vocabulary.find((s) => s.skill_id === id)?.label ?? null)
    .filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(", ") : null;
}

/** The openings box as the count the form will send — "Not set" for anything that is not one (≥ 1). */
function openingsLabel(raw: string): string | null {
  const n = parseWholeNumber(raw);
  return n.kind === "ok" && n.value >= 1 ? String(n.value) : null;
}

const orNull = (text: string | null | undefined) =>
  text === null || text === undefined || text.trim() === "" ? null : text.trim();

/** Company posting (create + edit). `matchSkills` is null when the form shows no skill picker. */
export function companyPostingFacts(input: {
  roleKind: string | null;
  openings: string;
  locationNote: string;
  matchSkills: { ids: readonly string[]; vocabulary: readonly MatchSkillWire[] } | null;
  description: string;
}): PostingFact[] {
  const facts: PostingFact[] = [
    { label: "Role", value: jobRoleLabel(input.roleKind) },
    { label: "Openings", value: openingsLabel(input.openings) },
  ];
  if (input.matchSkills !== null) {
    facts.push({
      label: "Skills",
      value: skillLabels(input.matchSkills.ids, input.matchSkills.vocabulary),
    });
  }
  facts.push(
    { label: "Location note", value: orNull(input.locationNote) },
    { label: "Description", value: orNull(input.description), note: DESCRIPTION_NOTE },
  );
  return facts;
}

/** Agency posting (create + edit): the trade is the agency's matching key. */
export function agencyPostingFacts(input: {
  roleKind: string | null;
  tradeKey: string;
  description: string;
}): PostingFact[] {
  return [
    { label: "Role", value: jobRoleLabel(input.roleKind) },
    { label: "Trade (matching)", value: orNull(tradeLabel(input.tradeKey)) },
    { label: "Description", value: orNull(input.description), note: DESCRIPTION_NOTE },
  ];
}
