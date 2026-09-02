import { describe, expect, it } from "vitest";

import {
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
} from "../profiles/worker-preferences.vocabulary";
import { readPreferenceFacts } from "./resume-preference-facts";
import {
  certificateFacts,
  certificateLine,
  educationFacts,
  educationLine,
  qualificationFactsFrom,
  type WorkerCertificateRecord,
  type WorkerEducationRecord,
} from "./resume-qualification-rows";
import { buildQualificationRows } from "./resume-sheet-rows";

/**
 * ZONE 5's two credential rows, from the worker's OWN structured rows (migration 0098).
 *
 * SEEDED RECORDS, NOT A DATABASE — the split `resume-employment-rows.test.ts` already uses. The
 * repository reads rows; the subject turns rows into the strings the sheet prints, and the
 * sheet's grammar is the half a database cannot answer: which separator joins what, and what an
 * absent segment costs.
 *
 * THE RATIFIED LINE IS ASSERTED VERBATIM rather than by pattern, because `resume-render-input.ts`
 * composes the same line out of the OLD attribute scalars and the two compositions must agree
 * byte for byte. A pattern would let them drift a space or a dash apart and still pass, which is
 * exactly the failure — one worker's ITI printing two different ways depending on which surface
 * he filled.
 */

/** The ratified sheet's own example, in the five columns 0098 stores it in. */
function education(over: Partial<WorkerEducationRecord> = {}): WorkerEducationRecord {
  return {
    credential: "iti",
    field: "Machinist",
    council: "ncvt",
    year: 2018,
    institute: "Govt. ITI, Faridabad",
    ...over,
  };
}

/** A row with only the named segments filled — the shape that proves a separator is conditional. */
function only(over: Partial<WorkerEducationRecord>): WorkerEducationRecord {
  return { credential: null, field: null, council: null, year: null, institute: null, ...over };
}

function certificate(over: Partial<WorkerCertificateRecord> = {}): WorkerCertificateRecord {
  return { name: "CNC Turning & Fanuc Programming", issuer: "RVM CAD", year: 2020, ...over };
}

const RATIFIED = "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad";

describe("educationLine — the ratified sheet's four segments", () => {
  it("composes the ratified line character for character", () => {
    expect(educationLine(education())).toBe(RATIFIED);
  });

  it("joins with the EM-dash and the middot, not their lookalikes", () => {
    // The two separators are shared with `resume-render-input.ts`'s scalar composition, and a
    // hyphen or an en-dash swapped in here would leave that file's output unchanged — so the
    // drift would show up only as two workers' sheets disagreeing, never as a failure.
    const line = educationLine(education())!;
    expect(line).toContain("—"); // em-dash, credential → field
    expect(line).toContain("·"); // middot, everything after
    expect(line).not.toContain("–"); // en-dash
    expect(line).not.toMatch(/ - |--/);
  });

  it("puts the field with the credential and everything else behind the middot", () => {
    // The em-dash belongs to ONE join. A second em-dash would mean the council or the year had
    // been promoted into the credential half of the line, which is a different claim.
    expect(educationLine(education())!.split(" — ")).toHaveLength(2);
    expect(educationLine(education())!.split(" · ")).toEqual([
      "ITI — Machinist",
      "NCVT",
      "2018",
      "Govt. ITI, Faridabad",
    ]);
  });
});

describe("educationLine — an absent segment takes its separator with it", () => {
  it("prints a lone credential with no orphan punctuation", () => {
    // §11 #2's case, and the one that reaches the sheet most: a worker who tapped his credential
    // and answered nothing else. "ITI — " or "ITI · " on a printed résumé reads as a truncation.
    expect(educationLine(only({ credential: "iti" }))).toBe("ITI");
  });

  it("prints each other lone segment the same way", () => {
    expect(educationLine(only({ field: "Machinist" }))).toBe("Machinist");
    expect(educationLine(only({ council: "ncvt" }))).toBe("NCVT");
    expect(educationLine(only({ year: 2018 }))).toBe("2018");
    expect(educationLine(only({ institute: "Govt. ITI, Faridabad" }))).toBe("Govt. ITI, Faridabad");
  });

  it("closes a hole in the middle rather than printing a double separator", () => {
    // Skipping the council and the year is the common shape — the finishing form asks for both
    // and neither is required. "ITI · · Govt. ITI" is the defect this catches.
    expect(educationLine(only({ credential: "iti", institute: "Govt. ITI, Faridabad" }))).toBe(
      "ITI · Govt. ITI, Faridabad",
    );
    expect(educationLine(education({ council: null, year: null }))).toBe(
      "ITI — Machinist · Govt. ITI, Faridabad",
    );
  });

  it("drops the em-dash with the credential, keeping the field on its own", () => {
    // A worker who typed his trade but never tapped a credential still has a printable fact.
    // The em-dash must leave with the credential, not strand itself in front of the field.
    expect(educationLine(only({ field: "Machinist", year: 2018 }))).toBe("Machinist · 2018");
    expect(educationLine(education({ credential: null }))).toBe(
      "Machinist · NCVT · 2018 · Govt. ITI, Faridabad",
    );
  });

  it("treats a whitespace-only free-text field as absent", () => {
    // `wed_not_empty_chk` stops an all-null row, not a row whose institute is three spaces.
    // Trimmed to nothing it must cost its separator too, or the line ends " · ".
    expect(educationLine(only({ credential: "iti", institute: "   " }))).toBe("ITI");
    expect(educationLine(education({ field: "  ", institute: " " }))).toBe("ITI · NCVT · 2018");
  });

  it("returns null, never an empty string, for a row that says nothing", () => {
    // The callers drop a null. An empty string survives every truthiness check they apply and
    // prints as a blank line under the Education heading.
    expect(educationLine(only({}))).toBeNull();
  });
});

describe("educationLine — an unknown slug is dropped, never printed raw", () => {
  it("drops `iti_diploma`, the merged option this dictionary exists to split", () => {
    // `qp_universal` stores the two credentials as one `iti_diploma` value, so it is the slug
    // most likely to arrive here from an older writer. "iti_diploma — Machinist" on the one line
    // a hiring supervisor checks hardest is worse than no credential at all.
    const line = educationLine(education({ credential: "iti_diploma" }))!;
    expect(line).toBe("Machinist · NCVT · 2018 · Govt. ITI, Faridabad");
    expect(line).not.toContain("iti_diploma");
  });

  it("drops a council the closed set does not know", () => {
    const line = educationLine(education({ council: "wb_scvt" }))!;
    expect(line).toBe("ITI — Machinist · 2018 · Govt. ITI, Faridabad");
    expect(line).not.toContain("wb_scvt");
  });

  it("never leaks a slug's shape when both dictionaries miss", () => {
    // A single assertion over the whole line, because the next retired option will not be one
    // of the two named above: nothing snake_cased may reach the page.
    const line = educationLine(education({ credential: "iti_diploma", council: "wb_scvt" }))!;
    expect(line).toBe("Machinist · 2018 · Govt. ITI, Faridabad");
    expect(line).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("prints nothing at all when the unknown slug was the only content", () => {
    // Not an empty string, and not the slug: the row disappears exactly like an empty one.
    expect(educationLine(only({ credential: "iti_diploma" }))).toBeNull();
    expect(educationLine(only({ council: "wb_scvt" }))).toBeNull();
  });
});

describe("certificateLine — the parentheses are conditional on their contents", () => {
  it("holds both halves with a comma between them", () => {
    expect(certificateLine(certificate())).toBe("CNC Turning & Fanuc Programming (RVM CAD, 2020)");
  });

  it("holds one half alone, with no comma and no empty slot", () => {
    expect(certificateLine(certificate({ issuer: null }))).toBe(
      "CNC Turning & Fanuc Programming (2020)",
    );
    expect(certificateLine(certificate({ year: null }))).toBe(
      "CNC Turning & Fanuc Programming (RVM CAD)",
    );
    // The comma is a separator, not decoration — with one value there is nothing to separate.
    expect(certificateLine(certificate({ issuer: null }))).not.toContain(",");
    expect(certificateLine(certificate({ year: null }))).not.toContain(",");
  });

  it("prints a bare name with NO brackets at all", () => {
    // The load-bearing one. "CNC Turning & Fanuc Programming ()" reads as a redaction — as if an
    // issuer and a year existed and were withheld — which is a claim about the certificate that
    // the worker never made, and §8 admits no fourth source for it.
    const line = certificateLine(certificate({ issuer: null, year: null }))!;
    expect(line).toBe("CNC Turning & Fanuc Programming");
    expect(line).not.toContain("(");
    expect(line).not.toContain(")");
  });

  it("treats a whitespace-only issuer as absent", () => {
    expect(certificateLine(certificate({ issuer: "  ", year: null }))).toBe(
      "CNC Turning & Fanuc Programming",
    );
  });

  it("returns null for a nameless row rather than orphaned brackets", () => {
    // A name is the certificate. Without one the issuer and year describe nothing, and
    // " (RVM CAD, 2020)" would print as a line with its subject missing.
    expect(certificateLine(certificate({ name: "   " }))).toBeNull();
    expect(certificateFacts([certificate({ name: "" }), certificate()])).toEqual([
      "CNC Turning & Fanuc Programming (RVM CAD, 2020)",
    ]);
  });
});

describe("educationFacts — the worker's own order, never the year's", () => {
  /** Three credentials whose years are deliberately neither ascending nor descending. */
  const OUT_OF_ORDER: readonly WorkerEducationRecord[] = [
    only({ credential: "diploma", field: "Mechanical", year: 2021 }),
    only({ credential: "iti", field: "Turner", council: "ncvt", year: 2014 }),
    only({ credential: "class_10", council: "cbse", year: 2018 }),
  ];

  it("keeps the given order — a sort by year would reorder these three", () => {
    // 2021, 2014, 2018 matches neither an ascending nor a descending sort, so a re-sort cannot
    // pass this by coincidence. Re-deriving the order would reshuffle rows between renders and
    // make every regenerated PDF a false diff against the last one the worker downloaded.
    const facts = educationFacts(OUT_OF_ORDER);
    expect(facts.headline).toBe("Diploma — Mechanical · 2021");
    expect(facts.rest).toEqual(["ITI — Turner · NCVT · 2014", "10th pass · CBSE · 2018"]);
  });

  it("makes the FIRST row the headline and every later row a list entry", () => {
    const facts = educationFacts(OUT_OF_ORDER);
    expect(facts.headline).toBe(educationLine(OUT_OF_ORDER[0]!));
    expect(facts.rest).toHaveLength(OUT_OF_ORDER.length - 1);
  });

  it("leaves `rest` empty for a single row rather than repeating the headline", () => {
    const facts = educationFacts([education()]);
    expect(facts.headline).toBe(RATIFIED);
    expect(facts.rest).toEqual([]);
  });

  it("returns a NULL headline for no rows, so the caller's `??` can fall through", () => {
    // An empty string here is truthy enough to win a `??` and would blank the education line of
    // every worker who filled the old attribute scalars and never opened this form.
    expect(educationFacts([])).toEqual({ headline: null, rest: [] });
  });

  it("skips a row that prints nothing instead of promoting it to the headline", () => {
    // A retired credential slug leaves a row that composes to null. It must vanish, not become
    // an empty headline that pushes the worker's real credential down into the list.
    const facts = educationFacts([only({ credential: "iti_diploma" }), education()]);
    expect(facts.headline).toBe(RATIFIED);
    expect(facts.rest).toEqual([]);
  });
});

describe("qualificationFactsFrom — `undefined` and `[]` are different answers", () => {
  it("returns undefined when the worker has no rows of either kind", () => {
    // Zone 5 resolves `qualification?.certifications ?? draftQualification.certifications`, and
    // `??` falls through on nullish ONLY. An empty ARRAY here would assert "no certificates" for
    // every worker who never opened this form and silently suppress the extraction's own.
    expect(qualificationFactsFrom({ certificates: [], educations: [] })).toBeUndefined();
  });

  it("returns an EMPTY certifications array when the worker has education and no certificates", () => {
    // The opposite case, and it is not symmetrical: this worker HAS used the surface, so his
    // empty list is the assertion "I have none" and the model's guess must not fill it back in.
    const block = qualificationFactsFrom({ certificates: [], educations: [education()] })!;
    expect(block.certifications).toEqual([]);
    expect(block.certifications).not.toBeUndefined();
    expect(block.educationHeadline).toBe(RATIFIED);
    expect(block.education).toEqual([]);
  });

  it("leaves the education headline NULL for a certificates-only worker", () => {
    // Per-field within the surface: the headline is nullish, so the caller's `??` falls through
    // to the attribute-scalar composition and the worker keeps the education line his interview
    // gave him — while the certificate he just entered still prints.
    const block = qualificationFactsFrom({ certificates: [certificate()], educations: [] })!;
    expect(block.educationHeadline).toBeNull();
    expect(block.education).toEqual([]);
    expect(block.certifications).toEqual(["CNC Turning & Fanuc Programming (RVM CAD, 2020)"]);
  });

  it("carries both lists, in order, when the worker filled both", () => {
    const block = qualificationFactsFrom({
      certificates: [certificate(), certificate({ name: "Forklift licence", issuer: null })],
      educations: [education(), only({ credential: "class_10", council: "cbse", year: 2012 })],
    })!;
    expect(block).toEqual({
      educationHeadline: RATIFIED,
      education: ["10th pass · CBSE · 2012"],
      certifications: [
        "CNC Turning & Fanuc Programming (RVM CAD, 2020)",
        "Forklift licence (2020)",
      ],
    });
  });

  it("counts ROWS, not printable lines, when deciding the surface was used", () => {
    // A row whose only slug has been retired prints nothing, but the worker did fill this form
    // — so the block still exists and its empty certifications list is still authoritative.
    // Falling back to `undefined` here would resurrect extracted certificates for a worker who
    // deleted his, which is the failure the all-or-nothing rule is written against.
    const block = qualificationFactsFrom({
      certificates: [],
      educations: [only({ credential: "iti_diploma" })],
    })!;
    expect(block).toEqual({ educationHeadline: null, education: [], certifications: [] });
  });
});

/**
 * ── REGRESSION PIN: THE SHAPES THE §8 GATE ALREADY ACCEPTS ────────────────────────────
 *
 * `__fixtures__/sheet-shapes.ts` FULL_QUALIFICATION, copied verbatim, is the block every
 * fabrication-gate shape renders today:
 *
 *   educationHeadline: "ITI — Turner"
 *   education:         ["NCVT, 2014", "Government ITI Faridabad"]
 *   certifications:    ["Forklift licence, 2021", "Safety training, 2023"]
 *
 * The gate splits a printed row into atoms on its composition separators and requires each atom
 * to be a closed-vocabulary label, a stated number, or a substring of something the worker
 * supplied. These functions are a NEW writer for those same two rows, so the property is
 * restated here at unit scale — cheaply, on every row shape, without rendering a sheet.
 */
describe("§8 — every part of these lines is a label, a number, or the worker's own words", () => {
  const DICTIONARY: ReadonlySet<string> = new Set([
    ...Object.values(EDUCATION_QUALIFICATIONS),
    ...Object.values(EDUCATION_COUNCILS),
  ]);

  /** The gate's own separators, plus the em-dash and the brackets this file composes with. */
  function partsOf(line: string): string[] {
    return line
      .split(/\s+·\s+|\s+—\s+|,\s+|[()]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /** ONE-DIRECTIONAL containment, exactly as the gate does it — see its header note. */
  function sourced(part: string, supplied: readonly string[]): boolean {
    return DICTIONARY.has(part) || supplied.some((said) => said.includes(part));
  }

  it("rejects an added word — the check is not vacuous", () => {
    // Reversing the containment would make "Highly skilled Machinist" pass because the worker
    // said "Machinist", which is precisely the fabrication the rule exists to catch.
    expect(sourced("Machinist", ["Machinist"])).toBe(true);
    expect(sourced("Highly skilled Machinist", ["Machinist"])).toBe(false);
  });

  it("sources every part of a full education line", () => {
    const record = education();
    const supplied = ["Machinist", "Govt. ITI, Faridabad", "2018"];
    for (const part of partsOf(educationLine(record)!)) {
      expect(sourced(part, supplied), `"${part}" has no source — §8 admits no fourth`).toBe(true);
    }
  });

  it("sources every part of a full certificate line", () => {
    const supplied = ["CNC Turning & Fanuc Programming", "RVM CAD", "2020"];
    for (const part of partsOf(certificateLine(certificate())!)) {
      expect(sourced(part, supplied), `"${part}" has no source — §8 admits no fourth`).toBe(true);
    }
  });

  it("composes into Zone 5's two rows exactly as the fixture block does", () => {
    // `buildQualificationRows` joins the headline to the rest with the SAME middot these lines
    // use internally, which is why the fixture's "ITI — Turner" + ["NCVT, 2014", …] prints as one
    // row. A separator changed on either side shows up here before it shows up on a PDF.
    const block = qualificationFactsFrom({
      certificates: [certificate(), certificate({ name: "Forklift licence", issuer: null })],
      educations: [education(), only({ credential: "class_10", council: "cbse", year: 2012 })],
    })!;
    const rows = buildQualificationRows({ ...block, languages: [] });
    expect(rows.find((r) => r.label === "Education")?.value).toBe(
      "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad · 10th pass · CBSE · 2012",
    );
    expect(rows.find((r) => r.label === "Certificates")?.value).toBe(
      "CNC Turning & Fanuc Programming (RVM CAD, 2020) · Forklift licence (2020)",
    );
  });

  it("collapses both rows away for a worker with nothing to say", () => {
    // §11 #2 — a twelve-year machinist with no ITI is often the most valuable worker on the
    // platform. Nothing may flag the absence, and an empty row IS a flag.
    const rows = buildQualificationRows({
      educationHeadline: null,
      education: [],
      certifications: [],
      languages: [],
    });
    expect(rows).toEqual([]);
  });
});

describe("parity with the attribute-scalar composition it replaces", () => {
  it("reproduces `readPreferenceFacts`'s education segments, in the same order", () => {
    // `resume-render-input.ts` builds the same line as
    // `[credential — field, educationDetail].join(" · ")`. Deriving half of the expectation from
    // that file rather than typing it out is the point: a reordering of council/year/institute
    // there, or a changed separator, fails HERE — which is the only place the two ever meet.
    const facts = readPreferenceFacts({
      education_credential: "iti",
      education_council: "ncvt",
      education_year: 2018,
      education_institute: "Govt. ITI, Faridabad",
    });
    expect(facts.educationDetail).toBe("NCVT · 2018 · Govt. ITI, Faridabad");
    expect(educationLine(education())).toBe(
      `${facts.educationCredential} — Machinist · ${facts.educationDetail}`,
    );
  });

  it("prints the same English for a slug both dictionaries hold", () => {
    // `EDUCATION_QUALIFICATIONS` is the whole-credential set and `EDUCATION_CREDENTIALS` the
    // two-value narrowing of `iti_diploma`. They overlap on `iti` and `diploma`, and a worker
    // whose row says `iti` and whose attribute says `iti` must not read differently.
    for (const slug of ["iti", "diploma"]) {
      const viaRow = educationLine(only({ credential: slug }));
      const viaAttributes = readPreferenceFacts({ education_credential: slug }).educationCredential;
      expect(viaRow).toBe(viaAttributes);
    }
  });
});
