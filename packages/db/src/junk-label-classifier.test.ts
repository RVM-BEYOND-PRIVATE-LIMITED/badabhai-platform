/**
 * The rules that decide whether a taxonomy row is disposable.
 *
 * Every test here is really the same question: can this classifier be talked into calling a
 * real, coded NCO occupation "junk" because the scrape put the wrong line in `label_en`? That
 * is the failure with consequences — the opposite mistake (over-cautious `AMBIGUOUS`) costs a
 * human five minutes of review.
 */
import { describe, expect, it } from "vitest";

import {
  classifyAlias,
  classifyDomain,
  classifyLabel,
  isProse,
  isTitleShaped,
  NO_REMEDIATION_NOTICE,
  type DomainInput,
} from "./junk-label-classifier";

describe("classifyLabel — the two shapes of scrape residue", () => {
  it("a section header ends with a colon", () => {
    expect(classifyLabel("ISCO 08 Unit Group Details:")).toEqual({
      defective: true,
      defect: "SECTION_HEADER",
    });
  });

  it("a wrapped continuation line starts lowercase", () => {
    expect(classifyLabel("skins or hides and keeps them near machine").defect).toBe("PROSE_FRAGMENT");
  });

  it("a real occupation title is not defective", () => {
    expect(classifyLabel("Electrical Line Installers, Repairers and Cable Jointers, Other")).toEqual({
      defective: false,
      defect: null,
    });
  });

  it("a caseless script is not treated as lowercase", () => {
    // Devanagari has no case. `'क' === 'क'.toLowerCase()` is true, so a naive check would
    // classify every Hindi label as scrape residue.
    expect(classifyLabel("कुली").defective).toBe(false);
  });

  it("an empty label is not a false positive", () => {
    expect(classifyLabel("").defective).toBe(false);
  });
});

describe("isTitleShaped / isProse", () => {
  it("accepts a title and rejects a paragraph", () => {
    expect(isTitleShaped("Cable Jointer")).toBe(true);
    expect(isTitleShaped("Elected Official, Local Bodies")).toBe(true);
    expect(isProse("or ad-hoc private bodies, not else-where classified.")).toBe(true);
  });

  it("rejects a title-cased string that is really a clause", () => {
    expect(isTitleShaped("Receives instructions from Scouring Supervisor and prepares")).toBe(false);
  });

  it("treats a trailing comma as a wrapped line", () => {
    expect(isProse("railways, tramways, buses, trucks, taxis, rickshaws, boats,")).toBe(true);
  });

  it("a semicolon means more than one clause, so not a title", () => {
    expect(isTitleShaped("skins or hides; spreads skin")).toBe(false);
  });
});

describe("classifyAlias — precedence is the point", () => {
  const base = { text: "Cable Jointer", isSearchable: true, domainsSharingNorm: 1 };

  it("the database's own election beats any guess from the text", () => {
    // is_searchable=false IS the recorded outcome of the duplicate election. A well-formed
    // title that lost that election is still a duplicate.
    expect(classifyAlias({ ...base, isSearchable: false })).toBe("DUPLICATE");
  });

  it("a collision outranks good shape — a tidy alias can still compete for a phrase", () => {
    expect(classifyAlias({ ...base, domainsSharingNorm: 2 })).toBe("CONFLICTING_ALIAS");
  });

  it("scraped prose is junk", () => {
    expect(classifyAlias({ ...base, text: "and notes important points. Records oral evidence" })).toBe("JUNK");
  });

  it("a clean unique title is legitimate", () => {
    expect(classifyAlias(base)).toBe("LEGITIMATE_ALIAS");
  });

  it("anything else is AMBIGUOUS rather than guessed", () => {
    // Capitalised, unique, under 80 chars, but too long to read as a title.
    expect(classifyAlias({ ...base, text: "Supervisor Of Loaders Who Shovel Material Onto The Conveyor" })).toBe(
      "AMBIGUOUS",
    );
  });
});

describe("classifyDomain — the rule that protects real occupations", () => {
  const d = (over: Partial<DomainInput> = {}): DomainInput => ({
    jobDomainId: "jd_nco_8155_0201",
    labelEn: "skins or hides and keeps them near machine",
    childCount: 0,
    referenceCount: 0,
    searchableAliases: 7,
    titleShapedAliases: 3,
    hasSourceCode: true,
    ...over,
  });

  it("a coded occupation with a usable alias is MISLABELLED, never junk", () => {
    expect(classifyDomain(d())).toBe("C_MISLABELLED_LEGITIMATE");
  });

  it("any reference wins over every other signal", () => {
    expect(classifyDomain(d({ referenceCount: 1, titleShapedAliases: 0, hasSourceCode: false }))).toBe(
      "B_LEGACY_REFERENCED",
    );
  });

  it("a parent is structural even with a terrible label", () => {
    expect(classifyDomain(d({ childCount: 3, titleShapedAliases: 0 }))).toBe("D_STRUCTURAL");
  });

  it("A_UNUSED_JUNK requires the identity to be genuinely unrecoverable", () => {
    expect(
      classifyDomain(d({ hasSourceCode: false, searchableAliases: 0, titleShapedAliases: 0 })),
    ).toBe("A_UNUSED_JUNK");
  });

  // The specific mistake this whole module exists to prevent.
  it("a coded row with NO usable alias is AMBIGUOUS — not junk", () => {
    // It has a published NCO code, so it is a real published occupation. That the scrape left
    // no readable alias is a data-quality problem, not a licence to remove the occupation.
    expect(classifyDomain(d({ titleShapedAliases: 0 }))).toBe("E_AMBIGUOUS");
  });

  it("an uncoded row that still has aliases is AMBIGUOUS, not junk", () => {
    expect(classifyDomain(d({ hasSourceCode: false, titleShapedAliases: 0 }))).toBe("E_AMBIGUOUS");
  });
});

describe("the notice", () => {
  it("states that a classification is not an authorization", () => {
    expect(NO_REMEDIATION_NOTICE).toMatch(/not an authorization/);
    expect(NO_REMEDIATION_NOTICE).toMatch(/not evidence that the occupation beneath/);
  });
});
