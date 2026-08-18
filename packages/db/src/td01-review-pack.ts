/**
 * Trainer review pack for the TD-01 merged skill — the coverage R19 finally made possible.
 *
 *   pnpm db:review-pack:td01 --vectors=<tsv> [--out=<dir>]
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE RUNNER AND NOT A RE-RUN OF THE MAIN PACK
 * ===========================================================================
 * `taxonomy-fixture-review-pack.ts` reads the DATABASE. Neither database has the post-TD-01
 * corpus: production holds 51 pre-merge skills, and the local dev DB was seeded before the
 * merge — so `skill_drawing_reading` exists in neither and a re-run cannot see it. The
 * authoritative corpus is the source files on `main`.
 *
 * So this runner sources the SKILL from files and the VECTORS from a read-only export, then
 * calls the main pack's OWN pure functions — `mechanicalCases`, `paraphraseSlots`,
 * `evidenceNeeded` — to build the entry. Nothing about the case format, the slot convention or
 * the evidence checklist is re-implemented here; a second copy of those is the copy that drifts.
 *
 * ===========================================================================
 * IT DOES NOT AUTHOR GROUND TRUTH, AND THAT IS THE POINT
 * ===========================================================================
 * Every paraphrase slot ships with an EMPTY query and `review_status: "pending_review"`. DC-18
 * is the standing example in this repo: a case that read as a model failure for two phases
 * turned out to be a fixture opinion. A paraphrase written by the same process that scores it
 * measures nothing, so the queries are left blank for a trainer.
 *
 * The only cases carrying a query are `mechanical` ones, where the query IS the skill's own
 * alias — tautologically correct, weak evidence by construction, present only to show
 * reachability.
 *
 * ===========================================================================
 * SLOT BREADTH IS DATA-DRIVEN, NOT TASTE
 * ===========================================================================
 * The stock pack opens `PARAPHRASE_SLOTS` slots in one domain. This skill is reachable in 12,
 * and `evidenceNeeded` itself raises the "confirm it means the same in each" question. Rather
 * than guess which domains matter, one extra slot is opened per domain the CORPUS marks
 * `required` — the corpus's own statement that the skill is not optional there. Every extra
 * slot is still empty, so this asks the trainer more questions; it never answers one.
 *
 * No provider call, no database, no mutation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_CORPUS, ratifiedWedgeAliases } from "@badabhai/taxonomy";
import { loadTaxonomyCorpus } from "./taxonomy-corpus";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import { cosine } from "./path-a-replay";
import { EMBEDDING_MODEL } from "./taxonomy-alias-experiment";
import { argValue } from "./match-v1-cli";
import {
  COMPETITORS_SHOWN,
  evidenceNeeded,
  mechanicalCases,
  paraphraseSlots,
  type CompetitorRef,
  type ProposedCase,
  type ReviewEntry,
} from "./taxonomy-fixture-review-pack";

const TARGET = "skill_drawing_reading";
const DATA = join(__dirname, "..", "data", "taxonomy");

function loadVectors(file: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [text, , model, vec] = line.split("\t");
    if (text === undefined || model !== EMBEDDING_MODEL || vec === undefined) continue;
    if (!out.has(text)) out.set(text, JSON.parse(vec) as number[]);
  }
  return out;
}

function main(): void {
  const vectorFile = argValue("vectors");
  if (vectorFile === undefined) {
    console.error("[review-pack:td01] --vectors=<tsv> is required (read-only export).");
    process.exit(2);
  }
  const outDir = argValue("out") ?? join(DATA, "eval", "review-pack");
  const vectors = loadVectors(vectorFile);

  const skill = SKILL_CORPUS.find((s) => s.skillId === TARGET);
  if (skill === undefined) throw new Error(`[review-pack:td01] ${TARGET} is not in SKILL_CORPUS`);

  // Aliases: the corpus's own, plus the TAX-5 wedge alias that moved with the merge.
  const aliases = [
    ...skill.aliases.map((a) => ({ text: a.text, lang: a.lang as string | null })),
    ...ratifiedWedgeAliases()
      .filter((w) => w.skillId === TARGET)
      .map((w) => ({ text: w.alias.text, lang: w.alias.lang as string | null })),
  ];

  // Domains, strongest first, so the stock functions pick the most load-bearing one.
  const corpus = loadTaxonomyCorpus(DATA);
  const own = corpus.edges.filter((e) => e.skill_id === TARGET);
  const ordered = [...own].sort(
    (a, b) =>
      Number(b.default_requirement === "required") - Number(a.default_requirement === "required") ||
      b.relevance - a.relevance,
  );
  const domains = ordered.map((e) => e.job_domain_id);
  const requiredDomains = ordered
    .filter((e) => e.default_requirement === "required")
    .map((e) => e.job_domain_id);

  // Competitors: the nearest OTHER skill sharing any of those domains — what a careless
  // phrasing would hit instead. Computed over vectors that already exist; nothing is embedded.
  const targetVecs = aliases
    .map((a) => vectors.get(a.text))
    .filter((v): v is number[] => v !== undefined);
  const labelOf = new Map(SKILL_CORPUS.map((s) => [s.skillId, s.labelEn as string | null]));
  const inScope = new Set(
    corpus.edges.filter((e) => domains.includes(e.job_domain_id)).map((e) => e.skill_id),
  );
  // A competitor retrieval can never RETURN is not a competitor — it is a distraction that
  // sends a reviewer hunting a distinction with no consequence. `skill_dimensional_inspection`
  // is the live example: it shares a domain and sits at cosine 0.757, but TD-02 deprecated it,
  // so `canonicalAliasRows` filters it out before ranking ever happens. Competitors are
  // therefore restricted to what the retrieval path could actually surface — which for the
  // growth corpus means `provisional` counts (it is one promotion away), and `deprecated`
  // never does.
  const deprecated = new Set(
    SKILL_CORPUS.filter((s) => s.status === "deprecated").map((s) => s.skillId),
  );
  for (const s of corpus.skills) if (s.status === "deprecated") deprecated.add(s.skill_id);

  const aliasesBySkill = new Map<string, { text: string }[]>();
  for (const s of SKILL_CORPUS) {
    if (!inScope.has(s.skillId) || s.skillId === TARGET || deprecated.has(s.skillId)) continue;
    aliasesBySkill.set(
      s.skillId,
      s.aliases.map((a) => ({ text: a.text })),
    );
  }
  for (const s of corpus.skills) {
    if (!inScope.has(s.skill_id) || s.skill_id === TARGET || deprecated.has(s.skill_id)) continue;
    aliasesBySkill.set(
      s.skill_id,
      s.aliases.map((a) => ({ text: a.text })),
    );
  }
  const competitors: CompetitorRef[] = [];
  for (const [skillId, as] of aliasesBySkill) {
    let best: { alias: string; similarity: number } | null = null;
    for (const a of as) {
      const v = vectors.get(a.text);
      if (v === undefined) continue;
      for (const tv of targetVecs) {
        const sim = cosine(tv, v);
        if (best === null || sim > best.similarity) best = { alias: a.text, similarity: sim };
      }
    }
    if (best !== null) {
      competitors.push({ skill_id: skillId, label: labelOf.get(skillId) ?? null, ...best });
    }
  }
  competitors.sort((a, b) => b.similarity - a.similarity);

  const base = {
    skill_id: TARGET,
    label_en: skill.labelEn,
    label_hi: skill.labelHi,
    status: skill.status,
    domains,
    existing_aliases: aliases,
    competing_skills: competitors.slice(0, COMPETITORS_SHOWN),
  };

  // Stock cases first — same functions, same conventions as the 26-skill pack.
  const proposed: ProposedCase[] = [...mechanicalCases(base), ...paraphraseSlots(base)];
  // Then one extra EMPTY slot per additional `required` domain.
  for (const d of requiredDomains.slice(1)) {
    proposed.push({
      case_id: `PR-drawing_reading-${d}`,
      query: "",
      lang: "en",
      category: "multi_domain_reach",
      job_domain_id: d,
      expected_skill_id: TARGET,
      provenance: "pending_reviewer_authorship",
      review_status: "pending_review",
      notes:
        `SLOT — ${d} marks this skill "required", so it is not optional work there. Write how a ` +
        "worker in THIS domain would describe it without reusing an alias verbatim, then set " +
        'review_status to "reviewed". Left blank on purpose.',
    });
  }

  const entry: ReviewEntry = {
    ...base,
    proposed_cases: proposed,
    evidence_needed: evidenceNeeded(base),
  };

  const fixture = loadEvalFixture(join(DATA, "eval", "retrieval-v2.jsonl"));
  const pack = {
    kind: "td01-trainer-review-pack",
    generated_against: "authoritative corpus source files on main (no database)",
    why_now:
      "Before R19 this pack was impossible: validateEvalFixture rejects any case whose expected " +
      "skill has no job_domain_skill edge (EXPECTED_SKILL_NOT_IN_SCOPE, 'unpassable by " +
      "construction'), and skill_drawing_reading had none. The edge re-point made it valid.",
    ground_truth_status:
      "NOT AUTHORED. Every paraphrase slot has an empty query and awaits a trainer.",
    existing_fixture_coverage_for_this_skill: fixture.cases.filter(
      (c) => c.expected_skill_id === TARGET,
    ).length,
    domain_detail: ordered.map((e) => ({
      job_domain_id: e.job_domain_id,
      default_requirement: e.default_requirement,
      relevance: e.relevance,
      slot_opened:
        e.job_domain_id === domains[0] || requiredDomains.slice(1).includes(e.job_domain_id),
    })),
    slots_awaiting_trainer: proposed.filter((c) => c.review_status === "pending_review").length,
    mechanical_cases: proposed.filter((c) => c.review_status === "mechanical").length,
    entries: [entry],
  };

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "td01-drawing-reading-trainer-pack.json");
  if (existsSync(jsonPath)) {
    console.error(`  refusing to overwrite ${jsonPath} — evidence is never replaced.`);
    process.exit(1);
  }
  writeFileSync(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

  console.log("[review-pack:td01] no database, no provider, no mutation.");
  console.log(`  skill            ${TARGET} (${skill.status})`);
  console.log(`  aliases          ${aliases.length}`);
  console.log(`  domains          ${domains.length} (${requiredDomains.length} required)`);
  console.log(`  existing fixture coverage: ${pack.existing_fixture_coverage_for_this_skill}`);
  console.log(`  mechanical cases ${pack.mechanical_cases}`);
  console.log(`  EMPTY slots awaiting a trainer: ${pack.slots_awaiting_trainer}`);
  console.log(
    `  competitors      ${entry.competing_skills.map((c) => `${c.skill_id}@${c.similarity.toFixed(4)}`).join(", ")}`,
  );
  console.log(`  written to       ${jsonPath}`);
}

main();
