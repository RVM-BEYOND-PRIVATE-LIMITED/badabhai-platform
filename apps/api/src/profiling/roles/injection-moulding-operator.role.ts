import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * INJECTION MOULDING OPERATOR / SETTER — runs, sets and optimises the plastics injection moulding
 * machine: machine make, tonnage, materials, mould change, parameters, defects.
 *
 * DECLARED IN BATCH 3, PACKED IN PHASE 2 #9 (CEO Launch Plan Pack v1, sheet 22) AND STILL
 * FORMLESS, like PLC and EDM: `qp_injection_moulding` is served through the chat interview on its
 * family (`fam_injection_moulding`). It was declared early for Batch 2's sake:
 * `press-operator.role.ts` had to veto injection moulding, because the taxonomy's own attribute
 * list would otherwise have folded this trade into the press form. A veto needs the words, and
 * the words live here.
 *
 * THE MACHINE, NOT THE TOOL ROOM. A man who builds the mould (core, cavity, spotting) is a Tool &
 * Die Maker; "mould ka kaam" stays an ask-first disambiguation (A3), so "mould" is not a term here.
 *
 * ═══ THE PROCESS TECHNICIAN IS THIS TRADE'S SENIOR RUNG, FOLDED IN (#3030) ═══
 *
 * CEO pack v2 Q4 (ruled 23 Nov 2026): "Plastic Process Technician is not a trade: it is the Senior
 * rung of Injection Moulding (T29), and the phrase leads there." `plastic-process-technician.role.ts`
 * is retired — its detection is empty and it competes with nobody — and its words live here as level
 * words for the Senior rung (the sheet shows that rung as "Process Technician"): "plastic process
 * technician" and "प्रोसेस टेक्नीशियन" beside the "process technician" that was already here.
 */
export const INJECTION_MOULDING_OPERATOR = {
  kind: "injection_moulding_operator",
  packId: "qp_injection_moulding",
  familyId: "fam_injection_moulding",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Injection Moulding Operator",
  offerName: "injection moulding operator",
  // Sheet 22's ladder; "Senior" is the process technician.
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "moulding_experience",
  detection: {
    occupationTerms: [
      "injection moulding",
      "injection molding",
      "moulding operator",
      "molding operator",
      "इंजेक्शन मोल्डिंग",
      // #3030 (CEO pack v2 Q4 / T29 sheet): the machine hand's own words. None of these is a
      // Tool & Die term or veto, which is what keeps the maker (T07) and the machine (T29) apart.
      "moulding machine",
      "mould setter",
      "mould change",
    ],
    machineTerms: [
      // Sheet 22 "Words": the moulding-machine makes and the machine's own parts. Corroborate a
      // pin; never route alone.
      "ferromatik",
      "milacron",
      "windsor",
      "haitian",
      "toshiba",
      "engel",
      "arburg",
      "robot take out",
      "clamping tonnage",
      "hot runner",
      "abs",
      "nylon",
    ],
    levelTerms: [
      "trainee",
      "operator",
      "setter",
      "process technician",
      "plastic process technician",
      "प्रोसेस टेक्नीशियन",
      "सेटर",
    ],
  },
  fresher: {
    workshopMachines: {
      injection_moulding: "Injection moulding machine",
      hand_moulding: "Hand moulding machine",
      blow_moulding: "Blow moulding machine",
      extruder: "Extruder",
      compression_press: "Compression moulding press",
      grinder: "Scrap grinder",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
} as const satisfies RoleFormDescriptor;
