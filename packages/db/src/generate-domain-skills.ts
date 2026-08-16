/**
 * `pnpm db:gen:domain-skills` — the offline Domain -> Skill generator (Phase 2).
 *
 * WHAT IT IS FOR. `job_domain_skill` is what the employer's skill picker reads: pick a
 * trade, get the 6-14 skills that trade actually needs, ticked as required or preferred.
 * Nobody is going to hand-author that for every trade, and nothing in the occupation
 * catalogue implies it — an NCO definition names TASKS, not the controls, machines and
 * certifications a shop floor hires on. So the first pass is drafted by a model and every
 * line of it is reviewed as a git diff before it can reach a database.
 *
 * IT IS AN AUTHORING AID, NOT A DECISION-MAKER. CLAUDE.md §3 forbids an LLM owning a
 * business decision; what satisfies it here is not a disclaimer but the shape of the
 * pipeline — the model's output lands in a batch directory, the validator refuses
 * everything it cannot prove is coherent, a human signs the diff, and the signature is
 * recoverable from `git blame` forever after. Nothing the model emits can reach `skill`,
 * `skill_alias` or `job_domain_skill` without passing `validateTaxonomyCorpus` AND a
 * human commit.
 *
 * TWO PHASES, AND WHY IT IS NOT ONE.
 *
 *   pnpm db:gen:domain-skills --emit-prompts data/taxonomy/batches   # creates <batch_id>/
 *   ...run prompts.jsonl against whichever capable model you have, save raw-responses.jsonl...
 *   pnpm db:gen:domain-skills --ingest data/taxonomy/batches/<batch_id>
 *
 * The obvious single-phase design — this script calling a model directly — would need a
 * new endpoint on the ai-service, because every LLM call in this repo goes through the
 * AIRouter for the spend ledger and the four cost ceilings, and `packages/db` has no
 * business holding a provider key. The ai-service is not this module's to extend
 * (CLAUDE.md §6), so a single-phase design would mean either crossing an ownership
 * boundary or smuggling a second, unmetered path to a provider. Two phases cost one extra
 * command and avoid both. It is also what a batch API actually is: submit a file, collect
 * a file. `generate-domain-aliases.ts` made the same call for the same reasons; this is
 * deliberately the same shape so there is one pipeline to learn, not two.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL NEVER SUPPLIES A DATABASE ID
 * ---------------------------------------------------------------------------
 * There is no field in the response schema for an invented `skill_id`. A new skill's id is
 * MINTED from its label by `taxonomySkillIdFor`, which is a pure function — the same label
 * always produces the same id, so a re-ingest is idempotent and a reviewer can verify the
 * id by reading the label.
 *
 * The model may only ECHO an id, in `existing_skill_id`, and only one that appeared in the
 * catalogue its prompt carried. The ingest side re-validates that against the catalogue
 * rather than trusting it, because a model that has seen thousands of `skill_*` ids in
 * training will confidently produce a plausible one that does not exist — and an id is
 * immutable and never reused (SG-5), so a wrong one is not a typo, it is a permanent
 * false claim about the vocabulary.
 *
 * ---------------------------------------------------------------------------
 * THE AUDIT MANIFEST
 * ---------------------------------------------------------------------------
 * Every batch directory carries a `manifest.json` recording what was asked, of what, in
 * what shape, and what came back. It carries NO TOKEN COUNT AND NO COST. Those numbers are
 * genuinely unknown for a batch run outside this process, and a plausible invented number
 * in an audit record is worse than an absent one: it looks like evidence. `model` and
 * `provider` are `null` until an operator states them at ingest with `--model` /
 * `--provider`, and the reporter says so out loud when they are still null.
 *
 * PRIVACY. Reads the occupation catalogue and the committed skill vocabulary only — no
 * worker data is involved, by construction, so nothing here crosses the pseudonymization
 * boundary. The ingest side still applies the corpus PII guard (no digits, '@' or URLs),
 * because a model asked for skill names can still return something shaped like a contact
 * detail.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  TAXONOMY_BATCHES_DIR,
  edgeLocator,
  loadTaxonomyCorpus,
  skillCatalogue,
  skillLocator,
  taxonomyProblemCode,
  taxonomyProblemLocator,
  taxonomySkillIdFor,
  validateTaxonomyCorpus,
  type SkillCatalogueEntry,
  type TaxonomyCorpus,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomyLang,
  type TaxonomySkillAliasRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";

const SCRIPT = "gen:domain-skills";

/** Bump on ANY edit to `PROMPT_TEMPLATE` or `RESPONSE_SCHEMA`. The sha256 below detects a
 *  forgotten bump; the version is what a human quotes when comparing two batches. */
export const PROMPT_TEMPLATE_VERSION = 1;

/** How many skills to ask for per trade. Fewer than 6 is not a usable picker; more than
 *  14 is the model padding with generics, which the stoplist check then rejects. */
const SKILLS_PER_DOMAIN_MIN = 6;
const SKILLS_PER_DOMAIN_MAX = 14;

/** Alias/label caps, restated in the prompt so a compliant model produces reviewable
 *  output on the first pass instead of a file that is 60% rejections. Kept numerically in
 *  step with `taxonomy-corpus.ts` by the test that asserts the prompt names them. */
const MAX_ALIAS_LEN = 60;

/**
 * The INVARIANT half of the prompt — everything that does not depend on the trade.
 *
 * Split out from `buildSkillPrompt` so it can be hashed. `prompt_template_sha256` in the
 * manifest is the sha256 of exactly this string, which makes "were these two batches asked
 * the same question?" a byte comparison instead of an argument. The per-domain header and
 * the catalogue are deliberately OUTSIDE the hash: they vary by construction, and folding
 * them in would make every batch's hash unique and the field worthless.
 *
 * The instructions encode the rules `validateTaxonomyCorpus` enforces anyway. Notably:
 *   - a SKILL, never a job title — "CNC Operator" is the trade, "Fanuc control operation"
 *     is the skill, and the domain-name-as-skill check rejects the former;
 *   - reuse before minting, because two canonical rows for one concept split it
 *     permanently and half the workers who have it stop matching the postings that want it;
 *   - no digits/'@'/URLs, which is a PII guard, not a style rule.
 */
export const PROMPT_TEMPLATE = [
  `You are helping build a hiring taxonomy for Indian blue-collar and industrial trades.`,
  ``,
  `List the ${SKILLS_PER_DOMAIN_MIN}-${SKILLS_PER_DOMAIN_MAX} skills an employer hiring for`,
  `this trade would actually screen on.`,
  ``,
  `Rules:`,
  `  - Give a SKILL, not a job title. "Fanuc control operation" is a skill;`,
  `    "CNC Operator" is the job and will be rejected.`,
  `  - Give a skill, not a personal quality. No "hard working", no "punctual".`,
  `  - REUSE an existing skill whenever one fits. Copy its skill_id EXACTLY into`,
  `    "existing_skill_id" and still give its label. Only leave "existing_skill_id" null`,
  `    when nothing in the catalogue means the same thing.`,
  `  - NEVER invent a skill_id. If it is not in the catalogue below, leave`,
  `    "existing_skill_id" null and just give the label — the id is derived from it.`,
  `  - Mark each skill "required" (the trade is not doable without it) or "preferred"`,
  `    (a differentiator between two candidates).`,
  `  - relevance: integer 0-100, how central the skill is to THIS trade.`,
  `  - confidence: number 0-1, how sure you are the skill genuinely belongs here.`,
  `  - aliases: other names a worker or a supervisor would say for the same skill,`,
  `    including Hinglish in Latin script (lang "en") and Hindi in Devanagari (lang "hi").`,
  `    Give the STEM, not a phrase: "welding", never "welding wala" — they normalize to`,
  `    the same key and only one can ever be retrieved.`,
  `  - No digits, no "@", no URLs, no employer names, no person names, anywhere.`,
  `  - Maximum ${MAX_ALIAS_LEN} characters per alias.`,
  `  - If you do not know a genuine skill for this trade, return fewer. Do not invent one.`,
  ``,
  `Return STRICT JSON on a single line. No prose, no markdown fence.`,
].join("\n");

/** The sha256 an operator can compare between batches. Computed once at module load. */
export const PROMPT_TEMPLATE_SHA256 = createHash("sha256").update(PROMPT_TEMPLATE).digest("hex");

/**
 * The response shape requested, recorded verbatim in the manifest as `instruction_schema`.
 *
 * A JSON object rather than prose so that "what did we ask for?" is answerable six months
 * later by diffing two manifests, not by reading two paragraphs and hoping.
 */
export const RESPONSE_SCHEMA = {
  job_domain_id: "string (echo the one given)",
  skills: [
    {
      existing_skill_id: "string from the catalogue, or null",
      label_en: "string",
      label_hi: "string or null",
      aliases: [{ text: "string", lang: "en | hi" }],
      requirement: "required | preferred",
      relevance: "integer 0-100",
      confidence: "number 0-1",
    },
  ],
} as const;

// ===========================================================================
// Prompt
// ===========================================================================

/** One line of `prompts.jsonl`. Mirrors what a batch API wants submitted. */
export interface SkillPrompt {
  job_domain_id: string;
  label_en: string;
  trade_group: string;
  /** The ids the model is allowed to echo. Recorded so a rejection is explainable. */
  catalogue_ids: string[];
  prompt: string;
}

/**
 * Build the prompt for one domain. PURE and DETERMINISTIC: same domain + same catalogue
 * (in the same order) => byte-identical prompt.
 *
 * That determinism is not cosmetic. It is what lets a re-emit be diffed against the last
 * one to prove only the intended thing changed, and it is what makes
 * `prompt_template_sha256` mean anything. `skillCatalogue` sorts its entries for exactly
 * this reason.
 */
export function buildSkillPrompt(
  domain: TaxonomyDomainRecord,
  existingSkills: readonly SkillCatalogueEntry[],
): string {
  const catalogue =
    existingSkills.length === 0
      ? ["  (none yet — mint every skill from its label)"]
      : existingSkills.map((e) => `  ${e.skill_id}  ${e.label_en}`);
  return [
    `Trade: ${domain.label_en}`,
    `Trade group: ${domain.trade_group}`,
    ``,
    PROMPT_TEMPLATE,
    ``,
    `Existing canonical skills you MAY reuse (echo the skill_id EXACTLY, or null):`,
    ...catalogue,
    ``,
    `Schema: ${JSON.stringify(RESPONSE_SCHEMA)}`,
    `Echo job_domain_id as "${domain.job_domain_id}".`,
  ].join("\n");
}

/**
 * Which domains to draft for, and which catalogue each one sees.
 *
 * `--missing-only` (the default) skips domains that already have edges: a second pass over
 * a covered trade spends review effort to re-propose what a human already signed.
 *
 * THE CATALOGUE IS SCOPED BY TRADE GROUP, plus every shipped `SKILL_CORPUS` skill. Showing
 * a CNC prompt the full corpus would be both wasteful and counterproductive — a long list
 * of irrelevant welding skills makes reuse LESS likely, not more, and it grows without
 * bound as the corpus does. Scoping by `trade_group` keeps the reuse candidates the ones
 * that could plausibly apply, which is the whole point of showing them.
 */
export function selectPromptInputs(
  corpus: TaxonomyCorpus,
  opts: { missingOnly: boolean; tradeGroup?: string; limit?: number },
): SkillPrompt[] {
  const edgedDomains = new Set(corpus.edges.map((e) => e.job_domain_id));
  let rows = [...corpus.domains];
  if (opts.tradeGroup !== undefined) rows = rows.filter((d) => d.trade_group === opts.tradeGroup);
  if (opts.missingOnly) rows = rows.filter((d) => !edgedDomains.has(d.job_domain_id));
  rows.sort(
    (a, b) =>
      a.trade_group.localeCompare(b.trade_group) || a.job_domain_id.localeCompare(b.job_domain_id),
  );
  if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);

  // domain -> trade_group, so the scoped catalogue can be built from the edges.
  const groupOf = new Map(corpus.domains.map((d) => [d.job_domain_id, d.trade_group]));
  const skillById = new Map(corpus.skills.map((s) => [s.skill_id, s]));
  const skillsInGroup = new Map<string, Set<string>>();
  for (const e of corpus.edges) {
    const group = groupOf.get(e.job_domain_id);
    if (group === undefined) continue;
    let set = skillsInGroup.get(group);
    if (set === undefined) {
      set = new Set<string>();
      skillsInGroup.set(group, set);
    }
    set.add(e.skill_id);
  }

  return rows.map((d) => {
    const inGroup = [...(skillsInGroup.get(d.trade_group) ?? [])]
      .map((id) => skillById.get(id))
      .filter((s): s is TaxonomySkillRecord => s !== undefined);
    const catalogue = skillCatalogue(inGroup);
    return {
      job_domain_id: d.job_domain_id,
      label_en: d.label_en,
      trade_group: d.trade_group,
      catalogue_ids: catalogue.map((c) => c.skill_id),
      prompt: buildSkillPrompt(d, catalogue),
    };
  });
}

// ===========================================================================
// Response parsing
// ===========================================================================

/** One skill as the model returns it. Every field is `unknown`-shaped until validated. */
export interface SkillResponseEntry {
  /** Echoed from the catalogue, or null/absent for a new skill. NEVER an invented id. */
  existing_skill_id?: string | null;
  label_en: string;
  label_hi?: string | null;
  aliases?: { text: string; lang: TaxonomyLang }[];
  requirement: "required" | "preferred";
  relevance: number;
  confidence?: number | null;
}

/** One line a reviewer feeds back in. Mirrors what a batch API returns. */
export interface SkillResponse {
  job_domain_id: string;
  skills: SkillResponseEntry[];
}

/**
 * Parse a JSONL response file. Malformed lines are REPORTED, never skipped silently.
 *
 * A silently dropped line is the failure mode that matters here: a batch of 200 domains
 * that quietly ingests 173 of them looks like a success, and the 27 missing trades show up
 * months later as empty pickers. Every problem string carries the 1-based line number so
 * the operator can open the file at the right place.
 */
export function parseSkillResponses(raw: string): {
  responses: SkillResponse[];
  problems: string[];
} {
  const responses: SkillResponse[] = [];
  const problems: string[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    let parsed: SkillResponse;
    try {
      parsed = JSON.parse(trimmed) as SkillResponse;
    } catch {
      problems.push(`response line ${i + 1}: not valid JSON`);
      return;
    }
    if (typeof parsed?.job_domain_id !== "string" || parsed.job_domain_id.length === 0) {
      problems.push(`response line ${i + 1}: missing job_domain_id`);
      return;
    }
    if (!Array.isArray(parsed.skills)) {
      problems.push(`response line ${i + 1}: ${parsed.job_domain_id} has no skills array`);
      return;
    }
    responses.push(parsed);
  });
  return { responses, problems };
}

// ===========================================================================
// Response -> corpus records
// ===========================================================================

export interface CorpusRecords {
  skills: TaxonomySkillRecord[];
  edges: TaxonomyDomainSkillRecord[];
  /** Faults attributable to the RESPONSE rather than to the corpus rules. */
  problems: string[];
}

function normaliseAliases(raw: unknown): TaxonomySkillAliasRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: TaxonomySkillAliasRecord[] = [];
  for (const a of raw) {
    const text = typeof (a as { text?: unknown })?.text === "string" ? (a as { text: string }).text.trim() : "";
    const lang = (a as { lang?: unknown })?.lang;
    if (text.length === 0) continue;
    // An unrecognised lang is passed THROUGH, not defaulted to "en". The validator has an
    // ALIAS_LANG_ENUM check whose whole job is to surface it; silently choosing a language
    // for the model would seed a Devanagari alias tagged English and nobody would know.
    out.push({ text, lang: lang as TaxonomyLang });
  }
  return out;
}

/**
 * Flatten responses into corpus records, ready for `validateTaxonomyCorpus`.
 *
 * THE ONE PLACE THE MODEL'S ID CLAIM IS CHECKED. `existing_skill_id` is accepted only if
 * it is in the catalogue that was actually sent; anything else is reported as an invented
 * id and the entry is dropped. Re-deriving this from the corpus instead of trusting the
 * response is the difference between "the model reused a skill" and "the model produced a
 * string that looks like an id".
 *
 * `source` is hard-coded to `llm_bootstrap`. The model is never asked for it and could not
 * be trusted with it: `curated` means "a human signed this" and always wins a
 * materialization conflict, so a model able to claim it could overwrite hand-authored
 * rows.
 */
export function toCorpusRecords(
  responses: readonly SkillResponse[],
  catalogue: readonly SkillCatalogueEntry[] = skillCatalogue(),
): CorpusRecords {
  const known = new Set(catalogue.map((c) => c.skill_id));
  const byId = new Map<string, TaxonomySkillRecord>();
  const edges: TaxonomyDomainSkillRecord[] = [];
  const problems: string[] = [];

  responses.forEach((r, ri) => {
    r.skills.forEach((s, si) => {
      const at = `response[${ri}].skills[${si}] (${r.job_domain_id})`;
      const label = typeof s?.label_en === "string" ? s.label_en.trim() : "";
      const echoed = typeof s?.existing_skill_id === "string" ? s.existing_skill_id.trim() : "";

      if (echoed.length > 0 && !known.has(echoed)) {
        problems.push(
          `${at}: INVENTED_SKILL_ID — the model returned existing_skill_id ` +
            `${JSON.stringify(echoed)}, which was not in the catalogue this prompt carried. A ` +
            `skill_id is immutable and never reused (SG-5), so a fabricated one is a permanent ` +
            `false claim about the vocabulary, not a typo. Entry dropped.`,
        );
        return;
      }
      if (echoed.length === 0 && label.length === 0) {
        problems.push(`${at}: NO_LABEL — neither existing_skill_id nor label_en was usable. Entry dropped.`);
        return;
      }

      const skillId = echoed.length > 0 ? echoed : taxonomySkillIdFor(label);
      const aliases = normaliseAliases(s?.aliases);

      // A reused id needs NO skill record: the row already exists, either in SKILL_CORPUS
      // or in a previously committed batch, and re-declaring it would be an id collision.
      // Only the edge is new. (Adding aliases to a shipped skill is the `reuses_existing`
      // path and is a deliberate hand edit, never something a batch does on its own.)
      if (echoed.length === 0) {
        const seen = byId.get(skillId);
        if (seen === undefined) {
          byId.set(skillId, {
            kind: "skill",
            skill_id: skillId,
            label_en: label,
            label_hi: typeof s?.label_hi === "string" && s.label_hi.trim().length > 0 ? s.label_hi.trim() : null,
            aliases,
          });
        } else {
          // Two domains proposed the same new skill. That is the REUSE we wanted; merge
          // their aliases rather than emitting a duplicate id the validator would reject.
          const have = new Set(seen.aliases.map((a) => `${a.lang}|${a.text}`));
          for (const a of aliases) {
            if (have.has(`${a.lang}|${a.text}`)) continue;
            have.add(`${a.lang}|${a.text}`);
            seen.aliases.push(a);
          }
        }
      }

      edges.push({
        kind: "domain_skill",
        job_domain_id: r.job_domain_id,
        skill_id: skillId,
        default_requirement: s?.requirement as TaxonomyDomainSkillRecord["default_requirement"],
        relevance: s?.relevance as number,
        confidence: typeof s?.confidence === "number" ? s.confidence : null,
        source: "llm_bootstrap",
      });
    });
  });

  return { skills: [...byId.values()], edges, problems };
}

// ===========================================================================
// The audit manifest
// ===========================================================================

/**
 * `manifest.json` — what was asked, of what, in what shape, and what came back.
 *
 * READ THE `model`/`provider` NOTE. They are nullable because the batch runs OUTSIDE this
 * process and the script genuinely does not know. An operator states them at ingest
 * (`--model`, `--provider`); until then they stay null and the reporter says so.
 *
 * THERE IS NO TOKEN COUNT AND NO COST FIELD, and there must never be one. Those numbers
 * are unknown for an external batch, and a plausible invented number in an audit record is
 * worse than an absent one — it looks like evidence. The spend ledger for metered calls
 * lives in the AIRouter, which is the only thing that actually knows.
 */
export interface BatchManifest {
  batch_id: string;
  generated_at: string;
  /** Always this, today. The field exists so an in-process mode would be distinguishable. */
  generation_mode: "external_session_batch";
  model: string | null;
  provider: string | null;
  prompt_template_version: number;
  prompt_template_sha256: string;
  instruction_schema: unknown;
  domain_count: number;
  domains: string[];
  // ── filled by --ingest; null until then ───────────────────────────────────
  ingested_at: string | null;
  raw_record_count: number | null;
  accepted_count: number | null;
  rejected_count: number | null;
  /** Counts keyed by the stable `TaxonomyProblemCode` (plus PARSE / INVENTED_SKILL_ID). */
  rejections_by_reason: Record<string, number> | null;
}

/** Build the emit-time manifest. Everything the ingest fills is explicitly null, never
 *  absent — an absent key is indistinguishable from a key someone forgot to write. */
export function buildBatchManifest(input: {
  batchId: string;
  generatedAt: Date;
  domains: readonly string[];
  model?: string | null;
  provider?: string | null;
}): BatchManifest {
  return {
    batch_id: input.batchId,
    generated_at: input.generatedAt.toISOString(),
    generation_mode: "external_session_batch",
    model: input.model ?? null,
    provider: input.provider ?? null,
    prompt_template_version: PROMPT_TEMPLATE_VERSION,
    prompt_template_sha256: PROMPT_TEMPLATE_SHA256,
    instruction_schema: RESPONSE_SCHEMA,
    domain_count: input.domains.length,
    domains: [...input.domains],
    ingested_at: null,
    raw_record_count: null,
    accepted_count: null,
    rejected_count: null,
    rejections_by_reason: null,
  };
}

/** One rejected candidate, as written to `rejections.jsonl`. */
export interface BatchRejection {
  /** `skill[...]`, `edge[... -> ...]`, or null for a parse/response-level fault. */
  locator: string | null;
  reason: string;
  message: string;
}

/** Fold the ingest result into the manifest. Returns a NEW object; the emit-time fields
 *  are copied through untouched so a re-ingest cannot rewrite what was asked. */
export function withIngestResults(
  manifest: BatchManifest,
  result: {
    ingestedAt: Date;
    rawRecordCount: number;
    acceptedCount: number;
    rejections: readonly BatchRejection[];
    model?: string | null;
    provider?: string | null;
  },
): BatchManifest {
  const byReason: Record<string, number> = {};
  for (const r of result.rejections) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  return {
    ...manifest,
    model: result.model ?? manifest.model,
    provider: result.provider ?? manifest.provider,
    ingested_at: result.ingestedAt.toISOString(),
    raw_record_count: result.rawRecordCount,
    accepted_count: result.acceptedCount,
    rejected_count: result.rejections.length,
    rejections_by_reason: byReason,
  };
}

/** Serialize records as corpus lines, in the committed files' exact shape. */
export function toSkillCorpusLines(records: readonly TaxonomySkillRecord[]): string {
  return records
    .map((r) =>
      JSON.stringify({
        kind: "skill",
        skill_id: r.skill_id,
        label_en: r.label_en,
        label_hi: r.label_hi,
        aliases: r.aliases,
      }),
    )
    .join("\n");
}

/** Serialize edges as corpus lines, in the committed files' exact shape. */
export function toEdgeCorpusLines(records: readonly TaxonomyDomainSkillRecord[]): string {
  return records
    .map((r) =>
      JSON.stringify({
        kind: "domain_skill",
        job_domain_id: r.job_domain_id,
        skill_id: r.skill_id,
        default_requirement: r.default_requirement,
        relevance: r.relevance,
        confidence: r.confidence,
        source: r.source,
      }),
    )
    .join("\n");
}

// ===========================================================================
// CLI
// ===========================================================================

function writeOut(path: string, body: string): void {
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `batch_2026-08-16T09-30-00Z` — sortable, filesystem-safe, and it says WHEN, which is
 *  the only thing anyone ever wants from a batch id they did not choose themselves. */
function defaultBatchId(now: Date): string {
  return `batch_${now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}`;
}

function emit(argv: string[], root: string): void {
  const now = new Date();
  const batchId = arg(argv, "--batch-id") ?? defaultBatchId(now);
  const tradeGroup = arg(argv, "--trade-group");
  const limitRaw = arg(argv, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const missingOnly = !argv.includes("--all");

  const corpus = loadTaxonomyCorpus();
  const prompts = selectPromptInputs(corpus, { missingOnly, tradeGroup, limit });
  if (prompts.length === 0) {
    console.log(
      `[${SCRIPT}] no domains selected. sample-domains.jsonl has ${corpus.domains.length} row(s); ` +
        `${missingOnly ? "every selected one already has edges (pass --all to re-draft)" : "check --trade-group"}.`,
    );
    return;
  }

  const dir = join(root, batchId);
  mkdirSync(dir, { recursive: true });
  writeOut(join(dir, "prompts.jsonl"), prompts.map((p) => JSON.stringify(p)).join("\n"));
  const manifest = buildBatchManifest({
    batchId,
    generatedAt: now,
    domains: prompts.map((p) => p.job_domain_id),
  });
  writeOut(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[${SCRIPT}] batch ${batchId}`);
  console.log(`  dir            = ${dir}`);
  console.log(`  prompts        = ${prompts.length}`);
  console.log(`  template       = v${PROMPT_TEMPLATE_VERSION} sha256=${PROMPT_TEMPLATE_SHA256.slice(0, 16)}…`);
  console.log(
    `[${SCRIPT}] run prompts.jsonl against a capable model, save the replies as ` +
      `${join(dir, "raw-responses.jsonl")}, then:\n` +
      `  pnpm db:gen:domain-skills --ingest ${dir} --model <model> --provider <provider>`,
  );
}

function ingest(argv: string[], dir: string): void {
  const rawPath = join(dir, "raw-responses.jsonl");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(rawPath)) {
    throw new Error(`[${SCRIPT}] ${rawPath} does not exist — nothing to ingest.`);
  }
  if (!existsSync(manifestPath)) {
    // Refusing is deliberate. The manifest is the audit record; ingesting without one
    // would produce corpus lines whose provenance is unrecoverable, which is exactly what
    // the manifest exists to prevent.
    throw new Error(
      `[${SCRIPT}] ${manifestPath} does not exist. A batch without its emit-time manifest has no ` +
        `recoverable provenance; re-emit rather than ingesting blind.`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BatchManifest;
  const committed = loadTaxonomyCorpus();

  // The catalogue the model was ALLOWED to echo from. Rebuilt from the same inputs rather
  // than read from prompts.jsonl so a hand-edited prompts file cannot widen it.
  const catalogue = skillCatalogue(committed.skills);

  const { responses, problems: parseProblems } = parseSkillResponses(readFileSync(rawPath, "utf8"));
  const candidates = toCorpusRecords(responses, catalogue);

  // Validate the UNION of what is committed and what is proposed. Anything less would miss
  // the cross-batch faults that matter most — an alias this batch invents that a previous
  // batch already gave to a different skill, or a label that duplicates a committed one.
  //
  // `domains` is the FULL committed list, so DOMAIN_ORPHAN fires for trades nobody has
  // drafted yet. Those are not this batch's fault, and the partition below files them as
  // context rather than as rejections.
  const problems = validateTaxonomyCorpus(
    [...committed.skills, ...candidates.skills],
    [...committed.edges, ...candidates.edges],
    { domains: committed.domains },
  );

  const candidateSkillLocators = new Set(candidates.skills.map((s) => skillLocator(s.skill_id)));
  const candidateEdgeLocators = new Set(
    candidates.edges.map((e) => edgeLocator(e.job_domain_id, e.skill_id)),
  );

  const rejectedLocators = new Set<string>();
  const rejections: BatchRejection[] = [];
  const context: string[] = [];
  for (const p of problems) {
    const locator = taxonomyProblemLocator(p);
    if (locator !== null && (candidateSkillLocators.has(locator) || candidateEdgeLocators.has(locator))) {
      rejectedLocators.add(locator);
      rejections.push({ locator, reason: taxonomyProblemCode(p), message: p });
    } else {
      context.push(p);
    }
  }
  for (const p of [...parseProblems, ...candidates.problems]) {
    const code = /: ([A-Z_]+) — /.exec(p)?.[1] ?? "PARSE";
    rejections.push({ locator: null, reason: code, message: p });
  }

  const acceptedSkills = candidates.skills.filter((s) => !rejectedLocators.has(skillLocator(s.skill_id)));
  const acceptedEdges = candidates.edges.filter(
    (e) =>
      !rejectedLocators.has(edgeLocator(e.job_domain_id, e.skill_id)) &&
      !rejectedLocators.has(skillLocator(e.skill_id)),
  );

  const updated = withIngestResults(manifest, {
    ingestedAt: new Date(),
    rawRecordCount: responses.length,
    acceptedCount: acceptedSkills.length + acceptedEdges.length,
    rejections,
    model: arg(argv, "--model") ?? null,
    provider: arg(argv, "--provider") ?? null,
  });

  const outDir = arg(argv, "--out") ?? dir;
  mkdirSync(outDir, { recursive: true });
  writeOut(join(outDir, "accepted-skills.jsonl"), toSkillCorpusLines(acceptedSkills));
  writeOut(join(outDir, "accepted-domain-skills.jsonl"), toEdgeCorpusLines(acceptedEdges));
  writeOut(join(dir, "rejections.jsonl"), rejections.map((r) => JSON.stringify(r)).join("\n"));
  writeOut(manifestPath, JSON.stringify(updated, null, 2));

  console.log(`[${SCRIPT}] batch ${updated.batch_id}`);
  console.log(`  responses      = ${responses.length}`);
  console.log(`  skills         = ${acceptedSkills.length} accepted / ${candidates.skills.length} proposed`);
  console.log(`  edges          = ${acceptedEdges.length} accepted / ${candidates.edges.length} proposed`);
  console.log(`  rejected       = ${rejections.length}`);
  for (const [code, n] of Object.entries(updated.rejections_by_reason ?? {}).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${code.padEnd(30)} = ${n}`);
  }
  for (const r of rejections) console.log(`  REJECT ${r.message}`);
  for (const c of context) console.log(`  NOTE   ${c} (pre-existing; not attributed to this batch)`);
  if (updated.model === null || updated.provider === null) {
    console.log(
      `[${SCRIPT}] manifest model/provider is null — this batch ran outside this process, so ` +
        `neither is known. Pass --model/--provider to record them. Token counts and cost are ` +
        `NEVER written here: they are unknown, and an invented number in an audit record is ` +
        `worse than an absent one.`,
    );
  }
  console.log(
    `[${SCRIPT}] REVIEW the accepted-*.jsonl files, then append them to ` +
      `data/taxonomy/skills.jsonl and data/taxonomy/domain-skills.jsonl. Your commit is the ` +
      `reviewer signature. Then: pnpm db:verify:taxonomy && pnpm db:seed:domain-skills.`,
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const emitTo = arg(argv, "--emit-prompts");
  const ingestFrom = arg(argv, "--ingest");

  if (!emitTo && !ingestFrom) {
    console.error(
      `[${SCRIPT}] usage:\n` +
        `  --emit-prompts <batches-dir>   create <batches-dir>/<batch_id>/ with prompts.jsonl + manifest.json\n` +
        `      [--batch-id <id>] [--trade-group <g>] [--limit <n>] [--all]\n` +
        `  --ingest <batch-dir>           validate raw-responses.jsonl into corpus lines + rejections.jsonl\n` +
        `      [--model <m>] [--provider <p>] [--out <dir>]\n` +
        `  default batches dir: ${TAXONOMY_BATCHES_DIR}`,
    );
    process.exit(1);
  }

  if (emitTo) emit(argv, emitTo);
  else ingest(argv, ingestFrom!);
}

// Guarded so importing the helpers for tests does not run the CLI.
if (process.argv[1] && /generate-domain-skills/.test(process.argv[1])) {
  main();
}
