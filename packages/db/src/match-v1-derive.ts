/**
 * Matching V1 — the pure derivation helpers shared by the D3/D4/D5 runners.
 *
 * A SEPARATE, SIDE-EFFECT-FREE module on purpose: every `*.ts` runner in this package
 * ends with `main().catch(...)`, so importing a helper out of one of them would EXECUTE
 * that runner. Anything two runners share lives here instead.
 *
 * Everything below is DETERMINISTIC (invariant #4) and PII-free.
 */
import { workerVisibleTextScreens, type WorkerVisibleScreen } from "@badabhai/validators";
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

/** The worker-visible text D4 copies from one legacy `jobs` row into `job_postings`. */
export interface JobTextForConversion {
  id: string;
  title: string;
  description: string | null;
  benefits: readonly string[] | null;
  requirements: readonly string[] | null;
}

/**
 * Which field failed. A chip is named by list and 0-based position (`benefits[2]`), so the
 * operator can find it without the runner printing the chip.
 */
export type JobTextField =
  | "title"
  | "description"
  | `benefits[${number}]`
  | `requirements[${number}]`;

/** One legacy-job field D4 must not copy, named by id, field and screen. Never the text. */
export interface JobTextScreenFailure {
  jobId: string;
  field: JobTextField;
  screens: WorkerVisibleScreen[];
}

/**
 * THE D4 WRITE BOUNDARY FOR WORKER-VISIBLE TEXT (#1823 B3).
 *
 * D4 copies `jobs.title` into `job_postings.role_title`, and `description` and each
 * `benefits` / `requirements` chip verbatim, without passing an API DTO. All four reach the
 * worker card, so each gets the screen every API write path runs on them:
 * `workerVisibleTextScreens` from `@badabhai/validators`, the same list the API's
 * `screenWorkerVisibleText` maps to its 400s. `city` and `area` are copied too and are not
 * screened here, matching the API, which does not screen them either (an open follow-up).
 *
 * The source rows were screened when they were written: agency routes run all three
 * heuristics on all four fields, and seed content is fixtures with its own guard. This is
 * the backstop for a row that predates that screen or was written by hand.
 *
 * Returns every failure, and an empty array when the batch is clean. The runner refuses
 * `--apply` on a non-empty result: converting the clean rows and leaving the rest would be a
 * partial cutover.
 */
export function screenJobTextForConversion(
  rows: ReadonlyArray<JobTextForConversion>,
): JobTextScreenFailure[] {
  const failures: JobTextScreenFailure[] = [];
  for (const row of rows) {
    const fields: Array<[JobTextField, string | null]> = [
      ["title", row.title],
      ["description", row.description],
      ...(row.benefits ?? []).map((b, i): [JobTextField, string] => [`benefits[${i}]`, b]),
      ...(row.requirements ?? []).map((r, i): [JobTextField, string] => [`requirements[${i}]`, r]),
    ];
    for (const [field, text] of fields) {
      if (text === null) continue;
      const screens = workerVisibleTextScreens(text);
      if (screens.length > 0) failures.push({ jobId: row.id, field, screens });
    }
  }
  return failures;
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
