import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PRESS / MACHINE OPERATOR — mechanical, hydraulic and pneumatic presses, by tonnage.
 *
 * DECLARED IN BATCH 2, form to follow.
 *
 * ═══ THE TAXONOMY PUTS "injection moulding" ON THIS ROLE'S ATTRIBUTE LIST. WE DO NOT ═══
 *
 * The master sheet's attribute column reads "Power press · injection moulding · general machine
 * operation · tonnage", and copying that here would be the single worst routing decision available
 * in Batch 2: `injection_moulding_operator` is its own role with its own reference page, its own
 * level ladder and its own eighteen questions about machine make, materials and robot take-out.
 * Claiming "injection moulding" as a machine term here would hand every moulding setter a press
 * form and there is no cluster relationship to veto it, because the two sit in `fabrication` and
 * `polymer` respectively.
 *
 * The taxonomy is describing what a generic "machine operator" might be doing; this descriptor has
 * to decide which FORM he gets, and those are different questions. Moulding is therefore declared
 * as an extra CONFLICT rather than as a machine term — the ambiguous man keeps talking.
 *
 * ═══ DIE SETTING IS THE TOOL ROOM'S WORD TOO ═══
 *
 * "Die setting & alignment", "shut-height setting" and "die change" are on this role's reference
 * page AND the tool maker's. They sit in different clusters, so the veto is authored: a man who
 * says "die setting" alone could be either, and neither form is safe to guess at.
 *
 * ═══ NO BARE "press" ═══
 *
 * A press brake is a sheet-metal machine, a hydraulic press is a maintenance-shop fixture, and
 * "press" on its own is also the word for a printing press. Every term below names the machine.
 */
export const PRESS_OPERATOR = {
  kind: "press_operator",
  packId: "qp_press_operation",
  familyId: "fam_press_operation",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Press / Machine Operator",
  offerName: "press operator",
  levelLadder: ["Helper", "Operator", "Setter"],
  tenureQuestionKey: "press_experience",
  detection: {
    occupationTerms: [
      "press operator",
      "power press operator",
      "press setter",
      "प्रेस ऑपरेटर",
      "प्रेस",
    ],
    machineTerms: [
      "power press",
      "mechanical press",
      "hydraulic press",
      "pneumatic press",
      "progressive tooling",
      "strip layout",
      "shut height",
    ],
    levelTerms: ["helper", "operator", "setter", "सेटर"],
    /**
     * Two cross-cluster rivals, both real and neither derivable.
     *
     * The tool room (`machining`) shares this role's entire setting vocabulary — it BUILDS the die
     * this role changes. The moulding shop (`polymer`) is what the taxonomy's own attribute list
     * would have folded into this role; see the header for why it is a veto instead.
     */
    extraConflictTerms: [
      "die setting",
      "die change",
      "tool room",
      "injection moulding",
      "injection molding",
      "moulding machine",
    ],
  },
} as const satisfies RoleFormDescriptor;
