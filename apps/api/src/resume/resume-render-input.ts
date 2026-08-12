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
    //
    // `role_label` IS THE LAST RESORT, AND ON THE LLM-LED PATH IT IS THE ONLY ONE THAT FIRES.
    // `toExtractionOutput` hardcodes both canonical ids to null — deliberately, since inventing
    // a taxonomy id would put an unvalidated value in the one place the match engine trusts
    // absolutely — so `trade` is undefined and `resolveId` returns null for EVERY OIE-path
    // profile. `{{headline}}` therefore rendered EMPTY on every resume the LLM-led interview
    // produced: the model named the role, the column held it, and the PDF had no job title.
    //
    // A free-text label, never a taxonomy id, so it can only ever reach the printed headline —
    // matching and ranking still read the canonical ids, which stay null.
    canonicalRole: trade?.display_name ?? resolveId(draft.canonical_role_id) ?? draft.role_label,
    // Issue #423 — the worker's CURRENT city is what belongs on a résumé, and it now
    // has its own field. The `preferred_cities[0]` fallback is NOT dead code: before
    // the split the current city was prepended to that list, so for every profile
    // extracted before this change it is still the only place the city exists.
    // Dropping the fallback would blank the location line on all of them.
    location:
      draft.location_preference.current_city ?? draft.location_preference.preferred_cities[0] ?? null,
    experienceYears: draft.experience.total_years,
    availability: humanizeAvailability(draft.availability.status, draft.shift),
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
 *  4. the LLM-led path's own labels, if the model captured any; else
 *  5. null (nothing known → nothing fabricated).
 */
function buildSummary(
  draft: ReturnType<typeof DraftProfileSchema.parse>,
  trade: TradeContent | undefined,
): string | null {
  if (draft.experience.summary) return draft.experience.summary;
  if (!trade) return summaryFromLabels(draft);
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

/**
 * Leg 4 — the summary an LLM-led profile can build when the taxonomy knows nothing about it.
 *
 * `resolveTradeContent` keys off the canonical ids, and `toExtractionOutput` hardcodes BOTH to
 * null on this path, so `trade` is undefined for every OIE-path profile and this function used
 * to `return null` outright. `{{summary}}` was blank on every LLM-led resume — alongside the
 * blank `{{headline}}` — even when the model had named the role and the trade in plain language.
 *
 * NOT FABRICATION, and the distinction is the whole point (§11). Every clause here is a value
 * the worker said and the model recorded; nothing is inferred, averaged, or filled with a
 * plausible default. A field that is null contributes NO clause rather than a hedge — which is
 * why this returns null when the model captured nothing, instead of a sentence about a worker
 * it knows nothing about.
 */
function summaryFromLabels(draft: ReturnType<typeof DraftProfileSchema.parse>): string | null {
  const role = draft.role_label?.trim();
  const domain = draft.domain_label?.trim();
  if (!role && !domain) return null;

  const years = draft.experience.total_years;
  const head = role ?? domain!;
  // The domain only earns its own clause when it says something the role does not already —
  // "Cook with 3 years of experience in cooking" is worse than saying it once.
  const context = domain && role && domain.toLowerCase() !== role.toLowerCase() ? ` in ${domain}` : "";
  const tenure = years && years > 0 ? ` with ${years} year${years === 1 ? "" : "s"} of experience` : "";
  return `${head}${tenure}${context}.`;
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

/**
 * Map the availability enum to a short human-readable phrase, and append the shift the model
 * captured — "Available immediately · Night shift".
 *
 * SHIFT RIDES THIS SLOT RATHER THAN GETTING ITS OWN. A new `{{shift}}` token would render on no
 * template at all: a shipped `<id>.v<n>.html` is immutable by the registry contract, so a new
 * slot means four v3 layouts plus registry entries, and an unknown token collapses to nothing in
 * the meantime. `{{availability}}` already prints on all four, and "when can you start / which
 * shift" is one answer to a recruiter.
 *
 * SHIFT ALONE IS ENOUGH TO PRINT THE LINE. `not_looking`/`unknown` still yield no availability
 * phrase, but a worker who told us they work nights has said something worth showing — before
 * this, the whole line collapsed and that answer was lost with it.
 */
function humanizeAvailability(status: string, shift: string | null): string | null {
  const phrase =
    status === "immediate"
      ? "Available immediately"
      : status === "notice_period"
        ? "On notice period"
        : null; // not_looking / unknown → omit
  const shiftPhrase = humanizeShift(shift);
  if (!phrase) return shiftPhrase;
  return shiftPhrase ? `${phrase} · ${shiftPhrase}` : phrase;
}

/**
 * The model's `shift` as a printable phrase, or null.
 *
 * The wire type is a bare `str | None` — `extract_system_prompt` asks for "day" | "night" |
 * "any" | null, but nothing constrains it, so an unrecognised value is passed through
 * title-cased rather than dropped. It is worker-derived occupational text that the
 * pseudonymizer already certified, and the renderer output-encodes every slot.
 */
function humanizeShift(shift: string | null): string | null {
  const value = shift?.trim();
  if (!value) return null;
  switch (value.toLowerCase()) {
    case "day":
      return "Day shift";
    case "night":
      return "Night shift";
    case "any":
      return "Any shift";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
