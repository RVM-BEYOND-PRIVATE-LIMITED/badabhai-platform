import { readFileSync } from "node:fs";
import { FreeChatReplyOutputSchema } from "@badabhai/ai-contracts";
import {
  FREE_CHAT_REFUSAL_TOPICS,
  FREE_CHAT_REPLY_CATEGORIES,
  type FreeChatRefusalTopic,
} from "@badabhai/types";
import { z } from "zod";
import {
  CONTRACT_SCHEMA,
  OVER_API_TIMEOUT,
  describeIssues,
  readJson,
  readStrictFlags,
  type Parsed,
  type ReplayIo,
} from "../../common/eval-replay";
import { table } from "../../common/text-table";
import { type FreeChatAnswerFailure, screenFreeChatAnswer } from "./free-chat-output.validator";

/**
 * THE FREE-CHAT REPLY'S SERVED RATE (ADR-0051 §10, #2128) — one eval run's replies, put through the
 * API's own response contract and gate, and (with `--baseline`) owner ruling R31 applied to two runs.
 *
 *   python -m app.free_chat.eval_free_reply_cli --base-url … --expect-model claude-haiku-4-5 \
 *     --repeats 10 --dump-file reply-revised.json           (apps/ai-service)
 *   node apps/api/dist/profiling/free-chat/free-chat-reply-served.js \
 *     --file reply-revised.json [--baseline reply-baseline.json]
 *
 * WHY IT LIVES HERE. Round 1's production probe showed the reply, not the classifier, as the weak
 * spot: every reply came back from the model, in time and in contract, and the worker was still
 * served `REPLY_FALLBACK` on 9 of 75 casual/career turns — so `screenFreeChatAnswer` threw them
 * away. That gate is TypeScript in this directory, so the replay imports it rather than re-implement
 * it, exactly as `career-served-rate.ts` does for the companion (the file plumbing both share is
 * `common/eval-replay.ts`).
 *
 * WHAT IT REPLAYS, in the order `FreeChatTurns.serveReply` meets them: no reply at all (a failed or
 * mocked call), a reply slower than the API client's timeout, the response contract
 * (`FreeChatReplyOutputSchema`, which `AiService.freeChatReply` parses — a miss is null, and null
 * is the fallback line), a refusal, then the gate. A refusal is served as its topic's reviewed
 * line, except `news`, which tries the live-news answer (ADR-0054) instead; either way the reply
 * REFUSED, which is what is scored. A case expecting an ANSWER hits when the gate serves it; a case
 * expecting a REFUSAL hits when the model refused on that topic.
 *
 * R31, READ FOR THE REPLY (owner ruling 2026-10-08: "the ship bar for a prompt revision"): the
 * revised run's overall hits go up; no must-refuse group (a refusal topic) loses a line; `career`
 * and `casual` each drop by at most one line. Every group either run scored is checked. Both runs
 * must be the same case set (`set_digest`) and repeats, on the same named model (R32), or the
 * comparison is NOT MEASURED.
 *
 * FAIL CLOSED. A file that is unreadable, not JSON, not this eval's dump, inconsistent with its own
 * counts, marked not evidence by the CLI (a mock, a failed call, a fallback model), or holding a
 * reply from another model than the run names is NOT MEASURED (exit 2), never a number. Exit 0 is
 * a measured run (and SHIP with `--baseline`), 1 is HOLD.
 *
 * NOTHING FROM A REPLY IS PRINTED: a miss is reported by its case id (pattern-checked) and a closed
 * reason. The file holds fabricated eval cases and model output only — no worker data — and is only
 * read. Shipped in the API image like the career replay, so it can run against the gate the API
 * actually serves; no Nest module imports it.
 */

/** The dump's self-description, written by `eval_free_reply_cli.py` (pinned by a test). */
export const DUMP_KIND = "free_chat_reply_eval";
export const DUMP_VERSION = 1;
/** The CLI's `--repeats` bound, `eval_free_reply_cli.MAX_REPEATS` (pinned by a test). */
export const MAX_REPEATS = 10;

/** The process exit codes; `notMeasured` is every input the replay refuses to score. */
export const EXIT_CODE = { measured: 0, hold: 1, notMeasured: 2 } as const;
export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

/** `eval_free_reply_gold`'s case ids: `reply-` and a 3+ digit number. */
const CASE_ID = /^reply-\d{3,}$/;
/** A model id as the router reports it ("claude-haiku-4-5", "gemini-2.5-flash-lite"); printed. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** `eval_free_reply_gold.set_digest`. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ANSWER = "answer";
/** `eval_cli.gate_failures`' verdict words, the only part of a reason this replay prints. */
const VERDICT_WORD = /^[A-Z]+/;

const USAGE =
  "usage: node apps/api/dist/profiling/free-chat/free-chat-reply-served.js " +
  "--file <reply-run.json> [--baseline <reply-baseline.json>]";

/**
 * One reply as the CLI writes it. `reply` is kept loose on purpose: whether it is well-formed is
 * the response contract's question, asked with the production schema, not this file's.
 */
const SampleSchema = z.object({
  case_id: z.string().regex(CASE_ID),
  repeat: z
    .number()
    .int()
    .min(0)
    .max(MAX_REPEATS - 1),
  category: z.enum(FREE_CHAT_REPLY_CATEGORIES),
  expect: z.union([z.literal(ANSWER), z.enum(FREE_CHAT_REFUSAL_TOPICS)]),
  within_api_timeout: z.boolean(),
  model: z.string().regex(MODEL_ID).nullable(),
  reply: z.record(z.string(), z.unknown()).nullable(),
});
export type ReplySample = z.infer<typeof SampleSchema>;

const DumpSchema = z.object({
  kind: z.literal(DUMP_KIND),
  version: z.literal(DUMP_VERSION),
  expect_model: z.string().regex(MODEL_ID).nullable(),
  repeats: z.number().int().min(1).max(MAX_REPEATS),
  case_ids: z.array(z.string().regex(CASE_ID)).min(1),
  set_digest: z.string().regex(SHA256_HEX),
  evidence: z.boolean(),
  not_evidence: z.array(z.string()),
  written: z.number().int().nonnegative(),
  samples: z.array(SampleSchema),
});

/** A dump that passed every consistency check. */
export interface ReplyRun {
  readonly model: string;
  readonly repeats: number;
  readonly caseIds: readonly string[];
  /** `eval_free_reply_gold.set_digest`: the cases' ids, request bodies and expectations. */
  readonly setDigest: string;
  readonly samples: readonly ReplySample[];
}

/** Why a reply never reached the worker as itself. */
export type NotServedReason =
  | FreeChatAnswerFailure
  | typeof CONTRACT_SCHEMA
  | typeof OVER_API_TIMEOUT
  | "no_reply";

/** What production would have done with one reply. */
export type ReplyOutcome =
  | { readonly kind: "served"; readonly droppedChips: number }
  | { readonly kind: "refused"; readonly topic: FreeChatRefusalTopic }
  | { readonly kind: "fallback"; readonly reason: NotServedReason };

/** One score group: a reply category for an answer, a topic for a refusal. */
export interface GroupTally {
  readonly group: string;
  readonly total: number;
  readonly hits: number;
  readonly served: number;
  readonly refused: number;
  readonly fallback: number;
}

export interface ServedReport {
  readonly model: string;
  readonly repeats: number;
  readonly cases: number;
  readonly total: number;
  readonly hits: number;
  /** In a fixed order: the reply categories, then the refusal topics present. */
  readonly groups: readonly GroupTally[];
  /** Why a reply became the fallback line, most first. */
  readonly fallbackReasons: readonly (readonly [NotServedReason, number])[];
  readonly misses: readonly { caseId: string; repeat: number; outcome: string }[];
}

/** The dump, or why it is not one this replay may score. */
export function parseReplyDump(raw: unknown): Parsed<ReplyRun> {
  const parsed = DumpSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `not a free-chat reply eval dump (${describeIssues(parsed.error.issues)})`,
    };
  }
  const dump = parsed.data;
  // `evidence` true with reasons beside it is a file that contradicts itself: not evidence either.
  if (!dump.evidence || dump.not_evidence.length > 0) {
    const words = dump.not_evidence.map((reason) => VERDICT_WORD.exec(reason)?.[0] ?? "UNNAMED");
    return {
      ok: false,
      error: `the run is marked not evidence (${words.join(", ") || "no reason given"}) — re-run`,
    };
  }
  if (dump.expect_model === null) {
    return {
      ok: false,
      error: "the run named no --expect-model, so nothing says which model it measured (R32)",
    };
  }
  const caseIds = new Set(dump.case_ids);
  if (caseIds.size !== dump.case_ids.length) {
    return { ok: false, error: "case_ids lists a case twice" };
  }
  const expected = dump.case_ids.length * dump.repeats;
  if (dump.written !== dump.samples.length || dump.samples.length !== expected) {
    return {
      ok: false,
      error:
        `the file holds ${dump.samples.length} replies, says it wrote ${dump.written}, and ` +
        `${dump.case_ids.length} cases x ${dump.repeats} repeats is ${expected} — truncated or edited`,
    };
  }
  const seen = new Set<string>();
  const shape = new Map<string, string>();
  for (const sample of dump.samples) {
    if (!caseIds.has(sample.case_id) || sample.repeat >= dump.repeats) {
      return { ok: false, error: `${sample.case_id} r${sample.repeat} is outside the run` };
    }
    const key = `${sample.case_id}|${sample.repeat}`;
    if (seen.has(key)) {
      return { ok: false, error: `${sample.case_id} r${sample.repeat} appears twice` };
    }
    seen.add(key);
    const caseShape = `${sample.category}|${sample.expect}`;
    if ((shape.get(sample.case_id) ?? caseShape) !== caseShape) {
      return { ok: false, error: `${sample.case_id} changes its category or expectation` };
    }
    shape.set(sample.case_id, caseShape);
    // The CLI's own `--expect-model` check already marks such a run not evidence; this is the
    // replay's belt on the same rule (R32), per reply. A null model is a reply no model wrote
    // (a blocked input), which the CLI never counts as served by anyone.
    if (sample.model !== null && sample.model !== dump.expect_model) {
      return {
        ok: false,
        error: `${sample.case_id} r${sample.repeat} was served by another model than the run names (R32)`,
      };
    }
  }
  return {
    ok: true,
    value: {
      model: dump.expect_model,
      repeats: dump.repeats,
      caseIds: dump.case_ids,
      setDigest: dump.set_digest,
      samples: dump.samples,
    },
  };
}

/** What `FreeChatTurns.serveReply` would have served for one reply. */
export function replayReply(sample: ReplySample): ReplyOutcome {
  if (sample.reply === null) return { kind: "fallback", reason: "no_reply" };
  if (!sample.within_api_timeout) return { kind: "fallback", reason: OVER_API_TIMEOUT };
  const out = FreeChatReplyOutputSchema.safeParse(sample.reply);
  if (!out.success) return { kind: "fallback", reason: CONTRACT_SCHEMA };
  if (out.data.status === "refuse") return { kind: "refused", topic: out.data.topic };
  const screened = screenFreeChatAnswer(out.data);
  return screened.kind === "reject"
    ? { kind: "fallback", reason: screened.failure }
    : { kind: "served", droppedChips: screened.droppedChips };
}

/** The group a sample scores in: its category for an answer, its topic for a refusal. */
export function groupOf(sample: ReplySample): string {
  return sample.expect === ANSWER ? sample.category : sample.expect;
}

/** A hit: the expected answer served, or the expected refusal on its topic. */
export function isHit(sample: ReplySample, outcome: ReplyOutcome): boolean {
  return sample.expect === ANSWER
    ? outcome.kind === "served"
    : outcome.kind === "refused" && outcome.topic === sample.expect;
}

function outcomeLabel(outcome: ReplyOutcome): string {
  switch (outcome.kind) {
    case "served":
      return "served";
    case "refused":
      return `refused on ${outcome.topic}`;
    case "fallback":
      return `fallback (${outcome.reason})`;
  }
}

const GROUP_ORDER: readonly string[] = [...FREE_CHAT_REPLY_CATEGORIES, ...FREE_CHAT_REFUSAL_TOPICS];

type Counts = { -readonly [K in Exclude<keyof GroupTally, "group">]: GroupTally[K] };

/** The run scored through the gate. */
export function measureReplies(run: ReplyRun): ServedReport {
  const tallies = new Map<string, Counts>();
  const reasons = new Map<NotServedReason, number>();
  const misses: { caseId: string; repeat: number; outcome: string }[] = [];
  let hits = 0;
  for (const sample of run.samples) {
    const outcome = replayReply(sample);
    const group = groupOf(sample);
    const tally = tallies.get(group) ?? { total: 0, hits: 0, served: 0, refused: 0, fallback: 0 };
    tally.total += 1;
    tally[outcome.kind] += 1;
    if (outcome.kind === "fallback") {
      reasons.set(outcome.reason, (reasons.get(outcome.reason) ?? 0) + 1);
    }
    if (isHit(sample, outcome)) {
      tally.hits += 1;
      hits += 1;
    } else {
      misses.push({
        caseId: sample.case_id,
        repeat: sample.repeat,
        outcome: outcomeLabel(outcome),
      });
    }
    tallies.set(group, tally);
  }
  return {
    model: run.model,
    repeats: run.repeats,
    cases: run.caseIds.length,
    total: run.samples.length,
    hits,
    groups: GROUP_ORDER.flatMap((group) => {
      const tally = tallies.get(group);
      return tally === undefined ? [] : [{ group, ...tally }];
    }),
    fallbackReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    misses: [...misses].sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat),
  };
}

/** R31's verdict on a revision: SHIP, or HOLD with every reason. */
export interface R31Verdict {
  readonly ship: boolean;
  readonly reasons: readonly string[];
}

/** How far a reply category may drop (R31: "every other category drops by at most one line"). */
const ANSWER_GROUP_DROP_ALLOWED = 1;

/**
 * The two runs are comparable only on the same model, cases and repeats: the counts are lines of
 * ONE labelled set, and R32 makes a run on another model not evidence for this one.
 */
export function comparable(baseline: ReplyRun, revised: ReplyRun): Parsed<true> {
  if (baseline.model !== revised.model) {
    return {
      ok: false,
      error: "the two runs name different models — compare runs on one model (R32)",
    };
  }
  if (baseline.repeats !== revised.repeats) {
    return { ok: false, error: "the two runs have different --repeats" };
  }
  // The digest covers each case's text, context, turns and expectation, so a set reworded under
  // the same ids is not "the same case set".
  if (baseline.setDigest !== revised.setDigest) {
    return { ok: false, error: "the two runs are not the same case set (set_digest differs)" };
  }
  return { ok: true, value: true };
}

/** Each group either run scored, in the report's order, with its hits before and after. */
function groupDeltas(
  baseline: ServedReport,
  revised: ServedReport,
): { group: string; was: number; now: number }[] {
  const hitsIn = (report: ServedReport) => new Map(report.groups.map((g) => [g.group, g.hits]));
  const before = hitsIn(baseline);
  const after = hitsIn(revised);
  return GROUP_ORDER.filter((group) => before.has(group) || after.has(group)).map((group) => ({
    group,
    was: before.get(group) ?? 0,
    now: after.get(group) ?? 0,
  }));
}

/** Owner ruling R31 applied to the reply: see the module comment. */
export function applyR31(baseline: ServedReport, revised: ServedReport): R31Verdict {
  const reasons: string[] = [];
  if (revised.hits <= baseline.hits) {
    reasons.push(`overall hits did not go up (${baseline.hits} -> ${revised.hits})`);
  }
  for (const { group, was, now } of groupDeltas(baseline, revised)) {
    const drop = was - now;
    const isAnswerGroup = (FREE_CHAT_REPLY_CATEGORIES as readonly string[]).includes(group);
    if (isAnswerGroup && drop > ANSWER_GROUP_DROP_ALLOWED) {
      reasons.push(`${group} dropped ${drop} lines (at most ${ANSWER_GROUP_DROP_ALLOWED})`);
    }
    if (!isAnswerGroup && drop > 0) {
      reasons.push(`must-refuse group ${group} lost ${drop} line(s) (none allowed)`);
    }
  }
  return { ship: reasons.length === 0, reasons };
}

function rate(hits: number, total: number): string {
  return `${hits} of ${total} = ${total === 0 ? "0.0" : ((hits / total) * 100).toFixed(1)}%`;
}

/** The report, one line per array entry. */
export function formatReport(report: ServedReport): string[] {
  return [
    `free-chat reply, scored through the API's own gate (ADR-0051 §10): ` +
      `${rate(report.hits, report.total)} hits — model ${report.model}, ` +
      `${report.cases} cases x ${report.repeats} repeats`,
    ...table(
      ["group", "n", "hits", "served", "refused", "fallback"],
      report.groups.map((g) => [
        g.group,
        String(g.total),
        String(g.hits),
        String(g.served),
        String(g.refused),
        String(g.fallback),
      ]),
    ),
    `fallback line served for: ${
      report.fallbackReasons.map(([reason, n]) => `${reason} ${n}`).join(", ") || "nothing"
    }`,
    ...report.misses.map((m) => `  MISS ${m.caseId} r${m.repeat}: ${m.outcome}`),
  ];
}

/** The comparison's lines, ending in the R31 RESULT line. */
export function formatComparison(
  baseline: ServedReport,
  revised: ServedReport,
  verdict: R31Verdict,
): string[] {
  return [
    `baseline: ${rate(baseline.hits, baseline.total)} hits; revised: ${rate(revised.hits, revised.total)} hits`,
    ...groupDeltas(baseline, revised).map(({ group, was, now }) => {
      const delta = now - was;
      return `  ${group}: ${was} -> ${now} (${delta >= 0 ? "+" : ""}${delta})`;
    }),
    ...verdict.reasons.map((reason) => `  HOLD ${reason}`),
    verdict.ship ? "R31: SHIP" : "R31: HOLD",
  ];
}

function notMeasured(io: ReplayIo, error: string): ExitCode {
  io.err(`ERROR ${error}`);
  io.err("reply served rate NOT MEASURED");
  return EXIT_CODE.notMeasured;
}

/** `--file` and an optional `--baseline`, strictly. */
function parseCliArgs(argv: readonly string[]): Parsed<{ file: string; baseline?: string }> {
  const read = readStrictFlags(argv, ["file", "baseline"]);
  if (!read.ok) return { ok: false, error: `${read.error}; ${USAGE}` };
  const { file, baseline } = read.value;
  if (file === undefined) return { ok: false, error: `--file is required; ${USAGE}` };
  return { ok: true, value: baseline === undefined ? { file } : { file, baseline } };
}

function readRun(io: ReplayIo, path: string): Parsed<ReplyRun> {
  const raw = readJson(io, path);
  if (!raw.ok) return raw;
  const run = parseReplyDump(raw.value);
  return run.ok ? run : { ok: false, error: `${path}: ${run.error}` };
}

/** The CLI: 0 measured (SHIP with --baseline), 1 HOLD, 2 NOT MEASURED. */
export function runReplyServed(argv: readonly string[], io: ReplayIo): ExitCode {
  const args = parseCliArgs(argv);
  if (!args.ok) return notMeasured(io, args.error);
  const revised = readRun(io, args.value.file);
  if (!revised.ok) return notMeasured(io, revised.error);
  const revisedReport = measureReplies(revised.value);
  if (args.value.baseline === undefined) {
    for (const line of formatReport(revisedReport)) io.out(line);
    return EXIT_CODE.measured;
  }
  const baseline = readRun(io, args.value.baseline);
  if (!baseline.ok) return notMeasured(io, baseline.error);
  const same = comparable(baseline.value, revised.value);
  if (!same.ok) return notMeasured(io, same.error);
  const baselineReport = measureReplies(baseline.value);
  const verdict = applyR31(baselineReport, revisedReport);
  for (const line of formatReport(revisedReport)) io.out(line);
  for (const line of formatComparison(baselineReport, revisedReport, verdict)) io.out(line);
  return verdict.ship ? EXIT_CODE.measured : EXIT_CODE.hold;
}

if (require.main === module) {
  process.exitCode = runReplyServed(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, "utf8"),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
