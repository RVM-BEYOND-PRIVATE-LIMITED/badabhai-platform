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
 */
export function buildResumeRenderInput(
  snapshot: unknown,
  displayName: string | null,
  templateId: string | null,
): ResumeRenderInput {
  const draft = DraftProfileSchema.parse(snapshot ?? {});
  const trade = resolveTradeContent(draft.canonical_role_id, draft.canonical_trade_id);
  return {
    templateId,
    displayName,
    // Prefer the recruiter-readable trade title over a raw taxonomy id.
    canonicalRole: trade?.display_name ?? draft.canonical_role_id,
    location: draft.location_preference.preferred_cities[0] ?? null,
    experienceYears: draft.experience.total_years,
    availability: humanizeAvailability(draft.availability.status),
    summary: buildSummary(draft, trade),
    skills: draft.skills,
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
