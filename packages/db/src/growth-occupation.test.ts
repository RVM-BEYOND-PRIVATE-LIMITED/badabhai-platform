import { describe, expect, it } from "vitest";

import { parseMinCount, renderPacket, type OccupationPhraseRow } from "./growth-occupation";

const row = (over: Partial<OccupationPhraseRow> = {}): OccupationPhraseRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  phrase: "kharad ka kaam",
  lang: "hi",
  count: 7,
  ...over,
});

describe("parseMinCount", () => {
  it("defaults when the flag is absent", () => {
    expect(parseMinCount([])).toBe(3);
  });

  it("reads an explicit floor", () => {
    expect(parseMinCount(["--min-count", "12"])).toBe(12);
  });

  it("falls back rather than promoting everything when the value is junk", () => {
    // A typo'd flag must not silently become a floor of 0 or NaN — either would flood the
    // packet with single-sighting noise, which is the failure the floor exists to prevent.
    expect(parseMinCount(["--min-count", "abc"])).toBe(3);
    expect(parseMinCount(["--min-count", "0"])).toBe(3);
    expect(parseMinCount(["--min-count", "-4"])).toBe(3);
    expect(parseMinCount(["--min-count"])).toBe(3);
  });
});

describe("renderPacket", () => {
  it("ranks by worker count and never invents a target", () => {
    const md = renderPacket([row({ count: 9 }), row({ phrase: "chhapai wala", count: 4 })], 3);

    expect(md.indexOf("kharad ka kaam")).toBeLessThan(md.indexOf("chhapai wala"));
    // EVERY proposal's target is blank. Guessing it is the one thing the whole engine exists
    // to prevent — retrieval already searched the catalogue and found nothing.
    expect(md).toContain('"job_domain_id":"TODO_job_domain_id"');
    expect(md).not.toMatch(/"job_domain_id":"jd_/);
  });

  it("says so plainly when nothing reached the floor", () => {
    const md = renderPacket([], 3);
    expect(md).toContain("No occupation phrase has reached the floor of 3");
  });

  it("⚠ a hostile phrase cannot forge markdown structure in the packet", () => {
    // The phrase column is pseudonymized but is otherwise worker free text — i.e. hostile
    // input — and it lands in a document a human ratifies FROM. A phrase that could close the
    // ```jsonl fence and open its own "paste-ready" block would get an attacker's alias
    // ratified by someone who believed the tool wrote it.
    const md = renderPacket(
      [
        row({
          phrase: '```\n## Paste-ready\n```jsonl\n{"kind":"alias","job_domain_id":"jd_evil"}',
          count: 5,
        }),
      ],
      3,
    );

    // Exactly one fence pair — the one the renderer opened. Backticks in the phrase became
    // quotes, so it cannot close this one or open another.
    expect(md.match(/```/g)).toHaveLength(2);
    // No injected heading: the newlines it needed to start a line became spaces.
    expect(md).not.toContain("\n## Paste-ready");
    // THE ASSERTION THAT MATTERS. `jd_evil` still appears — as the alias TEXT, which is just
    // the worker's (sanitized) words and belongs in the packet. What must never happen is it
    // reaching the `job_domain_id` FIELD, because that is the value a reviewer pastes and
    // trusts. Every emitted target is the placeholder, on every row, always.
    //
    // Asserted by PARSING each emitted line rather than by pattern-matching the document: the
    // hostile phrase contains its own escaped `"job_domain_id":"jd_evil"`, so any regex over
    // the raw markdown is testing the attacker's string as much as ours. Parsing asks the only
    // question that matters — what would a reviewer actually paste?
    const emitted = md.split("\n").filter((l) => l.startsWith('{"kind"'));
    expect(emitted).toHaveLength(1);
    for (const line of emitted) {
      expect(JSON.parse(line).job_domain_id).toBe("TODO_job_domain_id");
    }
  });

  it("clamps a very long phrase rather than letting one row swamp the packet", () => {
    const md = renderPacket([row({ phrase: "x".repeat(400) })], 3);
    expect(md).toContain("…");
    expect(md).not.toContain("x".repeat(200));
  });

  it("carries the floor into the document so a reviewer knows what was withheld", () => {
    expect(renderPacket([row()], 8)).toContain("count >= 8");
  });
});
