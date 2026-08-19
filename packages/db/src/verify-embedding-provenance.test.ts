/**
 * The rules that decide whether a stamp is written.
 *
 * These are unit tests and not an integration run on purpose: the failure mode of getting this
 * logic wrong is a `embedding_model` value that is confidently false, which no downstream check
 * can ever detect again — `corpusBlockReason` would pass, the eval harness would report a
 * number, and the number would be meaningless. So the decision rules are pure functions and
 * every branch is pinned here, rather than being "verified" by having watched one production
 * run print the answer somebody expected.
 */
import { describe, expect, it } from "vitest";

import {
  PROVEN_COSINE_FLOOR,
  applyBlockReason,
  cosine,
  referencesFromFile,
  summarize,
  verifyRow,
  type ReferenceVector,
  type RowVerdict,
} from "./verify-embedding-provenance";
import { hostClass, auditRows, l2Norm } from "./audit-embedding-provenance";
import { MOCK_MODEL_TAG, mockEmbedding } from "./taxonomy-retrieval-eval";

const unit = (seed: number, dim = 8): number[] => {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

describe("cosine", () => {
  it("is 1 for a vector against itself", () => {
    expect(cosine(unit(3), unit(3))).toBeCloseTo(1, 12);
  });

  it("is scale-invariant — a reference stored unnormalized still matches", () => {
    // The two corpora are L2-normalized, but the proof must not DEPEND on that: a reference
    // dump from a pipeline that normalized differently would otherwise read as MISMATCH and
    // send an operator off re-embedding a corpus that was fine.
    const a = unit(5);
    const scaled = a.map((x) => x * 7.5);
    expect(cosine(a, scaled)).toBeCloseTo(1, 12);
  });

  it("separates unrelated vectors far below the floor", () => {
    expect(cosine(unit(2), unit(11))).toBeLessThan(PROVEN_COSINE_FLOOR);
  });

  it("returns 0 rather than throwing on a dimension mismatch", () => {
    // A 768-vs-3072 comparison is exactly what a genuine model change looks like. It must
    // land on MISMATCH, not crash mid-run leaving the operator unsure what was written.
    expect(cosine([1, 0, 0], [1, 0])).toBe(0);
  });

  it("returns 0 for a zero vector instead of NaN", () => {
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe("verifyRow — the four verdicts", () => {
  const row = { id: "a1", text: "tig welding", embedding: unit(3) };

  it("PROVEN when a known-model reference matches, and reports the model and source", () => {
    const ref: ReferenceVector = { vector: unit(3), model: "gemini-embedding-001", source: "reference-file" };
    const v = verifyRow(row, ref);
    expect(v.verdict).toBe("PROVEN");
    expect(v.model).toBe("gemini-embedding-001");
    expect(v.source).toBe("reference-file");
    expect(v.cosine).toBeGreaterThanOrEqual(PROVEN_COSINE_FLOOR);
  });

  it("MISMATCH when the same text's reference is a different vector", () => {
    const ref: ReferenceVector = { vector: unit(11), model: "gemini-embedding-001", source: "embed-cache" };
    const v = verifyRow(row, ref);
    expect(v.verdict).toBe("MISMATCH");
    expect(v.model).toBeNull();
    // The cosine is still reported — an operator needs to see 0.62 vs 0.99998 to tell a
    // foreign model from a floating-point argument.
    expect(v.cosine).not.toBeNull();
  });

  it("NO_REFERENCE when nothing of known model covers that text", () => {
    const v = verifyRow(row, undefined);
    expect(v.verdict).toBe("NO_REFERENCE");
    expect(v.model).toBeNull();
    expect(v.cosine).toBeNull();
  });

  it("MOCK is checked BEFORE the reference, so a mock reference cannot launder a mock row", () => {
    // The trap this closes: two mock vectors of the same text are IDENTICAL, so a mock
    // reference agrees with a mock row at cosine exactly 1. Consulting the reference first
    // would stamp a mock corpus with a real model name — the precise outcome this script
    // exists to prevent.
    const mock = mockEmbedding("tig welding");
    const v = verifyRow(
      { id: "m1", text: "tig welding", embedding: mock },
      { vector: mock, model: "gemini-embedding-001", source: "reference-file" },
    );
    expect(v.verdict).toBe("MOCK");
    expect(v.model).toBeNull();
  });
});

describe("summarize", () => {
  const v = (verdict: RowVerdict["verdict"], model: string | null, c: number | null): RowVerdict => ({
    id: `${verdict}-${String(c)}`,
    verdict,
    model,
    cosine: c,
    source: null,
  });

  it("counts each verdict and collects the distinct proven models", () => {
    const s = summarize([
      v("PROVEN", "gemini-embedding-001", 0.999999),
      v("PROVEN", "gemini-embedding-001", 1),
      v("MISMATCH", null, 0.5),
      v("NO_REFERENCE", null, null),
      v("MOCK", null, null),
    ]);
    expect(s).toMatchObject({ proven: 2, mismatch: 1, noReference: 1, mock: 1, models: ["gemini-embedding-001"] });
  });

  it("reports the WORST proven cosine, not the best", () => {
    // Reporting the max would make a marginal corpus look perfect. The number an operator
    // needs is the weakest link.
    const s = summarize([v("PROVEN", "m", 1), v("PROVEN", "m", 0.999991), v("PROVEN", "m", 1)]);
    expect(s.minProvenCosine).toBe(0.999991);
  });

  it("has no proven cosine when nothing was proven", () => {
    expect(summarize([v("NO_REFERENCE", null, null)]).minProvenCosine).toBeNull();
  });
});

describe("applyBlockReason — when stamping is refused wholesale", () => {
  const clean = { proven: 76, mismatch: 0, noReference: 0, mock: 0, models: ["gemini-embedding-001"], minProvenCosine: 1 };

  it("allows a clean, single-model, fully-proven set", () => {
    expect(applyBlockReason(clean)).toBeNull();
  });

  it("refuses when any row is proven mock", () => {
    expect(applyBlockReason({ ...clean, mock: 1 })).toMatch(/launder a mock corpus/);
  });

  it("refuses on ANY mismatch, even beside hundreds of proven rows", () => {
    // Partial application is the tempting behaviour and the wrong one: a single mismatch means
    // the corpus contains a vector from an unknown source, and stamping the rest makes the
    // vocabulary look uniformly attributed while it is not.
    expect(applyBlockReason({ ...clean, mismatch: 1 })).toMatch(/MISMATCH/);
  });

  it("refuses when nothing was proven", () => {
    expect(applyBlockReason({ ...clean, proven: 0, models: [] })).toMatch(/nothing was proven/);
  });

  it("refuses when the proven rows span two models", () => {
    const r = applyBlockReason({ ...clean, models: ["gemini-embedding-001", "text-embedding-004"] });
    expect(r).toMatch(/span 2 models/);
  });

  it("mock outranks mismatch in the message, because it is the worse finding", () => {
    expect(applyBlockReason({ ...clean, mock: 1, mismatch: 1 })).toMatch(/mock/i);
  });
});

describe("referencesFromFile", () => {
  it("accepts pgvector's text form and a JSON array alike", () => {
    // `row_to_json` over `embedding::text` produces the string form. Requiring the operator to
    // reshape it would be a footgun on the one path they reach for under pressure.
    const m = referencesFromFile([
      { text: "a", embedding_model: "gemini-embedding-001", embedding: "[1,0,0]" },
      { text: "b", embedding_model: "gemini-embedding-001", embedding: [0, 1, 0] },
    ]);
    expect(m.size).toBe(2);
  });

  it("skips unstamped rows — an unstamped reference proves nothing", () => {
    const m = referencesFromFile([
      { text: "a", embedding_model: null, embedding: "[1,0,0]" },
      { text: "b", embedding_model: "", embedding: "[1,0,0]" },
    ]);
    expect(m.size).toBe(0);
  });

  it("skips rows whose embedding is not a vector", () => {
    expect(referencesFromFile([{ text: "a", embedding_model: "m", embedding: null }]).size).toBe(0);
  });
});

describe("hostClass — never the connection string, always enough to prevent a wrong target", () => {
  it.each([
    ["postgres://u:p@127.0.0.1:5432/db", "LOCAL DOCKER"],
    ["postgres://u:p@localhost:5432/db", "LOCAL DOCKER"],
    ["postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres", "SUPABASE (remote)"],
    ["postgres://u:p@db.example.internal:5432/postgres", "OTHER-REMOTE"],
    ["not a url", "UNPARSEABLE"],
  ])("%s -> %s", (url, expected) => {
    expect(hostClass(url)).toBe(expected);
  });

  it("never returns any part of the credentials", () => {
    const out = hostClass("postgres://superuser:hunter2@db.supabase.co:5432/postgres");
    expect(out).not.toMatch(/hunter2|superuser/);
  });
});

describe("auditRows — the forensic counters", () => {
  const row = (id: string, text: string, embedding: number[] | null, model: string | null, at: Date | null) => ({
    id,
    text,
    embedding,
    embedding_model: model,
    embedded_at: at,
  });

  it("separates 'unstamped and undated' from 'unstamped but dated'", () => {
    // The distinction IS the forensics: `embedded_at IS NULL` alongside a NULL model is the
    // pre-#900 runner signature. A row with a timestamp and no model has a different cause and
    // must not be silently folded into the same bucket.
    const a = auditRows("skill_alias", [
      row("1", "x", unit(1), null, null),
      row("2", "y", unit(2), null, new Date("2026-08-18T00:00:00Z")),
    ]);
    expect(a.provenance.unstamped).toBe(2);
    expect(a.embeddedAtMissing).toBe(1);
    expect(a.stampedTimeButNoModel).toBe(1);
  });

  it("ignores unembedded rows in every embedded-row statistic", () => {
    const a = auditRows("skill_alias", [row("1", "x", null, null, null), row("2", "y", unit(2), "m", null)]);
    expect(a.rows).toBe(2);
    expect(a.embedded).toBe(1);
    expect(a.provenance.unstamped).toBe(0);
  });

  it("surfaces more than one vector dimension — the second foreign-model smell", () => {
    const a = auditRows("skill_alias", [row("1", "x", unit(1, 8), "m", null), row("2", "y", unit(2, 4), "m", null)]);
    expect(a.dimensions).toEqual([4, 8]);
  });

  it("carries corpusBlockReason so the audit and the eval gate cannot disagree", () => {
    const a = auditRows("skill_alias", [row("1", "x", unit(1), null, null)]);
    expect(a.blockReason).toMatch(/no embedding_model/);
    const clean = auditRows("skill_alias", [row("1", "x", unit(1), "gemini-embedding-001", null)]);
    expect(clean.blockReason).toBeNull();
  });

  it("blocks on the mock sentinel even when every vector is real", () => {
    // A row can hold a genuine vector and still be stamped `mock-embedding` if a run was
    // re-pointed mid-flight. The stamp is the claim of record, so it blocks.
    const a = auditRows("skill_alias", [row("1", "x", unit(1), MOCK_MODEL_TAG, null)]);
    expect(a.blockReason).toMatch(/mock/i);
  });

  it("l2Norm reports ~1 for the normalized corpus", () => {
    expect(l2Norm(unit(4))).toBeCloseTo(1, 12);
  });

  it("has no L2 range when nothing is embedded", () => {
    expect(auditRows("skill_alias", [row("1", "x", null, null, null)]).l2).toBeNull();
  });
});
