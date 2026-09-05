import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PAINTER / POWDER COATING — powder booth, liquid spray, pretreatment and curing ovens.
 *
 * DECLARED IN BATCH 2, form to follow.
 *
 * ⚠ ═══ `fam_painting` IS HOUSE PAINTING. THIS IS NOT THAT TRADE ═══
 *
 * The plan flags this and it is the one binding decision on this role that can go wrong quietly.
 * The existing generic family covers building painters — walls, putty, distemper, a brush and a
 * ladder — and an industrial powder-coating hand has nothing in common with it beyond the English
 * word "painter". Binding this role's occupations under that family, or reusing its pack id, would
 * ask a man who runs a conveyorised powder line about wall putty.
 *
 * So the ids are `fam_powder_coating` / `qp_powder_coating`, named for the half of the trade that
 * is unambiguous, and the NCO bindings must be read carefully at authoring time: only the
 * industrial coating occupations, never the construction ones.
 *
 * ═══ WHICH MAKES "painter" ITSELF THE DANGEROUS WORD ═══
 *
 * It is not an occupation term here, and that is deliberate rather than cautious. A man who types
 * only "painter" is more likely to be a building painter than an industrial one, and
 * `fam_painting`'s own interview is the right place for him to be disambiguated — it already does
 * that work. What claims THIS trade is the process: powder coating, a spray booth, a DFT gauge.
 * "painter" appears only as a level rung, where it corroborates a family pin and never routes.
 */
export const PAINTER_COATING = {
  kind: "painter_coating",
  packId: "qp_powder_coating",
  familyId: "fam_powder_coating",
  cluster: "fabrication",
  formEnabled: true,
  displayName: "Painter / Powder Coating",
  offerName: "powder coating operator",
  levelLadder: ["Helper", "Operator", "Skilled"],
  tenureQuestionKey: "coating_experience",
  detection: {
    occupationTerms: [
      "powder coating",
      "powder coater",
      "paint shop",
      "spray painter",
      "industrial painting",
      "पाउडर कोटिंग",
    ],
    machineTerms: [
      "powder booth",
      "spray booth",
      "curing oven",
      "pretreatment line",
      "hvlp",
      "electrostatic spray",
      "dft gauge",
      "phosphating",
    ],
    // "painter" lives HERE and not above — see the header. A rung corroborates; it never routes.
    levelTerms: ["helper", "operator", "skilled", "painter", "पेंटर"],
    /**
     * Building painting, which is a different trade with a live family of its own. A worker who
     * says "painter" and "putty" in one breath belongs in `fam_painting`'s interview, not this
     * form.
     */
    extraConflictTerms: ["house painting", "wall painting", "putty", "distemper", "whitewash"],
  },
  fresher: {
    // KEYED BY STORED `value_text`. Booth, gun and oven — the paint shop's own equipment, for the
    // same reason the welder's list is welding sets: an ITI Painter General trainee never touches
    // a machine tool, and offering him one would be asking him to claim training he has not had.
    workshopMachines: {
      spray_gun: "Spray gun",
      powder_booth: "Powder coating booth",
      curing_oven: "Curing oven",
      compressor: "Air compressor",
      sanding_machine: "Sanding and buffing machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET.
   *
   * THE ENTRIES NAME THE COATING AND THE TEST, not a generic "painting course", because that is
   * what a paint-shop supervisor screens on: a man who can state a DFT range and has sat a
   * salt-spray or adhesion test is the man who can hold a specification. The reference sheet's own
   * education row is "10th standard — Painter General · SCVT", which is why the ITI entry names
   * that trade rather than an industrial-coating one that does not exist as an ITI trade.
   */
  suggestedCertificates: [
    "Powder Coating Operator — NSQF",
    "ITI Painter General — NCVT",
    "ITI Painter General — SCVT",
    "Industrial Spray Painting — HVLP",
    "Pretreatment & Phosphating",
    "Paint Inspection — DFT & Adhesion",
    "Trade Test — Painter",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
