/**
 * Reviewer pack for the UNCOVERED skills — everything a domain reviewer needs, and nothing
 * they would have to take on trust.
 *
 *   pnpm db:review-pack:fixture --run [--status active] [--out <dir>]
 *
 * ===========================================================================
 * THE PROBLEM THIS EXISTS FOR
 * ===========================================================================
 * Gate B embedded 98 aliases for the shipped catalogue, and the fixture exercises 4 of the 30
 * active skills reachable through an active edge. The other 26 are dark: no query in the
 * dataset has ever asked for them, so "Recall@1 99.1%" says nothing whatsoever about whether
 * a worker asking for bench fitting or GD&T reading gets the right skill.
 *
 * Closing that gap needs paraphrase cases, and paraphrase cases need ground truth.
 *
 * ===========================================================================
 * WHY THIS TOOL DOES NOT WRITE THE PARAPHRASES
 * ===========================================================================
 * It could. It would be easy, the output would look plausible, and the resulting number would
 * be worthless — because the same process would have chosen both the question and the answer.
 * DC-18 is the standing example in this repo: a case that read as a model failure for two
 * phases and turned out to be a fixture opinion, and it took a corpus check to tell the
 * difference. Manufacturing 50 more paraphrases would manufacture 50 more of those, with no
 * way to tell which.
 *
 * So the pack contains exactly two kinds of case:
 *
 *   `mechanical`     the query IS an existing alias. Correctness is tautological, no review is
 *                    needed, and its evidential value is close to zero — the run already warns
 *                    that 44.7% of queries are exact-alias hits. Generated here only so a
 *                    reviewer can see the skill is reachable at all before judging harder cases.
 *   `pending_review` a SLOT. The query field is empty and the reviewer writes it. The pack
 *                    supplies the context needed to write a good one: the skill's real aliases,
 *                    its domains, and the skills nearest to it in the vector space that a
 *                    careless phrasing would hit instead.
 *
 * Nothing in either kind is scored until a human sets `review_status: "reviewed"`.
 *
 * ===========================================================================
 * NO PROVIDER CALLS
 * ===========================================================================
 * The competing-skills section is computed with pgvector over embeddings already stored in
 * `skill_alias`. Nothing is embedded, nothing is written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";

import { createDbClient } from "./client";
import { DEFAULT_FIXTURE, PRE_PROMOTION_SKILL_STATUSES, evalArg } from "./taxonomy-retrieval-eval";
import { loadEvalFixture } from "./taxonomy-eval-fixture";

config({ path: "../../.env" });

const SCRIPT = "review-pack:fixture";

/** How many nearest other skills to show per uncovered skill. */
export const COMPETITORS_SHOWN = 4;
/** How many paraphrase slots to open per skill. */
export const PARAPHRASE_SLOTS = 2;

export interface CompetitorRef {
  skill_id: string;
  label: string | null;
  alias: string;
  similarity: number;
}

export interface ReviewEntry {
  skill_id: string;
  label_en: string | null;
  label_hi: string | null;
  status: string;
  domains: string[];
  existing_aliases: { text: string; lang: string | null }[];
  /** Nearest OTHER skills in a shared domain — what a careless phrasing would hit instead. */
  competing_skills: CompetitorRef[];
  proposed_cases: ProposedCase[];
  evidence_needed: string[];
}

export interface ProposedCase {
  case_id: string;
  query: string;
  lang: "en" | "hi";
  category: string;
  job_domain_id: string;
  expected_skill_id: string;
  provenance: string;
  review_status: "mechanical" | "pending_review";
  notes?: string;
}

/**
 * What the reviewer has to establish for this specific skill.
 *
 * Generated per skill rather than printed once as a preamble: the interesting question differs
 * by skill, and a checklist that is identical for all 26 gets read once and skipped.
 */
export function evidenceNeeded(e: Omit<ReviewEntry, "evidence_needed" | "proposed_cases">): string[] {
  const out: string[] = [
    `Confirm "${e.label_en ?? e.skill_id}" is the phrase a worker or supervisor would actually use. ` +
      "If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.",
  ];
  if (e.existing_aliases.length <= 2) {
    out.push(
      `Only ${e.existing_aliases.length} alias(es) exist. Decide whether that is genuinely the ` +
        "whole vocabulary for this skill, or whether the paraphrase case is about to measure a " +
        "gap in the corpus rather than a gap in retrieval.",
    );
  }
  if (!e.existing_aliases.some((a) => a.lang === "hi")) {
    out.push(
      "No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that " +
        "the English term is what is actually spoken.",
    );
  }
  for (const c of e.competing_skills.slice(0, 2)) {
    out.push(
      `Is "${c.alias}" (${c.skill_id}, cosine ${c.similarity.toFixed(4)}) a DIFFERENT skill or the ` +
        "same work under another name? If the same, this is a taxonomy merge, not an eval case. " +
        "If different, say what distinguishes them so the paraphrase can be written to separate them.",
    );
  }
  if (e.domains.length > 1) {
    out.push(
      `Reachable in ${e.domains.length} domains (${e.domains.join(", ")}). Confirm the skill means ` +
        "the same thing in each; if not, it needs one case per domain.",
    );
  }
  return out;
}

/** Mechanically valid cases: the query IS an alias, so the answer cannot be wrong. */
export function mechanicalCases(e: Omit<ReviewEntry, "evidence_needed" | "proposed_cases">): ProposedCase[] {
  const domain = e.domains[0];
  if (domain === undefined) return [];
  return e.existing_aliases.slice(0, 2).map((a, i) => {
    const lang = a.lang === "hi" ? "hi" : "en";
    return {
      case_id: `MX-${e.skill_id.replace(/^skill_/, "").slice(0, 18)}-${i + 1}`,
      query: a.text,
      lang,
      category: lang === "hi" ? "devanagari_alias" : "exact_alias",
      job_domain_id: domain,
      expected_skill_id: e.skill_id,
      provenance: `corpus_alias:${e.skill_id}/${lang}`,
      review_status: "mechanical" as const,
      notes:
        "Generated: the query is this skill's own alias. Tautologically correct and therefore " +
        "weak evidence — it proves reachability, not retrieval quality.",
    };
  });
}

/** Empty slots. The query is deliberately blank — a reviewer writes it. */
export function paraphraseSlots(
  e: Omit<ReviewEntry, "evidence_needed" | "proposed_cases">,
  slots = PARAPHRASE_SLOTS,
): ProposedCase[] {
  const domain = e.domains[0];
  if (domain === undefined) return [];
  return Array.from({ length: slots }, (_, i) => ({
    case_id: `PR-${e.skill_id.replace(/^skill_/, "").slice(0, 18)}-${i + 1}`,
    query: "",
    lang: (i === 0 ? "en" : "hi") as "en" | "hi",
    category: i === 0 ? "paraphrase_latin" : "devanagari_paraphrase",
    job_domain_id: domain,
    expected_skill_id: e.skill_id,
    provenance: "pending_reviewer_authorship",
    review_status: "pending_review" as const,
    notes:
      "SLOT — write how a worker would describe this WITHOUT using an existing alias verbatim, " +
      "then set review_status to \"reviewed\". Left blank on purpose: a paraphrase written by the " +
      "same process that scores it measures nothing.",
  }));
}

function markdown(entries: readonly ReviewEntry[]): string {
  const L: string[] = [
    "# Fixture review pack — uncovered active skills",
    "",
    `${entries.length} skills reachable through an active edge that **no fixture case has ever asked for**.`,
    "Recall figures reported today say nothing about any of them.",
    "",
    "## How to use this",
    "",
    '1. Read the skill, its real aliases, and the skills nearest to it in the vector space.',
    "2. Answer the evidence questions — several will turn out to be taxonomy problems, not eval gaps.",
    "3. Fill each empty **slot** with a phrase a worker would actually say, avoiding the existing",
    "   aliases verbatim, and set `review_status` to `reviewed`.",
    "4. Leave anything you are unsure about as `pending_review`. It stays out of every metric.",
    "",
    "`mechanical` cases need no review. They are also nearly worthless as evidence — the query is",
    "the skill's own alias, so it cannot be wrong. They are here to show reachability only.",
    "",
    "---",
    "",
  ];
  for (const e of entries) {
    L.push(`## ${e.label_en ?? e.skill_id}`, "");
    L.push(`- **skill_id**: \`${e.skill_id}\`  ·  **status**: ${e.status}`);
    if (e.label_hi !== null && e.label_hi !== "") L.push(`- **label_hi**: ${e.label_hi}`);
    L.push(`- **domains**: ${e.domains.map((d) => `\`${d}\``).join(", ")}`);
    L.push(
      `- **existing aliases (${e.existing_aliases.length})**: ` +
        (e.existing_aliases.length === 0
          ? "_none_"
          : e.existing_aliases.map((a) => `\`${a.text}\`${a.lang === "hi" ? " (hi)" : ""}`).join(", ")),
    );
    L.push("");
    if (e.competing_skills.length > 0) {
      L.push("**Nearest other skills in a shared domain** — what a careless phrasing would hit:", "");
      L.push("| cosine | skill | via alias |", "|---|---|---|");
      for (const c of e.competing_skills) {
        L.push(`| ${c.similarity.toFixed(4)} | \`${c.skill_id}\` | ${c.alias} |`);
      }
      L.push("");
    }
    L.push("**Evidence needed from you**", "");
    for (const q of e.evidence_needed) L.push(`- [ ] ${q}`);
    L.push("");
    L.push("**Proposed cases**", "");
    for (const c of e.proposed_cases) {
      L.push(
        `- \`${c.case_id}\` · ${c.review_status} · ${c.category} · ` +
          (c.query === "" ? "**query: _______________________ (write it)**" : `query: \`${c.query}\``),
      );
    }
    L.push("", "---", "");
  }
  return L.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv;
  const status = evalArg(argv, "--status") ?? "active";
  const outDir = evalArg(argv, "--out") ?? join(__dirname, "..", "data", "taxonomy", "eval", "review-pack");

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { sql } = createDbClient(url, { max: 1 });
  try {
    const fixture = loadEvalFixture(DEFAULT_FIXTURE);
    const exercised = new Set(
      fixture.cases.map((c) => c.expected_skill_id).filter((v): v is string => v !== null),
    );

    const skills = (await sql.unsafe(
      `SELECT DISTINCT s.skill_id, s.label_en, s.label_hi, s.status
       FROM skill s JOIN job_domain_skill jds ON jds.skill_id = s.skill_id AND jds.status='active'
       WHERE s.status = $1 ORDER BY s.skill_id`,
      [status],
    )) as unknown as { skill_id: string; label_en: string | null; label_hi: string | null; status: string }[];
    const dark = skills.filter((s) => !exercised.has(s.skill_id));

    const entries: ReviewEntry[] = [];
    for (const s of dark) {
      const domains = (
        (await sql.unsafe(
          `SELECT job_domain_id FROM job_domain_skill WHERE skill_id = $1 AND status='active' ORDER BY job_domain_id`,
          [s.skill_id],
        )) as unknown as { job_domain_id: string }[]
      ).map((r) => r.job_domain_id);

      const aliases = (await sql.unsafe(
        `SELECT text, lang FROM skill_alias WHERE skill_id = $1 ORDER BY text`,
        [s.skill_id],
      )) as unknown as { text: string; lang: string | null }[];

      // Nearest OTHER skills, measured over vectors already in the table. No provider call.
      const competing =
        domains.length === 0
          ? []
          : ((await sql.unsafe(
              `SELECT DISTINCT ON (other.skill_id) other.skill_id, os.label_en AS label,
                      other.text AS alias, max(1 - (mine.embedding <=> other.embedding)) AS similarity
               FROM skill_alias mine
               JOIN job_domain_skill jm ON jm.skill_id = mine.skill_id AND jm.status='active'
               JOIN job_domain_skill jo ON jo.job_domain_id = jm.job_domain_id AND jo.status='active'
               JOIN skill_alias other ON other.skill_id = jo.skill_id
               JOIN skill os ON os.skill_id = other.skill_id
               WHERE mine.skill_id = $1 AND other.skill_id <> $1
                 AND mine.embedding IS NOT NULL AND other.embedding IS NOT NULL
                 AND os.status = ANY($2::text[])
               GROUP BY other.skill_id, os.label_en, other.text
               ORDER BY other.skill_id, similarity DESC`,
              [s.skill_id, PRE_PROMOTION_SKILL_STATUSES],
            )) as unknown as { skill_id: string; label: string | null; alias: string; similarity: string }[])
              .map((r) => ({
                skill_id: r.skill_id,
                label: r.label,
                alias: r.alias,
                similarity: Number(r.similarity),
              }))
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, COMPETITORS_SHOWN);

      const base = {
        skill_id: s.skill_id,
        label_en: s.label_en,
        label_hi: s.label_hi,
        status: s.status,
        domains,
        existing_aliases: aliases,
        competing_skills: competing,
      };
      entries.push({
        ...base,
        proposed_cases: [...mechanicalCases(base), ...paraphraseSlots(base)],
        evidence_needed: evidenceNeeded(base),
      });
    }

    const pending = entries.reduce(
      (n, e) => n + e.proposed_cases.filter((c) => c.review_status === "pending_review").length,
      0,
    );
    const mech = entries.reduce(
      (n, e) => n + e.proposed_cases.filter((c) => c.review_status === "mechanical").length,
      0,
    );

    console.log(`[${SCRIPT}] status filter          = ${status}`);
    console.log(`  reachable skills of that status = ${skills.length}`);
    console.log(`  exercised by the fixture        = ${skills.length - dark.length}`);
    console.log(`  DARK -> in this pack            = ${dark.length}`);
    console.log(`  proposed cases                  = ${mech} mechanical + ${pending} pending-review SLOTS`);
    console.log(`  provider calls                  = 0`);
    console.log(`  NOT ground truth until a reviewer sets review_status: "reviewed".`);

    mkdirSync(outDir, { recursive: true });
    const jsonPath = join(outDir, `uncovered-${status}-skills.json`);
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          generated_against_fixture: `${fixture.manifest.fixture_id} v${fixture.manifest.version}`,
          corpus_batch: fixture.manifest.corpus_batch,
          skill_status: status,
          reachable: skills.length,
          dark: dark.length,
          status: "NOT GROUND TRUTH — pending domain review",
          entries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const mdPath = join(outDir, `uncovered-${status}-skills.md`);
    writeFileSync(mdPath, markdown(entries), "utf8");
    console.log(`[${SCRIPT}] ${jsonPath}`);
    console.log(`[${SCRIPT}] ${mdPath}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /taxonomy-fixture-review-pack\.ts$/.test(process.argv[1])) {
  void main();
}
