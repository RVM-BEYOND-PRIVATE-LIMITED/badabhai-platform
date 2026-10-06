/**
 * GENERIC FAMILY PACK ANSWERS → the `skill_*` corpus ids they literally claim (#2021).
 *
 * THE GAP THIS CLOSES. A structured-answer chat that ran a GENERIC family pack (`qp_welding`,
 * `qp_fitting`, `qp_machining`, `qp_plumbing`, `qp_carpentry`) asks its trade question with
 * `target_field: skills`. That answer lands in the profile draft's `skills`, never in
 * `worker_attributes`, so `PACK_ANSWER_SKILLS` (which reads attribute rows) never sees it. And
 * `toExtractionOutput` kept it only as `skill_labels`, which is free text. So a worker who tapped
 * "MIG welding" derived no `worker_skill` row and saw an empty V1 feed.
 *
 * WHAT IT DOES. `apps/api`'s `toExtractionOutput` passes the deterministic ANSWER-MAP values of
 * those questions through {@link canonicalGenericPackSkills}. The ids it returns are written to
 * the profile's canonical `skills` column. `WorkerSkillsService.rebuildForWorker` (and the batch
 * `db:backfill:worker-skills`, which reads the same column) then carries them through the existing
 * attribute bridge, `ATTRIBUTE_TO_MATCH_SKILLS`. This table emits only `skill_*` corpus ids and
 * never an `mskill_*` id. Whether a claim reaches a posting is decided by the bridge.
 *
 * A LOOKUP, NOT A MODEL. Every key is an option VALUE from a checked-in pack JSON, which is a
 * closed set the worker tapped (or `matchOptions` matched in the worker's own words). There is no
 * LLM, no embedding and no confidence floor. The model-produced `skill_labels` never reach this
 * table.
 *
 * THE RULES ARE `PACK_ANSWER_SKILLS`' RULES (see that file), restated where they bite here:
 *   1. Map only what a chip literally claims, read with the question stem.
 *   2. No nearest-skill proxy (owner ruling, 2026-10-06). A trade with no match skill derives
 *      nothing: see {@link GENERIC_PACKS_WITHOUT_MATCH_SKILL}.
 *   3. Being routed to a pack is not a claim. Only an answered option derives anything.
 *   4. Pack-scoped, never global (R12 §2.1). `furniture` is carpentry in `qp_carpentry` and
 *      painting in `qp_painting`. `building` is plumbing in `qp_plumbing` and painting in
 *      `qp_painting`. An entry applies only to an answer given under ITS pack id.
 *
 * KEYED BY STORED VALUE, NOT `option_key`. The answer map stores the option's `value`, which
 * equals its `option_key` for every option mapped here. The two that differ (`other_fit` and
 * `other_machine`, both stored as `unknown`) name nothing and are not mapped. A test in
 * `apps/api` checks every key against the pack JSON.
 */

/** A `skill_*` corpus id. Generic packs need no `role_*` id: every claim has a corpus skill. */
export type GenericPackSkillId = `skill_${string}`;

type ValueMap = Readonly<Record<string, readonly GenericPackSkillId[]>>;

/** `pack_id` → `question_key` → stored option value → corpus ids. */
export const GENERIC_PACK_SKILLS: Readonly<Record<string, Readonly<Record<string, ValueMap>>>> = {
  // "Aap kaunsi welding karte hain?" Each process is its own claim. `gas` (gas welding) has no
  // match skill: `skill_gas_cutting` is cutting, and cutting does not make a welder. `other`
  // names nothing.
  qp_welding: {
    welding_process: {
      mig: ["skill_mig_welding"],
      tig: ["skill_tig_welding"],
      arc: ["skill_arc_welding"],
    },
  },

  // "Aap kis tarah ka fitting kaam karte hain?" The stem scopes every option to fitting work, as
  // in `qp_fitter`. Bench and assembly fitting have their own corpus ids. Maintenance fitting is
  // fitting with no narrower id, so it takes the occupation anchor. "Pipe fitting" is the corpus
  // skill of that exact name. The bridge, not this table, decides what it reaches.
  qp_fitting: {
    fitting_type: {
      bench: ["skill_bench_fitting"],
      assembly: ["skill_mechanical_assembly"],
      maintenance: ["skill_fitter_occupation"],
      pipe: ["skill_pipe_fitting"],
    },
  },

  // "Aap kaunsi machine chalate hain?" Only `cnc_turning` names a CNC machine without ambiguity.
  // DELIBERATELY ABSENT, each because mapping it would be a proxy:
  //   lathe     "Khraad ya lathe" is a manual lathe. CNC Turner is the only turning match
  //             skill, and `qp_conventional_machining` derives nothing for the same reason.
  //   vmc       "VMC ya milling" also covers a manual mill. `qp_vmc_milling` maps only the VMC
  //             chip, and a manual miller is not a VMC operator.
  //   grinding  "Grinding machine" does not say CNC. `qp_cnc_grinding` maps only `cnc`/`both`.
  qp_machining: {
    machine_type: {
      cnc_turning: ["skill_turning"],
    },
  },

  // "Aap kis tarah ka nal kaam karte hain?" Every option is plumbing work, so each claims the
  // plumber's occupation. Drainage has its own corpus id.
  qp_plumbing: {
    plumbing_scope: {
      household: ["skill_plumber_occupation"],
      building: ["skill_plumber_occupation"],
      sanitary: ["skill_plumber_occupation"],
      drainage: ["skill_drainage_systems"],
    },
  },

  // "Aap kaunsa lakdi kaam karte hain?" Every option is woodwork. Furniture and doors/windows are
  // woodworking. A modular kitchen is cabinet making. Shuttering is carpentry with no narrower
  // id, so it takes the occupation anchor.
  qp_carpentry: {
    carpentry_scope: {
      furniture: ["skill_woodworking"],
      door_window: ["skill_woodworking"],
      modular: ["skill_cabinet_making"],
      shuttering: ["skill_carpenter_occupation"],
    },
  },
};

/**
 * Generic family packs whose trade question DELIBERATELY derives nothing. The V1 vocabulary has
 * no `mskill_*` for the trade, and the owner ruled out a proxy (2026-10-06). Closing a row means
 * minting a match skill first (a taxonomy decision). A test pins that each derives nothing.
 */
export const GENERIC_PACKS_WITHOUT_MATCH_SKILL = [
  "qp_electrical",
  "qp_painting",
  "qp_masonry",
] as const;

/** One deterministic answer-map value set, with the question it answered. */
export interface GenericPackAnswer {
  readonly questionKey: string;
  readonly values: readonly unknown[];
}

/**
 * The `skill_*` ids a generic pack's answer-map values claim. Sorted and deduped.
 *
 * `packId` is the pack the interview ran under. Null, or any pack not in the table, derives
 * nothing. Unknown questions and values are ignored rather than rejected: a pack that grows an
 * option must not stop the rest of the profile being built. Non-string values are ignored.
 */
export function canonicalGenericPackSkills(
  packId: string | null,
  answers: readonly GenericPackAnswer[],
): GenericPackSkillId[] {
  if (packId === null) return [];
  const pack = GENERIC_PACK_SKILLS[packId];
  if (!pack) return [];
  const ids = new Set<GenericPackSkillId>();
  for (const { questionKey, values } of answers) {
    const options = pack[questionKey];
    if (!options) continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      for (const id of options[value] ?? []) ids.add(id);
    }
  }
  return [...ids].sort();
}

/** Every id the table can emit — the surface a taxonomy retag has to keep covering. */
export function genericPackSkillIdsEmitted(): GenericPackSkillId[] {
  const ids = new Set<GenericPackSkillId>();
  for (const questions of Object.values(GENERIC_PACK_SKILLS)) {
    for (const options of Object.values(questions)) {
      for (const emitted of Object.values(options)) for (const id of emitted) ids.add(id);
    }
  }
  return [...ids].sort();
}
