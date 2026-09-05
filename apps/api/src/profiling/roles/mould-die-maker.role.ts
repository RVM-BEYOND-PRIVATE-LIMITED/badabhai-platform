import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * MOULD / DIE MAKER (PLASTICS) — 2-plate, 3-plate and hot-runner moulds, EDM, polishing.
 *
 * DECLARED FOR BATCH 3, and this one is load-bearing for Batch 2 rather than merely early.
 *
 * ═══ THE MIRROR OF `tool-die-maker.role.ts` ═══
 *
 * The plan named Tool & Die Maker ↔ Mould / Die Maker as the cross-cluster pair, and it is real:
 * one tool room, one EDM, one surface grinder, one vocabulary, two materials. They sit in
 * `machining` and `polymer`, so `conflictTermsFor` derives NOTHING between them and the veto has
 * to be authored on both descriptors.
 *
 * BOTH SIDES, ALWAYS. A one-sided veto is worse than none: the trade that declared it would send
 * its ambiguous workers back to the interview while the trade that forgot silently claimed them,
 * so the misroute would run in exactly one direction and look like a preference rather than a bug.
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
    occupationTerms: ["mould maker", "mold maker", "mould making", "मोल्ड मेकर"],
    machineTerms: [
      "mould",
      "mold",
      "two plate mould",
      "three plate mould",
      "hot runner",
      "spark erosion",
      "mould polishing",
      "मोल्ड",
    ],
    levelTerms: ["trainee", "mould maker", "senior", "सीनियर"],
    /** The metal tool room (`machining`). Mirrored on `tool-die-maker.role.ts` — see the header. */
    extraConflictTerms: [
      "press tool",
      "progressive die",
      "jigs and fixtures",
      "tool room",
      "टूल रूम",
    ],
  },
} as const satisfies RoleFormDescriptor;
