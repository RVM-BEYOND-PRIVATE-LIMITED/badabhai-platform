import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { ResumeRenderInput } from "./resume-renderer.service";
import { resolveTradeContent, type TradeContent } from "./trade-content";

/**
 * Pure snapshot → {@link ResumeRenderInput} mapping (NO LLM, NO I/O, NO DI).
 *
 * Extracted from the resume-render worker so BOTH the worker's-own render
 * (resume-render.processor.ts) and the EMPLOYER-facing masked disclosure
 * (disclosures/resume-disclosure.service.ts) build the renderer input the SAME way.
 * The ONLY difference between the two is the `displayName` the caller passes:
 *   - worker's own copy  → the decrypted real name (TD21);
 *   - employer disclosure → `maskInitials(realName)` (decision eafcccc, gate B-G).
 *
 * The snapshot is the stored, NAME-FREE `sourceProfileSnapshot` (a DraftProfile).
 * `displayName` is the ONLY identifying field and is supplied by the caller — it is
 * never derived from the snapshot, and this function never logs/throws on it.
 *
 * ADR-0032: `photoDataUri` follows the exact same caller-supplied contract — and it
 * is a REQUIRED parameter (no default) so both call-sites are explicit: the worker's
 * own render passes the fetched photo; the masked disclosure passes null. Deriving
 * the photo INSIDE this function is the one shape that would leak it into the
 * disclosure automatically (shared mapper, shared templates) — never do that.
 */
export function buildResumeRenderInput(
  snapshot: unknown,
  displayName: string | null,
  templateId: string | null,
  photoDataUri: string | null,
): ResumeRenderInput {
  const draft = DraftProfileSchema.parse(snapshot ?? {});
  const trade = resolveTradeContent(draft.canonical_role_id, draft.canonical_trade_id);
  return {
    templateId,
    displayName,
    photoDataUri,
    // Prefer the recruiter-readable trade title over a raw taxonomy id.
    canonicalRole: trade?.display_name ?? draft.canonical_role_id,
    location: draft.location_preference.preferred_cities[0] ?? null,
    experienceYears: draft.experience.total_years,
    availability: humanizeAvailability(draft.availability.status),
    summary: buildSummary(draft, trade),
    // Q14: canonical ids first, then the worker-confirmed raw labels (deduped
    // against the ids). The snapshot labels were extraction-clamped and are
    // pseudonymize-gated by the AI service at résumé generation; this is a pure
    // render mapping (no LLM here).
    skills: mergeSkillsWithLabels(draft.skills, draft.skill_labels),
    machines: draft.machines,
    // Controllers/education/certifications aren't in the DraftProfile snapshot; they
    // stay empty (no fabrication). Responsibilities are TRADE-level copy.
    controllers: [],
    education: [],
    certifications: [],
    responsibilities: trade ? [...trade.responsibilities] : [],
  };
}

/**
 * Deterministic resume summary (NO LLM):
 *  1. the worker's OWN summary, if present; else
 *  2. the trade's experienced template filled with profile facts; else
 *  3. the trade's fresher phrase; else
 *  4. null (unknown trade + no summary → nothing fabricated).
 */
function buildSummary(
  draft: ReturnType<typeof DraftProfileSchema.parse>,
  trade: TradeContent | undefined,
): string | null {
  if (draft.experience.summary) return draft.experience.summary;
  if (!trade) return null;
  const years = draft.experience.total_years;
  if (years && years > 0) {
    const primaryMachine = draft.machines[0] ?? "CNC/VMC machines";
    return trade.summary_template
      .replace(/\{\{\s*role\s*\}\}/g, trade.display_name)
      .replace(/\{\{\s*years\s*\}\}/g, `${years} year${years === 1 ? "" : "s"}`)
      .replace(/\{\{\s*primary_machine\s*\}\}/g, primaryMachine);
  }
  return trade.fresher_phrases[0] ?? null;
}

/**
 * Q14: skills for render = canonical ids + worker-confirmed raw labels, dropping a
 * label whose normalization matches an id's (with the `skill_` prefix stripped) —
 * e.g. label "Milling" dupes id `skill_milling`. Mirrors `_skills_entries` in
 * apps/ai-service/app/extraction.py.
 */
function mergeSkillsWithLabels(ids: string[], labels: string[]): string[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const seen = new Set(ids.map((id) => norm(id.replace(/^skill_/, ""))));
  const out = [...ids];
  for (const label of labels) {
    const key = norm(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/** Map the availability enum to a short human-readable phrase (or omit). */
function humanizeAvailability(status: string): string | null {
  switch (status) {
    case "immediate":
      return "Available immediately";
    case "notice_period":
      return "On notice period";
    default:
      return null; // not_looking / unknown → omit
  }
}
