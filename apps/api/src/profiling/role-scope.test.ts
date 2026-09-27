import { describe, expect, it } from "vitest";

import { FAMILY_CHIP_LABELS } from "../occupation/family-chip-labels";

import {
  ADJACENT_FAMILY_IDS,
  classifyRoleScope,
  DECLARED_FAMILY_IDS,
  DECLARED_OCCUPATION_TERMS,
  NOT_EVIDENCE_WORDS,
  OUTSIDE_RULED_RUNGS,
  RULED_RUNG_QUALIFIERS,
  SCOPE_DECLARED_TERMS,
  STRIPPED_TERMS,
  type RoleScope,
  type RoleScopeInput,
} from "./role-scope";
import { ROLE_FORM_DESCRIPTORS } from "./roles/role-registry";
import { routeToTradeForm } from "./trade-form-router";

/**
 * THE LANE READ, ASSERTED CASE BY CASE (ADR-0045 §3.1).
 *
 * The regression that matters most is a FALSE `outside`: one of the 21 sent down the general road
 * and handed a general résumé instead of the trade form the owner built for them. So the
 * `declared` and `unknown` tables are as long as the `outside` one, and every rule that keeps a
 * worker off the road has a case that fails if the rule is removed.
 */
function scope(
  roleLabel: string | null,
  rest: Partial<Omit<RoleScopeInput, "roleLabel">> = {},
): RoleScope {
  return classifyRoleScope({
    domainLabel: rest.domainLabel ?? null,
    roleLabel,
    pinFamilyId: rest.pinFamilyId ?? null,
    pinLabel: rest.pinLabel ?? null,
  });
}

/** The same preparation the module applies to its terms, for the invariant checks below. */
function fold(term: string): string {
  return term
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

describe("classifyRoleScope", () => {
  describe("outside — the model captured a role, and it names none of the 21", () => {
    const outside: readonly string[] = [
      "Software developer",
      "Pilot",
      "Commercial pilot",
      "Interior designer",
      "Trader",
      "Cook",
      "Tandoor cook",
      "Driver",
      "Accountant",
      "Teacher",
      "Shop manager",
      "Captain",
      // Bare "electrician" is the domestic wireman (ruling A2) — see `OUTSIDE_RULED_RUNGS`.
      "Electrician",
      "House painter",
      // A rung with a trade beside it: the rung goes, the trade stays.
      "Kitchen helper",
      "Forklift operator",
      "Senior accountant",
      "AC technician",
      "Software programmer",
      "रसोइया",
      // The vehicle mechanic is `fam_auto_mechanic`, not the 21's machine mechanic.
      "Mechanic",
      "Car mechanic",
      // A discipline word is stripped; the trade beside it still stands.
      "Electrical contractor",
      // A credential word is stripped; the ruled rung beside it is still bare.
      "ITI electrician",
      // The Latin "press" is not evidence either way, and the ironing trade's own word is left.
      "Istri press wala",
    ];
    for (const role of outside) {
      it(JSON.stringify(role), () => {
        expect(scope(role)).toBe("outside");
      });
    }

    it("a pin to a family outside the 21 does not pull a role in", () => {
      expect(
        scope("Electrician", { pinFamilyId: "fam_electrical", pinLabel: "bijli ka kaam" }),
      ).toBe("outside");
      expect(
        scope("House painter", { pinFamilyId: "fam_painting", pinLabel: "painter ka kaam" }),
      ).toBe("outside");
      expect(scope("Cook", { pinFamilyId: "fam_cooking", pinLabel: "khana banana" })).toBe(
        "outside",
      );
    });

    it("a qualified shared rung is decided by its qualifier, as the rung's own role file rules", () => {
      // `fitter.role.ts`: a pipe fitter is plumbing, not the 21's fitter.
      expect(scope("Pipe fitter")).toBe("outside");
      // `cad-draughtsman.role.ts`: the bare draughtsman belongs to twelve occupations; civil is
      // one of the ones the 21 does not model.
      expect(scope("Civil draughtsman")).toBe("outside");
    });
  });

  describe("declared — something names one of the 21", () => {
    describe("each descriptor's first occupation term, as the role alone", () => {
      for (const descriptor of ROLE_FORM_DESCRIPTORS) {
        const term = descriptor.detection.occupationTerms[0]!;
        it(`${descriptor.kind}: ${JSON.stringify(term)}`, () => {
          expect(scope(term)).toBe("declared");
        });
      }
    });

    it("every occupation term of every descriptor, including the 5 formless ones", () => {
      const misses = ROLE_FORM_DESCRIPTORS.flatMap((descriptor) =>
        descriptor.detection.occupationTerms
          .filter((term) => scope(term) !== "declared")
          .map((term) => `${descriptor.kind}: ${term}`),
      );
      expect(misses).toEqual([]);
    });

    describe("a pin to any of the 21's own families, with only a rung for a role", () => {
      for (const descriptor of ROLE_FORM_DESCRIPTORS) {
        it(descriptor.familyId, () => {
          expect(scope("operator", { pinFamilyId: descriptor.familyId })).toBe("declared");
        });
      }
    });

    describe("a pin to an adjacent generic family, with only generic words for a role", () => {
      for (const familyId of ADJACENT_FAMILY_IDS) {
        it(familyId, () => {
          expect(scope("machine operator", { pinFamilyId: familyId })).toBe("declared");
        });
      }
    });

    it("two of the 21 at once is still the 21 — the router's veto is not applied", () => {
      const input = {
        domainLabel: null,
        roleLabel: "CNC turning aur VMC",
        pinFamilyId: "fam_cnc_turning",
        pinLabel: null,
      };
      // The router refuses it: "vmc" is turning's conflict term, and the honest answer to "which
      // ONE form" is none. That is a different question from "is this one of the 21".
      expect(
        routeToTradeForm({
          draft: { domain_label: null, role_label: input.roleLabel, skills: [], experiences: [] },
          occupationFamilyId: input.pinFamilyId,
          occupationLabel: null,
        }),
      ).toBeNull();
      expect(classifyRoleScope(input)).toBe("declared");
      // And without the pin, on the occupation term alone.
      expect(scope("CNC turning aur VMC")).toBe("declared");
    });

    it("a formless polymer role, which the router can never route, is still one of the 21", () => {
      expect(scope("injection moulding operator")).toBe("declared");
      expect(
        scope("Plastic moulding machine operator", { pinFamilyId: "fam_rubber_plastic" }),
      ).toBe("declared");
    });

    describe("the recall gaps the role files leave on purpose (SCOPE_DECLARED_TERMS)", () => {
      // Every one of these read `outside` before, most with the pin offline retrieval actually
      // produces for it — and a false `outside` is the costly mistake.
      const declared: readonly (readonly [string, Partial<RoleScopeInput>])[] = [
        // R1: the 5 polymer roles keep today's path. No pin: the corpus pins nothing for these.
        ["Moulding machine operator", {}],
        ["Molding machine operator", {}],
        ["Plastic moulding", {}],
        ["Plastic molding", {}],
        ["Plastic moulding machine operator", {}],
        ["Moulder", {}],
        ["Molder", {}],
        ["Moulding helper", {}],
        ["moulding machine chalata hoon", {}],
        ["मोल्डिंग ऑपरेटर", {}],
        ["प्लास्टिक मोल्डिंग", {}],
        ["Moulder", { domainLabel: "Plastics" }],
        // The Latin twin of the Devanagari "मशीनिस्ट".
        ["Machinist", {}],
        ["CNC machinist", {}],
        // The Latin twin of the Devanagari "असेंबली"; bare "assembler" ties offline, so no pin.
        ["Assembler", {}],
        ["Assembly worker", {}],
        // The industrial electrician's rung, qualified the ways the registry does not list.
        ["Panel wireman", {}],
        ["Maintenance electrician", {}],
        ["मेंटेनेंस इलेक्ट्रीशियन", {}],
        // "maintenance" is stripped; what stood beside it was read as the role.
        ["Maintenance mechanic", { pinFamilyId: "fam_electronics_install" }],
        ["Mechanical maintenance", {}],
        ["Electrical maintenance", {}],
        ["Machine mechanic", {}],
        // `fitter.role.ts`: he keeps the generic interview — today's path.
        [
          "Mechanical fitter",
          { pinFamilyId: "fam_electrical_equipment", pinLabel: "Mechanical Fitter" },
        ],
        // The CAD draughtsman, in the other word order and by his top rung.
        ["Draftsman mechanical", { pinFamilyId: "fam_draughting" }],
        ["Mechanical design engineer", { pinFamilyId: "fam_universal", pinLabel: "General" }],
        // "QC inspector" was declared and "QA inspector" was not.
        ["QA inspector", {}],
        ["QA QC inspector", {}],
      ];
      for (const [role, rest] of declared) {
        it(`${JSON.stringify(role)}${rest.pinFamilyId ? ` pinned ${rest.pinFamilyId}` : ""}`, () => {
          expect(scope(role, rest)).toBe("declared");
        });
      }

      it("every entry reads declared as the whole role", () => {
        expect(SCOPE_DECLARED_TERMS.filter((term) => scope(term) !== "declared")).toEqual([]);
      });
    });

    it("the two generic packs the role files name as siblings are adjacent", () => {
      // `assembly-line-worker.role.ts`: `fam_assemblers_other` (minor 821) is a generic pack it
      // sits beside. A wiring-harness assembler is minor 821; his words name none of the 21.
      expect(scope("Wiring harness worker")).toBe("outside");
      expect(scope("Wiring harness worker", { pinFamilyId: "fam_assemblers_other" })).toBe(
        "declared",
      );
      // `maintenance-technician.role.ts`: `fam_machinery_repair` (minor 723, less the vehicle
      // mechanics of 7231) is a generic pack it sits beside.
      expect(scope("Mechanic", { pinFamilyId: "fam_machinery_repair" })).toBe("declared");
      expect(scope("Mechanic", { pinFamilyId: "fam_auto_mechanic" })).toBe("outside");
    });

    it("a dotted abbreviation is joined back before it is matched", () => {
      expect(scope("V.M.C operator")).toBe("declared");
      expect(scope("Q.C. inspector")).toBe("declared");
      expect(scope("Q.A. inspector")).toBe("declared");
    });

    it("Devanagari occupation terms", () => {
      expect(scope("टर्नर")).toBe("declared");
      expect(scope("वेल्डर")).toBe("declared");
    });

    it("an occupation term in the pin's catalogue label is enough", () => {
      expect(
        scope("operator", { pinFamilyId: "fam_other_plant", pinLabel: "CNC Operator-Turning" }),
      ).toBe("declared");
    });

    it("ACCEPTED FALSE DECLARED: a printing press operator", () => {
      // "press operator" is the press operator's occupation term, and the printing press is not a
      // trade the 21 model — the router vetoes it on "printing". Here it reads `declared`, and that
      // is accepted rather than patched: a false `declared` costs the worker nothing they have
      // today (the classic lane is today's interview, and the router still refuses the offer),
      // while the only patch available — reading the veto here — would make "CNC turning aur VMC"
      // `outside`, which is the mistake this module exists to prevent.
      expect(scope("Printing press operator")).toBe("declared");
    });

    // ACCEPTED FALSE DECLARED, the same trade as the printing press: each is an outsider named by
    // a word one of the 21 owns, and each costs the worker nothing he has today — the classic lane
    // is today's path, byte for byte. Patching any of them means reading a veto or a context here,
    // which is how a real member of the 21 ("CNC turning aur VMC") would be pushed out. So they are
    // pinned, not fixed. Three of them — "प्रेस वाला", "Rice milling", "Mixer grinder repair" — the
    // live router ROUTES today (a form is offered), and the lane must follow the offer (check (d)):
    // that is the router's precision, owned by the role files, not this module's recall.
    const acceptedFalseDeclared: readonly (readonly [string, string])[] = [
      // Devanagari "प्रेस" is the press operator's occupation term; the ironing press-wala says it.
      ["प्रेस वाला", "the clothes-ironing press-wala"],
      ["कपड़े प्रेस करने वाला", "the clothes-ironing press-wala"],
      // "milling" is the VMC operator's term; a rice mill is not a milling machine.
      ["Rice milling", "a rice mill hand"],
      // "qc" is the quality inspector's term; the router vetoes pharma and chemist, this does not.
      ["Pharma QC chemist", "a pharmaceutical QC chemist"],
      // "autocad" is the CAD draughtsman's term; civil drafting is not a trade the 21 model.
      ["Civil draughtsman AutoCAD", "a civil draughtsman"],
      // "grinder" is the grinding operator's term; a kitchen appliance repairer says it.
      ["Mixer grinder repair", "a mixer-grinder repairer"],
      // "machine mechanic" is a scope term; a garment unit's sewing-machine mechanic says it.
      ["Sewing machine mechanic", "a sewing-machine mechanic"],
      // "moulding" is a scope term; a plaster-of-Paris cornice is a moulding too.
      ["POP moulding", "a plaster-of-Paris cornice worker"],
    ];
    for (const [role, who] of acceptedFalseDeclared) {
      it(`ACCEPTED FALSE DECLARED: ${JSON.stringify(role)} (${who})`, () => {
        expect(scope(role)).toBe("declared");
      });
    }
  });

  describe("unknown — nothing yet says either", () => {
    const unknown: readonly (readonly [string, string | null, Partial<RoleScopeInput>])[] = [
      ["no role", null, {}],
      ["a blank role", "   ", {}],
      ["punctuation only", " — ? ", {}],
      ["a bare rung", "helper", {}],
      ["a bare rung", "operator", {}],
      ["generic words, no pin", "machine operator", {}],
      ["generic words, no pin", "CNC operator", {}],
      ["a bare rank", "senior", {}],
      [
        "the universal placeholder pin with no role",
        null,
        { pinFamilyId: "fam_universal", pinLabel: "General" },
      ],
      ["a worker, not a trade", "Factory worker", {}],
      ["Hinglish around a machine word", "khraad par kaam karta hoon", {}],
      ["Hinglish around generic words", "machine chalata hoon", {}],
      ["Devanagari rung", "ऑपरेटर", {}],
      ["a pin outside the 21 does not rescue a rung", "operator", { pinFamilyId: "fam_packing" }],
      // THE PRESS FAMILY: the Latin word is not evidence either way (the Devanagari is declared).
      ["the Latin press word", "Press machine operator", {}],
      ["the Latin press word", "Press worker", {}],
      ["the Latin press word", "Press helper", {}],
      ["the Latin press word", "Press shop operator", {}],
      ["the Latin press word", "Punching operator", {}],
      ["the Latin press word", "Stamping operator", {}],
      ["the Latin press word", "press wala", {}],
      ["the Latin press word", "Press machine operator", { domainLabel: "Automobile parts" }],
      // A DISCIPLINE beside a stripped rung.
      ["a discipline and a rung", "Mechanical technician", {}],
      ["a discipline and a rung", "Electrical technician", {}],
      ["a discipline and a rung", "QA engineer", {}],
      // A CREDENTIAL beside a stripped rung.
      ["a credential and a rung", "ITI fitter", {}],
      ["a credential and a rung", "I.T.I. fitter", {}],
      // DOTTED ABBREVIATIONS, which `normalise` spells out letter by letter.
      ["a dotted abbreviation", "C.N.C operator", {}],
      ["a dotted abbreviation", "C.N.C. machine operator", {}],
      // Joined, the article is swallowed ("acnc"); as written, the letters are dropped.
      ["a dotted abbreviation after an article", "I am a C.N.C operator", {}],
      // Only the joined reading makes "ac drive" the electrician's machine phrase.
      ["a dotted machine phrase", "A.C. drive technician", {}],
      // THE DEVANAGARI TWINS of generic Latin labels.
      ["Devanagari generic words", "सीएनसी मशीन ऑपरेटर", {}],
      ["Devanagari generic words", "मशीन चलाता हूँ", {}],
      ["Devanagari generic words", "मशीन ऑपरेटर रहा हूँ", {}],
      ["Devanagari generic words", "फैक्ट्री में लेबर", {}],
      // A RULED RUNG WITH A PLACE WORD no longer stands alone.
      ["a ruled rung with a place word", "Electrician industrial", {}],
      ["a ruled rung with a place word", "Electrician, plant", {}],
      ["a ruled rung with a place word", "Electrician in plant", {}],
      ["a ruled rung with a place word", "Factory electrician", {}],
      ["a ruled rung with a place word", "Company electrician", {}],
      ["a ruled rung with a place word", "Painter industrial", {}],
      ["a ruled rung with a place word", "Factory painter", {}],
      ["a ruled rung with a place word", "Wireman in company", {}],
      ["a ruled rung with a place word", "कंपनी में इलेक्ट्रीशियन", {}],
      ["a ruled rung with a place word", "इंडस्ट्रियल पेंटर", {}],
    ];
    for (const [label, role, rest] of unknown) {
      it(`${label}: ${JSON.stringify(role)}`, () => {
        expect(scope(role, rest)).toBe("unknown");
      });
    }

    it("ACCEPTED CHEAP UNKNOWN: a dotted outsider loses its abbreviation", () => {
      // "AC technician" is `outside`. Dotted, the as-written reading drops "a" and "c" and strips to
      // nothing — and "I am a C.N.C operator" needs exactly that reading, because joining swallows
      // its article. `unknown` is the cheap mistake, so the dotted air-conditioning man takes it.
      expect(scope("AC technician")).toBe("outside");
      expect(scope("A.C. technician")).toBe("unknown");
    });
  });

  describe("script parity: a generic label reads the same in Latin and in Devanagari", () => {
    const twins: readonly (readonly [string, string])[] = [
      ["CNC machine operator", "सीएनसी मशीन ऑपरेटर"],
      ["machine chalata hoon", "मशीन चलाता हूँ"],
      ["machine operator raha hoon", "मशीन ऑपरेटर रहा हूँ"],
      ["factory mein labour", "फैक्ट्री में लेबर"],
      ["machine chalate hain", "मशीन चलाते हैं"],
      ["trainee operator thi", "ट्रेनी ऑपरेटर थी"],
      ["machine wale ka kaam bhi", "मशीन वाले का काम भी"],
      ["helper ya operator", "हेल्पर या ऑपरेटर"],
      ["senior engineer", "सीनियर इंजीनियर"],
      ["mechanical kaam karna", "मैकेनिकल काम करना"],
      ["Factory electrician", "फैक्ट्री इलेक्ट्रीशियन"],
    ];
    for (const [latin, devanagari] of twins) {
      it(`${JSON.stringify(latin)} / ${JSON.stringify(devanagari)}`, () => {
        expect(scope(latin)).toBe("unknown");
        expect(scope(devanagari)).toBe("unknown");
      });
    }
  });

  describe("the level-term trap", () => {
    it("a term that is BOTH an occupation and a rung is read as the occupation, before stripping", () => {
      // Each of these is on its role's ladder AND is its occupation term. Stripping first would
      // leave nothing and read a welder as `unknown`.
      for (const role of ["Welder", "Mould maker", "Tool maker", "Process technician"]) {
        expect(scope(role), role).toBe("declared");
      }
      expect(scope("Senior welder")).toBe("declared");
      expect(scope("Certified welder")).toBe("declared");
    });

    it("a shared rung with no occupation word is `unknown`, never `outside`", () => {
      for (const role of [
        "Setter",
        "Programmer",
        "Technician",
        "Inspector",
        "Fitter",
        "Draughtsman",
        "Engineer",
        "Senior technician",
        "Setter cum programmer",
        "सेटर",
      ]) {
        expect(scope(role), role).toBe("unknown");
      }
    });

    it("the same rung is `declared` when its own family is pinned", () => {
      expect(scope("Fitter", { pinFamilyId: "fam_fitter" })).toBe("declared");
      expect(scope("Setter", { pinFamilyId: "fam_press_operation" })).toBe("declared");
    });

    it("the ruled rungs are the exception: bare they are outside, but never against the 21's evidence", () => {
      expect(scope("Electrician")).toBe("outside");
      expect(scope("Wireman")).toBe("outside");
      expect(scope("Painter")).toBe("outside");
      expect(scope("इलेक्ट्रीशियन")).toBe("outside");
      expect(scope("Industrial electrician")).toBe("declared");
      expect(scope("Electrician", { pinFamilyId: "fam_industrial_electrician" })).toBe("declared");
      expect(scope("Painter", { pinFamilyId: "fam_powder_coating" })).toBe("declared");
      expect(scope("Powder coating painter")).toBe("declared");
    });
  });

  describe("the domain and the pin can prove declared, never outside", () => {
    it("with no role, a domain outside the 21 is `unknown`", () => {
      expect(scope(null, { domainLabel: "Software" })).toBe("unknown");
      expect(scope("   ", { domainLabel: "Hospitality" })).toBe("unknown");
    });

    it("with no role, a pin outside the 21 is `unknown`", () => {
      expect(scope(null, { pinFamilyId: "fam_cooking", pinLabel: "khana banana" })).toBe("unknown");
    });

    it("a domain never supplies the residue: a rung under a non-21 domain is still `unknown`", () => {
      expect(scope("Operator", { domainLabel: "Software" })).toBe("unknown");
    });

    it("with no role, a domain or a pin that names one of the 21 is `declared`", () => {
      expect(scope(null, { domainLabel: "CNC Turning" })).toBe("declared");
      expect(scope(null, { pinFamilyId: "fam_cnc_turning" })).toBe("declared");
      expect(scope(null, { pinFamilyId: "fam_welding" })).toBe("declared");
    });

    it("a domain naming one of the 21 outranks a role that does not", () => {
      // The safe direction: one piece of 21 evidence anywhere is enough.
      expect(scope("Cook", { domainLabel: "Welding" })).toBe("declared");
    });
  });

  describe("text preparation", () => {
    it("NFKC folds a full-width label before matching", () => {
      expect(scope("ＴＵＲＮＥＲ")).toBe("declared");
      expect(scope("ＣＮＣ ｏｐｅｒａｔｏｒ")).toBe("unknown");
    });

    it("both spellings of a Devanagari nukta match the same term", () => {
      const precomposed = "\u092e\u095b\u0926\u0942\u0930"; // मज़दूर with U+095B
      const decomposed = "\u092e\u091c\u093c\u0926\u0942\u0930"; // मज़दूर with ज + U+093C
      expect(scope(precomposed)).toBe("unknown");
      expect(scope(decomposed)).toBe("unknown");
    });

    // DOCUMENTARY TODAY: neither placeholder spelling contains any of the 21's terms, so dropping
    // the filter changes no answer. The filter is there so a future term cannot make "General" —
    // which the #1691 ruling says is never a trade — into evidence of one.
    it("the universal placeholder pin label contributes nothing", () => {
      expect(scope(null, { pinFamilyId: "fam_universal", pinLabel: "सामान्य" })).toBe("unknown");
      expect(scope("Driver", { pinFamilyId: "fam_universal", pinLabel: "General" })).toBe(
        "outside",
      );
    });
  });

  describe("phrases are stripped before their words", () => {
    it("a machine phrase whose first word is not evidence is removed whole", () => {
      // "machine repair" is the maintenance technician's equipment phrase. Stripping "machine"
      // first would leave "repair" standing as if it named a trade.
      expect(scope("Machine repair")).toBe("unknown");
      expect(scope("Mixing mill operator")).toBe("unknown");
      expect(scope("Drawing office")).toBe("unknown");
    });

    it("a phrase is matched only whole: its words alone are still evidence", () => {
      expect(scope("Drawing teacher")).toBe("outside");
      expect(scope("Office assistant")).toBe("outside");
    });
  });

  it("is pure: the same frozen input gives the same answer every time", () => {
    const input = Object.freeze({
      domainLabel: "Hospitality",
      roleLabel: "Tandoor cook",
      pinFamilyId: null,
      pinLabel: null,
    });
    const answers = new Set([1, 2, 3].map(() => classifyRoleScope(input)));
    expect([...answers]).toEqual(["outside"]);
  });
});

describe("the closed sets", () => {
  it("DECLARED_FAMILY_IDS is exactly the 21 descriptors' families", () => {
    expect(ROLE_FORM_DESCRIPTORS).toHaveLength(21);
    expect([...DECLARED_FAMILY_IDS].sort()).toEqual(
      ROLE_FORM_DESCRIPTORS.map((descriptor) => descriptor.familyId).sort(),
    );
  });

  it("ADJACENT_FAMILY_IDS is disjoint from the 21 and names real families", () => {
    for (const familyId of ADJACENT_FAMILY_IDS) {
      expect(DECLARED_FAMILY_IDS.has(familyId), familyId).toBe(false);
      expect(FAMILY_CHIP_LABELS[familyId], familyId).toBeDefined();
    }
  });

  it("ADJACENT_FAMILY_IDS never holds the domestic electrician or the house painter", () => {
    for (const familyId of ["fam_electrical", "fam_electrical_equipment", "fam_painting"]) {
      expect(ADJACENT_FAMILY_IDS.has(familyId), familyId).toBe(false);
    }
  });

  it("ADJACENT_FAMILY_IDS never holds the vehicle mechanic, who sits beside fam_machinery_repair", () => {
    expect(ADJACENT_FAMILY_IDS.has("fam_auto_mechanic")).toBe(false);
  });

  it("no not-evidence word is an occupation term of the 21", () => {
    const occupation = new Set(DECLARED_OCCUPATION_TERMS);
    expect(NOT_EVIDENCE_WORDS.filter((word) => occupation.has(word))).toEqual([]);
  });

  it("no not-evidence word is a scope term, and no scope term is shadowed by another", () => {
    const scopeTerms = new Set(SCOPE_DECLARED_TERMS);
    expect(NOT_EVIDENCE_WORDS.filter((word) => scopeTerms.has(word))).toEqual([]);
    // A stem already matches every compound it sits in, so the compound is noise.
    const shadowed = SCOPE_DECLARED_TERMS.filter((term) =>
      SCOPE_DECLARED_TERMS.some((other) => other !== term && ` ${term} `.includes(` ${other} `)),
    );
    expect(shadowed).toEqual([]);
  });

  it("every ruled-rung qualifier is a not-evidence word and never a ruled rung", () => {
    for (const qualifier of RULED_RUNG_QUALIFIERS) {
      expect(NOT_EVIDENCE_WORDS.includes(qualifier), qualifier).toBe(true);
      expect(OUTSIDE_RULED_RUNGS.includes(qualifier), qualifier).toBe(false);
    }
  });

  it("every ruled rung is a rung of the 21 and nothing else, and is never stripped", () => {
    const levels = new Set(ROLE_FORM_DESCRIPTORS.flatMap((d) => d.detection.levelTerms).map(fold));
    const claimed = new Set(
      ROLE_FORM_DESCRIPTORS.flatMap((d) => [
        ...d.detection.occupationTerms,
        ...d.detection.machineTerms,
      ]).map(fold),
    );
    const stripped = new Set(STRIPPED_TERMS);
    for (const rung of OUTSIDE_RULED_RUNGS) {
      expect(levels.has(rung), rung).toBe(true);
      expect(claimed.has(rung), rung).toBe(false);
      expect(stripped.has(rung), rung).toBe(false);
      expect(NOT_EVIDENCE_WORDS.includes(rung), rung).toBe(false);
    }
  });

  it("STRIPPED_TERMS runs longest phrase first", () => {
    const tokens = STRIPPED_TERMS.map((term) => term.split(" ").length);
    const sorted = [...tokens].sort((a, b) => b - a);
    expect(tokens).toEqual(sorted);
  });

  it("the tables are frozen and already in their prepared form", () => {
    for (const table of [
      DECLARED_OCCUPATION_TERMS,
      SCOPE_DECLARED_TERMS,
      NOT_EVIDENCE_WORDS,
      OUTSIDE_RULED_RUNGS,
      RULED_RUNG_QUALIFIERS,
      STRIPPED_TERMS,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
      for (const term of table) expect(fold(term), term).toBe(term);
    }
  });
});
