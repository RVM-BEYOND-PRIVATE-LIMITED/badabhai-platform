"use server";

import { matchSelectionInputSchema, type ReachPreview } from "../../../../lib/contracts";
import { previewReach } from "../../../../lib/payer-api";

/**
 * The Matching V1 reach-preview Server Action (ADR-0036, spec Part 2).
 *
 * The posting form calls this while the payer ticks skills, so it is a HOT path with a
 * human waiting on every keystroke-ish interaction. It stays a Server Action rather
 * than a client fetch for the same reason every other payer read does: the session
 * Bearer never reaches the browser (XB-A).
 *
 * NOTHING IS WRITTEN HERE, and nothing is evented. The decision the payer is making is
 * evented once, at publish, by `job_posting.reach_materialized` — which carries the
 * unticks that were actually honoured. Emitting per-preview would fill the audit spine
 * with drafts of a decision not yet taken.
 *
 * FAIL-SOFT, NOT FAIL-SILENT. A failed preview returns an error the form renders next
 * to the counter; it never returns a fabricated count. Showing "0 workers" for a
 * network error would read as the E13 zero-reach warning and scare a payer off a
 * posting that in fact reaches plenty — the two must never be confusable.
 */
export type ReachPreviewResult =
  | { ok: true; preview: ReachPreview }
  | { ok: false; error: string };

export async function previewReachAction(input: {
  matchSkillIds: string[];
  untickedRelatedIds: string[];
}): Promise<ReachPreviewResult> {
  const parsed = matchSelectionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Pick at least one skill to see how many workers it reaches." };
  }
  try {
    return { ok: true, preview: await previewReach(parsed.data) };
  } catch {
    // A 400 from the cap check and a transport failure collapse to one retryable line:
    // the form already disables adding past the cap, so a 400 here is not a state the
    // payer can reach by clicking, and spelling out backend errors on a live counter
    // would leak more about the platform than it helps.
    return { ok: false, error: "Could not check reach right now. Please retry." };
  }
}
