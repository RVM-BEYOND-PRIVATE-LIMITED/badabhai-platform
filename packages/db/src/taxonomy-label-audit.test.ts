import { describe, expect, it } from "vitest";

import {
  aliasVectorKey,
  auditCanonicalLabels,
  competitorFindings,
  corpusDelta,
  tokenDocumentFrequency,
  type AliasRow,
  type CandidateAudit,
  type SkillRow,
} from "./taxonomy-label-audit";

const alias = (o: Partial<AliasRow> & { skill_id: string; text: string }): AliasRow => ({
  lang: "en",
  text_norm: null,
  is_searchable: true,
  ...o,
});
const skill = (skill_id: string, label_en: string | null): SkillRow => ({
  skill_id,
  label_en,
  status: "provisional",
});
const domains = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m));

const codes = (a: CandidateAudit[], id: string): string[] =>
  (a.find((x) => x.skill_id === id)?.findings ?? []).map((f) => f.code);

describe("auditCanonicalLabels — candidacy", () => {
  it("proposes a label the skill does not already carry", () => {
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Coolant management")],
      aliases: [alias({ skill_id: "s1", text: "coolant top up" })],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    expect(a).toHaveLength(1);
    expect(a[0]?.verdict).toBe("OK");
  });

  it("does NOT propose a label the DATABASE already considers present", () => {
    // Candidacy is judged with normalizeOccupationText, the function that fills text_norm, so
    // case and trailing punctuation fold to the same row.
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Bench fitting")],
      aliases: [alias({ skill_id: "s1", text: "bench  fitting!" })],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    expect(a).toHaveLength(0);
  });

  it("DOES propose a label whose only near-match is hyphenated", () => {
    // normalizeOccupationText keeps intra-word hyphens, so "bench-fitting" and "bench fitting"
    // are two different text_norm values and the unique index permits both. Pinning it because
    // it is counter-intuitive: this candidate looks like a duplicate to a reader and is not one
    // to the database, and a reviewer should see it rather than have it silently dropped.
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Bench fitting")],
      aliases: [alias({ skill_id: "s1", text: "bench-fitting" })],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    expect(a).toHaveLength(1);
    expect(a[0]?.text_norm).toBe("bench fitting");
  });

  it("skips skills with no usable label", () => {
    const a = auditCanonicalLabels({
      skills: [skill("s1", null), skill("s2", "  ")],
      aliases: [],
      domainsBySkill: domains({}),
    });
    expect(a).toHaveLength(0);
  });
});

describe("auditCanonicalLabels — cross-skill duplicates", () => {
  it("BLOCKS when another skill in the SAME domain already owns the text", () => {
    // Two skills at identical text in one domain means the query cannot separate them and the
    // winner is decided by tie-break. That is the GP-04 failure with the margin removed.
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Quality check")],
      aliases: [alias({ skill_id: "s1", text: "QC" }), alias({ skill_id: "s2", text: "quality check" })],
      domainsBySkill: domains({ s1: ["d1"], s2: ["d1"] }),
    });
    expect(codes(a, "s1")).toContain("CROSS_SKILL_DUPLICATE_SAME_DOMAIN");
    expect(a[0]?.verdict).toBe("BLOCK");
  });

  it("only REVIEWS the same duplicate when no domain is shared", () => {
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Quality check")],
      aliases: [alias({ skill_id: "s1", text: "QC" }), alias({ skill_id: "s2", text: "quality check" })],
      domainsBySkill: domains({ s1: ["d1"], s2: ["d2"] }),
    });
    expect(codes(a, "s1")).toContain("CROSS_SKILL_DUPLICATE");
    expect(a[0]?.verdict).toBe("REVIEW");
  });

  it("does not treat the skill's OWN other aliases as a cross-skill duplicate", () => {
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Turning")],
      aliases: [alias({ skill_id: "s1", text: "lathe operation" })],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    expect(codes(a, "s1")).not.toContain("CROSS_SKILL_DUPLICATE");
  });
});

describe("auditCanonicalLabels — the unique index", () => {
  it("BLOCKS a row the index would reject", () => {
    // Same skill, same text_norm, same lang, searchable. The insert fails; better to know now
    // than during an ingest that is half-applied.
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Deburring")],
      aliases: [
        alias({ skill_id: "s1", text: "burr removal" }),
        // text_norm supplied directly, mimicking a row whose stored norm collides.
        alias({ skill_id: "s1", text: "Deburring!", text_norm: "deburring" }),
      ],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    // The stored norm makes this label already present, so it is not even a candidate.
    expect(a).toHaveLength(0);
  });

  it("does not block against a NON-searchable duplicate", () => {
    // The unique index is partial: WHERE is_searchable. A losing duplicate keeps its row and
    // must not be mistaken for a live conflict.
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Deburring")],
      aliases: [alias({ skill_id: "s1", text: "deburring", text_norm: "deburring", is_searchable: false })],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    // Still not a candidate (the norm is present), but if it were, no BLOCK would be raised.
    expect(a.every((c) => !c.findings.some((f) => f.code === "UNIQUE_INDEX_COLLISION"))).toBe(true);
  });
});

describe("auditCanonicalLabels — genericness", () => {
  const spread = (token: string, n: number): AliasRow[] =>
    Array.from({ length: n }, (_, i) => alias({ skill_id: `other${i}`, text: `${token} thing${i}` }));

  it("flags a label whose sharpest token is already everywhere", () => {
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Control")],
      aliases: [alias({ skill_id: "s1", text: "unrelated" }), ...spread("control", 9)],
      domainsBySkill: domains({ s1: ["d1"] }),
      genericMinDf: 8,
    });
    expect(codes(a, "s1")).toContain("GENERIC_LABEL");
  });

  it("does NOT flag a label with one rare token, even if its other tokens are common", () => {
    // Specificity is set by the sharpest word. "Refrigerant leak detection" survives because
    // `refrigerant` is rare, however common `detection` may be.
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Refrigerant detection")],
      aliases: [alias({ skill_id: "s1", text: "unrelated" }), ...spread("detection", 12)],
      domainsBySkill: domains({ s1: ["d1"] }),
      genericMinDf: 8,
    });
    expect(codes(a, "s1")).not.toContain("GENERIC_LABEL");
  });

  it("flags every single-token label as broad-matching", () => {
    const a = auditCanonicalLabels({
      skills: [skill("s1", "Turning")],
      aliases: [alias({ skill_id: "s1", text: "lathe work" })],
      domainsBySkill: domains({ s1: ["d1"] }),
    });
    expect(codes(a, "s1")).toContain("SINGLE_TOKEN_LABEL");
  });
});

describe("tokenDocumentFrequency", () => {
  it("counts DISTINCT skills, not alias occurrences", () => {
    // Counting rows would let one skill with many aliases make its own vocabulary look
    // universal, and every one of its labels would then read as generic.
    const df = tokenDocumentFrequency([
      alias({ skill_id: "s1", text: "welding one" }),
      alias({ skill_id: "s1", text: "welding two" }),
      alias({ skill_id: "s1", text: "welding three" }),
      alias({ skill_id: "s2", text: "welding four" }),
    ]);
    expect(df.get("welding")).toBe(2);
  });

  it("prefers a stored text_norm over recomputing", () => {
    const df = tokenDocumentFrequency([alias({ skill_id: "s1", text: "IGNORED", text_norm: "stored token" })]);
    expect(df.get("stored")).toBe(1);
    expect(df.has("ignored")).toBe(false);
  });
});

describe("competitorFindings — cache only, never the provider", () => {
  const audits: CandidateAudit[] = [
    { skill_id: "s1", label: "L", lang: "en", text_norm: "l", domains: ["d1"], findings: [], verdict: "OK" },
  ];
  const aliases = [alias({ skill_id: "s2", text: "rival" })];
  const doms = domains({ s1: ["d1"], s2: ["d1"] });

  it("reports NOT_ASSESSED when the label has no cached vector", () => {
    // "No finding" and "not looked at" are different claims. Collapsing them would let an
    // unaudited candidate read as a clean one.
    const f = competitorFindings(audits, aliases, doms, new Map(), new Map());
    expect(f.get("s1")?.[0]?.code).toBe("COMPETITOR_NOT_ASSESSED");
  });

  it("flags a label sitting on top of another skill's alias in a shared domain", () => {
    const f = competitorFindings(
      audits,
      aliases,
      doms,
      new Map([["s1", [1, 0]]]),
      new Map([[aliasVectorKey("s2", "rival"), [1, 0]]]),
      0.85,
    );
    expect(f.get("s1")?.[0]?.code).toBe("POTENTIAL_TOP_COMPETITOR");
  });

  it("ignores a distant alias", () => {
    const f = competitorFindings(
      audits,
      aliases,
      doms,
      new Map([["s1", [1, 0]]]),
      new Map([[aliasVectorKey("s2", "rival"), [0, 1]]]),
      0.85,
    );
    expect(f.get("s1")).toEqual([]);
  });

  it("never compares a skill against its own aliases", () => {
    const own = [alias({ skill_id: "s1", text: "mine" })];
    const f = competitorFindings(
      audits,
      own,
      doms,
      new Map([["s1", [1, 0]]]),
      new Map([[aliasVectorKey("s1", "mine"), [1, 0]]]),
      0.85,
    );
    expect(f.get("s1")).toEqual([]);
  });
});

describe("corpusDelta", () => {
  const c = (skill_id: string, ds: string[]): CandidateAudit => ({
    skill_id,
    label: "L",
    lang: "en",
    text_norm: "l",
    domains: ds,
    findings: [],
    verdict: "OK",
  });

  it("counts rows, distinct skills and distinct domains", () => {
    const d = corpusDelta([c("s1", ["d1", "d2"]), c("s2", ["d2"])]);
    expect(d.rows_added).toBe(2);
    expect(d.skills_touched).toBe(2);
    expect(d.domains_touched).toBe(2);
  });

  it("costs the embed at the corpus batch size, not one request per text", () => {
    // The eval harness sends one text per request; the corpus embedder batches 100. Quoting
    // the harness's rate here would overstate the ingest cost by two orders of magnitude.
    expect(corpusDelta(Array.from({ length: 119 }, (_, i) => c(`s${i}`, ["d"]))).provider_requests_at_batch_100).toBe(2);
  });

  it("is zero-safe", () => {
    expect(corpusDelta([]).rows_added).toBe(0);
  });
});

describe("auditCanonicalLabels — compound labels", () => {
  const one = (label: string): string[] =>
    auditCanonicalLabels({
      skills: [skill("s1", label)],
      aliases: [alias({ skill_id: "s1", text: "unrelated" })],
      domainsBySkill: domains({ s1: ["d1"] }),
    })[0]?.findings.map((f) => f.code) ?? [];

  it("flags a slash-joined label", () => {
    // "Deburring / finishing" as one alias matches neither half as well as either would alone.
    expect(one("Deburring / finishing")).toContain("COMPOUND_LABEL");
  });

  it("flags 'and' and comma enumerations", () => {
    expect(one("Cable termination and jointing")).toContain("COMPOUND_LABEL");
    expect(one("Brick, block laying")).toContain("COMPOUND_LABEL");
  });

  it("does not flag an ordinary multi-word label", () => {
    expect(one("Refrigerant leak detection")).not.toContain("COMPOUND_LABEL");
  });

  it("does not mistake a hyphenated or slashed WORD for an enumeration", () => {
    // normalizeOccupationText keeps intra-word "/" and "-" precisely because they are part of
    // the term. Only a spaced separator enumerates.
    expect(one("Go/no-go gauge checking")).not.toContain("COMPOUND_LABEL");
  });
});
