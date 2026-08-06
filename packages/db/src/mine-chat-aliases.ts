/**
 * `pnpm db:mine:aliases` — mine vernacular alias candidates from real worker messages
 * (Phase 2, generator #2).
 *
 * THE HIGHEST-FIDELITY SOURCE THERE IS: literally the words workers typed. Generator #1
 * asks a model what a worker MIGHT say; this asks the transcript what one DID say. Its
 * blind spot is the mirror image — it can only surface trades that have already been
 * seen, so the two generators are complementary rather than redundant.
 *
 * WHY IT DOES NOT USE growth-cluster.ts, which the plan named. That pipeline exists to
 * discover UNKNOWN vocabulary: it embeds below-floor `unresolved_phrase` rows and greedily
 * clusters them because there is no target taxonomy to match against. Here there is one —
 * 4,071 published occupations — so the useful question is not "which phrases group
 * together" but "which phrases does retrieval currently MISS", which the L0/L1 resolver
 * answers exactly, for free, with no embedding spend. Clustering first would pay an embed
 * per phrase to rediscover a structure the catalogue already publishes. The growth loop
 * remains the right tool for its own job and is untouched.
 *
 * FAIL-CLOSED ON PRIVACY, and this is the part to read before changing anything.
 * `chat_messages.body_text` is raw worker free text — the most sensitive input in the
 * system. Every message goes through the ai-service pseudonymizer BEFORE it is inspected,
 * and a message the pseudonymizer BLOCKS is dropped and counted, never partially used.
 * Candidates are then filtered again for digits, '@' and URLs by the corpus validator, so
 * a phone number that somehow survived pseudonymization still cannot reach a committed
 * file. Nothing raw is ever logged: output is normalized candidate phrases plus counts.
 *
 * A CANDIDATE COMES ONLY FROM A MESSAGE THAT FAILED TO RESOLVE. If a worker's message
 * already reaches an occupation at L0 or L1, its vocabulary is by definition covered and
 * mining it would produce thousands of confirmatory n-grams that bury the real signal.
 * Filtering at the MESSAGE level rather than the phrase level is what keeps the review
 * file short enough for a human to actually read.
 *
 *   pnpm db:mine:aliases                       # report-only
 *   pnpm db:mine:aliases --min-count 3         # frequency floor (default 3)
 *   pnpm db:mine:aliases --limit 5000 --out .scratch/candidates.jsonl
 *
 * REPORT-ONLY BY DESIGN — there is no `--apply`. The output is a review file; a human
 * decides which candidates become aliases and which `job_domain_id` each attaches to,
 * because that mapping IS the business decision and no frequency count can make it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "dotenv";
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { createDbClient } from "./client";
import { hasForbiddenAliasChars, resolveJobDomainCorpus } from "./job-domain-corpus";
import { buildOccupationIndex, resolveOccupation, type OccupationIndex } from "./occupation-retrieval-eval";
import { chatMessages } from "./schema";

config();

const SCRIPT = "mine:aliases";

/** Attach the ai-service bearer when the env provides one, exactly as the three existing
 *  db runners do (`embed-job-domain-aliases.ts:53-56`). Absent = the historical open dev
 *  posture; present = required, since the service 401s every route but /health. */
const AI_HEADERS: Record<string, string> = { "content-type": "application/json" };
if (process.env.AI_INTERNAL_TOKEN) AI_HEADERS["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

/** How many recent worker messages to scan. Bounded so a mining run cannot become a
 *  full-table scan of the most sensitive table in the database. */
const DEFAULT_LIMIT = 5_000;

/** A candidate must appear this often before it is worth a reviewer's attention. The
 *  growth loop's discipline: a single occurrence is as likely to be a typo as a trade. */
const DEFAULT_MIN_COUNT = 3;

/** Candidate spans, in tokens. 1 is too noisy alone but catches "kharad"; beyond 3 a span
 *  is a sentence fragment rather than a trade name. */
const MIN_SPAN_TOKENS = 1;
const MAX_SPAN_TOKENS = 3;

/** Longest message worth mining. A worker naming their trade does it briefly; a very long
 *  message is a story, and its n-grams are noise. Also bounds the pseudonymizer payload,
 *  which rejects >20,000 chars outright. */
const MAX_MESSAGE_CHARS = 600;

export interface MinedCandidate {
  /** The normalized phrase. Never raw worker text — normalization has already run. */
  phrase: string;
  count: number;
  /** Distinct sessions it appeared in. A phrase from one talkative worker is not a trend. */
  sessions: number;
}

/**
 * Tokens that are pure conversational scaffolding. These survive normalization (they are
 * not occupational particles, so `particles.json` correctly leaves them alone) but a span
 * made only of them is never a trade name.
 *
 * Deliberately SMALL and deliberately not a general Hindi stopword list: the risk runs the
 * wrong way. Over-filtering silently deletes a real trade word — "kaam" appears inside
 * genuine compounds — so this holds only tokens that cannot be part of any occupation
 * name, and a span is dropped only when EVERY token is one.
 */
const SCAFFOLD = new Set([
  "main", "mai", "hun", "hoon", "hu", "tha", "thi", "the", "hai", "hain", "ho",
  "ka", "ki", "ke", "ko", "se", "me", "mein", "par", "pe", "aur", "ya", "bhi",
  "nahi", "nahin", "haan", "ji", "abhi", "phir", "ab", "kuch", "sab", "yah", "woh",
  "kar", "karta", "karti", "karte", "raha", "rahi", "rahe", "saal", "mahina", "din",
]);

/** Every contiguous token window in the allowed size range. */
export function candidateSpans(normalized: string): string[] {
  const tokens = normalized.split(" ").filter((t) => t.length > 0);
  const out: string[] = [];
  for (let len = MIN_SPAN_TOKENS; len <= MAX_SPAN_TOKENS; len++) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const span = tokens.slice(i, i + len);
      if (span.every((t) => SCAFFOLD.has(t))) continue;
      out.push(span.join(" "));
    }
  }
  return out;
}

/**
 * Turn resolved-nothing messages into ranked candidates.
 *
 * EXPORTED AND PURE so the whole mining decision is testable without a database, a
 * pseudonymizer or a single chat row — which matters because `chat_messages` is empty
 * today and this logic must still be provably correct before it ever sees traffic.
 */
export function mineCandidates(
  index: OccupationIndex,
  messages: { sessionId: string; text: string }[],
  minCount: number,
): { candidates: MinedCandidate[]; resolved: number; unresolved: number } {
  const counts = new Map<string, { count: number; sessions: Set<string> }>();
  let resolved = 0;
  let unresolved = 0;

  for (const m of messages) {
    // A message that already reaches an occupation is covered; mining it would bury the
    // signal under confirmatory n-grams.
    if (resolveOccupation(index, m.text) !== null) {
      resolved++;
      continue;
    }
    unresolved++;
    // NORMALIZE BEFORE SPANNING, and this is load-bearing twice over. It strips the
    // occupational particles, so "kharad ka kaam" yields the candidate `kharad` rather
    // than the three worthless windows `ka kaam`, `kharad ka` and `kharad ka kaam` — which
    // otherwise out-rank every real trade word, because every worker says them. It also
    // makes the privacy claim in this file's header TRUE: what gets counted, written and
    // logged is normalized text, never the worker's raw sentence.
    const normalized = normalizeOccupationText(m.text);
    for (const span of candidateSpans(normalized)) {
      // THE SAME PII GUARD THE CORPUS VALIDATOR APPLIES, enforced here rather than only at
      // commit time. A review file is already on disk, so a mined salary figure has left
      // the database before any validator sees it. This is not hypothetical: the first
      // real run against 14 messages proposed "30", "40 hazar" and "30 hazar" — the
      // worker's pay, extracted verbatim.
      if (hasForbiddenAliasChars(span)) continue;
      // A span that ALREADY resolves is not a gap even though its parent message did not
      // resolve — it just lost the longest-span race. Re-proposing it is noise.
      if (resolveOccupation(index, span) !== null) continue;
      const at = counts.get(span);
      if (at === undefined) counts.set(span, { count: 1, sessions: new Set([m.sessionId]) });
      else {
        at.count++;
        at.sessions.add(m.sessionId);
      }
    }
  }

  const candidates = [...counts.entries()]
    .map(([phrase, v]) => ({ phrase, count: v.count, sessions: v.sessions.size }))
    // Ranked by DISTINCT SESSIONS first: ten workers saying a word once is a trade, one
    // worker saying it ten times is a habit.
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.phrase.localeCompare(b.phrase));

  return { candidates, resolved, unresolved };
}

/** Raised when the pseudonymizer cannot be reached at all. Deliberately distinct from a
 *  blocked message — see `pseudonymizeOne`. */
class PseudonymizerUnreachable extends Error {}

/**
 * Pseudonymize one message. Returns null when the service BLOCKED it — the fail-closed
 * path, where the message is dropped and counted.
 *
 * A TRANSPORT FAILURE IS NOT A BLOCK, and conflating the two is the dangerous bug this
 * function is shaped to avoid. If an unreachable ai-service returned null like a block
 * does, every message would be "blocked", the run would report zero candidates, and that
 * empty result reads exactly like "the corpus already covers everything" — a false all-
 * clear on the one job this script exists to do. So: fail CLOSED on a block (drop one
 * message, keep going), fail LOUD on unreachable (abort the run).
 */
async function pseudonymizeOne(aiBase: string, text: string): Promise<string | null> {
  let resp: Response;
  try {
    // `/pseudonymize`, not `/privacy/pseudonymize` — privacy.api_router is included with
    // NO prefix (main.py:139), so the router's filename is not part of the path.
    resp = await fetch(`${aiBase}/pseudonymize`, {
      method: "POST",
      headers: AI_HEADERS,
      body: JSON.stringify({ text }),
    });
  } catch (cause) {
    throw new PseudonymizerUnreachable(
      `cannot reach the pseudonymizer at ${aiBase}. Mining raw worker messages without it ` +
        `is not permitted, so this run stops. Start the ai-service (pnpm dev:ai) or set ` +
        `AI_SERVICE_URL.`,
      { cause },
    );
  }
  // ONLY A 200 CARRIES A VERDICT. Any other status is the service refusing to answer —
  // 401 because AI_INTERNAL_TOKEN is unset here, 5xx because it is failing, 404 because
  // the route moved — and none of those say anything about the text. Counting them as
  // blocks is how a misconfigured run prints "0 candidates" and reads as "the corpus
  // already covers everything". This exact case was hit in development: every message
  // came back 401 and the summary showed 14 blocked, 0 mined, no error.
  if (!resp.ok) {
    throw new PseudonymizerUnreachable(
      `pseudonymizer returned ${resp.status}. That is a refusal to answer, not a verdict on ` +
        `the text, so this run stops rather than reporting an empty result as success.` +
        (resp.status === 401 ? " Set AI_INTERNAL_TOKEN to the ai-service's value." : ""),
    );
  }
  // The field is `pseudonymized_text`, NOT `text` — see PseudonymizationOutput in
  // apps/ai-service/app/contracts.py. Reading the wrong key here does not throw: it
  // yields undefined, which this function would report as a block, which would drop
  // EVERY message and print "0 candidates" as though the corpus were already complete.
  // Verified against the contract rather than assumed.
  const body = (await resp.json()) as { blocked?: boolean; pseudonymized_text?: string };
  if (body.blocked === true || typeof body.pseudonymized_text !== "string") return null;
  return body.pseudonymized_text;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = Number(arg(argv, "--limit") ?? DEFAULT_LIMIT);
  const minCount = Number(arg(argv, "--min-count") ?? DEFAULT_MIN_COUNT);
  const outTo = arg(argv, "--out");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

  const index = buildOccupationIndex(resolveJobDomainCorpus());
  const { db, sql } = createDbClient(databaseUrl, { max: 1 });

  try {
    // `inbound` is the worker; outbound is our own question text. Mining our own prompts
    // would manufacture aliases out of the vocabulary we already chose — the same
    // self-confirmation the parse gates reject at role level.
    const rows = await db
      .select({ sessionId: chatMessages.sessionId, bodyText: chatMessages.bodyText })
      .from(chatMessages)
      .where(and(eq(chatMessages.direction, "inbound"), isNotNull(chatMessages.bodyText)))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    console.log(`[${SCRIPT}] fetched ${rows.length} inbound message(s) (limit ${limit})`);
    if (rows.length === 0) {
      console.log(
        `[${SCRIPT}] nothing to mine — chat_messages holds no inbound rows. ` +
          `This generator needs production traffic; until then generator #1 ` +
          `(pnpm db:gen:aliases) is the corpus source.`,
      );
      return;
    }

    const clean: { sessionId: string; text: string }[] = [];
    let blocked = 0;
    for (const r of rows) {
      const raw = (r.bodyText ?? "").slice(0, MAX_MESSAGE_CHARS);
      if (raw.trim().length === 0) continue;
      const safe = await pseudonymizeOne(aiBase, raw);
      // FAIL CLOSED: a message the pseudonymizer would not clear is dropped whole. It is
      // never partially mined and never logged.
      if (safe === null) {
        blocked++;
        continue;
      }
      clean.push({ sessionId: r.sessionId, text: safe });
    }

    const { candidates, resolved, unresolved } = mineCandidates(index, clean, minCount);

    console.log(`[${SCRIPT}] summary:`);
    console.log(`  pseudonymizer blocked      = ${blocked}`);
    console.log(`  already resolved (covered) = ${resolved}`);
    console.log(`  unresolved (mined)         = ${unresolved}`);
    console.log(`  candidates >= ${minCount}          = ${candidates.length}`);

    const body = candidates.map((c) => JSON.stringify(c)).join("\n");
    if (outTo) {
      const dir = dirname(outTo);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outTo, `${body}\n`, "utf8");
      console.log(`[${SCRIPT}] wrote ${candidates.length} candidate(s) to ${outTo}`);
    } else {
      for (const c of candidates.slice(0, 50)) {
        // FULLY LITERAL FORMAT STRING, every value an argument. The phrase is
        // worker-derived — normalized and pseudonymized, but still whatever someone typed
        // — so interpolating it would let a worker's "%s" forge lines in an operator's
        // console. console.log honours specifiers only in its first argument, and a first
        // argument with no interpolation at all is the only form that is both safe and
        // obviously safe to a reader (and to semgrep, which is purely syntactic here).
        console.log("  %s sessions  %sx  %s", String(c.sessions).padStart(4), String(c.count).padStart(4), c.phrase);
      }
    }
    console.log(
      `[${SCRIPT}] REVIEW-ONLY. Attach each accepted phrase to a job_domain_id by hand in ` +
        `data/job-domains/rvm-aliases.jsonl — that mapping is a business decision, not a count.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Guarded so importing `mineCandidates`/`candidateSpans` for tests does not open a
// database connection — the footgun that took `verify-job-domains.ts` down in CI.
if (process.argv[1] && /mine-chat-aliases/.test(process.argv[1])) {
  main().catch((err) => {
    // An unreachable pseudonymizer is an operator problem with an obvious fix, not a bug.
    // Printing a stack trace for it buries the one line that says what to do.
    if (err instanceof PseudonymizerUnreachable) {
      console.error(`[${SCRIPT}] ABORTED — ${err.message}`);
      process.exit(1);
    }
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
