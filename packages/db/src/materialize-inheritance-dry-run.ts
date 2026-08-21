/**
 * ISCO/NCO inheritance materializer — DRY RUN. Read-only by construction.
 *
 * ===========================================================================
 * WHY THERE IS NO `--apply`
 * ===========================================================================
 * This file contains NO write path at all: no INSERT, UPDATE, DELETE, UPSERT, no transaction
 * that could be committed by mistake. That is deliberate and is stronger than a dry-run flag
 * guarding a write branch — a flag can be mistyped, and a transaction can be committed by an
 * early return. Here the capability is simply absent, which `materialize-inheritance.test.ts`
 * asserts by reading this source.
 *
 * A future authorized execution mode belongs in a SEPARATE, guarded runner, the way
 * `decollide-skill-aliases.ts` is separate from `embed-skill-aliases.ts`.
 *
 * ===========================================================================
 * WHAT THE NUMBER MEANS — AND WHAT IT DOES NOT
 * ===========================================================================
 * `job_domain_skill` is authoring/corpus metadata. It is NOT read by the runtime match path
 * (`d1-runtime-path-trace.md`). A large fan-out here looks like a relevance win and is not
 * one, so `NO_RUNTIME_EFFECT_NOTICE` is printed with every report rather than left to the
 * reader's memory.
 *
 *   pnpm db:materialize:inheritance:dry-run [--json=<out>] [--limit=<n>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { hostClass } from "./ops-guard";
import {
  fanOut,
  NO_RUNTIME_EFFECT_NOTICE,
  planInheritance,
  verifyInvariants,
  type DomainNode,
  type ExistingEdge,
  type SkillRef,
} from "./isco-inheritance";

config({ path: "../../.env" });
config();

const SCRIPT = "materialize:inheritance:dry-run";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // Three SELECTs. Nothing else touches the database in this file.
    const domains = (await db.execute(dsql`
      SELECT job_domain_id, parent_job_domain_id, status, selectable, label_en
      FROM job_domain`)) as unknown as DomainNode[];
    const edges = (await db.execute(dsql`
      SELECT job_domain_id, skill_id, source, status, default_requirement, relevance, confidence
      FROM job_domain_skill`)) as unknown as ExistingEdge[];
    const skills = (await db.execute(dsql`
      SELECT skill_id, status FROM skill`)) as unknown as SkillRef[];

    const plan = planInheritance(domains, edges, skills);
    const fan = fanOut(plan);
    const inv = verifyInvariants(domains, edges, skills, plan);

    const authoredDomains = plan.roots.length;
    const reachable = plan.reachableDomains.length;

    console.log(`[${SCRIPT}] READ-ONLY. This file has no write path.`);
    console.log(`  target                     = ${hostClass(url)}`);
    console.log(`\n  === source ===`);
    console.log(`  job_domain rows            = ${domains.length}`);
    console.log(`  job_domain_skill rows      = ${edges.length}`);
    console.log(`  skill rows                 = ${skills.length}`);
    console.log(`  authored root domains      = ${authoredDomains}`);
    console.log(`  strict descendants reached = ${reachable}`);
    console.log(`  domains touched (roots+desc)= ${new Set([...plan.roots, ...plan.reachableDomains]).size}`);

    console.log(`\n  === proposals, by disposition ===`);
    for (const [k, v] of Object.entries(plan.counts)) {
      console.log(`  ${k.padEnd(26)} ${String(v).padStart(6)}`);
    }
    console.log(`  ${"—".repeat(33)}`);
    console.log(`  ${"total proposals".padEnd(26)} ${String(plan.proposals.length).padStart(6)}`);

    console.log(`\n  === what an authorized run would write ===`);
    console.log(`  new edges (CANDIDATE)      = ${plan.counts.CANDIDATE}`);
    console.log(`  domains gaining edges      = ${plan.domainsGainingEdges}`);
    console.log(`  …of which depend on a PROVISIONAL skill = ${plan.candidatesOnProvisionalSkills}`);
    console.log(`  duplicates (impossible)    = 0  — PK (job_domain_id, skill_id) forbids them`);

    // A single total invites "inheritance is broadly useful". The breakdown is what says whether
    // it is, so it is printed unconditionally rather than behind a flag nobody passes.
    console.log(`\n  === fan-out, per authored occupation ===`);
    console.log(`  authored roots             = ${fan.authoredRoots}`);
    console.log(`  …that reach any descendant = ${fan.rootsThatFanOut}  (the rest are childless leaves)`);
    console.log(`  unique target domains      = ${fan.uniqueTargetDomains}`);
    console.log(`  total fan-out edges        = ${fan.totalEdges}`);
    console.log(`  two largest roots produce  = ${(fan.topTwoRootShare * 100).toFixed(1)}% of all of it`);
    console.log(`  depth histogram            = ${JSON.stringify(fan.depthHistogram)}`);
    let cum = 0;
    for (const r of fan.byRoot) {
      cum += r.edges;
      const share = fan.totalEdges === 0 ? 0 : (100 * cum) / fan.totalEdges;
      console.log(
        `     ${r.root.padEnd(22)} edges ${String(r.edges).padStart(4)}  domains ${String(r.targets).padStart(3)}` +
          `  cumulative ${share.toFixed(1)}%`,
      );
    }

    console.log(`\n  === fan-out, per authored skill (${fan.bySkill.length} distinct) ===`);
    for (const s of fan.bySkill.slice(0, Number(arg("skills") ?? 15))) {
      console.log(`     ${s.skill_id.padEnd(48)} domains ${String(s.targets).padStart(3)}  [${s.skill_status}]`);
    }
    if (fan.bySkill.length > 15) console.log(`     (${fan.bySkill.length - 15} further skills not listed)`);

    // Re-derived from the same inputs rather than trusted from the plan. A run that broke its
    // own rule must say so here instead of printing a confident total above.
    console.log(`\n  === invariants, re-derived ===`);
    console.log(`  author -> strict descendant only   ${inv.downwardOnly ? "HOLDS" : "VIOLATED"}`);
    console.log(`  inherited edges are never roots    ${inv.inheritedNeverRoot ? "HOLDS" : "VIOLATED"}`);
    console.log(`  converges in one pass              ${inv.converged ? "HOLDS" : "VIOLATED"} (second pass proposes ${inv.secondPassCandidates})`);
    for (const v of inv.violations.slice(0, 20)) console.log(`     !! ${v}`);

    // A fail-closed count of zero is only evidence if the rule had something to look at.
    console.log(`\n  === what each fail-closed rule was searching ===`);
    for (const [k, v] of Object.entries(inv.population)) {
      console.log(`  ${k.padEnd(42)} ${String(v).padStart(6)}`);
    }

    if (plan.cycles.length > 0) {
      console.log(`\n  !! CYCLES IN THE DOMAIN TREE (${plan.cycles.length}) — walk stopped early:`);
      for (const c of plan.cycles.slice(0, 10)) console.log(`     ${c}`);
    }

    const blocked = plan.proposals.filter(
      (p) => p.disposition === "AMBIGUOUS" || p.disposition === "UNRESOLVABLE",
    );
    if (blocked.length > 0) {
      console.log(`\n  === FAIL-CLOSED: not written, and not guessed (${blocked.length}) ===`);
      for (const p of blocked.slice(0, 20)) {
        console.log(`     ${p.disposition.padEnd(14)} ${p.job_domain_id} / ${p.skill_id} — ${p.reason}`);
      }
    }

    const limit = Number(arg("limit") ?? 15);
    const sample = plan.proposals.filter((p) => p.disposition === "CANDIDATE").slice(0, limit);
    if (sample.length > 0) {
      console.log(`\n  === sample candidates (auditable without reading the code) ===`);
      for (const p of sample) {
        console.log(
          `     ${p.job_domain_id} <- ${p.skill_id}  [from ${p.inherited_from} depth ${p.depth}, ` +
            `${p.default_requirement}, rel ${p.relevance}, skill ${p.skill_status}]`,
        );
      }
    }

    console.log(`\n  ${NO_RUNTIME_EFFECT_NOTICE}`);
    console.log(`\n  NOTHING WAS WRITTEN. An authorized apply lives in a separate guarded runner.`);

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "inheritance-dry-run",
            target: hostClass(url),
            source: { domains: domains.length, edges: edges.length, skills: skills.length },
            roots: plan.roots,
            // Was `reachable_domains`, holding a COUNT. A field named like a list and holding a
            // number is a reader trap — it read as 64 domain ids to anyone consuming the file.
            reachable_domain_count: reachable,
            reachable_domains: plan.reachableDomains,
            counts: plan.counts,
            candidates_on_provisional_skills: plan.candidatesOnProvisionalSkills,
            domains_gaining_edges: plan.domainsGainingEdges,
            fan_out: fan,
            invariants: inv,
            cycles: plan.cycles,
            proposals: plan.proposals,
            notice: NO_RUNTIME_EFFECT_NOTICE,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`  report written to ${out}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
