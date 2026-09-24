/**
 * TIERED PROFILING — the two headings a tier can change. Pure; no I/O.
 *
 * "Adjust section titles when a tier drops a whole group": an Easy sheet prints
 * "MACHINES & CONTROLLERS" over the rows the full sheet heads "MACHINES, CONTROLLERS & CAPABILITY",
 * and "QUALIFICATION & LANGUAGES" where the full sheet says "QUALIFICATION, DOCUMENTS & LANGUAGES"
 * (the approved Easy targets in `docs/profiling-tiers/`). Every other heading is untouched, and a
 * sheet with no tier — or a Hard one — prints exactly today's headings.
 */
import type { ProfilingTier } from "@badabhai/types";

import { sharedFieldIncluded } from "../profiling/tiers/profiling-tier.policy";
import { tradeResumeMapFor } from "./trade-resume-map";

/**
 * Zone 5's two headings. The template carries both as literals (`.sec-qual::before` and
 * `.sec-qual[data-variant="no_documents"]::before`) and the document JSON reads this table, so the PDF and the
 * app's résumé view cannot disagree.
 */
export const QUAL_SECTION_TITLES = {
  full: "Qualification, documents & languages",
  no_documents: "Qualification & languages",
} as const;

/** The capability heading at a tier: the map's tier title when it has one, else today's. */
export function tieredCapabilityTitle(
  sectionTitle: string | null,
  packId: string | null,
  tier: ProfilingTier | null,
): string | null {
  // No section (no map, no rows) stays no section: a tier title must never resurrect a heading
  // over nothing.
  if (sectionTitle === null || tier === null || tier === "hard") return sectionTitle;
  return tradeResumeMapFor(packId)?.tier_section_titles?.[tier] ?? sectionTitle;
}

/** "no_documents" when the tier asks neither documents nor certificates; null keeps today's. */
export function qualSectionVariantFor(tier: ProfilingTier | null): "no_documents" | null {
  if (tier === null) return null;
  return sharedFieldIncluded("documents_ready", tier) || sharedFieldIncluded("certificates", tier)
    ? null
    : "no_documents";
}
