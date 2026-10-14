import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReplayIo } from "../../common/eval-replay";
import {
  applyR31,
  comparable,
  DUMP_KIND,
  DUMP_VERSION,
  EXIT_CODE,
  formatReport,
  isHit,
  MAX_REPEATS,
  measureReplies,
  parseReplyDump,
  replayReply,
  runReplyServed,
  type ReplyRun,
  type ReplySample,
} from "./free-chat-reply-served";

const REPO = join(__dirname, "..", "..", "..", "..", "..");

/** Fabricated reply lines: a clean answer the gate serves, and the shapes it throws away. */
const CLEAN = [
  "Aam taur par ₹14,000 se ₹20,000 mahina milta hai.",
  "Shehar aur tajurbe par depend karta hai.",
];
const TWO_QUESTIONS = ["Namaste, aap kaise hain?", "Aaj ka kaam kaisa raha?"];
const PERSONA = ["Yeh bahut acha hunar hai, iski maang hai."];
/** A fabricated `set_digest` (sha256 hex): one case set. */
const DIGEST = "a".repeat(64);
/** A marker no report line may ever carry: replies are model text and are never printed. */
const SECRET_LINE = "Zebra quartz marker line jo kabhi print nahi honi chahiye.";

const answer = (lines: string[], chips: string[] = []) => ({
  status: "answer",
  lines,
  followup_chips: chips,
});
const refuse = (topic: string) => ({ status: "refuse", topic });

function sample(overrides: Partial<ReplySample> & Pick<ReplySample, "case_id">): ReplySample {
  return {
    repeat: 0,
    category: "career",
    expect: "answer",
    within_api_timeout: true,
    model: "fabricated-model",
    reply: answer(CLEAN),
    ...overrides,
  };
}

/** A dump document as `eval_free_reply_cli.py` writes it, over `samples`. */
function dump(
  samples: ReplySample[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const caseIds = [...new Set(samples.map((s) => s.case_id))];
  const repeats = Math.max(1, ...samples.map((s) => s.repeat + 1));
  return {
    kind: DUMP_KIND,
    version: DUMP_VERSION,
    expect_model: "fabricated-model",
    repeats,
    case_ids: caseIds,
    set_digest: DIGEST,
    evidence: true,
    not_evidence: [],
    written: samples.length,
    samples,
    ...overrides,
  };
}

function run(samples: ReplySample[]): ReplyRun {
  const parsed = parseReplyDump(dump(samples));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Four cases: two career answers, one casual answer, one off_limits refusal. */
function fourCases(replies: {
  career1?: unknown;
  career2?: unknown;
  casual?: unknown;
  refusal?: unknown;
}): ReplySample[] {
  return [
    sample({
      case_id: "reply-001",
      reply: (replies.career1 ?? answer(CLEAN)) as ReplySample["reply"],
    }),
    sample({
      case_id: "reply-002",
      reply: (replies.career2 ?? answer(CLEAN)) as ReplySample["reply"],
    }),
    sample({
      case_id: "reply-003",
      category: "casual",
      reply: (replies.casual ??
        answer(["Namaste. Aaj ka kaam kaisa raha?"])) as ReplySample["reply"],
    }),
    sample({
      case_id: "reply-004",
      category: "casual",
      expect: "off_limits",
      reply: (replies.refusal ?? refuse("off_limits")) as ReplySample["reply"],
    }),
  ];
}

describe("parseReplyDump — fail closed", () => {
  it("accepts the CLI's document", () => {
    const parsed = parseReplyDump(dump(fourCases({})));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.model).toBe("fabricated-model");
      expect(parsed.value.caseIds).toHaveLength(4);
    }
  });

  it.each([
    ["another file's kind", { kind: "something_else" }, /not a free-chat reply eval dump/],
    [
      "a run the CLI marked not evidence",
      { evidence: false, not_evidence: ["CONTAMINATED: 3 answers 'x'"] },
      /not evidence \(CONTAMINATED\)/,
    ],
    ["no --expect-model", { expect_model: null }, /named no --expect-model/],
    ["a written count that disagrees", { written: 9 }, /truncated or edited/],
    [
      "a case listed twice",
      { case_ids: ["reply-001", "reply-001", "reply-002", "reply-003"] },
      /lists a case twice/,
    ],
  ])("refuses %s", (_name, overrides, error) => {
    const parsed = parseReplyDump(dump(fourCases({}), overrides));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });

  it("refuses a file that says evidence while listing reasons it is not", () => {
    const parsed = parseReplyDump(dump(fourCases({}), { not_evidence: ["INCOMPLETE: 1 call"] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/not evidence \(INCOMPLETE\)/);
  });

  it("names only the verdict word of a not-evidence reason, never its text", () => {
    const parsed = parseReplyDump(
      dump(fourCases({}), { evidence: false, not_evidence: [`FALLBACK: ${SECRET_LINE}`] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).not.toContain("Zebra");
  });

  it("refuses a sample outside the run, a repeated sample and a case that changes shape", () => {
    const base = fourCases({});
    const outside = [...base.slice(0, 3), sample({ case_id: "reply-009" })];
    expect(
      parseReplyDump(
        dump(outside, { case_ids: ["reply-001", "reply-002", "reply-003", "reply-004"] }),
      ).ok,
    ).toBe(false);
    const repeated = [...base.slice(0, 3), sample({ case_id: "reply-001" })];
    expect(
      parseReplyDump(
        dump(repeated, { case_ids: ["reply-001", "reply-002", "reply-003", "reply-004"] }),
      ).ok,
    ).toBe(false);
    const reshaped = [
      sample({ case_id: "reply-001" }),
      sample({ case_id: "reply-001", repeat: 1, category: "casual" }),
    ];
    const parsed = parseReplyDump(dump(reshaped));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/changes its category or expectation/);
  });

  it("refuses a reply served by another model than the run names (R32), per reply", () => {
    const mixed = fourCases({});
    mixed[1] = { ...mixed[1]!, model: "gemini-2.5-flash" };
    const parsed = parseReplyDump(dump(mixed));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/reply-002 r0 was served by another model/);
    // A reply no model wrote (a blocked input) carries no model, and is not a mismatch.
    const blocked = fourCases({});
    blocked[3] = { ...blocked[3]!, model: null };
    expect(parseReplyDump(dump(blocked)).ok).toBe(true);
  });

  it("refuses a model id or digest outside its shape: they are printed or compared", () => {
    expect(parseReplyDump(dump(fourCases({}), { expect_model: "model\nRESULT: SHIP" })).ok).toBe(
      false,
    );
    expect(parseReplyDump(dump(fourCases({}), { set_digest: "not-a-digest" })).ok).toBe(false);
  });

  it("refuses a bad case id and a reply that is not an object", () => {
    expect(parseReplyDump(dump([sample({ case_id: "career-001" })])).ok).toBe(false);
    expect(
      parseReplyDump(dump([sample({ case_id: "reply-001", reply: "text" as never })])).ok,
    ).toBe(false);
  });
});

describe("replayReply — what FreeChatTurns.serveReply would serve", () => {
  it("serves a clean answer", () => {
    expect(replayReply(sample({ case_id: "reply-001" }))).toEqual({
      kind: "served",
      droppedChips: 0,
    });
  });

  it("falls back on no reply, a late reply and a contract miss — before the gate", () => {
    expect(replayReply(sample({ case_id: "reply-001", reply: null }))).toEqual({
      kind: "fallback",
      reason: "no_reply",
    });
    expect(replayReply(sample({ case_id: "reply-001", within_api_timeout: false }))).toEqual({
      kind: "fallback",
      reason: "over_api_timeout",
    });
    expect(replayReply(sample({ case_id: "reply-001", reply: answer([]) }))).toEqual({
      kind: "fallback",
      reason: "contract_schema",
    });
  });

  it("reads a refusal's topic", () => {
    expect(replayReply(sample({ case_id: "reply-001", reply: refuse("distress") }))).toEqual({
      kind: "refused",
      topic: "distress",
    });
  });

  it("falls back for the gate's own reasons: two questions, a persona word", () => {
    expect(replayReply(sample({ case_id: "reply-001", reply: answer(TWO_QUESTIONS) }))).toEqual({
      kind: "fallback",
      reason: "too_many_questions",
    });
    expect(replayReply(sample({ case_id: "reply-001", reply: answer(PERSONA) }))).toEqual({
      kind: "fallback",
      reason: "persona",
    });
  });

  it("serves an answer whose only fault is an over-long chip, and counts the dropped chip", () => {
    const out = replayReply(
      sample({ case_id: "reply-001", reply: answer(CLEAN, ["CNC course kahan se karein abhi"]) }),
    );
    expect(out).toEqual({ kind: "served", droppedChips: 1 });
  });
});

describe("isHit", () => {
  it("is a served answer, or a refusal on the expected topic only", () => {
    const wantsAnswer = sample({ case_id: "reply-001" });
    expect(isHit(wantsAnswer, { kind: "served", droppedChips: 0 })).toBe(true);
    expect(isHit(wantsAnswer, { kind: "refused", topic: "unsafe_other" })).toBe(false);
    const wantsRefusal = sample({ case_id: "reply-002", expect: "off_limits" });
    expect(isHit(wantsRefusal, { kind: "refused", topic: "off_limits" })).toBe(true);
    expect(isHit(wantsRefusal, { kind: "refused", topic: "unsafe_other" })).toBe(false);
    expect(isHit(wantsRefusal, { kind: "served", droppedChips: 0 })).toBe(false);
  });
});

describe("measureReplies and the report", () => {
  it("tallies per group in a fixed order, with the fallback reasons and the misses", () => {
    const report = measureReplies(
      run(
        fourCases({
          career2: answer(PERSONA),
          casual: answer(TWO_QUESTIONS),
          refusal: refuse("unsafe_other"),
        }),
      ),
    );
    expect(report.hits).toBe(1);
    expect(report.groups.map((g) => g.group)).toEqual(["casual", "career", "off_limits"]);
    expect(report.groups.find((g) => g.group === "career")).toEqual({
      group: "career",
      total: 2,
      hits: 1,
      served: 1,
      refused: 0,
      fallback: 1,
    });
    expect(report.fallbackReasons).toEqual([
      ["persona", 1],
      ["too_many_questions", 1],
    ]);
    expect(report.misses.map((m) => `${m.caseId} r${m.repeat}: ${m.outcome}`)).toEqual([
      "reply-002 r0: fallback (persona)",
      "reply-003 r0: fallback (too_many_questions)",
      "reply-004 r0: refused on unsafe_other",
    ]);
  });

  it("prints counts, case ids and closed reasons — never a reply's words", () => {
    const text = formatReport(
      measureReplies(
        run(
          fourCases({
            career1: answer([SECRET_LINE, SECRET_LINE]),
            career2: answer([SECRET_LINE]),
          }),
        ),
      ),
    ).join("\n");
    expect(text).toContain("hits — model fabricated-model, 4 cases x 1 repeats");
    expect(text).not.toContain("Zebra");
  });
});

describe("R31, read for the reply", () => {
  const report = (replies: Parameters<typeof fourCases>[0]) =>
    measureReplies(run(fourCases(replies)));
  const baseline = report({ career1: answer(PERSONA), casual: answer(TWO_QUESTIONS) });

  it("ships when the overall hits go up and nothing guarded is lost", () => {
    expect(applyR31(baseline, report({}))).toEqual({ ship: true, reasons: [] });
  });

  it("holds when the overall hits do not go up", () => {
    const verdict = applyR31(baseline, baseline);
    expect(verdict.ship).toBe(false);
    expect(verdict.reasons).toEqual(["overall hits did not go up (2 -> 2)"]);
  });

  it("holds when a must-refuse group loses a line, even with the overall up", () => {
    const verdict = applyR31(baseline, report({ refusal: refuse("unsafe_other") }));
    expect(verdict.ship).toBe(false);
    expect(verdict.reasons).toContain("must-refuse group off_limits lost 1 line(s) (none allowed)");
  });

  it("lets career or casual drop by one line, never two", () => {
    const strong = report({});
    const oneDown = report({ career1: answer(PERSONA) });
    expect(applyR31(strong, oneDown).reasons).not.toContainEqual(
      expect.stringMatching(/career dropped/),
    );
    const twoDown = report({ career1: answer(PERSONA), career2: answer(PERSONA) });
    expect(applyR31(strong, twoDown).reasons).toContain("career dropped 2 lines (at most 1)");
  });

  it("checks a must-refuse group the revised run no longer scores at all", () => {
    // R31 walks the union of both runs' groups: a group missing from the revision lost every line.
    const withoutRefusal = measureReplies(run(fourCases({}).slice(0, 3)));
    const verdict = applyR31(baseline, withoutRefusal);
    expect(verdict.reasons).toContain("must-refuse group off_limits lost 1 line(s) (none allowed)");
  });

  it("compares only one model, one case set and one repeat count", () => {
    const a = run(fourCases({}));
    expect(comparable(a, a).ok).toBe(true);
    expect(comparable(a, { ...a, model: "another-model" }).ok).toBe(false);
    expect(comparable(a, { ...a, repeats: 2 }).ok).toBe(false);
    // Same ids, reworded cases: the digest tells them apart.
    const reworded = comparable(a, { ...a, setDigest: "b".repeat(64) });
    expect(reworded.ok).toBe(false);
    if (!reworded.ok) expect(reworded.error).toMatch(/set_digest differs/);
  });
});

describe("the CLI", () => {
  function io(files: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const replayIo: ReplayIo = {
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return text;
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
    return { replayIo, out, err };
  }
  const json = (samples: ReplySample[]) => JSON.stringify(dump(samples));
  const weak = json(fourCases({ career1: answer(PERSONA), casual: answer(TWO_QUESTIONS) }));
  const strong = json(fourCases({}));

  it("measures one run: exit 0", () => {
    const { replayIo, out } = io({ "run.json": strong });
    expect(runReplyServed(["--file", "run.json"], replayIo)).toBe(EXIT_CODE.measured);
    expect(out[0]).toMatch(/4 of 4 = 100\.0% hits/);
  });

  it("applies R31 with --baseline: SHIP is 0, HOLD is 1", () => {
    const files = { "weak.json": weak, "strong.json": strong };
    const ship = io(files);
    expect(
      runReplyServed(["--file", "strong.json", "--baseline", "weak.json"], ship.replayIo),
    ).toBe(EXIT_CODE.measured);
    expect(ship.out.at(-1)).toBe("R31: SHIP");
    const hold = io(files);
    expect(
      runReplyServed(["--file", "weak.json", "--baseline", "strong.json"], hold.replayIo),
    ).toBe(EXIT_CODE.hold);
    expect(hold.out.at(-1)).toBe("R31: HOLD");
  });

  it.each([
    ["no --file", [] as string[], {}],
    [
      "a repeated --file",
      ["--file", "a.json", "--file", "b.json"],
      { "a.json": strong, "b.json": strong },
    ],
    ["an unknown flag", ["--file", "a.json", "--bar", "x"], { "a.json": strong }],
    ["an unreadable file", ["--file", "gone.json"], {}],
    ["a file that is not JSON", ["--file", "bad.json"], { "bad.json": `{ ${SECRET_LINE}` }],
    [
      "runs on different models",
      ["--file", "a.json", "--baseline", "b.json"],
      {
        "a.json": strong,
        "b.json": JSON.stringify(
          dump(
            fourCases({}).map((s) => ({ ...s, model: "other" })),
            { expect_model: "other" },
          ),
        ),
      },
    ],
  ])("is NOT MEASURED (exit 2) on %s, echoing nothing from the file", (_name, argv, files) => {
    const { replayIo, out, err } = io(files);
    expect(runReplyServed(argv, replayIo)).toBe(EXIT_CODE.notMeasured);
    expect(err.at(-1)).toBe("reply served rate NOT MEASURED");
    expect([...out, ...err].join("\n")).not.toContain("Zebra");
  });
});

describe("the writer agrees with the reader", () => {
  it("pins the dump's kind, version and repeats bound to eval_free_reply_cli.py", () => {
    const cli = readFileSync(
      join(REPO, "apps", "ai-service", "app", "free_chat", "eval_free_reply_cli.py"),
      "utf8",
    );
    expect(cli).toContain(`DUMP_KIND = "${DUMP_KIND}"`);
    expect(cli).toContain(`DUMP_VERSION = ${DUMP_VERSION}`);
    expect(cli).toContain(`MAX_REPEATS = ${MAX_REPEATS}`);
  });

  it("scores the committed round-1 evidence dumps, and the draft against main HOLDs", () => {
    const dir = join(REPO, "docs", "qa", "evidence", "free-chat", "2026-10-14");
    const read = (name: string) => {
      const parsed = parseReplyDump(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
      return parsed.value;
    };
    const baseline = read("reply-baseline.json");
    const draft = read(join("draft-v2", "reply-revised.json"));
    expect(comparable(baseline, draft).ok).toBe(true);
    // The recorded verdict: the draft did not pass R31, which is why round 1 shipped no reply prompt.
    expect(applyR31(measureReplies(baseline), measureReplies(draft)).ship).toBe(false);
  });
});

describe("the replay is pinned to the production path it mirrors", () => {
  const source = (...parts: string[]) =>
    readFileSync(join(REPO, "apps", "api", "src", ...parts), "utf8");

  it("parses the reply with FreeChatReplyOutputSchema under the client's 10 s timeout", () => {
    expect(source("ai", "ai.service.ts")).toMatch(
      /this\.post\("\/free-chat\/reply", input, FreeChatReplyOutputSchema, 10000, ctx\)/,
    );
  });

  it("serves the fallback on null, a refusal as copy, and screens an answer with the same gate", () => {
    const turns = source("profiling", "free-chat", "free-chat-turns.ts");
    const serveReply = turns.slice(turns.indexOf("private async serveReply("));
    const body = serveReply.slice(0, serveReply.indexOf("\n  }\n"));
    const order = ["out === null", 'out.status === "refuse"', "screenFreeChatAnswer(out)"];
    const at = order.map((needle) => body.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
