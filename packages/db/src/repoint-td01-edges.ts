/**
 * Re-point a merge's orphaned `job_domain_skill` edges onto the skill that replaced them.
 *
 * ===========================================================================
 * WHAT THIS FIXES (R19)
 * ===========================================================================
 * TD-01 merged `skill_gdt_reading` + `skill_cad_interpretation` into a new
 * `skill_drawing_reading` and left both predecessors' edges where they were. The predecessors
 * then went `deprecated`, and `canonicalAliasRows` gates on BOTH `s.status = 'active'` AND the
 * `job_domain_skill` join — so the edges point at skills retrieval refuses, and the skill
 * retrieval accepts has no edges. The whole drawing-reading alias surface became unreachable.
 *
 * Measured, not assumed: across 96 diagnostic probes the surface went 96/96 reachable to 0/96,
 * and in 88 of those the top-1 became a confidently WRONG, unrelated skill rather than an empty
 * result. Re-pointing restores 96/96. See `data/taxonomy/replay/`.
 *
 * ===========================================================================
 * THE COLLISION THIS EXISTS TO HANDLE
 * ===========================================================================
 * 14 edges do NOT become 14 edges. Two domains (`jd_nco_7223_6003`, `jd_nco_7224_0102`) are
 * wired to BOTH predecessors, so a naive rewrite would emit the same `(job_domain_id, skill_id)`
 * pair twice — which `validateTaxonomyCorpus` rejects as `EDGE_DUPLICATE`. 14 in, 12 out.
 *
 * The two survivors are chosen by STRENGTH, never by file order: `required` beats `preferred`,
 * then higher relevance, then higher confidence. Taking the weaker of a colliding pair would
 * silently downgrade a domain's requirement from `required` to `preferred` — a real change to
 * what the platform asks of a worker, hidden inside what looks like a mechanical re-point.
 *
 * ===========================================================================
 * SCOPE, AND HOW IT IS ENFORCED RATHER THAN PROMISED
 * ===========================================================================
 * Nothing is hardcoded to TD-01. The target set is DERIVED: a skill is in scope only if it is
 * `deprecated`, names a `replacedBy` successor, and that successor holds no edges of its own
 * (i.e. it was minted by the merge and is the R19 shape). Any edge whose skill fails that test
 * is passed through untouched, and the runner asserts the derived set matches `--expect=<n>`
 * before writing anything.
 *
 * Every other line of the file — comments, ordering, unrelated edges, whitespace — is copied
 * byte-for-byte. This is a corpus-file change only: no database, no provider, no flag.
 *
 * Usage:
 *   pnpm db:repoint:td01-edges                                   # dry run + manifest preview
 *   pnpm db:repoint:td01-edges --apply --expect=14 --manifest=<json>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_CORPUS } from "@badabhai/taxonomy";
import { argFlag, argValue } from "./match-v1-cli";

const FILE = join(__dirname, "..", "data", "taxonomy", "domain-skills.jsonl");

interface Edge {
  kind: "domain_skill";
  job_domain_id: string;
  skill_id: string;
  default_requirement: "required" | "preferred";
  relevance: number;
  confidence: number | null;
  source: string;
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** `required` beats `preferred`, then relevance, then confidence. Deterministic, total. */
function stronger(a: Edge, b: Edge): Edge {
  if (a.default_requirement !== b.default_requirement) {
    return a.default_requirement === "required" ? a : b;
  }
  if (a.relevance !== b.relevance) return a.relevance > b.relevance ? a : b;
  return (a.confidence ?? 0) >= (b.confidence ?? 0) ? a : b;
}

function main(): void {
  const apply = argFlag("apply");
  const expect = argValue("expect");
  const manifestPath = argValue("manifest");

  const raw = readFileSync(FILE, "utf8");
  const lines = raw.split(/\r?\n/);

  // ---- derive the in-scope set from the corpus itself ---------------------------------------
  const edgeSkillIds = new Set<string>();
  for (const l of lines) {
    if (l.length === 0 || l.startsWith("#")) continue;
    const o = JSON.parse(l) as { kind?: string; skill_id?: string };
    if (o.kind === "domain_skill" && o.skill_id !== undefined) edgeSkillIds.add(o.skill_id);
  }
  const successorOf = new Map<string, string>();
  for (const s of SKILL_CORPUS) {
    if (s.status !== "deprecated" || s.replacedBy === undefined) continue;
    // Only a successor that was MINTED by the merge — one holding no edges of its own — is the
    // R19 shape. A successor that already has edges never lost anything and is left alone.
    if (edgeSkillIds.has(s.replacedBy)) continue;
    successorOf.set(s.skillId, s.replacedBy);
  }

  console.log("[repoint:td01-edges] corpus-file change only — no database, no provider, no flag.");
  console.log(`  in-scope predecessors -> successor:`);
  for (const [from, to] of successorOf) console.log(`     ${from.padEnd(30)} -> ${to}`);
  if (successorOf.size === 0) {
    console.log("  nothing in scope. No merge has left an orphaned successor.");
    return;
  }

  // ---- plan ---------------------------------------------------------------------------------
  const sourceEdges: { line: number; edge: Edge }[] = [];
  lines.forEach((l, i) => {
    if (l.length === 0 || l.startsWith("#")) return;
    const o = JSON.parse(l) as Edge;
    if (o.kind === "domain_skill" && successorOf.has(o.skill_id)) sourceEdges.push({ line: i + 1, edge: o });
  });

  // Group by (domain, successor) to find collisions.
  const byTarget = new Map<string, { line: number; edge: Edge }[]>();
  for (const e of sourceEdges) {
    const key = `${e.edge.job_domain_id}|${successorOf.get(e.edge.skill_id)!}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), e]);
  }

  const keep = new Set<number>();
  const absorb: { line: number; edge: Edge; losesTo: number }[] = [];
  for (const group of byTarget.values()) {
    const winner = group.reduce((best, cur) => (stronger(best.edge, cur.edge) === best.edge ? best : cur));
    keep.add(winner.line);
    for (const g of group) if (g.line !== winner.line) absorb.push({ ...g, losesTo: winner.line });
  }

  console.log(`\n  source edges         ${sourceEdges.length}`);
  console.log(`  distinct targets     ${byTarget.size}`);
  console.log(`  re-pointed           ${keep.size}`);
  console.log(`  absorbed (duplicate) ${absorb.length}`);
  console.log(`\n  ${"line".padStart(5)}  ${"job_domain_id".padEnd(18)} ${"from".padEnd(26)} -> to / disposition`);
  for (const { line, edge } of sourceEdges) {
    const to = successorOf.get(edge.skill_id)!;
    const lost = absorb.find((a) => a.line === line);
    const note = lost === undefined
      ? `${to}  [${edge.default_requirement}/${edge.relevance}/${edge.confidence ?? "null"}]`
      : `ABSORBED into line ${lost.losesTo} (weaker: ${edge.default_requirement}/${edge.relevance})`;
    console.log(`  ${String(line).padStart(5)}  ${edge.job_domain_id.padEnd(18)} ${edge.skill_id.padEnd(26)} -> ${note}`);
  }

  // ---- scope assertions -----------------------------------------------------------------------
  const touchedSkills = new Set(sourceEdges.map((e) => e.edge.skill_id));
  const touchedDomains = new Set(sourceEdges.map((e) => e.edge.job_domain_id));
  console.log(`\n  skills touched  ${JSON.stringify([...touchedSkills].sort())}`);
  console.log(`  domains touched ${touchedDomains.size}`);
  for (const s of touchedSkills) {
    if (!successorOf.has(s)) throw new Error(`[repoint] out-of-scope skill in plan: ${s}`);
  }
  if (expect !== undefined && sourceEdges.length !== Number(expect)) {
    console.error(
      `\n  ABORT — --expect=${expect} but the plan covers ${sourceEdges.length} edges. ` +
        `Nothing was written. Reconcile the expectation with the corpus before applying.`,
    );
    process.exit(1);
  }

  // ---- rewrite ----------------------------------------------------------------------------------
  // Every untouched line is copied verbatim, so comments, ordering and unrelated edges are
  // byte-identical afterwards.
  const absorbed = new Set(absorb.map((a) => a.line));
  const out: string[] = [];
  const after: Edge[] = [];
  lines.forEach((l, i) => {
    const n = i + 1;
    if (absorbed.has(n)) return;
    const src = sourceEdges.find((e) => e.line === n);
    if (src === undefined) {
      out.push(l);
      return;
    }
    const next: Edge = { ...src.edge, skill_id: successorOf.get(src.edge.skill_id)! };
    after.push(next);
    out.push(JSON.stringify(next));
  });
  const nextRaw = out.join("\n");

  const manifest = {
    kind: "td01-edge-repoint-manifest",
    reason: "R19 — the merged skill held no edges while its deprecated predecessors held all of them",
    file: "packages/db/data/taxonomy/domain-skills.jsonl",
    successor_map: Object.fromEntries(successorOf),
    counts: {
      source_edges: sourceEdges.length,
      repointed: keep.size,
      absorbed_duplicates: absorb.length,
      distinct_domains: touchedDomains.size,
    },
    before: sourceEdges.map((e) => ({ line: e.line, ...e.edge })),
    after: after.map((e) => ({ ...e })),
    absorbed: absorb.map((a) => ({ line: a.line, ...a.edge, absorbed_into_line: a.losesTo })),
    sha256_before: sha(raw),
    sha256_after: sha(nextRaw),
  };

  if (manifestPath !== undefined) {
    if (existsSync(manifestPath)) {
      console.error(`\n  refusing to overwrite ${manifestPath} — evidence is never replaced.`);
      process.exit(1);
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`\n  manifest written to ${manifestPath}`);
  }
  console.log(`\n  sha256 before ${manifest.sha256_before}`);
  console.log(`  sha256 after  ${manifest.sha256_after}`);

  if (!apply) {
    console.log("\n  DRY RUN — nothing was written. Re-run with --apply to rewrite the corpus file.");
    return;
  }
  writeFileSync(FILE, nextRaw, "utf8");
  console.log(`\n  APPLIED — ${keep.size} edges re-pointed, ${absorb.length} absorbed. Verify with db:verify:taxonomy.`);
}

main();
