import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * INDUSTRIAL ELECTRICIAN — MCC/PCC panels, VFD and AC drives, starters, motors, LT distribution.
 *
 * DECLARED IN BATCH 2, form to follow. `fam_electrical` and `fam_lineman` stay as they are.
 *
 * ⚠ ═══ THE HOUSE WIRING PROBLEM, WHICH IS THIS ROLE'S VERSION OF THE PAINTER TRAP ═══
 *
 * "Electrician" covers a domestic wireman changing a switchboard and a plant electrician
 * commissioning a VFD, and the platform serves both. The generic `fam_electrical` interview is the
 * right home for the first; this role is the second, and its form asks about drive parameters and
 * earth-pit testing — eighteen questions a house wireman cannot answer and should never see.
 *
 * The word therefore has to earn its route. "electrician" alone is NOT an occupation term here; it
 * is a level rung, so it corroborates a family pin and never routes on its own. What claims this
 * trade is the industrial qualifier or the equipment: "industrial electrician", "panel wiring",
 * "MCC", "VFD". A man who types only "electrician" or "bijli ka kaam" stays in the generic
 * interview, which already disambiguates him — the same reasoning, and the same fail-safe
 * direction, as `painter-coating.role.ts`.
 *
 * ═══ THE LICENCE IS EVIDENCE OF THE TRADE, AND IT IS STILL NOT A ROUTE ═══
 *
 * "Wireman licence" appears on the reference page as a certificate. A state wireman licence is
 * held by domestic electricians too, so it corroborates at most.
 *
 * ═══ WHY IT IS IN `maintenance` ═══
 *
 * The reference page's work rows are fault finding, motor rewind coordination and cable
 * termination on a running plant — the maintenance technician's shift, done to the electrical
 * half of the machine. The two overlap on exactly the boundary the cluster exists to police.
 */
export const INDUSTRIAL_ELECTRICIAN = {
  kind: "industrial_electrician",
  packId: "qp_industrial_electrician",
  familyId: "fam_industrial_electrician",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Industrial Electrician",
  offerName: "industrial electrician",
  levelLadder: ["Helper", "Electrician", "Senior"],
  tenureQuestionKey: "electrical_experience",
  detection: {
    occupationTerms: [
      "industrial electrician",
      "panel electrician",
      "plant electrician",
      "panel wiring",
      "इंडस्ट्रियल इलेक्ट्रीशियन",
    ],
    machineTerms: [
      "mcc panel",
      "pcc panel",
      "vfd",
      "ac drive",
      "star delta",
      "dol starter",
      "induction motor",
      "megger",
      "cable termination",
      "earth pit",
    ],
    // "electrician" lives HERE, not above — see the header. A rung corroborates; it never routes.
    levelTerms: ["helper", "electrician", "senior", "इलेक्ट्रीशियन", "wireman"],
    /**
     * Domestic and construction electrical work, which `fam_electrical` already serves well. A
     * worker who says "ghar ki wiring" belongs in that interview, not in a panel-shop form.
     */
    extraConflictTerms: ["house wiring", "home wiring", "ghar ki wiring", "domestic wiring"],
  },
} as const satisfies RoleFormDescriptor;
