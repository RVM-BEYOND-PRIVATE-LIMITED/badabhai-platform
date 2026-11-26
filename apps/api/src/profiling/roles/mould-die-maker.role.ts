import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * MOULD / DIE MAKER (PLASTICS) — RETIRED, FOLDED INTO TOOL & DIE MAKER (#3030).
 *
 * CEO pack v2 Q4 (ruled 23 Nov 2026): "Mould / Die Maker is not a new trade: it is the live
 * Tool & Die Maker (T07), and the phrase leads there."
 *
 * The kind stays in `TRADE_FORM_KINDS_ALL` and this file stays registered so the kind can still
 * be named on stored events — removing either breaks the event spine. But its detection is empty
 * on purpose: "mould maker", "mold maker", "mould making", "मोल्ड मेकर" and "mould polishing"
 * moved to `tool-die-maker.role.ts`, the bare machine words are dropped, and this descriptor
 * competes with nobody. `assertRegistryIsCoherent` allows a disabled role with no occupation terms.
 */
export const MOULD_DIE_MAKER = {
  kind: "mould_die_maker",
  packId: "qp_mould_making",
  familyId: "fam_mould_making",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Mould / Die Maker (Plastics)",
  offerName: "mould maker",
  levelLadder: ["Trainee", "Mould Maker", "Senior"],
  tenureQuestionKey: "mould_making_experience",
  detection: {
    occupationTerms: [],
    machineTerms: [],
    levelTerms: [],
    /** Retired: no cross-cluster rival needs declaring. */
    extraConflictTerms: [],
  },
} as const satisfies RoleFormDescriptor;
