import { DraftProfileSchema } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
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
    // Prefer the recruiter-readable trade title; else resolve the role id to its
    // display name (never print a raw `role_*` id — e.g. role_welder / the generic
    // role_cnc_operator have no trade content but DO resolve via the taxonomy).
    canonicalRole: trade?.display_name ?? resolveId(draft.canonical_role_id),
    // Issue #423 — the worker's CURRENT city is what belongs on a résumé, and it now
    // has its own field. The `preferred_cities[0]` fallback is NOT dead code: before
    // the split the current city was prepended to that list, so for every profile
    // extracted before this change it is still the only place the city exists.
    // Dropping the fallback would blank the location line on all of them.
    location:
      draft.location_preference.current_city ?? draft.location_preference.preferred_cities[0] ?? null,
    experienceYears: draft.experience.total_years,
    availability: humanizeAvailability(draft.availability.status),
    summary: buildSummary(draft, trade),
    // Q14: canonical skill NAMES first (ids resolved to display labels — the résumé
    // must never show skill_* ids), then the worker-confirmed raw labels (deduped).
    // The snapshot labels were extraction-clamped and are pseudonymize-gated by the
    // AI service at résumé generation; this is a pure render mapping (no LLM here).
    skills: mergeSkillsWithLabels(
      draft.skills.map(labelForTaxonomyId),
      draft.skill_labels.map(labelForTaxonomyId),
    ),
    // Machines are `mach_*` ids on the snapshot — resolve each to its name (VMC, HMC).
    machines: draft.machines.map(labelForTaxonomyId),
    // #499 — education + certifications now ride on the DraftProfile snapshot
    // (closed-set canonical tokens: ITI/Diploma/Degree, NCVT/NSQF/…), so the
    // templates' "Education & Certifications" section renders instead of collapsing.
    // Old snapshots lack the keys → DraftProfileSchema defaults them to [] (invariant
    // #8). Controllers still aren't on the snapshot; they stay empty (no fabrication).
    // Responsibilities are TRADE-level copy.
    controllers: [],
    // Highest academic level + stream, carried on the DraftProfile snapshot beside
    // the education list. Rendered as a single leading line in the Education section.
    // Old snapshots lack the keys → DraftProfileSchema defaults them to null
    // (invariant #8). PII-free qualification labels.
    educationLevel: draft.education_level,
    educationField: draft.education_field,
    // Resolve any taxonomy IDs that may have leaked into education/certifications
    // from the LLM extraction path — mirrors the worker app's replaceTaxonomyIds().
    education: draft.education.map(labelForTaxonomyId),
    certifications: draft.certifications.map(labelForTaxonomyId),
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
    const primaryMachine = draft.machines[0]
      ? labelForTaxonomyId(draft.machines[0])
      : "CNC/VMC machines";
    return trade.summary_template
      .replace(/\{\{\s*role\s*\}\}/g, trade.display_name)
      .replace(/\{\{\s*years\s*\}\}/g, `${years} year${years === 1 ? "" : "s"}`)
      .replace(/\{\{\s*primary_machine\s*\}\}/g, primaryMachine);
  }
  return trade.fresher_phrases[0] ?? null;
}

/** Null-safe id → display name (keeps `null` as `null` for optional fields). */
function resolveId(id: string | null): string | null {
  return id ? labelForTaxonomyId(id) : null;
}

/**
 * Q14: skills for render = canonical skill NAMES (already resolved from `skill_*`
 * ids by the caller) + worker-confirmed raw labels, dropping a label whose
 * normalization already matches a resolved name — e.g. label "Milling" dupes the
 * resolved "Milling". Mirrors `_skills_entries` in apps/ai-service/app/extraction.py.
 */
function mergeSkillsWithLabels(names: string[], labels: string[]): string[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const seen = new Set(names.map(norm));
  const out = [...names];
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
