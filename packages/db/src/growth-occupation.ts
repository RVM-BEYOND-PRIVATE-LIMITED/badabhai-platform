/**
 * `pnpm db:growth:occupation` — the OCCUPATION half of the growth loop (OIE Phase 9).
 *
 * The plan's loop is one sentence: `count >= N` -> ops queue -> `rvm` alias -> the next worker
 * who says that word hits L0 for free. This runner is the middle arrow.
 *
 *   pnpm db:growth:occupation                  # report-only packet
 *   pnpm db:growth:occupation --min-count 3    # raise/lower the promotion floor
 *   pnpm db:growth:occupation --apply          # also mark emitted rows 'clustered'
 *   pnpm db:growth:occupation --reopen         # clustered -> open (rejected/lost packets)
 *
 * WHY THIS IS NOT `db:growth:cluster` WITH A FLAG. That runner embeds phrases and clusters them
 * against the `skill_alias` anchor set, because an unresolved SKILL is usually a near-miss on a
 * skill we already have — the vector is what finds the neighbour. An unresolved OCCUPATION is
 * the opposite situation by construction: retrieval already ran L0, L1, L2 and L3 over the whole
 * catalogue and came back with nothing above the floor. Embedding it again to look for a
 * neighbour would repeat, at cost, the search that just failed.
 *
 * So there is no clustering here and no embedding call. What ops needs is the ranked list of
 * words workers actually used that the catalogue does not understand — and the ranking IS the
 * signal: one worker saying "kharad" is noise, forty saying it is a missing alias on
 * `jd_nco_7223_*` worth more than any similarity score.
 *
 * THE TARGET IS DELIBERATELY BLANK. Every proposal renders `job_domain_id` as a TODO for a human
 * to fill. Guessing it would be the one thing this whole engine exists to prevent: a machine
 * inventing an occupation for a worker from a phrase nothing could match. SG-5 — no id is minted
 * here, and this runner activates NOTHING. The only activation path is the existing one: a human
 * pastes into `rvm-aliases.jsonl`, `db:seed:domains --apply` inserts, `db:normalize:aliases`
 * backfills `text_norm`, and the phrase resolves at L0 from then on.
 *
 * PRIVACY: `unresolved_phrase.phrase` is written pseudonymized by `IdentifyService` (it calls
 * `ai.pseudonymize()` before `recordUnresolved`, and skips the write entirely when the
 * pseudonymizer is unreachable). It is nonetheless HOSTILE free text, so it is sanitized at
 * render exactly as the skill packet does — it must not be able to forge markdown structure in
 * the document a human ratifies from.
 *
 * GUARDED: refuses `NODE_ENV === "production"` (ops action, deliberately gated).
 */
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { createDbClient } from "./client";
import { unresolvedPhrases } from "./schema";

config({ path: "../../.env" });

const SCRIPT = "growth:occupation";

/**
 * The default promotion floor.
 *
 * THREE, not one. A single unmatched utterance is far more likely to be a typo, a joke, or a
 * worker describing their employer than a gap in a 4,071-row catalogue — promoting those buries
 * the real signal in noise the reviewer has to clear every week. Three independent workers
 * reaching for the same word is the cheapest available evidence that the word is real.
 *
 * Overridable because the right floor depends on traffic: at launch volumes 3 is generous, and
 * once the catalogue is being hit by a million workers it will need raising. That is a Phase 9+
 * calibration question against real data, which is exactly why it is a flag and not a constant.
 */
const DEFAULT_MIN_COUNT = 3;

/** Rows per packet. A reviewer works a list, not a firehose. */
const MAX_PROPOSALS = 200;

const REPORT_PATH =
  process.env.OCCUPATION_GROWTH_REPORT_PATH ??
  path.join("..", "..", "docs", "registers", "occupation-growth-proposals.md");

/**
 * Sanitize QUEUE-DERIVED text before it enters the markdown packet.
 *
 * Mirrors `growth-cluster.ts`'s `safeText` deliberately rather than importing it: the two
 * packets are separate documents with separate fences, and a shared helper would couple the
 * render rules of two files that are allowed to diverge. Strip control characters and newlines
 * (no forged headings or fences), replace backticks (cannot close the ```jsonl block), clamp.
 */
function safeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/`/g, "'");
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

/** `--min-count N`, falling back to the default when absent or unparseable. */
export function parseMinCount(argv: readonly string[], fallback = DEFAULT_MIN_COUNT): number {
  const idx = argv.indexOf("--min-count");
  if (idx < 0) return fallback;
  const parsed = Number(argv[idx + 1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface OccupationPhraseRow {
  id: string;
  phrase: string;
  lang: string | null;
  count: number;
}

/**
 * Render the ops packet.
 *
 * Exported for tests: the render is where hostile input meets a document a human trusts, so it
 * is worth asserting directly rather than only through a live-DB run.
 */
export function renderPacket(rows: readonly OccupationPhraseRow[], minCount: number): string {
  const lines: string[] = [
    "# Occupation growth proposals",
    "",
    "> GENERATED by `pnpm db:growth:occupation`. Do not edit by hand — re-run instead.",
    "",
    "Words workers used for their own trade that the catalogue could not match at ANY retrieval",
    "layer (L0 exact, L1 skeleton, L2 trigram, L3 vector). Ranked by how many distinct workers",
    "reached for them.",
    "",
    `Floor: \`count >= ${minCount}\`. Rows below it stay open and re-surface as they grow.`,
    "",
    "## How to ratify",
    "",
    "1. For each row below, decide the `job_domain_id` it belongs to — or reject it.",
    "   `db:audit:domains` and the catalogue in `packages/db/data/job-domains/` are the reference.",
    "2. Paste the accepted lines into `packages/db/data/job-domains/rvm-aliases.jsonl`,",
    "   replacing `TODO_job_domain_id`.",
    "3. `pnpm db:seed:domains --apply` then `pnpm db:normalize:aliases`.",
    "4. `pnpm db:eval:occupation` to confirm the retrieval gate still passes.",
    "5. `pnpm db:growth:occupation --apply` to close these rows.",
    "",
    "**The target is blank on purpose.** Retrieval already searched the whole catalogue and found",
    "nothing; a machine filling this in would be inventing an occupation for a worker from a phrase",
    "nothing could match — the single failure mode this engine exists to prevent.",
    "",
  ];

  if (rows.length === 0) {
    lines.push(`_No occupation phrase has reached the floor of ${minCount}. Nothing to review._`, "");
    return lines.join("\n");
  }

  lines.push(`## ${rows.length} proposal(s)`, "", "| workers | lang | phrase |", "|---:|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.count} | ${safeText(r.lang ?? "-")} | ${safeText(r.phrase)} |`);
  }
  lines.push("", "### Paste-ready", "", "```jsonl");
  for (const r of rows) {
    lines.push(
      JSON.stringify({
        kind: "alias",
        job_domain_id: "TODO_job_domain_id",
        text: safeText(r.phrase),
        lang: r.lang ?? "hi",
      }),
    );
  }
  lines.push("```", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[${SCRIPT}] refusing to run in production (run is §7-gated ops).`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is required.`);

  const apply = process.argv.includes("--apply");
  const minCount = parseMinCount(process.argv);
  const { db, sql } = createDbClient(url, { max: 1 });

  try {
    // --reopen: clustered → open. The recovery for rejected proposals and lost packets, and the
    // reason the status machine is not a one-way door. Scoped, so it cannot reopen skill rows.
    if (process.argv.includes("--reopen")) {
      const reopened = await db
        .update(unresolvedPhrases)
        .set({ status: "open" })
        .where(
          and(
            eq(unresolvedPhrases.scope, "occupation"),
            eq(unresolvedPhrases.status, "clustered"),
          ),
        )
        .returning({ id: unresolvedPhrases.id });
      console.log(`[${SCRIPT}] reopened ${reopened.length} row(s) → open; re-run to re-propose.`);
      return;
    }

    const rows = await db
      .select({
        id: unresolvedPhrases.id,
        phrase: unresolvedPhrases.phrase,
        lang: unresolvedPhrases.lang,
        count: unresolvedPhrases.count,
      })
      .from(unresolvedPhrases)
      .where(
        and(
          eq(unresolvedPhrases.scope, "occupation"),
          eq(unresolvedPhrases.status, "open"),
          gte(unresolvedPhrases.count, minCount),
        ),
      )
      .orderBy(desc(unresolvedPhrases.count))
      .limit(MAX_PROPOSALS);

    console.log(`[${SCRIPT}] ${rows.length} phrase(s) at or above count ${minCount}.`);

    const packet = renderPacket(rows, minCount);
    const out = path.resolve(REPORT_PATH);
    // One backup slot, mirroring the skill packet. The DB rows are the source of truth, so a
    // lost packet is always regenerable via `--reopen` + a re-run.
    if (existsSync(out)) copyFileSync(out, out.replace(/\.md$/, ".prev.md"));
    writeFileSync(out, packet, "utf8");
    console.log(`[${SCRIPT}] packet written to ${out}`);

    if (!apply) {
      console.log(
        `[${SCRIPT}] REPORT-ONLY — ${rows.length} row(s) left open. ` +
          `Re-run with --apply AFTER the packet is triaged.`,
      );
      return;
    }
    if (rows.length === 0) {
      console.log(`[${SCRIPT}] --apply with nothing to close; no rows changed.`);
      return;
    }
    const closed = await db
      .update(unresolvedPhrases)
      .set({ status: "clustered" })
      .where(
        inArray(
          unresolvedPhrases.id,
          rows.map((r) => r.id),
        ),
      )
      .returning({ id: unresolvedPhrases.id });
    console.log(`[${SCRIPT}] APPLY — ${closed.length} row(s) open → clustered.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /growth-occupation/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
