/**
 * Offline Path-A replay runner — READ-ONLY, and offline by construction.
 *
 * ===========================================================================
 * WHAT IT DOES
 * ===========================================================================
 * Replays the evaluation fixture's `(phrase, job_domain_id)` pairs against the AUTHORITATIVE
 * corpus (the source files on `main`), through both retrieval paths, across three corpus
 * variants. It is the shadow evidence D0 requires before Stage B, obtained without enabling
 * canonicalization — which is the change the shadow exists to de-risk.
 *
 * ===========================================================================
 * WHY IT CANNOT WRITE OR SPEND QUOTA
 * ===========================================================================
 * There is no write path in this file: no INSERT, UPDATE, DELETE, no seeding, no `db:*` write
 * runner invoked. Vectors are INPUTS, never fetched:
 *
 *   - QUERY vectors come from the gitignored embed cache with `offline: true`. A miss throws
 *     rather than calling the provider, so an incomplete run fails loudly instead of quietly
 *     reporting a partial simulation as a complete one.
 *   - ALIAS vectors come from a TSV exported read-only from a database, passed via
 *     `--vectors=<file>`. Reusing a stored vector for the same text under a different skill is
 *     exact, not an approximation: the embedder is deterministic per model, which is the
 *     property `assertExactSimulationHolds` measures at cosine 1.0000. The model is pinned and
 *     a mismatch is a hard failure, because mixing two geometries produces cosines that look
 *     entirely normal and mean nothing.
 *
 * Export the alias vectors with (read-only, one statement):
 *
 *   docker exec badabhai-postgres psql -U badabhai -d badabhai -A -t -c \
 *     "COPY (SELECT text, lang, coalesce(embedding_model,'<null>'), embedding::text
 *              FROM skill_alias WHERE embedding IS NOT NULL)
 *      TO STDOUT WITH (FORMAT csv, DELIMITER E'\t')" > vectors.tsv
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ===========================================================================
 * It does not repoint TD-01's 14 `job_domain_skill` edges. `edges_repointed` is computed in
 * memory as a counterfactual so the cost of that unauthorized decision can be quantified
 * before anyone takes it. Nothing here mutates the corpus, the database, or either flag.
 *
 * Usage:
 *   pnpm db:replay:path-a --vectors=<tsv> [--report=<json>] [--k=5]
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_CORPUS, ratifiedWedgeAliases } from "@badabhai/taxonomy";
import { EMBEDDING_MODEL } from "./taxonomy-alias-experiment";
import { isScoreable, reviewStatusOf, loadEvalFixture, type EvalCase } from "./taxonomy-eval-fixture";
import { loadTaxonomyCorpus } from "./taxonomy-corpus";
import { COVERAGE_ONLY_CATEGORIES } from "./taxonomy-retrieval-eval";
import { argFlag, argValue } from "./match-v1-cli";
import {
  LEGACY_ANCHOR_SKILL_DOMAIN,
  findMintedSkillIds,
  mergeFamilies,
  probeFamilyReachability,
  PRE_PROMOTION_STATUSES,
  RETRIEVABLE_SKILL_STATUSES,
  buildVariant,
  diffCase,
  pathACandidates,
  replayCase,
  summarizeAgreement,
  summarizeReplay,
  type CorpusInput,
  type CorpusVariant,
  type ReplayAlias,
  type ReplayCaseResult,
  type ReplayEdge,
  type ReplaySkill,
  type RetrievalPath,
} from "./path-a-replay";

config();

// `aliases_retagged` is LAST on purpose: it is the only variant that models a step which has
// not run anywhere yet (`db:retag:skills`), so it reads as the forecast it is rather than as
// another view of the current corpus.
const VARIANTS: readonly CorpusVariant[] = [
  "pre_merge",
  "as_applied",
  "edges_repointed",
  "aliases_retagged",
];
const PATHS: readonly RetrievalPath[] = ["path_a_canonical", "path_b_legacy"];

function dataPath(...p: string[]): string {
  return join(__dirname, "..", "data", "taxonomy", ...p);
}

/** Alias vectors, keyed by text. Model-pinned: a foreign stamp is fatal, not a warning. */
/**
 * Exported so the S3-D shadow report reads the SAME corpus this replay does. A second loader
 * would be a second definition of "what Path A can see", which is the duplicate-rule defect
 * this phase has now found four times.
 */
export function loadVectors(file: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const foreign = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [text, , model, vec] = line.split("\t");
    if (text === undefined || model === undefined || vec === undefined) continue;
    if (model !== EMBEDDING_MODEL) {
      foreign.add(model);
      continue;
    }
    if (!out.has(text)) out.set(text, JSON.parse(vec) as number[]);
  }
  if (foreign.size > 0) {
    throw new Error(
      `[replay] vector file mixes embedding models: ${[...foreign].join(", ")} alongside ` +
        `${EMBEDDING_MODEL}. Cosines across two geometries look normal and mean nothing.`,
    );
  }
  return out;
}

/** Query vectors from the gitignored cache. Offline: a miss is reported, never fetched. */
function loadQueryCache(): Map<string, number[]> {
  const file = join(__dirname, "..", ".embed-cache", "vectors.json");
  if (!existsSync(file)) return new Map();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>;
  const out = new Map<string, number[]>();
  for (const [k, v] of Object.entries(raw)) {
    const [model, hash] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    if (model === EMBEDDING_MODEL) out.set(hash, v);
  }
  return out;
}

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/**
 * The authoritative corpus, read from source files — never from a database.
 *
 * BOTH halves, and the second one is not optional. `SKILL_CORPUS` holds the 49 shipped skills;
 * the 98 generated skills live in the JSONL growth corpus, and they are what most fixture
 * cases actually expect. Loading only the first makes every growth-corpus expectation
 * unreachable and reports R@1 = 0 — a number that says nothing about either the corpus or
 * production. `SKILL_CORPUS DOES NOT GROW` is a boundary in the seeder, not in retrieval:
 * `skill_alias` ends up holding both.
 */
export function loadCorpusInput(vectors: Map<string, number[]>): CorpusInput {
  const skills: ReplaySkill[] = SKILL_CORPUS.map((s) => ({
    skillId: s.skillId,
    status: s.status,
    replacedBy: s.replacedBy ?? null,
    // TD-01/02/03 dissolved ACTIVE, shipped skills (register sections 7 and 8), so a
    // deprecated SKILL_CORPUS row was active before the merge.
    preMergeStatus: s.status === "deprecated" && s.replacedBy !== undefined ? "active" : s.status,
  }));
  const domainOf = new Map(SKILL_CORPUS.map((s) => [s.skillId, s.domainId]));

  const aliases: ReplayAlias[] = [];
  for (const s of SKILL_CORPUS) {
    for (const a of s.aliases) {
      aliases.push({
        skillId: s.skillId,
        text: a.text,
        lang: a.lang,
        domainId: s.domainId,
        vector: vectors.get(a.text) ?? null,
      });
    }
  }
  // TAX-5 wedge aliases seed into `skill_alias` from the same run as the corpus's own.
  for (const w of ratifiedWedgeAliases()) {
    aliases.push({
      skillId: w.skillId,
      text: w.alias.text,
      lang: w.alias.lang,
      domainId: domainOf.get(w.skillId) ?? "",
      vector: vectors.get(w.alias.text) ?? null,
    });
  }

  // ---- the growth corpus -------------------------------------------------------------------
  // `seed-domain-skills.ts` writes these as `provisional` unless the record overrides it, which
  // TD-04/TD-06 now do (`deprecated`). `reuses_existing` records never get their own row.
  // They carry NO legacy `domain_id`: only the 11 hand-minted slugs do, so Path B cannot see
  // them at all — modelled as "" so the slug filter never matches.
  for (const s of loadTaxonomyCorpus(dataPath()).skills) {
    if (s.reuses_existing === true) continue;
    skills.push({
      skillId: s.skill_id,
      status: s.status === "deprecated" ? "deprecated" : "provisional",
      replacedBy: s.replaced_by ?? null,
      // TD-04/TD-06 dissolved PROVISIONAL, never-promoted growth-corpus skills (register
      // section 9). They were never retrievable, so pre_merge must not make them so.
      preMergeStatus: "provisional",
    });
    for (const a of s.aliases) {
      aliases.push({
        skillId: s.skill_id,
        text: a.text,
        lang: a.lang,
        domainId: "",
        vector: vectors.get(a.text) ?? null,
      });
    }
  }

  // The corpus's OWN loader, not a second parser: it already skips `#` comments and blank
  // lines, and a private copy here would be the copy that drifts.
  const edges: ReplayEdge[] = loadTaxonomyCorpus(dataPath()).edges.map((e) => ({
    jobDomainId: e.job_domain_id,
    skillId: e.skill_id,
  }));
  return { skills, aliases, edges };
}

function main(): void {
  const vectorFile = argValue("vectors");
  if (vectorFile === undefined) {
    console.error("[replay] --vectors=<tsv> is required. See the header for the export command.");
    process.exit(2);
  }
  const k = Number(argValue("k") ?? "5");
  const reportPath = argValue("report");
  const includeProvisional = argFlag("include-provisional");
  const statuses = includeProvisional ? PRE_PROMOTION_STATUSES : RETRIEVABLE_SKILL_STATUSES;

  const vectors = loadVectors(vectorFile);
  const queryCache = loadQueryCache();
  const input = loadCorpusInput(vectors);
  const fixture = loadEvalFixture(dataPath("eval", "retrieval-v2.jsonl"));

  const covered: EvalCase[] = [];
  const skipped: EvalCase[] = [];
  for (const c of fixture.cases) {
    (queryCache.has(sha(c.query)) ? covered : skipped).push(c);
  }

  console.log("[replay:path-a] READ-ONLY — no write path, no provider call.");
  console.log(`  corpus         ${input.skills.length} skills, ${input.aliases.length} aliases, ${input.edges.length} active edges`);
  console.log(`  alias vectors  ${vectors.size} distinct texts (model ${EMBEDDING_MODEL})`);
  console.log(`  aliases WITH a vector   ${input.aliases.filter((a) => a.vector !== null).length}`);
  console.log(`  aliases WITHOUT         ${input.aliases.filter((a) => a.vector === null).length}`);
  console.log(`  fixture        ${fixture.cases.length} cases — ${covered.length} replayable, ${skipped.length} SKIPPED (no cached query vector)`);
  if (skipped.length > 0) {
    console.log(`  skipped (${skipped.filter(isScoreable).length} of them scoreable/reviewed):`);
    for (const c of skipped) {
      // The status verbatim. `isScoreable` stood here and is true for `mechanical` too, so
      // every mechanical case printed as REVIEWED.
      console.log(`     ${c.case_id.padEnd(8)} ${reviewStatusOf(c).padEnd(14)} ${c.job_domain_id.padEnd(18)} ${JSON.stringify(c.query)}`);
    }
  }

  // ---- run every variant x path over identical inputs -------------------------------------
  const runs = new Map<string, ReplayCaseResult[]>();
  const provenances = new Map<CorpusVariant, ReturnType<typeof buildVariant>["provenance"]>();
  for (const variant of VARIANTS) {
    const { corpus, provenance } = buildVariant(input, variant);
    provenances.set(variant, provenance);
    for (const path of PATHS) {
      const rows = covered.map((c) =>
        replayCase(corpus, path, {
          caseId: c.case_id,
          query: queryCache.get(sha(c.query))!,
          jobDomainId: c.job_domain_id,
          legacyDomainId: LEGACY_ANCHOR_SKILL_DOMAIN,
          expectedSkillId: c.expected_skill_id,
          acceptableSkillIds: c.acceptable_skill_ids,
          forbiddenSkillIds: c.must_not_return_skill_ids,
          k,
          statuses,
          // Load-bearing: without it every `unembedded_shipped` case is scored in Recall/MRR,
          // which is what silently moved R@1 the first time all 127 queries had vectors.
          category: c.category,
        }),
      );
      runs.set(`${variant}|${path}`, rows);
    }
  }

  const get = (v: CorpusVariant, p: RetrievalPath) => runs.get(`${v}|${p}`)!;

  // ---- is the variant machinery still meaningful? -------------------------------------------
  //
  // `pre_merge` and `edges_repointed` are both defined relative to a MINTED successor — one that
  // holds no edges. Once R19 is repaired that successor has edges, `findMintedSkillIds` returns
  // nothing, and both variants silently degrade: `pre_merge` restores the predecessors to active
  // WITHOUT removing the successor (so it reports a hybrid state that never existed), and
  // `edges_repointed` has nothing left to move. Neither number means anything after the repair.
  //
  // Left unsaid, those two rows are exactly the kind of thing that gets quoted later. So the
  // run says so itself, loudly, instead of printing three rows that look equally trustworthy.
  const repaired = findMintedSkillIds(input).length === 0 && mergeFamilies(input).length > 0;
  if (repaired) {
    console.log(
      `\n  ⚠ NOTE: every merge successor now holds its own edges, so there is no MINTED skill.\n` +
        `    'pre_merge' and 'edges_repointed' are NO LONGER RECONSTRUCTIBLE from this corpus and\n` +
        `    their rows below are meaningless — ignore them. Compare 'as_applied' here against the\n` +
        `    committed PRE-repair artifact's 'edges_repointed' instead; they should match exactly.`,
    );
  }

  console.log(`\n=== corpus reconstruction (audit) ===`);
  for (const v of VARIANTS) {
    const p = provenances.get(v)!;
    console.log(`  ${v}`);
    console.log(`     minted skills detected : ${JSON.stringify(p.mintedSkillIds)}`);
    if (p.restoredSkillIds.length > 0) console.log(`     restored to active     : ${JSON.stringify(p.restoredSkillIds)}`);
    if (p.reassignedAliases.length > 0) console.log(`     aliases reassigned     : ${JSON.stringify(p.reassignedAliases)}`);
    if (p.repointedEdges.length > 0) console.log(`     edges repointed        : ${p.repointedEdges.length}`);
  }

  console.log(`\n=== summary — ${covered.length} cases, k=${k} ===`);
  // `scored` is printed beside R@1 on purpose. A recall figure whose denominator is invisible
  // is how 113 and 117 got compared as though they described the same set.
  console.log(
    `  ${"variant".padEnd(17)} ${"path".padEnd(18)} ${"resolved".padStart(8)} ${"unres".padStart(6)} ` +
      `${"scored".padStart(6)} ${"R@1".padStart(7)} ${"MRR".padStart(7)} ${"meanCand".padStart(9)} ${"cover".padStart(7)}`,
  );
  for (const v of VARIANTS) {
    for (const p of PATHS) {
      const s = summarizeReplay(get(v, p));
      console.log(
        `  ${v.padEnd(17)} ${p.padEnd(18)} ${String(s.resolved).padStart(8)} ${String(s.unresolved).padStart(6)} ` +
          `${String(s.scored).padStart(6)} ${s.recallAt1.toFixed(4).padStart(7)} ${s.mrr.toFixed(4).padStart(7)} ` +
          `${s.meanCandidates.toFixed(1).padStart(9)} ${`${s.coverageReached}/${s.coverageOnly}`.padStart(7)}`,
      );
    }
  }
  console.log(
    `  cover = coverage-only cases REACHED/TOTAL (category ${[...COVERAGE_ONLY_CATEGORIES].join(", ")}).\n` +
      `  They are excluded from scored/R@1/MRR: their expected skill is shipped-and-reused-only, so the\n` +
      `  case asks whether it is reachable at all, not whether it ranks first.`,
  );

  console.log(`\n=== path agreement on identical phrases (as_applied) ===`);
  const ag = summarizeAgreement(get("as_applied", "path_a_canonical"), get("as_applied", "path_b_legacy"));
  for (const [key2, val] of Object.entries(ag)) {
    console.log(`  ${key2.padEnd(18)} ${typeof val === "number" ? val.toFixed(4).replace(/\.0000$/, "") : val}`);
  }

  // ---- the TD-01 questions ----------------------------------------------------------------
  const tdImpact = get("as_applied", "path_a_canonical").map((after, i) =>
    diffCase(get("pre_merge", "path_a_canonical")[i]!, after),
  );
  const edgeGain = get("edges_repointed", "path_a_canonical").map((after, i) =>
    diffCase(get("as_applied", "path_a_canonical")[i]!, after),
  );
  const tally = (rows: readonly { delta: string }[]) =>
    rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.delta]: (m[r.delta] ?? 0) + 1 }), {});

  console.log(`\n=== TD-01/02/03 impact on Path A  (pre_merge -> as_applied) ===`);
  console.log(`  ${JSON.stringify(tally(tdImpact))}`);
  for (const d of tdImpact.filter((x) => x.delta !== "unchanged")) {
    console.log(
      `   ${d.delta.padEnd(20)} ${d.caseId.padEnd(8)} cand ${String(d.before.candidateCount).padStart(3)}->${String(d.after.candidateCount).padEnd(3)} ` +
        `top1 ${String(d.before.top1SkillId).padEnd(30)} -> ${d.after.top1SkillId}`,
    );
  }

  console.log(`\n=== counterfactual: TD-01's 14 edges repointed  (as_applied -> edges_repointed) ===`);
  console.log(`  ${JSON.stringify(tally(edgeGain))}`);
  for (const d of edgeGain.filter((x) => x.delta !== "unchanged")) {
    console.log(
      `   ${d.delta.padEnd(20)} ${d.caseId.padEnd(8)} cand ${String(d.before.candidateCount).padStart(3)}->${String(d.after.candidateCount).padEnd(3)} ` +
        `top1 ${String(d.before.top1SkillId).padEnd(30)} -> ${d.after.top1SkillId}`,
    );
  }

  // ---- drawing-reading reachability, stated directly ---------------------------------------
  console.log(`\n=== drawing-reading surface reachability ===`);
  const DR = ["skill_drawing_reading", "skill_gdt_reading", "skill_cad_interpretation"];
  for (const v of VARIANTS) {
    const { corpus } = buildVariant(input, v);
    const domains = [...new Set(fixture.cases.map((c) => c.job_domain_id))];
    let reachable = 0;
    const domainsWith = new Set<string>();
    for (const d of domains) {
      const hits = pathACandidates(corpus, d, statuses).filter((a) => DR.includes(a.skillId));
      if (hits.length > 0) {
        reachable += hits.length;
        domainsWith.add(d);
      }
    }
    console.log(
      `  ${v.padEnd(17)} reachable drawing-reading aliases across the ${domains.length} fixture domains: ` +
        `${reachable} (in ${domainsWith.size} domains)`,
    );
  }

  console.log(`\n=== per-domain candidate counts, Path A (as_applied vs pre_merge) ===`);
  const byDomain = new Map<string, { pre: number; app: number; rep: number; cases: number }>();
  for (let i = 0; i < covered.length; i++) {
    const d = covered[i]!.job_domain_id;
    const e = byDomain.get(d) ?? { pre: 0, app: 0, rep: 0, cases: 0 };
    e.pre = get("pre_merge", "path_a_canonical")[i]!.candidateCount;
    e.app = get("as_applied", "path_a_canonical")[i]!.candidateCount;
    e.rep = get("edges_repointed", "path_a_canonical")[i]!.candidateCount;
    e.cases += 1;
    byDomain.set(d, e);
  }
  const changed = [...byDomain.entries()].filter(([, e]) => e.pre !== e.app || e.app !== e.rep);
  console.log(`  domains in fixture: ${byDomain.size}; with a candidate-count change: ${changed.length}`);
  for (const [d, e] of changed.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`   ${d.padEnd(20)} cases=${String(e.cases).padStart(2)}  pre=${String(e.pre).padStart(3)}  applied=${String(e.app).padStart(3)}  repointed=${String(e.rep).padStart(3)}`);
  }

  // ---- TD-01 reachability probe -------------------------------------------------------------
  //
  // WHY A PROBE AND NOT FIXTURE CASES. The obvious way to make the merged skill observable is
  // to add fixture cases for it. That is impossible: `validateEvalFixture` rejects any case
  // whose expected skill is not wired to the queried domain —
  // `EXPECTED_SKILL_NOT_IN_SCOPE: ... unpassable by construction` — and `skill_drawing_reading`
  // has no edges. The instrument cannot be extended to observe the defect while the defect
  // exists, so the fixture-first ordering is circular. Verified, not assumed.
  //
  // This probe answers the same question through a different instrument. It asks each of the
  // merged skill's own alias texts, in each domain its predecessors are wired to, and reports
  // whether the surface is reachable at all.
  //
  // These are REACHABILITY probes, never ground truth. Every query is literally an alias of the
  // expected skill, so its correctness is tautological — the DC-18 lesson. They are excluded
  // from recall by construction (they are not in the fixture) and must stay that way. What they
  // measure is not "does retrieval rank well" but "can retrieval see this at all", which is
  // precisely the R19 question.
  //
  // The family is derived from `replacedBy` alone (`mergeFamilies`), NOT from the successor
  // being edgeless. Gating on edgelessness would switch this probe off the instant R19 is
  // repaired, so the very run that proves the repair worked would report nothing — and a probe
  // that vanishes on success cannot be told apart from a probe that never ran. The domain set
  // is likewise the UNION of the family's edges, so it stays the same 12 domains whether those
  // edges sit on the predecessors (before) or on the successor (after), keeping the before/after
  // comparison over an identical probe set.
  const probeResults: Record<string, unknown> = {};
  const families = mergeFamilies(input);
  // Only families whose successor was minted by the merge are the R19 shape worth probing; a
  // successor that pre-existed with its own edges (skill_quality_control, skill_turning) never
  // lost a surface. `successorHasEdges` is reported rather than used as a filter, because after
  // the repair it flips to true and the family must remain in the report.
  const R19_FAMILY_SUCCESSORS = new Set(["skill_drawing_reading"]);
  for (const fam of families.filter((f) => R19_FAMILY_SUCCESSORS.has(f.successor))) {
    const mintedId = fam.successor;
    const predecessors = [...fam.predecessors];
    const familyIds = [mintedId, ...predecessors];
    const probeDomains = [
      ...new Set(input.edges.filter((e) => familyIds.includes(e.skillId)).map((e) => e.jobDomainId)),
    ].sort();
    const probeTexts = input.aliases
      .filter((a) => a.skillId === mintedId && a.vector !== null)
      .map((a) => a.text);
    const family = new Set(familyIds);

    console.log(`\n=== TD-01 reachability probe (NOT ground truth, NOT counted in recall) ===`);
    console.log(`  merged skill   ${mintedId}  (holds its own edges: ${String(fam.successorHasEdges)})`);
    console.log(`  predecessors   ${JSON.stringify(predecessors)}`);
    console.log(`  probe domains  ${probeDomains.length} (union of the family's edges)`);
    console.log(`  probe texts    ${probeTexts.length} (the merged skill's embedded aliases)`);
    console.log(`  probes         ${probeDomains.length * probeTexts.length}`);
    console.log(`  ${"variant".padEnd(17)} ${"family reachable".padStart(16)} ${"family top-1".padStart(13)} ${"probes".padStart(7)}`);

    for (const variant of VARIANTS) {
      const { corpus } = buildVariant(input, variant);
      const r = probeFamilyReachability(corpus, {
        family: [...family],
        domains: probeDomains,
        vectorsByText: vectors,
        texts: probeTexts,
        k,
        statuses,
      });
      probeResults[variant] = r;
      console.log(
        `  ${variant.padEnd(17)} ${String(r.familyReachable).padStart(16)} ${String(r.familyTop1).padStart(13)} ${String(r.probes).padStart(7)}`,
      );
      if (r.winsInstead.length > 0) {
        console.log(
          `      wins instead: ${r.winsInstead.slice(0, 4).map((w) => `${w.skillId}×${w.count}`).join(", ")}`,
        );
      }
    }
  }

  if (reportPath !== undefined) {
    if (existsSync(reportPath)) {
      console.error(`\n[replay] refusing to overwrite ${reportPath} — evidence is never replaced.`);
      process.exit(1);
    }
    const report = {
      kind: "path-a-offline-replay",
      generated_for_corpus: "authoritative source files on main",
      embedding_model: EMBEDDING_MODEL,
      k,
      fixture: { id: fixture.manifest.fixture_id, version: fixture.manifest.version, cases: fixture.cases.length },
      replayed: covered.length,
      skipped: skipped.map((c) => ({ case_id: c.case_id, query: c.query, job_domain_id: c.job_domain_id, scoreable: isScoreable(c) })),
      corpus: {
        skills: input.skills.length,
        aliases: input.aliases.length,
        aliases_with_vector: input.aliases.filter((a) => a.vector !== null).length,
        edges: input.edges.length,
      },
      provenance: Object.fromEntries([...provenances].map(([v, p]) => [v, p])),
      summaries: Object.fromEntries(
        VARIANTS.flatMap((v) => PATHS.map((p) => [`${v}|${p}`, summarizeReplay(get(v, p))])),
      ),
      agreement_as_applied: ag,
      td01_reachability_probe: probeResults,
      td_impact: tally(tdImpact),
      edge_repoint_gain: tally(edgeGain),
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n[replay] report written to ${reportPath}`);
  }

  console.log(`\n[replay:path-a] done — nothing was written to any database, no provider was called.`);
}

// GUARDED: this module now exports `loadVectors` / `loadCorpusInput`, so importing either must
// not run the whole replay.
if (require.main === module) {
  main();
}
