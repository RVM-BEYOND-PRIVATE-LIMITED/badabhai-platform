/**
 * The trainer pack's validation harness — what engineering owes, and the line it must not cross.
 *
 *   pnpm --filter @badabhai/db db:verify:trainer-pack
 *   pnpm --filter @badabhai/db db:verify:trainer-pack --pack=<path> --fixture=<path>
 *
 * ===========================================================================
 * WHY ENGINEERING WRITES THE CHECKER AND NOT THE PHRASES
 * ===========================================================================
 * Owner ruling, 2026-08-20: *"Do not invent the six trainer phrases in engineering. Leave the
 * trainer pack ready for the domain/trade trainer. Engineering should only provide the
 * validation/evaluation harness."*
 *
 * That ruling is the same argument E1 itself rests on. The six skills are blocked precisely
 * because their only evaluation case is MECHANICAL — a query that is the skill's own alias,
 * asking the index whether an exact string matches itself. A paraphrase invented by the same
 * side that scores it is the identical failure one layer up: it would clear the gate and measure
 * nothing, and the gate would then be worse than useless because it would look satisfied.
 *
 * So this file never authors a query. It reads what a trainer wrote and answers one question:
 * **would this case actually measure something?** Every rule below is a way of failing that
 * question, and each one exists because it is a plausible way to fill a slot and clear the gate
 * without measuring anything.
 *
 * ===========================================================================
 * READ-ONLY AND OFFLINE
 * ===========================================================================
 * Files only — the pack and the fixture. No database, no provider, no vectors. It answers
 * "is this case well-formed and non-tautological", which is decidable from the corpus, and
 * deliberately not "does retrieval find it", which is `db:eval:taxonomy`'s question and needs
 * embeddings that do not exist yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeAliasText } from "./taxonomy-alias-experiment";
import { loadEvalFixture, type EvalFixture } from "./taxonomy-eval-fixture";
import { TAXONOMY_DATA_DIR } from "./taxonomy-corpus";
import { DEFAULT_FIXTURE } from "./taxonomy-retrieval-eval";

const SCRIPT = "verify:trainer-pack";

export const DEFAULT_PACK = join(
  TAXONOMY_DATA_DIR,
  "eval",
  "review-pack",
  "e1-eval-coverage-trainer-pack.json",
);

/** The slot prefix the pack uses for a case awaiting a trainer. */
export const SLOT_PREFIX = "PR-";
/** The provenance a slot ships with. A filled slot must no longer carry it. */
export const UNAUTHORED_PROVENANCE = "pending_reviewer_authorship";

export interface PackCase {
  case_id: string;
  query: string;
  lang: string;
  category: string;
  job_domain_id: string | null;
  expected_skill_id: string | null;
  provenance: string;
  review_status?: string;
  notes?: string;
}

export interface PackEntry {
  skill_id: string;
  label_en: string;
  domains: string[];
  existing_aliases: { text: string; lang: string }[];
  proposed_cases: PackCase[];
}

export interface TrainerPack {
  kind: string;
  entries: PackEntry[];
}

export type SlotState = "empty" | "filled" | "invalid";

export interface SlotVerdict {
  readonly caseId: string;
  readonly skillId: string;
  readonly state: SlotState;
  /** Every reason this slot would not measure anything. Empty when `filled`. */
  readonly problems: readonly string[];
}

export interface SkillVerdict {
  readonly skillId: string;
  readonly labelEn: string;
  /** At least one slot filled, valid, and `reviewed` — the gate is cleared for this skill. */
  readonly cleared: boolean;
  readonly slots: readonly SlotVerdict[];
}

export interface PackVerdict {
  readonly skills: readonly SkillVerdict[];
  readonly cleared: number;
  readonly awaiting: number;
  readonly invalid: number;
}

/** Devanagari by SCRIPT, not by codepoint range — the same reasoning as `normalizeAliasText`. */
const DEVANAGARI = /\p{Script=Devanagari}/u;

/**
 * Validate one filled slot.
 *
 * Returns every problem rather than the first: a trainer fixing one line at a time, with a
 * round trip through a person for each, is how a six-slot pack takes six weeks.
 */
export function validateSlot(
  slot: PackCase,
  entry: PackEntry,
  fixtureCaseIds: ReadonlySet<string>,
  siblingQueries: ReadonlyMap<string, string>,
): SlotVerdict {
  const query = slot.query.trim();
  if (query === "") {
    return { caseId: slot.case_id, skillId: entry.skill_id, state: "empty", problems: [] };
  }

  const problems: string[] = [];
  const norm = normalizeAliasText(query);

  // 1. THE REUSE RULE, and the reason the whole pack exists. A paraphrase that IS an existing
  //    alias reproduces the mechanical case it was meant to replace, one indirection along.
  for (const a of entry.existing_aliases) {
    if (normalizeAliasText(a.text) === norm) {
      problems.push(
        `query is an existing alias of this skill ("${a.text}") — that is the mechanical case ` +
          `again, which is what E1 stopped counting`,
      );
    }
  }

  // 2. ...and not a duplicate of the pack's OTHER slot for the same skill. Two slots holding the
  //    same phrase is one measurement reported as two.
  for (const [otherId, otherQuery] of siblingQueries) {
    if (otherId !== slot.case_id && otherQuery !== "" && normalizeAliasText(otherQuery) === norm) {
      problems.push(`query is identical to ${otherId} — the two slots must measure different things`);
    }
  }

  // 3. IT MUST BE MARKED REVIEWED, or the gate still will not count it and the trainer's work
  //    is invisible. `countsAsEvalCoverage` reads exactly this field.
  if (slot.review_status !== "reviewed") {
    problems.push(
      `review_status is "${slot.review_status ?? "(absent)"}" — a filled slot must be "reviewed", ` +
        `or EVAL_COVERED still does not count it`,
    );
  }

  // 4. PROVENANCE MUST CHANGE. Left as shipped, `reviewStatusOf` and every report would still
  //    describe this as unauthored; set to `corpus_alias:*`, it derives back to mechanical.
  if (slot.provenance === UNAUTHORED_PROVENANCE) {
    problems.push(
      `provenance is still "${UNAUTHORED_PROVENANCE}" — name who authored it, e.g. "trainer:<name>"`,
    );
  }
  if (slot.provenance.startsWith("corpus_alias:")) {
    problems.push(
      `provenance "${slot.provenance}" derives back to mechanical — a hand-written phrase is not ` +
        `a corpus alias`,
    );
  }

  // 5. THE LANGUAGE SLOT MUST HOLD THAT LANGUAGE. A Hindi slot answered in Latin script is the
  //    single most likely way this pack comes back wrong, and it is silent: the case scores, and
  //    the Devanagari phrasing — the one workers actually say — stays unmeasured.
  if (slot.lang === "hi" && !DEVANAGARI.test(query)) {
    problems.push("the Hindi slot must be written in Devanagari, not transliterated");
  }
  if (slot.lang === "en" && DEVANAGARI.test(query)) {
    problems.push("the English slot contains Devanagari — fill the Hindi slot instead");
  }

  // 6. GROUND TRUTH MUST STILL POINT AT THIS SKILL, IN A DOMAIN IT IS WIRED TO.
  if (slot.expected_skill_id !== entry.skill_id) {
    problems.push(
      `expected_skill_id is "${slot.expected_skill_id}" but this slot belongs to ` +
        `"${entry.skill_id}" — a slot may not be re-pointed at another skill`,
    );
  }
  if (slot.job_domain_id !== null && !entry.domains.includes(slot.job_domain_id)) {
    problems.push(
      `job_domain_id "${slot.job_domain_id}" is not one this skill is wired to ` +
        `(${entry.domains.join(", ")}) — retrieval is domain-scoped, so the case cannot pass`,
    );
  }

  // 7. NO ID COLLISION WITH THE SHIPPED FIXTURE. Two cases sharing a `case_id` makes every
  //    report that joins on it silently wrong.
  if (fixtureCaseIds.has(slot.case_id)) {
    problems.push(`case_id "${slot.case_id}" already exists in the fixture — pick another`);
  }

  return {
    caseId: slot.case_id,
    skillId: entry.skill_id,
    state: problems.length === 0 ? "filled" : "invalid",
    problems,
  };
}

/** Judge the whole pack. Pure. */
export function validateTrainerPack(pack: TrainerPack, fixture: EvalFixture): PackVerdict {
  const fixtureCaseIds = new Set(fixture.cases.map((c) => c.case_id));
  const skills: SkillVerdict[] = [];

  for (const entry of pack.entries) {
    const slotCases = entry.proposed_cases.filter((c) => c.case_id.startsWith(SLOT_PREFIX));
    const siblings = new Map(slotCases.map((c) => [c.case_id, c.query.trim()]));
    const slots = slotCases.map((c) => validateSlot(c, entry, fixtureCaseIds, siblings));
    skills.push({
      skillId: entry.skill_id,
      labelEn: entry.label_en,
      // ONE valid slot clears the gate — the pack says so, and the second slot is an invitation
      // rather than a requirement.
      cleared: slots.some((s) => s.state === "filled"),
      slots,
    });
  }

  return {
    skills,
    cleared: skills.filter((s) => s.cleared).length,
    awaiting: skills.filter((s) => !s.cleared && s.slots.every((x) => x.state === "empty")).length,
    invalid: skills.reduce((n, s) => n + s.slots.filter((x) => x.state === "invalid").length, 0),
  };
}

export function render(v: PackVerdict): string[] {
  const L = [
    `[${SCRIPT}] OFFLINE — the pack and the fixture, no database.`,
    "",
    `  skills in the pack     ${v.skills.length}`,
    `  gate cleared           ${v.cleared}`,
    `  still awaiting a phrase ${v.awaiting}`,
    `  slots with problems    ${v.invalid}`,
    "",
  ];
  for (const s of v.skills) {
    const mark = s.cleared ? "CLEARED " : s.slots.some((x) => x.state === "invalid") ? "PROBLEM " : "awaiting";
    L.push(`  ${mark} ${s.skillId.padEnd(38)} ${s.labelEn}`);
    for (const slot of s.slots) {
      if (slot.state === "invalid") {
        for (const p of slot.problems) L.push(`      ${slot.caseId}: ${p}`);
      }
    }
  }
  L.push("");
  if (v.invalid > 0) {
    L.push("  A slot with a problem is NOT counted as cleared. Nothing here rejects a phrase for");
    L.push("  being a poor description — that judgement is the trainer's, and this tool has no");
    L.push("  opinion on it. Every rule above is a way a case would measure NOTHING.");
  } else if (v.cleared === v.skills.length) {
    L.push("  Every skill has a reviewed, non-tautological case. Fold them into the fixture and");
    L.push("  re-run `db:report:taxonomy` / `db:promote:skills --batch <dir>` to see the gate move.");
  } else {
    L.push("  Slots left empty cost nothing: `pending_review` stays out of every metric.");
  }
  return L;
}

function argValue(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

function main(): void {
  const packPath = argValue("pack") ?? DEFAULT_PACK;
  const fixturePath = argValue("fixture") ?? DEFAULT_FIXTURE;
  if (!existsSync(packPath)) throw new Error(`[${SCRIPT}] pack not found: ${packPath}`);

  const pack = JSON.parse(readFileSync(packPath, "utf8")) as TrainerPack;
  const verdict = validateTrainerPack(pack, loadEvalFixture(fixturePath));
  for (const line of render(verdict)) console.log(line);

  // Exit 1 ONLY for a malformed slot. An empty pack is the expected state until a trainer has
  // written anything, and failing on it would make this command unusable as a routine check.
  if (verdict.invalid > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
