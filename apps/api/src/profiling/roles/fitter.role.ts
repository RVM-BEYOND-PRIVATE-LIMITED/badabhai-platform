import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FITTER — assembly fitting, maintenance fitting, erection and commissioning.
 *
 * DECLARED IN BATCH 2, SHIPPED IN PART TWO. `fam_fitting` stays exactly where it is as the generic
 * unit pack; this role binds the NCO fitting occupations beside it at specificity 50 — 7233.0200
 * "Fitter, Bench" and 7233.0100 "Fitter, General" on their own merits, and 7233.0101
 * "Maintenance Fitter-Mechanical" as an INTERIM, by owner decision (2026-09-24). Ruling A1 gives
 * 0101 to the maintenance technician, but plain "fitter" is still an alias on it and there is no
 * way yet to retire one; until there is, binding it is what lets the trade's commonest word reach
 * this form. The cost — four maintenance phrases the #1685 tranche put on 0101 now reach this
 * pack too — is written down in `_families.jsonl` and pinned in the reachability test.
 *
 * ═══ THE ITI TRADE NAME IS WHY THIS ROLE NEEDS A TIGHT CLUSTER ═══
 *
 * "Fitter" is one of the highest-volume ITI trades in India, which means an enormous number of
 * workers describe themselves with it regardless of what they now do. The reference page shows the
 * range inside the word alone: gearboxes and pumps (assembly), plant breakdowns (maintenance), and
 * site erection. Two of those three are the maintenance technician's page almost line for line —
 * "Coupling alignment", "Bearing fitting", a dial gauge and a laser alignment kit appear on both.
 *
 * That is precisely the "eighteen wrong questions" test, so the two are cluster siblings and the
 * veto derives in both directions. The plan listed Fitter ↔ Maintenance Technician as a
 * cross-cluster pair needing `extraConflictTerms`; putting them in one `maintenance` cluster is
 * strictly better, because derivation is symmetric by construction and an authored pair is not.
 *
 * ═══ ASSEMBLY IS THE OTHER HALF OF THE WORD, AND IT CROSSES A BOUNDARY ═══
 *
 * "Assembly fitting" is this role's own first chip, and `assembly_line_worker` sits in
 * `production`. Nothing derives between them. A man who says "assembly ka kaam" could be either —
 * a fitter building a gearbox or a line worker torquing a seat — so it is declared as a veto from
 * this side and mirrored from that one.
 *
 * ═══ THE BARE WORD NEEDS THE FAMILY PIN (owner ruling, Divyanshu, 2026-09-24) ═══
 *
 * "fitter" and "fitting" name the trade AND sit inside half a dozen other trades' names. When
 * they were occupation terms, enabling this form measured five catalogue occupations outside
 * `fam_fitter` being offered it on the pin alone — "pipe fitting", "camera fitting", "Die Fitter",
 * "Mechanical Fitter-Control Panel" and the ISCO 7233 node's "Train engine fitter" (tractor and
 * mining-machinery mechanics) — and any model label such as "Pipe fitter", "Glass fitter", "Tile
 * fitting", "AC fitting" or "Fitter automobile" did the same. Hinglish "fitting" is installation
 * work of any kind; a plumber who taps "Haan" on that card files a fitter's résumé.
 *
 * RULED: the bare words are CORROBORATED terms (`machineTerms`). They hand over this form only
 * when retrieval has already placed the worker in `fam_fitter` — the mechanism "laser cutting"
 * and "press brake" use for sheet metal, and the same fail-safe direction as
 * `industrial-electrician.role.ts` treating bare "electrician" as a rung. Every code `fam_fitter`
 * binds pins with a label that names the trade ("fitter", "bench fitter", "Fitter, General"), so
 * the fitter who says "fitter" is still handed the form on turn one; a pipe fitter pinned to
 * plumbing is not. `occupationTerms` keeps only a compound no other trade's worker says, because
 * an enabled role must name at least one and a worker who says it has claimed this trade outright.
 *
 * Moving a word between the two lists does not change what the maintenance siblings derive: both
 * lists are this role's vocabulary for `conflictTermsFor`. The one compound is new vocabulary, so
 * `maintenance_technician` and `industrial_electrician` each gain "general fitter" as a veto —
 * measured, and nothing else in any role's conflict set moved.
 */
export const FITTER = {
  kind: "fitter",
  packId: "qp_fitter",
  familyId: "fam_fitter",
  cluster: "maintenance",
  formEnabled: true,
  displayName: "Fitter",
  offerName: "fitter",
  levelLadder: ["Helper", "Fitter", "Senior Fitter"],
  tenureQuestionKey: "fitting_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_fitter@1. An ITI Fitter
    // trainee spends his first year at the bench and vice — filing, marking, drilling, tapping —
    // so the bench leads, and the machines are the few his workshop runs beside it.
    workshopMachines: {
      fitting_bench: "Fitting bench and vice work",
      drilling_machine: "Drilling machine",
      grinder: "Grinding machine",
      power_hacksaw: "Power hacksaw",
      lathe: "Lathe",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The ratified page carries one certificate — "Mechanical Seal &
   * Alignment Training", issued by the worker's own employer — beside the education line "ITI —
   * Fitter · NCVT"; so the ITI trade leads, the page's own credential follows, and the rest are
   * what a plant or an assembly shop asks a fitter about.
   */
  suggestedCertificates: [
    "ITI Fitter — NCVT",
    "Trade Test — Fitter",
    "Mechanical Seal & Alignment Training",
    "Hydraulics & Pneumatics Training",
    "Rigging & Lifting Safety",
    "Site Safety Induction",
    "Fire & Safety Awareness",
    "First Aid",
  ],
  detection: {
    // COMPOUNDS ONLY — owner ruling 2026-09-24, see the header. An occupation term routes with no
    // pin at all, so each candidate was checked against every catalogue title and alias for
    // another trade's worker who says it, and only one survived. NOT here:
    //   "bench fitter" / "बेंच फिटर" — ISCO 8211's "Bench fitter (trucks)" is a truck ASSEMBLER,
    //                        the assembly line's side of the declared rivalry
    //   "fitter general"   — inside "Electronics Fitter, General" (7421.0100)
    //   "assembly fitter"  — inside "Vehicle Assembly Fitter" (8211.1201) and "Auto Component
    //                        Assembly Fitter" (3139.1501), the assembly line's words
    //   "mechanical fitter"— 7412.0202 and 7412.1001, control-panel fitters on the electrical side
    //   "iti fitter", "fitter mistri" — any trade's ITI pass-out or mistri says them
    // Five of the six cost a fitter nothing: they resolve to a code fam_fitter binds, and the pin
    // plus the bare "fitter" below hands the form over. "mechanical fitter" does not — retrieval
    // lands it on 7412.0202 (fam_electrical_equipment), as it did before this role shipped, so a
    // mechanical fitter who says exactly that keeps the generic interview. That is alias work.
    occupationTerms: ["general fitter"],
    machineTerms: [
      // THE BARE WORDS, CORROBORATED — they hand over the form only once the resolver has placed
      // the worker in fam_fitter, the rule "laser cutting" and "press brake" follow for sheet metal.
      "fitter",
      "fitting",
      "फिटर",
      "फिटिंग",
      "fitting ka kaam",
      "gearbox",
      "centrifugal pump",
      "hydraulic power pack",
      "coupling alignment",
      "bearing fitting",
      "filing and scraping",
    ],
    levelTerms: ["helper", "fitter", "senior fitter", "हेल्पर"],
    /** The production line's assembly work, which sits in `production` and derives nothing here. */
    extraConflictTerms: ["assembly line", "final assembly", "sub assembly", "takt"],
  },
} as const satisfies RoleFormDescriptor;
