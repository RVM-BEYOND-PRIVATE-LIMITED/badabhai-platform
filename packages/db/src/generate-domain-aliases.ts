/**
 * `pnpm db:gen:aliases` — the offline vernacular-alias generator (Phase 2, generator #1).
 *
 * WHAT IT IS FOR. 77% of selectable occupations carry exactly one alias: the official
 * English title. A worker saying "kharad ka kaam karta hun" matches none of them. This
 * script drafts vernacular candidates per occupation so a human can review them as a git
 * diff before any of it reaches the database.
 *
 * IT IS AN AUTHORING AID, NOT A DECISION-MAKER. CLAUDE.md §3 forbids an LLM owning a
 * business decision; what satisfies it here is not a disclaimer but the shape of the
 * pipeline — the model's output lands in a REVIEW file, a human signs the diff, and the
 * signature is recoverable from `git blame` forever after. Nothing the model emits can
 * reach `job_domain_alias` without passing `validateAliasOverlay` AND a human commit.
 *
 * TWO PHASES, AND WHY IT IS NOT ONE.
 *
 *   pnpm db:gen:aliases --emit-prompts out/prompts.jsonl   # what to ask, per occupation
 *   ...run the batch against whichever capable model you have...
 *   pnpm db:gen:aliases --ingest out/responses.jsonl       # validate + emit corpus lines
 *
 * The obvious single-phase design — this script calling a model directly — would need a
 * new alias-generation endpoint on the ai-service, because every LLM call in this repo
 * goes through the AIRouter for the spend ledger and the four cost ceilings, and
 * `packages/db` has no business holding a provider key. The ai-service is not this
 * module's to extend (CLAUDE.md §6), so a single-phase design would mean either crossing
 * an ownership boundary or smuggling a second, unmetered path to a provider. Two phases
 * cost one extra command and avoid both.
 *
 * It is also what a batch API actually is: submit a file, collect a file. And it means
 * the generator is fully buildable, testable and reviewable with no provider key at all —
 * only the middle step needs one.
 *
 * If a metered in-process path is wanted later, the right move is a
 * `POST /skills/vernacular-alias` on the ai-service raised as an issue against its owner,
 * and an `--ai-service` flag here. Deliberately not done unilaterally.
 *
 * PRIVACY. Reads published occupation titles and definitions only — no worker data is
 * involved, by construction, so nothing here crosses the pseudonymization boundary. The
 * ingest side still applies the corpus PII guard (no digits, '@' or URLs), because a
 * model asked for job titles can still return something that looks like contact detail.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  resolveJobDomainCorpus,
  validateAliasOverlay,
  type JobDomainAliasOverlayRecord,
  type ResolvedJobDomain,
} from "./job-domain-corpus";

const SCRIPT = "gen:aliases";

/**
 * Blue-collar ISCO majors. The plan scopes pack coverage — and therefore alias coverage —
 * to majors 5-9, which is where BadaBhai's workers are. Generating for majors 1-4
 * (managers, professionals, technicians, clerks) would spend review effort on occupations
 * the platform does not serve.
 */
const BLUE_COLLAR_MAJORS = new Set(["5", "6", "7", "8", "9"]);

/** How many aliases to ask for per occupation. ~15 x ~200 families is the plan's ~3,000. */
const ALIASES_PER_OCCUPATION = 15;

/** Truncate the NCO definition prose fed to the model. Some run to 1,900 characters of
 *  OCR'd task description, and the tail is never the part that names the trade. */
const MAX_DESCRIPTION_CHARS = 400;

export interface AliasPrompt {
  job_domain_id: string;
  label_en: string;
  isco_unit: string | null;
  existing_aliases: string[];
  prompt: string;
}

/** One line a reviewer feeds back in. Mirrors what a batch API returns. */
export interface AliasResponse {
  job_domain_id: string;
  aliases: { text: string; lang: "en" | "hi" }[];
}

/**
 * The prompt. Written here rather than in a prompts module because it is corpus tooling,
 * not a production prompt — nothing on a request path ever reads it.
 *
 * The instructions encode the corpus rules the validator will enforce anyway, so that a
 * compliant model produces reviewable output on the first pass instead of a file that is
 * 60% rejections. Notably: STEMS not particle phrases, because "welding wala" and
 * "welding" collapse to the same normalized form and only one can ever be retrieved.
 */
export function buildPrompt(domain: ResolvedJobDomain): string {
  const description = (domain.description_en ?? "").slice(0, MAX_DESCRIPTION_CHARS).trim();
  const existing = (domain.aliases ?? []).map((a) => a.text).join("; ");
  return [
    `Occupation: ${domain.label_en}`,
    domain.isco_unit ? `ISCO unit group: ${domain.isco_unit}` : null,
    description ? `Official description: ${description}` : null,
    existing ? `Already known names: ${existing}` : null,
    "",
    `List up to ${ALIASES_PER_OCCUPATION} names an Indian blue-collar worker would ACTUALLY use`,
    "for this job when speaking to a recruiter. Include:",
    "  - Hindi in Devanagari script (lang: hi)",
    "  - Hinglish written in Latin script (lang: en)",
    "  - common misspellings workers type on a phone (lang: en)",
    "",
    "Rules:",
    "  - Give the STEM, not a phrase. Write 'welding', never 'welding wala' or",
    "    'welding ka kaam' — the three are treated as identical and only one survives.",
    "  - No digits, no '@', no URLs, no employer or person names.",
    "  - Maximum 60 characters each.",
    "  - Do not repeat anything under 'Already known names'.",
    "  - If you do not know a genuine vernacular name, return fewer. Do not invent one.",
    "",
    'Return JSON: {"job_domain_id": "' + domain.jobDomainId + '", "aliases": [{"text": "...", "lang": "hi"}]}',
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Which occupations to draft for, most-valuable first.
 *
 * `--missing-only` (the default) skips occupations that already have a vernacular alias,
 * because a second pass over a covered trade spends review effort for near-zero recall
 * gain. Ordering puts the occupations with the FEWEST existing aliases first: those are
 * the 77% carrying nothing but their official English title, which is exactly where
 * retrieval is blind today.
 */
export function selectDomains(
  corpus: ResolvedJobDomain[],
  opts: { missingOnly: boolean; unit?: string; limit?: number },
): ResolvedJobDomain[] {
  let rows = corpus.filter(
    (d) => d.selectable && d.isco_major !== null && BLUE_COLLAR_MAJORS.has(d.isco_major),
  );
  if (opts.unit) rows = rows.filter((d) => d.isco_unit === opts.unit);
  if (opts.missingOnly) {
    rows = rows.filter((d) => !(d.aliases ?? []).some((a) => a.source === "rvm"));
  }
  rows.sort((a, b) => {
    const byCount = (a.aliases?.length ?? 0) - (b.aliases?.length ?? 0);
    if (byCount !== 0) return byCount;
    return a.jobDomainId.localeCompare(b.jobDomainId);
  });
  return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
}

/** Parse a JSONL response file. Malformed lines are REPORTED, never skipped silently. */
export function parseResponses(raw: string): { responses: AliasResponse[]; problems: string[] } {
  const responses: AliasResponse[] = [];
  const problems: string[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    let parsed: AliasResponse;
    try {
      parsed = JSON.parse(trimmed) as AliasResponse;
    } catch {
      problems.push(`response line ${i + 1}: not valid JSON`);
      return;
    }
    if (!parsed.job_domain_id || !Array.isArray(parsed.aliases)) {
      problems.push(`response line ${i + 1}: needs job_domain_id and an aliases array`);
      return;
    }
    responses.push(parsed);
  });
  return { responses, problems };
}

/** Flatten responses into overlay records, ready for the corpus validator. */
export function toOverlayRecords(responses: AliasResponse[]): JobDomainAliasOverlayRecord[] {
  return responses.flatMap((r) =>
    r.aliases.map((a) => ({
      kind: "alias" as const,
      job_domain_id: r.job_domain_id,
      text: typeof a.text === "string" ? a.text.trim() : "",
      lang: a.lang,
    })),
  );
}

/** Serialize accepted records as corpus lines, in the committed file's exact shape. */
export function toCorpusLines(records: JobDomainAliasOverlayRecord[]): string {
  return records
    .map((r) =>
      JSON.stringify({ kind: "alias", job_domain_id: r.job_domain_id, text: r.text, lang: r.lang }),
    )
    .join("\n");
}

function writeOut(path: string, body: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${body}\n`, "utf8");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const emitTo = arg(argv, "--emit-prompts");
  const ingestFrom = arg(argv, "--ingest");
  const outTo = arg(argv, "--out");
  const unit = arg(argv, "--unit");
  const limitRaw = arg(argv, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const missingOnly = !argv.includes("--all");

  if (!emitTo && !ingestFrom) {
    console.error(
      `[${SCRIPT}] usage:\n` +
        `  --emit-prompts <file>   draft prompts for review\n` +
        `  --ingest <file> [--out <file>]  validate model output into corpus lines\n` +
        `  --unit <isco>  --limit <n>  --all (include already-covered occupations)`,
    );
    process.exit(1);
  }

  const corpus = resolveJobDomainCorpus();

  if (emitTo) {
    const rows = selectDomains(corpus, { missingOnly, unit, limit });
    const prompts: AliasPrompt[] = rows.map((d) => ({
      job_domain_id: d.jobDomainId,
      label_en: d.label_en,
      isco_unit: d.isco_unit,
      existing_aliases: (d.aliases ?? []).map((a) => a.text),
      prompt: buildPrompt(d),
    }));
    writeOut(emitTo, prompts.map((p) => JSON.stringify(p)).join("\n"));
    console.log(`[${SCRIPT}] wrote ${prompts.length} prompt(s) to ${emitTo}`);
    console.log(`[${SCRIPT}] run these against a capable model, then --ingest the JSONL replies.`);
    return;
  }

  // ── Ingest ────────────────────────────────────────────────────────────────
  const { responses, problems: parseProblems } = parseResponses(readFileSync(ingestFrom!, "utf8"));
  const candidates = toOverlayRecords(responses);

  // The SAME validator the committed corpus passes through. Running a weaker check here
  // would let a row into the review file that the seed then rejects, which trains a
  // reviewer to ignore the gate.
  const problems = validateAliasOverlay(candidates, corpus);

  // A problem names its candidate by index, so rejects can be excluded precisely rather
  // than by re-deriving the rule.
  const rejected = new Set<number>();
  for (const p of problems) {
    const m = /^alias\[(\d+)\]/.exec(p);
    if (m) rejected.add(Number(m[1]));
  }
  const accepted = candidates.filter((_, i) => !rejected.has(i));

  console.log(`[${SCRIPT}] responses=${responses.length} candidates=${candidates.length}`);
  console.log(`[${SCRIPT}] accepted=${accepted.length} rejected=${rejected.size}`);
  for (const p of [...parseProblems, ...problems]) console.log(`  REJECT ${p}`);

  const body = toCorpusLines(accepted);
  if (outTo) {
    writeOut(outTo, body);
    console.log(`[${SCRIPT}] wrote ${accepted.length} line(s) to ${outTo}`);
    console.log(
      `[${SCRIPT}] REVIEW THEM, then append to data/job-domains/rvm-aliases.jsonl. ` +
        `Your commit is the reviewer signature.`,
    );
  } else {
    console.log(body);
  }
}

// Guarded so importing the helpers for tests does not run the CLI.
if (process.argv[1] && /generate-domain-aliases/.test(process.argv[1])) {
  main();
}
