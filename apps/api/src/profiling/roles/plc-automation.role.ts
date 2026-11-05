import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PLC / AUTOMATION TECHNICIAN — reads, edits and writes ladder logic; HMI/SCADA; VFD,
 * servo and motion; commissioning on automated lines and SPMs.
 *
 * DECLARED FOR PHASE 2 #6 (CEO Launch Plan Pack v1, sheet 14) AND FORMLESS, like the 3D
 * designer and the polymer batch: it supplies the vocabulary that makes its `maintenance`-
 * cluster siblings' vetoes whole, and its family (`fam_plc_automation`) is what the chat
 * interview serves through retrieval. Enabling a form later is a boolean on one line.
 *
 * NOT THE PANEL ELECTRICIAN (sheet 14 / A3). "Electrician + PLC panel wiring only" is the
 * Industrial Electrician, so bare "plc" is NOT a term here: it would make every
 * "PLC panel wiring karta hoon" a veto on the electrician's own form. The routable words
 * name the programming — the A3 line "PLC/Automation if programming is main job".
 */
export const PLC_AUTOMATION = {
  kind: "plc_automation_technician",
  packId: "qp_plc_automation",
  familyId: "fam_plc_automation",
  /**
   * `maintenance`, WITH THE ELECTRICIAN AND THE MAINTENANCE TECHNICIAN — the bench the trade
   * grows out of. A worker who names both a PLC programming word and "electrician" keeps
   * talking instead of being handed either form (A3: ask which is the main job).
   */
  cluster: "maintenance",
  formEnabled: false,
  displayName: "PLC / Automation Technician",
  offerName: "PLC automation technician",
  levelLadder: ["Trainee", "Technician", "Senior Technician", "Lead", "Supervisor"],
  tenureQuestionKey: "plc_experience",
  detection: {
    occupationTerms: [
      "plc programming",
      "plc programmer",
      "plc technician",
      "automation technician",
      "automation engineer",
    ],
    machineTerms: [
      // Sheet 14 "Words": the software and devices that name the seat. Corroborate a pin.
      "ladder logic",
      "tia portal",
      "rslogix",
      "studio 5000",
      "gx works",
      "wincc",
      "factorytalk",
      "scada",
      "servo drive",
      "robot teaching",
    ],
    levelTerms: ["trainee", "technician", "senior technician", "lead", "टेक्नीशियन"],
  },
} as const satisfies RoleFormDescriptor;
