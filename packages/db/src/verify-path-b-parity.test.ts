/**
 * P1's implementation, and the pin that keeps it honest.
 *
 * The assertion is only worth anything if the predicate it captures is the SAME predicate
 * production serves. If `legacyAliasRows` gains a filter and this does not, P1 keeps passing
 * while measuring a set no caller ever sees — which is a worse position than having no P1 at
 * all, because the plan's safety argument would then cite a green check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diffParity, overallDigest, slugDigest, type SlugParity } from "./verify-path-b-parity";

const REPOSITORY_TS = join(__dirname, "..", "..", "..", "apps", "api", "src", "skills", "skills.repository.ts");
const SELF = readFileSync(join(__dirname, "verify-path-b-parity.ts"), "utf8");

describe("the predicate is pinned to production's", () => {
  it("uses every filter legacyAliasRows uses", () => {
    const src = readFileSync(REPOSITORY_TS, "utf8");
    const at = src.indexOf("private legacyAliasRows");
    expect(at, "legacyAliasRows was renamed — re-pin this test").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("`", src.indexOf("`", at) + 1));

    // The three predicates that decide MEMBERSHIP. Order-by and limit are excluded on purpose:
    // they are a pure function of the query vector over the set this captures.
    expect(body).toMatch(/sa\.domain_id\s*=/);
    expect(body).toMatch(/s\.status\s*=\s*'active'/);
    expect(body).toMatch(/sa\.embedding IS NOT NULL/);

    expect(SELF).toMatch(/s\.status = 'active'/);
    expect(SELF).toMatch(/sa\.embedding IS NOT NULL/);
    expect(SELF).toMatch(/sa\.domain_id IS NOT NULL/);
  });

  it("does not hash the vectors themselves", () => {
    // A digest over 768 floats depends on float formatting, and a digest that changes for
    // reasons nobody can explain is one people learn to override.
    expect(SELF).not.toMatch(/embedding::text/);
  });
});

describe("slugDigest", () => {
  const row = (skill_id: string, text: string, embedding_model: string | null = "gemini-embedding-001") => ({
    skill_id,
    text,
    embedding_model,
  });

  it("is stable under row order — Postgres does not promise one", () => {
    const a = [row("s1", "alpha"), row("s2", "beta")];
    expect(slugDigest(a)).toBe(slugDigest([...a].reverse()));
  });

  it("changes when a row is added", () => {
    expect(slugDigest([row("s1", "alpha")])).not.toBe(slugDigest([row("s1", "alpha"), row("s2", "beta")]));
  });

  it("changes when a row is removed", () => {
    expect(slugDigest([row("s1", "a"), row("s2", "b")])).not.toBe(slugDigest([row("s1", "a")]));
  });

  it("changes when the embedding MODEL changes, even with identical membership", () => {
    // Two models produce two incomparable geometries, so Path B's ORDER BY changes even though
    // every candidate is still present. P1 must see that.
    expect(slugDigest([row("s1", "a", "gemini-embedding-001")])).not.toBe(
      slugDigest([row("s1", "a", "text-embedding-004")]),
    );
  });

  it("distinguishes a text moving between skills from nothing happening", () => {
    // The exact shape of a retag. Membership count is unchanged; ownership is not.
    expect(slugDigest([row("s1", "shared")])).not.toBe(slugDigest([row("s2", "shared")]));
  });

  it("cannot be fooled by field-boundary ambiguity", () => {
    // ("ab","c") and ("a","bc") must not collide — a naive join would let them.
    expect(slugDigest([row("ab", "c", null)])).not.toBe(slugDigest([row("a", "bc", null)]));
  });
});

describe("diffParity", () => {
  const s = (domainId: string, digest: string, candidates = 3, skills = 2): SlugParity => ({
    domainId,
    candidates,
    skills,
    digest,
  });

  it("reports nothing when the sets match", () => {
    expect(diffParity([s("welding", "d1")], [s("welding", "d1")])).toEqual([]);
  });

  it("reports a changed slug with both sides", () => {
    const d = diffParity([s("welding", "d1", 9, 4)], [s("welding", "d2", 8, 4)]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "changed", before: { candidates: 9 }, after: { candidates: 8 } });
  });

  it("reports a slug that vanished", () => {
    expect(diffParity([s("grinding", "d1")], [])[0]).toMatchObject({ kind: "removed" });
  });

  it("reports a slug that appeared — P1 is about what a caller sees, in both directions", () => {
    // The easy mistake is to iterate only the baseline. A new slug is a change to the result
    // set too, and a stage that invents one has done something nobody planned.
    expect(diffParity([], [s("new-slug", "d1")])[0]).toMatchObject({ kind: "added" });
  });

  it("is sorted, so two runs of the same drift read identically", () => {
    const d = diffParity([s("z", "a"), s("a", "a")], [s("z", "b"), s("a", "b")]);
    expect(d.map((x) => x.domainId)).toEqual(["a", "z"]);
  });
});

describe("overallDigest", () => {
  const s = (domainId: string, digest: string): SlugParity => ({ domainId, candidates: 1, skills: 1, digest });

  it("is order-independent", () => {
    expect(overallDigest([s("a", "1"), s("b", "2")])).toBe(overallDigest([s("b", "2"), s("a", "1")]));
  });

  it("changes when any slug's digest changes", () => {
    expect(overallDigest([s("a", "1")])).not.toBe(overallDigest([s("a", "2")]));
  });

  it("changes when a slug's counts change even if its digest somehow did not", () => {
    // Belt and braces: the counts are what a human reads, so they are inside the seal too.
    const a: SlugParity = { domainId: "x", candidates: 1, skills: 1, digest: "d" };
    const b: SlugParity = { domainId: "x", candidates: 2, skills: 1, digest: "d" };
    expect(overallDigest([a])).not.toBe(overallDigest([b]));
  });
});

describe("the committed pre-S3 baseline", () => {
  it("is a valid baseline whose overall digest matches its own slugs", () => {
    // If the file were hand-edited to make a future check pass, this fails.
    const b = JSON.parse(
      readFileSync(join(__dirname, "..", "data", "taxonomy", "replay", "phase-9-path-b-parity-BASELINE-PRE-S3.json"), "utf8"),
    ) as { kind: string; slugs: SlugParity[]; digest: string };
    expect(b.kind).toBe("path-b-parity");
    expect(b.slugs.length).toBeGreaterThan(0);
    expect(overallDigest(b.slugs)).toBe(b.digest);
  });
});
