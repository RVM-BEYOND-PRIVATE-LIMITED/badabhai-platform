/**
 * Matching V1 — the pure derivation helpers shared by the D3/D4/D5 runners.
 *
 * A SEPARATE, SIDE-EFFECT-FREE module on purpose: every `*.ts` runner in this package
 * ends with `main().catch(...)`, so importing a helper out of one of them would EXECUTE
 * that runner. Anything two runners share lives here instead.
 *
 * Everything below is DETERMINISTIC (invariant #4) and PII-free.
 */
import { inArray } from "drizzle-orm";

import type { Database } from "./client";
import { skillRelated } from "./schema";
import type { MatchSkillSeed } from "./match-taxonomy";

/**
 * Normalize a label or a role title to a comparable token string: lowercase, every run
 * of non-letter/non-number characters collapsed to a single space, trimmed.
 *
 * Unicode-property classes (`\p{L}`/`\p{N}`) rather than an ASCII+Devanagari RANGE, so
 * Hindi labels survive normalization without a character class that mixes combining
 * marks into a range (which is both an eslint `no-misleading-character-class` error and
 * a real correctness trap for scripts with combining marks).
 *
 * Deliberately dumb. This backs a PROPOSAL step whose failure mode must be
 * "no match" (visible, sent to an ops worklist) and never "wrong match" (silent).
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Propose match skills for a free-text role title.
 *
 * A skill matches when its normalized label appears as a WHOLE-TOKEN SUBSEQUENCE of the
 * normalized title — so "cnc operator" matches "Senior CNC Operator — Night Shift", while
 * "welder" does NOT match "welding inspector" by substring accident. Longest label wins
 * (most specific first); capped at `maxSkills`. Returns [] when nothing matches, which
 * the caller must treat as "leave empty + escalate", never as "pick something".
 */
export function proposeMatchSkills(
  roleTitle: string,
  corpus: readonly MatchSkillSeed[],
  maxSkills: number,
): string[] {
  const title = ` ${normalizeForMatch(roleTitle)} `;
  if (title.trim().length === 0) return [];

  const candidates: { skillId: string; length: number }[] = [];
  for (const s of corpus) {
    for (const label of [s.labelEn, s.labelHi ?? ""]) {
      if (!label) continue;
      const norm = normalizeForMatch(label);
      if (norm.length === 0) continue;
      if (title.includes(` ${norm} `)) {
        candidates.push({ skillId: s.skillId, length: norm.length });
        break;
      }
    }
  }
  candidates.sort((a, b) => b.length - a.length || a.skillId.localeCompare(b.skillId));

  const out: string[] = [];
  for (const c of candidates) {
    if (out.includes(c.skillId)) continue;
    out.push(c.skillId);
    if (out.length >= maxSkills) break;
  }
  return out;
}

/**
 * THE TIER-2 EXPANSION: match ids ∪ every `skill_related` neighbour of a match id.
 *
 * This is what `job_postings.reach_skill_ids` stores, and it is why the reach set can be
 * probed with ONE GIN lookup instead of a recursive join. Sorted so the stored array is
 * stable and two runs of the same input produce the same jsonb (no spurious updates).
 */
export async function expandReachSkillIds(db: Database, matchIds: string[]): Promise<string[]> {
  if (matchIds.length === 0) return [];
  const neighbours = await db
    .select({ relatedSkillId: skillRelated.relatedSkillId })
    .from(skillRelated)
    .where(inArray(skillRelated.skillId, matchIds));
  const set = new Set<string>(matchIds);
  for (const n of neighbours) set.add(n.relatedSkillId);
  return [...set].sort();
}
