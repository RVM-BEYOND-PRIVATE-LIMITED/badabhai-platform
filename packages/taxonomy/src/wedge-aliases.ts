/**
 * RVM launch-wedge vernacular aliases (ADR-0030 / TAX-5) — Hinglish/regional shop-floor
 * terms the international standards MISS, mapped to EXISTING immutable skill ids.
 *
 * RATIFICATION GATE (TAX-0 gate (d) — human domain judgment, NOT automatable):
 * RATIFIED 2026-07-16 by the RVM owner — gate (d) CLOSED. All 22 entries carry
 * `ratified: true` (none struck); Q-A remapped chhilai → skill_deburring and Q-B
 * remapped "drawing padhna" → skill_cad_interpretation. The seed (`db:seed:skills`)
 * inserts ONLY `ratified: true` rows; the decision record is
 * [the ratification packet](../../../docs/registers/skill-vernacular-ratification-packet.md).
 *
 * INVARIANTS: aliases are ADDITIVE onto existing `skill_id`s (SG-5 — no new ids, no
 * renames); the vector layer still assigns from the closed set (SG-3). A term whose
 * mapping is uncertain carries a `note` and is listed as an open question in the packet
 * rather than silently guessed.
 *
 * WHY THIS MATTERS (measured 2026-07-14, real vectors): "kharad ka kaam" scored 0.61
 * against the WRONG concept (grinding) and was floor-refused — the worker's phrase went
 * to the growth queue instead of their profile. A ratified `kharad → skill_turning`
 * alias makes it an exact-space match.
 */

import type { SkillAliasSeed } from "./skill-corpus";

/** One proposed vernacular alias for an EXISTING canonical skill. */
export interface WedgeAliasProposal {
  /** The EXISTING immutable skill id this vernacular term should resolve to. */
  skillId: string;
  alias: SkillAliasSeed;
  /** Human ratification flag (TAX-0 gate d). The seed inserts ONLY ratified rows. */
  ratified: boolean;
  /** Mapping caveat for the RVM reviewer / the recorded ratification ruling. */
  note?: string;
}

const hi = (text: string): SkillAliasSeed => ({ text, lang: "hi", source: "rvm" });

/**
 * RATIFIED 2026-07-16 (all 22 — RVM owner). Curated for the 7 launch roles' core skills:
 * turning / milling / drilling / threading / grinding / setting / programming /
 * measurement / maintenance + the adjacent welding/fitting/fabrication anchors.
 */
export const WEDGE_ALIASES: readonly WedgeAliasProposal[] = [
  // --- the two owner-named exemplars -------------------------------------------------
  { skillId: "skill_turning", alias: hi("kharad"), ratified: true },
  { skillId: "skill_turning", alias: hi("kharad ka kaam"), ratified: true },
  {
    skillId: "skill_deburring",
    alias: hi("chhilai"),
    ratified: true,
    note: "RATIFIED Q-A (owner, 2026-07-16): shop-floor sense is finishing → remapped skill_milling ➜ skill_deburring (joins 'finishing ka kaam' on the same skill).",
  },
  // --- machining core -----------------------------------------------------------------
  { skillId: "skill_drilling", alias: hi("chhed karna"), ratified: true },
  { skillId: "skill_drilling", alias: hi("drilling ka kaam"), ratified: true },
  {
    skillId: "skill_tapping_threading",
    alias: hi("chudi katna"),
    ratified: true,
    note: "chudi/chooree = thread; also seen as 'chudi katai'.",
  },
  { skillId: "skill_grinding_ops", alias: hi("ghisai"), ratified: true },
  { skillId: "skill_grinding_ops", alias: hi("ghisai ka kaam"), ratified: true },
  { skillId: "skill_deburring", alias: hi("finishing ka kaam"), ratified: true },
  // --- setup / programming / drawing ---------------------------------------------------
  { skillId: "skill_fixture_setup", alias: hi("job setting"), ratified: true },
  { skillId: "skill_fixture_setup", alias: hi("setting karna"), ratified: true },
  { skillId: "skill_cnc_programming", alias: hi("program banana"), ratified: true },
  { skillId: "skill_program_editing", alias: hi("program sudharna"), ratified: true },
  {
    skillId: "skill_cad_interpretation",
    alias: hi("drawing padhna"),
    ratified: true,
    note: "RATIFIED Q-B (owner, 2026-07-16): the phrase implies reading CAD/digital models on their floors → remapped skill_gdt_reading ➜ skill_cad_interpretation.",
  },
  // --- measurement / quality -----------------------------------------------------------
  { skillId: "skill_measuring_instruments", alias: hi("naap tol"), ratified: true },
  { skillId: "skill_measuring_instruments", alias: hi("micrometer se naapna"), ratified: true },
  { skillId: "skill_quality_control", alias: hi("quality check karna"), ratified: true },
  // --- adjacent trades (welding / fabrication / fitting / maintenance) ------------------
  { skillId: "skill_welder_occupation", alias: hi("welding ka kaam"), ratified: true },
  { skillId: "skill_gas_cutting", alias: hi("gas se katna"), ratified: true },
  { skillId: "skill_sheet_metal", alias: hi("chadar ka kaam"), ratified: true },
  { skillId: "skill_bench_fitting", alias: hi("fitting ka kaam"), ratified: true },
  { skillId: "skill_machine_maintenance", alias: hi("machine ki marammat"), ratified: true },
] as const;

/** The rows the seed may insert — ratified ONLY (the TAX-0 gate d enforcement point). */
export function ratifiedWedgeAliases(): WedgeAliasProposal[] {
  return WEDGE_ALIASES.filter((w) => w.ratified);
}

/** Structural validation (mirrors validateSkillCorpus): unknown ids / dup (id,text,lang). */
export function validateWedgeAliases(knownSkillIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const w of WEDGE_ALIASES) {
    if (!knownSkillIds.has(w.skillId)) {
      problems.push(`wedge alias "${w.alias.text}" targets unknown skill_id ${w.skillId}`);
    }
    const key = `${w.skillId}::${w.alias.text.toLowerCase()}::${w.alias.lang}`;
    if (seen.has(key)) problems.push(`duplicate wedge alias: ${w.skillId} "${w.alias.text}"`);
    seen.add(key);
    if (w.alias.source !== "rvm") {
      problems.push(`wedge alias "${w.alias.text}" must have source=rvm (got ${w.alias.source})`);
    }
  }
  return problems;
}
