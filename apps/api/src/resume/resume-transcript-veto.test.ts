import { describe, expect, it } from "vitest";

import { applyTranscriptVeto } from "./resume-transcript-veto";

/**
 * THE TEST THIS FILE IS REALLY ABOUT IS THE FALSE-VETO ONE.
 *
 * "Does it catch the over-claim?" is the easy half, and a gazetteer that vetoed everything would
 * pass it. A veto DELETES a claim from a man's résumé — the same under-representation failure the
 * total-years bug was — so the property that matters is what it PERMITS. Half the cases below are
 * sentences that must survive: hedges, weak positives, and negations aimed at something else.
 */

const P2_TURNS = [
  "CNC lathe chalata hoon sir. Do saal ho gaye.",
  "CNC lathe hai, Fanuc control. Ek hi machine par rehta hoon zyada tar.",
  "Nahi sir, programme setter banata hai. Main sirf chalata hoon. Offset thoda bahut dekh leta hoon jab supervisor bolte hain, par khud se setting nahi karta.",
  "Vernier aur micrometer. Plug gauge bhi rakhte hain bore ke liye. Drawing dekh leta hoon, simple wali.",
  "Sir attendance meri poori rehti hai, do saal me ek bhi din bina batae nahi chhoda.",
];

describe("applyTranscriptVeto — an explicit negation withdraws a chip claim", () => {
  it("withdraws a setting claim the worker explicitly denied", () => {
    // "par khud se setting nahi karta" — and `first_piece` has no positive anywhere.
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { setting_operation: ["first_piece", "jaw_change"] },
      workerSaid: P2_TURNS,
    });
    expect(attributes.setting_operation).toEqual([]);
    expect(vetoes.map((v) => v.slug).sort()).toEqual(["first_piece", "jaw_change"]);
  });

  it("carries the triggering sentence VERBATIM, so every veto is auditable", () => {
    const { vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { setting_operation: ["first_piece"] },
      workerSaid: P2_TURNS,
    });
    expect(vetoes[0]!.phrase).toBe("khud se setting nahi karta");
  });

  it("withdraws a programming claim from 'Nahi sir, programme setter banata hai'", () => {
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { programming_level: ["write_program"] },
      workerSaid: P2_TURNS,
    });
    expect(attributes.programming_level).toEqual([]);
    expect(vetoes[0]!.phrase).toBe("Nahi sir, programme setter banata hai");
  });
});

describe("applyTranscriptVeto — what it must PERMIT", () => {
  it("RESCUES tool offset: he denied setting in general, but claimed offsets specifically", () => {
    // THE CASE THE WHOLE RESCUE RULE EXISTS FOR. "Offset thoda bahut dekh leta hoon" is a weak
    // positive, and §8.3's own table maps "offset marta hoon" to a setting capability. An
    // attribute-wide negation must not reach a slug the worker separately supported.
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { setting_operation: ["tool_offset"] },
      workerSaid: P2_TURNS,
    });
    expect(attributes.setting_operation).toEqual(["tool_offset"]);
    expect(vetoes).toEqual([]);
  });

  it("does NOT read 'dekh leta hoon' as 'dekha hai'", () => {
    // "Drawing dekh leta hoon" is "I do read drawings" — a claim. "Drawing dekha hai" would be
    // "I have seen a drawing". A stemmer collapses the two and deletes a true capability.
    const kept = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { drawing_reading: ["basic_drawing"] },
      workerSaid: ["Drawing dekh leta hoon, simple wali."],
    });
    expect(kept.attributes.drawing_reading).toEqual(["basic_drawing"]);

    const withdrawn = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { drawing_reading: ["basic_drawing"] },
      workerSaid: ["Drawing dekha hai, par khud padhta nahi."],
    });
    expect(withdrawn.attributes.drawing_reading).toEqual([]);
  });

  it("ignores a 'nahi' that negates something with no capability term in it", () => {
    // "do saal me ek bhi din bina batae nahi chhoda" is an attendance boast. A turn-scoped
    // matcher would let it reach every claim in the same message.
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { quality_work: ["in_process"], troubleshooting: ["alarm"] },
      workerSaid: [
        "Sir attendance meri poori rehti hai, do saal me ek bhi din bina batae nahi chhoda.",
      ],
    });
    expect(attributes.quality_work).toEqual(["in_process"]);
    expect(attributes.troubleshooting).toEqual(["alarm"]);
    expect(vetoes).toEqual([]);
  });

  it("does not treat a HEDGE as a negation", () => {
    // §8.4: "sab kar leta hoon" resolves to NOTHING, not to a claim — and not to a denial either.
    // A hedge is evidence in neither direction.
    const { vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { setting_operation: ["first_piece"], quality_work: ["spc"] },
      workerSaid: ["Sab kar leta hoon sir.", "Thoda bahut setting bhi dekh leta hoon."],
    });
    expect(vetoes).toEqual([]);
  });

  it("keeps 'edit' when he denied WRITING — the measured false veto", () => {
    // PERSONA 3, AND THE FIRST VERSION OF THIS FILE GOT IT WRONG. "Naya programme nahi likhta,
    // par jo chal raha hai usme edit kar leta hoon" — the negated clause carries the
    // attribute-wide term "programme", so an attribute-wide veto withdrew his `edit_program`
    // chip on the strength of a sentence that AFFIRMS it. "naya programme" names `write_program`,
    // so the clause is a statement about that slug and reaches no other.
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { programming_level: ["edit_program"] },
      workerSaid: [
        "Naya programme nahi likhta, par jo chal raha hai usme edit kar leta hoon. Feed speed badalna, tool number change karna, ye sab kar leta hoon.",
      ],
    });
    expect(attributes.programming_level).toEqual(["edit_program"]);
    expect(vetoes).toEqual([]);
  });

  it("…and still withdraws the WRITE claim from that same sentence", () => {
    // The other half of the same rule: scoping the veto to the named slug must not turn it off.
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes: { programming_level: ["write_program"] },
      workerSaid: ["Naya programme nahi likhta, par jo chal raha hai usme edit kar leta hoon."],
    });
    expect(attributes.programming_level).toEqual([]);
    expect(vetoes[0]!.slug).toBe("write_program");
  });

  it("vetoes NOTHING when there is no transcript at all", () => {
    const attributes = { setting_operation: ["first_piece"], programming_level: ["cam"] };
    const out = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes,
      workerSaid: [],
    });
    expect(out.attributes).toEqual(attributes);
    expect(out.vetoes).toEqual([]);
  });

  it("leaves an attribute the gazetteer does not cover completely alone", () => {
    // An unreviewed trade term list is more dangerous than no veto: it deletes true claims on a
    // guess. Machines, materials and workholding have no entry and must pass through untouched.
    const attributes = {
      turning_machine: ["cnc_lathe"],
      material_worked: ["mild_steel"],
      workholding: ["three_jaw"],
    };
    const out = applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes,
      workerSaid: P2_TURNS,
    });
    expect(out.attributes).toEqual(attributes);
    expect(out.vetoes).toEqual([]);
  });

  it("never mutates the caller's attribute map", () => {
    // The same object is the worker's stored answers on the render path. A veto that edited it
    // in place would silently narrow his matching reach — which this explicitly does not do.
    const attributes = { setting_operation: ["first_piece"] };
    applyTranscriptVeto({
      packId: "qp_cnc_turning",
      attributes,
      workerSaid: P2_TURNS,
    });
    expect(attributes.setting_operation).toEqual(["first_piece"]);
  });
});
