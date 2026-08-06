/**
 * The two Phase 2 alias generators.
 *
 * BOTH ARE TESTED WITHOUT A PROVIDER OR A DATABASE, which is the point of how they are
 * built: generator #1's model call is out-of-band (it emits prompts and ingests replies),
 * and generator #2's whole mining decision is a pure function over already-pseudonymized
 * text. `chat_messages` holds zero rows today, so the miner's logic has to be provably
 * correct BEFORE it ever sees traffic — a test that needed real messages would be a test
 * that never ran.
 */
import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  parseResponses,
  selectDomains,
  toCorpusLines,
  toOverlayRecords,
} from "./generate-domain-aliases";
import type { ResolvedJobDomain } from "./job-domain-corpus";
import { candidateSpans, mineCandidates } from "./mine-chat-aliases";
import { buildOccupationIndex } from "./occupation-retrieval-eval";

function domain(
  id: string,
  major: string,
  unit: string,
  aliases: { text: string; source: "nco2015" | "rvm" }[],
  selectable = true,
): ResolvedJobDomain {
  return {
    source: "nco2015",
    code: id,
    level: 5,
    parent_code: unit,
    parent_source: "isco08",
    isco_major: major,
    isco_unit: unit,
    skill_level: 2,
    label_en: aliases[0]?.text ?? id,
    label_hi: null,
    description_en: "Does the thing.",
    selectable,
    industry_id: null,
    canonical_role_id: null,
    aliases: aliases.map((a) => ({ text: a.text, lang: "en" as const, source: a.source })),
    jobDomainId: id,
    parentJobDomainId: null,
  };
}

describe("selectDomains — what to spend review effort on", () => {
  const corpus = [
    domain("jd_white", "2", "2512", [{ text: "Software Developer", source: "nco2015" }]),
    domain("jd_bare", "7", "7212", [{ text: "Welder, Gas", source: "nco2015" }]),
    domain("jd_covered", "7", "7212", [
      { text: "Welder, Arc", source: "nco2015" },
      { text: "welding", source: "rvm" },
    ]),
    domain("jd_notsel", "7", "7212", [{ text: "Bucket", source: "nco2015" }], false),
  ];

  it("excludes white-collar majors — the platform does not serve them", () => {
    const ids = selectDomains(corpus, { missingOnly: false }).map((d) => d.jobDomainId);
    expect(ids).not.toContain("jd_white");
  });

  it("excludes non-selectable rows", () => {
    const ids = selectDomains(corpus, { missingOnly: false }).map((d) => d.jobDomainId);
    expect(ids).not.toContain("jd_notsel");
  });

  it("skips occupations that already have a vernacular alias by default", () => {
    const ids = selectDomains(corpus, { missingOnly: true }).map((d) => d.jobDomainId);
    expect(ids).toEqual(["jd_bare"]);
  });

  it("--all includes the already-covered ones", () => {
    const ids = selectDomains(corpus, { missingOnly: false }).map((d) => d.jobDomainId);
    expect(ids).toContain("jd_covered");
  });

  it("orders fewest-aliases first — the blindest occupations lead", () => {
    const ids = selectDomains(corpus, { missingOnly: false }).map((d) => d.jobDomainId);
    expect(ids.indexOf("jd_bare")).toBeLessThan(ids.indexOf("jd_covered"));
  });

  it("filters to one unit group when asked", () => {
    expect(selectDomains(corpus, { missingOnly: false, unit: "2512" })).toHaveLength(0);
  });

  it("honours --limit", () => {
    expect(selectDomains(corpus, { missingOnly: false, limit: 1 })).toHaveLength(1);
  });
});

describe("buildPrompt", () => {
  const d = domain("jd_a", "7", "7212", [{ text: "Welder, Gas", source: "nco2015" }]);

  it("names the occupation and its existing aliases so the model does not repeat them", () => {
    const p = buildPrompt(d);
    expect(p).toContain("Welder, Gas");
    expect(p).toContain("Already known names");
  });

  it("asks for STEMS, because particle phrases collapse to the same normalized form", () => {
    // "welding wala" and "welding" both normalize to `welding`; only one can win
    // is_searchable, so asking for phrases would generate guaranteed rejects.
    expect(buildPrompt(d)).toContain("never 'welding wala'");
  });

  it("carries the PII rule the validator will enforce anyway", () => {
    expect(buildPrompt(d)).toContain("No digits");
  });

  it("truncates a long official description", () => {
    const long = { ...d, description_en: "x".repeat(2_000) };
    expect(buildPrompt(long).length).toBeLessThan(1_500);
  });
});

describe("parseResponses", () => {
  it("reports a malformed line instead of skipping it", () => {
    // Silently dropping a bad line would under-count the batch and hide a broken model
    // run as a small yield.
    const { responses, problems } = parseResponses('{"job_domain_id":"jd_a","aliases":[]}\nnot json\n');
    expect(responses).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  it("rejects a line missing the required fields", () => {
    const { problems } = parseResponses('{"aliases":[]}');
    expect(problems[0]).toContain("needs job_domain_id");
  });

  it("ignores blanks and comments", () => {
    const { responses, problems } = parseResponses('# header\n\n{"job_domain_id":"jd_a","aliases":[]}');
    expect(responses).toHaveLength(1);
    expect(problems).toHaveLength(0);
  });
});

describe("toOverlayRecords / toCorpusLines", () => {
  it("flattens responses and trims whitespace", () => {
    const recs = toOverlayRecords([
      { job_domain_id: "jd_a", aliases: [{ text: "  welding  ", lang: "en" }] },
    ]);
    expect(recs).toEqual([{ kind: "alias", job_domain_id: "jd_a", text: "welding", lang: "en" }]);
  });

  it("emits lines in the committed corpus shape", () => {
    const line = toCorpusLines([{ kind: "alias", job_domain_id: "jd_a", text: "welding", lang: "en" }]);
    expect(JSON.parse(line)).toEqual({
      kind: "alias",
      job_domain_id: "jd_a",
      text: "welding",
      lang: "en",
    });
  });
});

describe("candidateSpans", () => {
  it("yields 1..3 token windows", () => {
    expect(candidateSpans("kharad chalata hun")).toContain("kharad");
    expect(candidateSpans("kharad chalata hun")).toContain("kharad chalata hun");
  });

  it("drops spans made only of conversational scaffolding", () => {
    expect(candidateSpans("main hun ji")).toHaveLength(0);
  });

  it("keeps a span where scaffolding surrounds a real word", () => {
    // Over-filtering is the dangerous direction: a span is dropped only when EVERY token
    // is scaffolding, so a trade word carried between them survives.
    expect(candidateSpans("main kharad hun")).toContain("main kharad");
  });
});

describe("mineCandidates", () => {
  const index = buildOccupationIndex([domain("jd_weld", "7", "7212", [{ text: "welding", source: "rvm" }])]);

  it("ignores a message that already resolves", () => {
    // Its vocabulary is covered by definition; mining it buries the signal.
    const r = mineCandidates(index, [{ sessionId: "s1", text: "welding ka kaam karta hun" }], 1);
    expect(r.resolved).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it("mines a message that resolves to nothing", () => {
    const r = mineCandidates(index, [{ sessionId: "s1", text: "kharad ka kaam" }], 1);
    expect(r.unresolved).toBe(1);
    expect(r.candidates.map((c) => c.phrase)).toContain("kharad");
  });

  it("applies the frequency floor", () => {
    const msgs = [
      { sessionId: "s1", text: "kharad ka kaam" },
      { sessionId: "s2", text: "kharad ka kaam" },
    ];
    expect(mineCandidates(index, msgs, 3).candidates).toHaveLength(0);
    expect(mineCandidates(index, msgs, 2).candidates.length).toBeGreaterThan(0);
  });

  it("ranks by DISTINCT SESSIONS, not raw count", () => {
    // Ten workers saying a word once is a trade; one worker saying it ten times is a
    // habit. Ranking by count alone would promote the habit.
    const msgs = [
      ...Array.from({ length: 5 }, () => ({ sessionId: "loud", text: "bakbak ka kaam" })),
      { sessionId: "a", text: "kharad ka kaam" },
      { sessionId: "b", text: "kharad ka kaam" },
      { sessionId: "c", text: "kharad ka kaam" },
    ];
    const r = mineCandidates(index, msgs, 3);
    expect(r.candidates[0]?.phrase).toBe("kharad");
    expect(r.candidates[0]?.sessions).toBe(3);
  });

  it("does not re-propose a span that already resolves on its own", () => {
    // "welding" resolves; the parent message did not only because the longer span lost.
    // Re-proposing the covered sub-span is noise.
    const r = mineCandidates(index, [{ sessionId: "s1", text: "zzz welding qqq zzz welding qqq" }], 1);
    expect(r.candidates.map((c) => c.phrase)).not.toContain("welding");
  });

  it("counts sessions, not messages, for the session tally", () => {
    const msgs = [
      { sessionId: "s1", text: "kharad ka kaam" },
      { sessionId: "s1", text: "kharad ka kaam" },
    ];
    const r = mineCandidates(index, msgs, 1);
    const kharad = r.candidates.find((c) => c.phrase === "kharad");
    expect(kharad).toMatchObject({ count: 2, sessions: 1 });
  });

  it("never proposes a candidate containing a digit — the PII guard", () => {
    // Found on the FIRST real run against 14 messages, which proposed "30", "40 hazar"
    // and "30 hazar": the worker's pay, extracted verbatim into a file on disk. The guard
    // has to run at mining time, not only at commit time, because a review file has
    // already left the database.
    const r = mineCandidates(index, [{ sessionId: "s1", text: "30 hazar salary chahiye" }], 1);
    expect(r.candidates.map((c) => c.phrase)).not.toContain("30");
    expect(r.candidates.every((c) => !/[0-9०-९]/.test(c.phrase))).toBe(true);
  });

  it("applies the guard to Devanagari digits too", () => {
    // JS \d is ASCII-only while Python's is not, so a Devanagari phone number must not
    // pass a check an ASCII one fails.
    const r = mineCandidates(index, [{ sessionId: "s1", text: "३० hazar chahiye" }], 1);
    expect(r.candidates.every((c) => !/[०-९]/.test(c.phrase))).toBe(true);
  });

  it("returns nothing for an empty input without dividing by zero", () => {
    expect(mineCandidates(index, [], 1)).toMatchObject({ candidates: [], resolved: 0, unresolved: 0 });
  });
});
