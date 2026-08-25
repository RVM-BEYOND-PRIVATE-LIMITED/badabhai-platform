/**
 * P1-B — the Stage B form of the Path B parity invariant.
 *
 * ===========================================================================
 * WHY P1 NEEDED A STAGE-B FORM, AND WHY THIS IS NOT A WEAKENING
 * ===========================================================================
 * P1 says Path B's candidate set must be BYTE-IDENTICAL before and after a stage, and for
 * Stages C–G that is exactly right — their contract is "no behaviour change", so any drift is
 * a defect. `verify-path-b-parity.ts` is UNCHANGED and still enforces that.
 *
 * Stage B's contract is the opposite: its declared purpose is to add corpus rows. Byte-identity
 * is unsatisfiable there by construction, so P1 could only ever report Stage B as a failure —
 * and a check that must fail tells you nothing about whether the stage went well.
 *
 * P1-B replaces equality with FOUR rules that are, in aggregate, harder to satisfy than a
 * digest compare, because each one has to be argued in a committed file rather than merely
 * observed:
 *
 *   R1  NO UNENUMERATED REMOVAL OR MUTATION. Every baseline row must still be present with an
 *       identical (skill_id, text, embedding_model) tuple, UNLESS it is listed in `removed[]`
 *       with a reviewer and a reason. Proven by recomputing the baseline digest over the
 *       current rows minus the declared delta — if the file understates what moved, the digest
 *       does not reproduce and the check fails.
 *   R2  GROWTH BY ENUMERATION, NOT BY COUNT. Every added row is listed in `added[]`, and every
 *       listed row must actually exist. R1's arithmetic makes the two sets exact: remainder =
 *       current − added + removed, so an unlisted addition breaks the digest.
 *   R3  NO UNREVIEWED NEW SKILL IN A SLUG. Adding aliases to a skill already in the set changes
 *       that skill's recall. Adding a SKILL changes what the slug can return at all, so it
 *       needs a named reviewer.
 *   R4  NO CROSS-SKILL ALIAS COLLISION INSIDE A SLUG. Two skills sharing an alias text in one
 *       domain spend two `LIMIT k` slots on one concept and displace a third skill. Computed
 *       from the live corpus, so it cannot be argued away in a file.
 *
 * R4 is the rule that caught the real defect in the 2026-08-21 run — `skill_drawing_reading`
 * duplicating `skill_gdt_reading` — which a digest compare reported only as "8 slugs drifted".
 *
 * READ-ONLY. No write path.
 *
 *   pnpm db:verify:stage-b --against=<baseline.json> --delta=<delta.json>
 */
import { existsSync, readFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { hostClass } from "./ops-guard";
import { slugDigest, type ParityBaseline } from "./verify-path-b-parity";

config({ path: "../../.env" });
config();

const SCRIPT = "verify:stage-b";

/** One candidate row, in the shape the digest is taken over. */
export interface CandidateRow {
  readonly domain_id: string;
  readonly skill_id: string;
  readonly text: string;
  readonly embedding_model: string | null;
}

export interface NewSkillRecord {
  readonly skill_id: string;
  readonly domain_id: string;
  readonly reviewed_by: string;
  readonly note: string;
}

export interface RemovedRecord extends CandidateRow {
  readonly reviewed_by: string;
  readonly reason: string;
}

/** The stage's declared delta — what it claims it did, in a file a reviewer can read. */
export interface StageBDelta {
  readonly kind: "stage-b-delta";
  readonly stage: string;
  readonly added: readonly CandidateRow[];
  readonly removed: readonly RemovedRecord[];
  readonly new_skills: readonly NewSkillRecord[];
}

const key = (r: CandidateRow): string =>
  `${r.domain_id}\u001f${r.skill_id}\u001f${r.text}\u001f${r.embedding_model ?? ""}`;

export interface RuleResult {
  readonly rule: "R1" | "R2" | "R3" | "R4";
  readonly title: string;
  readonly pass: boolean;
  readonly detail: readonly string[];
}

/**
 * R1 + R2 together: subtract the declared delta from the live rows and check the remainder
 * reproduces the committed baseline, slug by slug.
 *
 * Pure, so the whole invariant is testable without a database.
 */
export function checkReconstruction(
  baseline: ParityBaseline,
  current: readonly CandidateRow[],
  delta: StageBDelta,
): { r1: RuleResult; r2: RuleResult } {
  const currentKeys = new Set(current.map(key));
  const addedKeys = new Set(delta.added.map(key));

  // R2 first: a phantom addition (declared but absent) means the file describes a different
  // run than the one that happened, and every later conclusion drawn from it is unfounded.
  const phantom = delta.added.filter((r) => !currentKeys.has(key(r)));
  const phantomRemoved = delta.removed.filter((r) => currentKeys.has(key(r)));
  const r2Detail: string[] = [];
  for (const r of phantom) r2Detail.push(`declared added but NOT present: ${r.domain_id}/${r.skill_id}/${r.text}`);
  for (const r of phantomRemoved) r2Detail.push(`declared removed but STILL present: ${r.domain_id}/${r.skill_id}/${r.text}`);
  if (r2Detail.length === 0) {
    r2Detail.push(`${delta.added.length} addition(s) and ${delta.removed.length} removal(s) all verified against the live corpus`);
  }
  const r2: RuleResult = {
    rule: "R2",
    title: "growth by enumeration — every declared row exists, every existing row is declared",
    pass: r2Detail.length === 1 && phantom.length === 0 && phantomRemoved.length === 0,
    detail: r2Detail,
  };

  // R1: remainder = (current − added) + removed. If the delta is complete and honest, that set
  // IS the baseline, and its digests reproduce byte for byte.
  const remainder: CandidateRow[] = current.filter((r) => !addedKeys.has(key(r)));
  for (const r of delta.removed) remainder.push({ domain_id: r.domain_id, skill_id: r.skill_id, text: r.text, embedding_model: r.embedding_model });

  const bySlug = new Map<string, CandidateRow[]>();
  for (const r of remainder) bySlug.set(r.domain_id, [...(bySlug.get(r.domain_id) ?? []), r]);

  const r1Detail: string[] = [];
  let r1Pass = true;
  for (const b of baseline.slugs) {
    const rs = bySlug.get(b.domainId) ?? [];
    const d = slugDigest(rs);
    const ok = d === b.digest && rs.length === b.candidates;
    if (!ok) r1Pass = false;
    r1Detail.push(
      `  ${b.domainId.padEnd(22)} baseline=${String(b.candidates).padStart(3)} reconstructed=${String(rs.length).padStart(3)}  ${ok ? "MATCH" : `MISMATCH ${d.slice(0, 12)}… vs ${b.digest.slice(0, 12)}…`}`,
    );
  }
  for (const [id] of bySlug) {
    if (!baseline.slugs.some((s) => s.domainId === id)) {
      r1Pass = false;
      r1Detail.push(`  UNEXPECTED SLUG in reconstruction: ${id}`);
    }
  }
  return {
    r1: {
      rule: "R1",
      title: "no unenumerated removal or mutation — the baseline reconstructs exactly",
      pass: r1Pass,
      detail: r1Detail,
    },
    r2,
  };
}

/** R3: a skill that was not reachable in the slug before needs a named reviewer. */
export function checkNewSkills(
  baseline: ParityBaseline,
  current: readonly CandidateRow[],
  delta: StageBDelta,
  baselineSkillsBySlug: ReadonlyMap<string, ReadonlySet<string>>,
): RuleResult {
  const detail: string[] = [];
  let pass = true;
  const declared = new Map(delta.new_skills.map((s) => [`${s.domain_id}\u001f${s.skill_id}`, s]));
  const seen = new Set<string>();
  for (const r of current) {
    const k = `${r.domain_id}\u001f${r.skill_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (baselineSkillsBySlug.get(r.domain_id)?.has(r.skill_id) === true) continue;
    const rec = declared.get(k);
    if (rec === undefined) {
      pass = false;
      detail.push(`  UNREVIEWED new skill in slug: ${r.domain_id} / ${r.skill_id}`);
    } else if (rec.reviewed_by.trim() === "") {
      pass = false;
      detail.push(`  new skill ${r.domain_id} / ${r.skill_id} declared with an empty reviewed_by`);
    } else {
      detail.push(`  reviewed new skill: ${r.domain_id} / ${r.skill_id} — ${rec.reviewed_by}`);
    }
  }
  if (detail.length === 0) detail.push("  no new skill entered any slug");
  void baseline;
  return { rule: "R3", title: "no unreviewed new skill in a slug", pass, detail };
}

/** R4: two skills must never share an alias text inside one slug. */
export function checkCollisions(current: readonly CandidateRow[]): RuleResult {
  const byText = new Map<string, Set<string>>();
  for (const r of current) {
    const k = `${r.domain_id}\u001f${r.text.toLowerCase()}`;
    byText.set(k, (byText.get(k) ?? new Set()).add(r.skill_id));
  }
  const detail: string[] = [];
  for (const [k, skills] of byText) {
    if (skills.size > 1) {
      const [slug, text] = k.split("\u001f");
      detail.push(`  COLLISION ${slug} ${JSON.stringify(text)} -> ${[...skills].sort().join(", ")}`);
    }
  }
  const pass = detail.length === 0;
  if (pass) detail.push(`  no cross-skill alias collisions across ${byText.size} distinct (slug, text) pairs`);
  return { rule: "R4", title: "no cross-skill alias collision inside a slug", pass, detail };
}

async function main(): Promise<void> {
  const arg = (n: string): string | undefined => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a?.slice(n.length + 3);
  };
  const againstPath = arg("against");
  const deltaPath = arg("delta");
  if (againstPath === undefined || deltaPath === undefined) {
    throw new Error(`[${SCRIPT}] usage: --against=<baseline.json> --delta=<delta.json>`);
  }
  for (const p of [againstPath, deltaPath]) {
    if (!existsSync(p)) throw new Error(`[${SCRIPT}] file not found: ${p}`);
  }
  const baseline = JSON.parse(readFileSync(againstPath, "utf8")) as ParityBaseline;
  const delta = JSON.parse(readFileSync(deltaPath, "utf8")) as StageBDelta;
  if (delta.kind !== "stage-b-delta") throw new Error(`[${SCRIPT}] --delta is not a stage-b-delta file`);

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const current = (await db.execute(
      dsql`SELECT sa.domain_id, sa.skill_id, sa.text, sa.embedding_model
           FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
           WHERE s.status = 'active' AND sa.embedding IS NOT NULL AND sa.domain_id IS NOT NULL`,
    )) as unknown as CandidateRow[];

    // The baseline stores digests, not rows, so "which skills were in the slug before" is
    // reconstructed the same way R1 reconstructs the rows: current minus the declared delta.
    const addedKeys = new Set(delta.added.map(key));
    const baselineSkills = new Map<string, Set<string>>();
    for (const r of current) {
      if (addedKeys.has(key(r))) continue;
      baselineSkills.set(r.domain_id, (baselineSkills.get(r.domain_id) ?? new Set()).add(r.skill_id));
    }
    for (const r of delta.removed) {
      baselineSkills.set(r.domain_id, (baselineSkills.get(r.domain_id) ?? new Set()).add(r.skill_id));
    }

    console.log(`[${SCRIPT}] READ-ONLY — P1-B, the Stage B form of P1.`);
    console.log(`  target                   = ${hostClass(url)}`);
    console.log(`  baseline                 = ${againstPath}`);
    console.log(`  delta                    = ${deltaPath} (stage ${delta.stage})`);
    console.log(`  live Path B candidates   = ${current.length}`);
    console.log(`  declared added / removed = ${delta.added.length} / ${delta.removed.length}`);

    const { r1, r2 } = checkReconstruction(baseline, current, delta);
    const r3 = checkNewSkills(baseline, current, delta, baselineSkills);
    const r4 = checkCollisions(current);

    let allPass = true;
    for (const r of [r1, r2, r3, r4]) {
      if (!r.pass) allPass = false;
      console.log(`\n  ${r.rule} ${r.pass ? "PASS" : "FAIL"} — ${r.title}`);
      for (const d of r.detail) console.log(d.startsWith("  ") ? d : `    ${d}`);
    }

    console.log(`\n  === P1-B ===`);
    if (allPass) {
      console.log(`  PASS — Stage B's effect on Path B is fully enumerated, reviewed and collision-free.`);
      return;
    }
    console.log(`  FAIL — see the failing rule(s) above. P1-B is not satisfied by re-baselining;`);
    console.log(`  it is satisfied by fixing the corpus or by enumerating and reviewing the delta.`);
    process.exitCode = 1;
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
