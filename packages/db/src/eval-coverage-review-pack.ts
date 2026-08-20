/**
 * Trainer review pack for the skills E1 demoted — the six the strict `EVAL_COVERED` gate blocks.
 *
 *   pnpm db:review-pack:eval-coverage [--vectors=<tsv>] [--out=<dir>]
 *
 * ===========================================================================
 * WHAT E1 LEFT BEHIND, AND WHY IT NEEDS AN ARTIFACT
 * ===========================================================================
 * `EVAL_COVERED` now counts only REVIEWED cases (owner ruling 2026-08-20). A skill covered
 * solely by a `corpus_alias:*` MECHANICAL case is self-certifying — its query is the skill's own
 * alias, so the "measurement" asks the index whether an exact string matches itself — and it no
 * longer unlocks promotion.
 *
 * Six skills in the committed fixture are in exactly that position. Each is ONE reviewed case
 * away from promotable, and "someone should write six cases" is not a work item anybody can
 * pick up. This runner turns it into one: a pack with a named, empty slot per skill.
 *
 * ===========================================================================
 * THE SET IS NOT A LIST IN THIS FILE
 * ===========================================================================
 * The six come from `evalCoverage(fixture).demoted` — the SAME function `promote-skills` calls
 * to build the gate. So the pack cannot describe a different set from the one the gate enforces,
 * and it self-corrects the moment a trainer case lands: fill a slot, re-run, that skill is gone
 * from the pack. A hardcoded list would have been correct exactly once.
 *
 * ===========================================================================
 * IT DOES NOT AUTHOR GROUND TRUTH
 * ===========================================================================
 * Same rule as `td01-review-pack.ts` and for the same reason. Every paraphrase slot ships with
 * an EMPTY query and `review_status: "pending_review"`, and stays out of every metric until a
 * human sets `reviewed`. DC-18 is the standing example: a case that read as a model failure for
 * two phases and turned out to be a fixture opinion. A paraphrase written by the process that
 * scores it measures nothing — and here it would be worse than useless, because the whole point
 * of E1 is that self-certifying evidence must not unlock a promotion. Generating the six cases
 * automatically would re-open the hole E1 closed, one layer up.
 *
 * The case CONVENTIONS are not re-implemented either: `mechanicalCases`, `paraphraseSlots` and
 * `evidenceNeeded` are imported from the stock pack. A second copy is the copy that drifts.
 *
 * ===========================================================================
 * OFFLINE
 * ===========================================================================
 * No database, no provider call, no mutation. The corpus comes from the committed source files
 * and the fixture from `retrieval-v2.jsonl`. `--vectors=<tsv>` (from `db:export:alias-vectors`)
 * is OPTIONAL and only adds the competing-skills section; without it the pack still lists every
 * slot, and says in `competitors_available` that it was built without them rather than implying
 * a skill has no near neighbours.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SKILL_CORPUS } from "@badabhai/taxonomy";

import { argValue } from "./match-v1-cli";
import { cosine } from "./path-a-replay";
import { evalCoverage } from "./promote-skills";
import { EMBEDDING_MODEL } from "./taxonomy-alias-experiment";
import { loadTaxonomyCorpus, TAXONOMY_DATA_DIR } from "./taxonomy-corpus";
import { loadEvalFixture, reviewStatusOf, type EvalCase } from "./taxonomy-eval-fixture";
import {
  COMPETITORS_SHOWN,
  evidenceNeeded,
  mechanicalCases,
  paraphraseSlots,
  type CompetitorRef,
  type ReviewEntry,
} from "./taxonomy-fixture-review-pack";

const SCRIPT = "review-pack:eval-coverage";
const PACK_FILE = "e1-eval-coverage-trainer-pack.json";

/** One skill's corpus facts, from whichever corpus holds it. */
export interface SkillFacts {
  skill_id: string;
  label_en: string | null;
  label_hi: string | null;
  status: string;
  aliases: { text: string; lang: string | null }[];
}

/**
 * Find a skill in either corpus.
 *
 * The two are DISJOINT id spaces — the 51-skill wedge corpus lives in `SKILL_CORPUS` and is what
 * production actually holds; the 98-skill growth corpus lives in `skills.jsonl` and is 0% seeded.
 * All six demoted skills are growth-corpus, which is precisely why E1 blocks zero live
 * promotions, but this reads both so the runner does not silently skip a skill if that changes.
 */
export function findSkill(
  skillId: string,
  corpus: ReturnType<typeof loadTaxonomyCorpus>,
): SkillFacts | undefined {
  const wedge = SKILL_CORPUS.find((s) => s.skillId === skillId);
  if (wedge !== undefined) {
    return {
      skill_id: wedge.skillId,
      label_en: wedge.labelEn,
      label_hi: wedge.labelHi,
      status: wedge.status,
      aliases: wedge.aliases.map((a) => ({
        text: a.text,
        lang: (a.lang as string | null) ?? null,
      })),
    };
  }
  const growth = corpus.skills.find((s) => s.skill_id === skillId);
  if (growth === undefined) return undefined;
  return {
    skill_id: growth.skill_id,
    label_en: growth.label_en ?? null,
    label_hi: growth.label_hi ?? null,
    status: growth.status ?? "provisional",
    aliases: growth.aliases.map((a) => ({ text: a.text, lang: (a.lang as string | null) ?? null })),
  };
}

/**
 * The domains to open slots in, strongest first.
 *
 * The domain the EXISTING mechanical case already used is pulled to the front deliberately: that
 * is the scope the skill has been observed reachable in, so the reviewed case that replaces it
 * measures the same thing the mechanical one only claimed.
 */
export function orderedDomains(
  skillId: string,
  corpus: ReturnType<typeof loadTaxonomyCorpus>,
  mechanicalDomain: string | undefined,
): { domains: string[]; required: string[] } {
  const own = corpus.edges.filter((e) => e.skill_id === skillId);
  const ordered = [...own].sort(
    (a, b) =>
      Number(b.job_domain_id === mechanicalDomain) - Number(a.job_domain_id === mechanicalDomain) ||
      Number(b.default_requirement === "required") - Number(a.default_requirement === "required") ||
      b.relevance - a.relevance,
  );
  return {
    domains: ordered.map((e) => e.job_domain_id),
    required: ordered
      .filter((e) => e.default_requirement === "required")
      .map((e) => e.job_domain_id),
  };
}

/** Alias text -> vector, for the one model in force. Same reader as `td01-review-pack`. */
export function loadVectors(file: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [text, , model, vec] = line.split("\t");
    if (text === undefined || model !== EMBEDDING_MODEL || vec === undefined) continue;
    if (!out.has(text)) out.set(text, JSON.parse(vec) as number[]);
  }
  return out;
}

function competitorsFor(
  facts: SkillFacts,
  domains: readonly string[],
  corpus: ReturnType<typeof loadTaxonomyCorpus>,
  vectors: Map<string, number[]>,
): CompetitorRef[] {
  const targetVecs = facts.aliases
    .map((a) => vectors.get(a.text))
    .filter((v): v is number[] => v !== undefined);
  if (targetVecs.length === 0) return [];

  const inScope = new Set(
    corpus.edges.filter((e) => domains.includes(e.job_domain_id)).map((e) => e.skill_id),
  );
  // A competitor retrieval can never RETURN is not a competitor — it sends a reviewer hunting a
  // distinction with no consequence. `deprecated` is filtered out before ranking; `provisional`
  // is kept, because it is one promotion away.
  const deprecated = new Set<string>();
  for (const s of SKILL_CORPUS) if (s.status === "deprecated") deprecated.add(s.skillId);
  for (const s of corpus.skills) if (s.status === "deprecated") deprecated.add(s.skill_id);

  const labelOf = new Map<string, string | null>();
  const aliasesBySkill = new Map<string, string[]>();
  const consider = (id: string, label: string | null, texts: string[]): void => {
    if (!inScope.has(id) || id === facts.skill_id || deprecated.has(id)) return;
    labelOf.set(id, label);
    aliasesBySkill.set(id, texts);
  };
  for (const s of SKILL_CORPUS)
    consider(
      s.skillId,
      s.labelEn,
      s.aliases.map((a) => a.text),
    );
  for (const s of corpus.skills)
    consider(
      s.skill_id,
      s.label_en ?? null,
      s.aliases.map((a) => a.text),
    );

  const out: CompetitorRef[] = [];
  for (const [skillId, texts] of aliasesBySkill) {
    let best: { alias: string; similarity: number } | null = null;
    for (const t of texts) {
      const v = vectors.get(t);
      if (v === undefined) continue;
      for (const tv of targetVecs) {
        const sim = cosine(tv, v);
        if (best === null || sim > best.similarity) best = { alias: t, similarity: sim };
      }
    }
    if (best !== null)
      out.push({ skill_id: skillId, label: labelOf.get(skillId) ?? null, ...best });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, COMPETITORS_SHOWN);
}

/** The mechanical cases already in the fixture for this skill — what the slot has to beat. */
export function mechanicalEvidence(cases: readonly EvalCase[], skillId: string): EvalCase[] {
  return cases.filter(
    (c) =>
      reviewStatusOf(c) === "mechanical" &&
      (c.expected_skill_id === skillId || (c.acceptable_skill_ids ?? []).includes(skillId)),
  );
}

function markdown(pack: {
  entries: readonly (ReviewEntry & { existing_mechanical: EvalCase[] })[];
  competitors_available: boolean;
}): string {
  const L: string[] = [
    "# Trainer pack — the six skills the strict EVAL_COVERED gate blocks",
    "",
    "Each skill below is covered in the evaluation fixture **only by a mechanical case**: a query",
    "that is the skill's own alias, asking the index whether an exact string matches itself. Under",
    "E1 that no longer counts as having measured the skill, so none of the six can be promoted.",
    "",
    "**Each needs one thing: a phrase a real worker in that trade would say.** Write it in the",
    "slot, set `review_status` to `reviewed`, and that skill becomes promotable again.",
    "",
    "Two slots are offered per skill — English and Hindi. **One filled slot clears the gate**; the",
    "second is there because the Devanagari phrasing is usually the one workers actually say, and",
    "no skill here has ever been measured against it. Leave it `pending_review` if you cannot",
    "answer it; a `pending_review` slot stays out of every metric and costs nothing.",
    "",
    "**Do not reuse the existing phrase.** It is printed under each skill so you can avoid it — a",
    "paraphrase that repeats an alias tests nothing, which is the whole reason the mechanical case",
    "stopped counting.",
    "",
  ];
  if (!pack.competitors_available) {
    L.push(
      "> Built without alias vectors, so the *nearest other skills* section is absent. Re-run with",
      "> `--vectors=<tsv>` from `db:export:alias-vectors` to include it. Its absence means it was",
      "> not computed — not that these skills have no near neighbours.",
      "",
    );
  }
  L.push("---", "");
  for (const e of pack.entries) {
    L.push(`## ${e.label_en ?? e.skill_id}`, "");
    L.push(`- **skill_id**: \`${e.skill_id}\`  ·  **status**: ${e.status}`);
    if (e.label_hi !== null && e.label_hi !== "") L.push(`- **label_hi**: ${e.label_hi}`);
    L.push(
      `- **trades it is wired to**: ${e.domains.map((d) => `\`${d}\``).join(", ") || "_none_"}`,
    );
    L.push(
      `- **phrases it already answers to — DO NOT REUSE**: ` +
        e.existing_aliases.map((a) => `\`${a.text}\`${a.lang === "hi" ? " (hi)" : ""}`).join(", "),
    );
    L.push(
      `- **the case that used to count**: ` +
        e.existing_mechanical
          .map((c) => `\`${c.case_id}\` — query \`${c.query}\` in \`${c.job_domain_id}\``)
          .join("; "),
    );
    L.push("");
    if (e.competing_skills.length > 0) {
      L.push(
        "**Nearest other skills in a shared trade** — what a careless phrasing would hit:",
        "",
      );
      L.push("| cosine | skill | via phrase |", "|---|---|---|");
      for (const c of e.competing_skills)
        L.push(`| ${c.similarity.toFixed(4)} | \`${c.skill_id}\` | ${c.alias} |`);
      L.push("");
    }
    L.push("**Evidence needed from you**", "");
    for (const q of e.evidence_needed) L.push(`- [ ] ${q}`);
    L.push("", "**Write here**", "");
    for (const c of e.proposed_cases.filter((x) => x.review_status === "pending_review")) {
      L.push(
        `- \`${c.case_id}\` · ${c.lang === "hi" ? "**Hindi, in Devanagari**" : "English"} · ` +
          `scope \`${c.job_domain_id}\`  →  _______________________________`,
      );
    }
    L.push("", "---", "");
  }
  return L.join("\n");
}

export interface CoveragePack {
  kind: string;
  generated_against: string;
  why_now: string;
  ground_truth_status: string;
  gate_state: Record<string, unknown>;
  competitors_available: boolean;
  slots_awaiting_trainer: number;
  entries: (ReviewEntry & { existing_mechanical: EvalCase[] })[];
  /** Demoted skills no corpus can describe. Non-empty is a hard failure, never a short list. */
  missing: string[];
}

/**
 * Build the pack. Pure over its inputs and separate from `main` so a test can assert the
 * artifact WITHOUT writing files — including that no slot ever ships with a query in it, which
 * is the one property of this runner that actually matters.
 */
export function buildPack(vectors: Map<string, number[]> = new Map()): CoveragePack {
  const fixture = loadEvalFixture(join(TAXONOMY_DATA_DIR, "eval", "retrieval-v2.jsonl"));
  const { covered, demoted } = evalCoverage(fixture);
  const corpus = loadTaxonomyCorpus(TAXONOMY_DATA_DIR);

  const entries: (ReviewEntry & { existing_mechanical: EvalCase[] })[] = [];
  const missing: string[] = [];
  for (const skillId of demoted) {
    const facts = findSkill(skillId, corpus);
    if (facts === undefined) {
      missing.push(skillId);
      continue;
    }
    const existing = mechanicalEvidence(fixture.cases, skillId);
    // `required` is deliberately not consumed. The TD-01 pack opens one extra slot per
    // required domain; these six need ONE reviewed case each to clear the gate, and asking for
    // more per skill trades a bounded trainer task for an open-ended one.
    const { domains } = orderedDomains(skillId, corpus, existing[0]?.job_domain_id);
    const base = {
      skill_id: facts.skill_id,
      label_en: facts.label_en,
      label_hi: facts.label_hi,
      status: facts.status,
      domains,
      existing_aliases: facts.aliases,
      competing_skills: vectors.size === 0 ? [] : competitorsFor(facts, domains, corpus, vectors),
    };
    entries.push({
      ...base,
      // Mechanical cases are re-emitted so the pack is self-contained evidence of the state it
      // describes: the reviewer sees exactly what "already covered" meant before E1.
      proposed_cases: [...mechanicalCases(base), ...paraphraseSlots(base)],
      evidence_needed: evidenceNeeded(base),
      existing_mechanical: existing,
    });
  }

  const pack = {
    kind: "e1-eval-coverage-trainer-pack",
    generated_against: "committed corpus source files and retrieval-v2.jsonl (no database)",
    why_now:
      "E1 (owner ruling 2026-08-20) made EVAL_COVERED count only REVIEWED cases. These skills " +
      "were covered solely by a mechanical corpus_alias case and are now blocked from promotion.",
    ground_truth_status:
      "NOT AUTHORED. Every paraphrase slot has an empty query and awaits a trainer.",
    gate_state: {
      fixture_cases: fixture.cases.length,
      covered_by_reviewed: covered.size,
      demoted: demoted.length,
      blocks_live_promotions: 0,
      blocks_live_promotions_why:
        "all demoted skills belong to the 98-skill growth corpus, which is 0% seeded; production " +
        "holds the disjoint wedge corpus",
    },
    competitors_available: vectors.size > 0,
    slots_awaiting_trainer: entries.reduce(
      (n, e) => n + e.proposed_cases.filter((c) => c.review_status === "pending_review").length,
      0,
    ),
    entries,
    missing,
  };
  return pack;
}

export function main(): void {
  const outDir = argValue("out") ?? join(TAXONOMY_DATA_DIR, "eval", "review-pack");
  const vectorFile = argValue("vectors");
  const pack = buildPack(
    vectorFile === undefined ? new Map<string, number[]>() : loadVectors(vectorFile),
  );

  if (pack.missing.length > 0) {
    // Fail loudly: a demoted skill the corpus cannot describe means the fixture and the corpus
    // disagree, and a pack that silently omitted it would send a trainer a short list.
    console.error(
      `[${SCRIPT}] ${pack.missing.length} demoted skill(s) are in NEITHER corpus: ${pack.missing.join(", ")}`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, PACK_FILE);
  const mdPath = join(outDir, PACK_FILE.replace(/\.json$/, ".md"));
  for (const p of [jsonPath, mdPath]) {
    if (existsSync(p)) {
      // Same rule as every other pack: evidence is never replaced. A trainer may already have
      // written in it.
      console.error(`[${SCRIPT}] refusing to overwrite ${p} — evidence is never replaced.`);
      process.exit(1);
    }
  }
  writeFileSync(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, markdown(pack), "utf8");

  console.log(`[${SCRIPT}] no database, no provider, no mutation.`);
  console.log(`  fixture cases              ${pack.gate_state.fixture_cases}`);
  console.log(`  covered by a REVIEWED case ${pack.gate_state.covered_by_reviewed}`);
  console.log(`  demoted by E1              ${pack.gate_state.demoted}`);
  for (const e of pack.entries) {
    console.log(
      `     ${e.skill_id.padEnd(38)} ${e.domains.length} trade(s), ${e.existing_aliases.length} phrase(s)`,
    );
  }
  console.log(
    `  competitors computed       ${pack.competitors_available ? "yes" : "no (--vectors not given)"}`,
  );
  console.log(`  EMPTY slots awaiting a trainer: ${pack.slots_awaiting_trainer}`);
  console.log(`  written to                 ${jsonPath}`);
  console.log(`                             ${mdPath}`);
}

if (process.argv[1] !== undefined && /eval-coverage-review-pack\.ts$/.test(process.argv[1])) {
  main();
}
