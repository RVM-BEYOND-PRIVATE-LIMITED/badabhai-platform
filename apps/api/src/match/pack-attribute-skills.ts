/**
 * B0b — the role pack's closed-set answers → the corpus (`skill_*`) attribute ids they imply.
 *
 * THE GAP THIS CLOSES. A fully-answered CNC turner used to derive ZERO match skills and appear in
 * no posting's reach: `deriveWorkerSkills` reads `worker_profiles.canonical_role_id` and
 * `.skills`, the role-pack path writes neither, and the pack's answers land in
 * `worker_attributes`, which nothing on the matching side read. The platform knew he had eight
 * years on a lathe and could not surface him for a lathe vacancy.
 *
 * WHY A LOOKUP AND NOT A MODEL. Every value here is an `option_key` from
 * `qp_cnc_turning.json` — a closed set the worker TAPPED. There is nothing to infer, so there is
 * no LLM, no embedding and no confidence floor, and invariant #4 holds trivially: this is a
 * deterministic table and the match engine stays the only thing that decides reach.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — and this is the part to read before extending it:
 *
 *   - **It never invents a `canonical_role_id`.** Being routed to the turning pack is not the
 *     same as having said you turn. Reach follows what the worker actually answered, so a man
 *     who tapped nothing about machines derives nothing, and `toExtractionOutput`'s deliberate
 *     null stands.
 *   - **It maps only what a chip literally claims.** §5.3 calls an unclaimed capability upgrade
 *     the most damaging failure available to us, because it surfaces at the machine trial and the
 *     employer stops trusting BadaBhai rather than the worker. Two chips were left unmapped for
 *     exactly that reason and they are the ones a careless pass would have taken:
 *       · `quality_work` — checking your own first piece, or filling an SPC chart at the machine,
 *         is not a quality inspector's chair. Every option here maps to NOTHING.
 *       · `programming_level: edit_program` — editing G/M code at the machine is a setter's
 *         attribute. `write_program` and `cam` DO claim the posting-level concept and are mapped.
 *   - **It writes nothing.** This runs on the derive READ path, so a retag on the taxonomy side
 *     changes a worker's reach on the next rebuild instead of leaving a stale row behind.
 *
 * Ids that map to `[]` in `ATTRIBUTE_TO_MATCH_SKILLS` are still emitted. They are true attributes
 * of the worker and cost nothing; the taxonomy is what decides they imply no posting-level skill,
 * and that decision belongs there rather than here.
 */

/**
 * `pack_id` → `attribute_key` → `option_key` → the corpus attribute ids that option implies.
 *
 * PACK-KEYED AT THE TOP (R12 §2.1), and the outer key is not decoration. This map used to be
 * keyed by attribute alone, so every entry applied to any worker whose attribute bag held that
 * key regardless of which pack he answered. Measured across all 143 packs, three keys already
 * collide: `drawing_reading` (three packs), `measuring_tools` (two) and `material_worked` (two).
 * `measuring_tools` is the live one — a `qp_machining` worker's `vernier`/`micrometer` answers
 * were mapped to reach through a table authored for turners. Probably right; entirely
 * unreviewed; and nobody decided it. Whether machining SHOULD share the turner mapping is an
 * owner ruling, not a code decision — see NEEDS_PRAKASH Q14.
 *
 * An unknown pack contributes NOTHING, which is the same fail-quiet default as before and the
 * safe direction: a worker whose pack has no entry reaches through his profile skills alone,
 * rather than through a mapping somebody else's trade authored.
 */
export const PACK_ATTRIBUTE_SKILLS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>
> = {
  qp_cnc_turning: {
    // "Aap kaunsi turning machine chalate hain?" — the question stem scopes every answer to
    // turning, which is what makes `spm` safe to map. `other_machine` names nothing and is left out.
    turning_machine: {
      cnc_lathe: ["skill_turning"],
      conventional_lathe: ["skill_turning"],
      vtl: ["skill_turning"],
      sliding_head: ["skill_turning"],
      spm: ["skill_turning"],
    },
    // Operations. Facing/OD, grooving and knurling are turning; the other three are their own
    // corpus ids, all of which the taxonomy treats as attributes rather than postable skills.
    turning_operation: {
      facing_od: ["skill_turning"],
      grooving: ["skill_turning"],
      knurling: ["skill_turning"],
      boring: ["skill_boring"],
      drilling: ["skill_drilling"],
      threading: ["skill_tapping_threading"],
    },
    // Controllers. `haas`, `mazak` and `unknown_controller` have no corpus id, so they map to
    // nothing rather than to the nearest one.
    controller_brand: {
      fanuc: ["skill_fanuc"],
      siemens: ["skill_siemens"],
      mitsubishi: ["skill_mitsubishi"],
    },
    workholding: {
      three_jaw: ["skill_fixture_setup"],
      four_jaw: ["skill_fixture_setup"],
      collet: ["skill_fixture_setup"],
      soft_jaw: ["skill_fixture_setup"],
      tailstock: ["skill_fixture_setup"],
      steady_rest: ["skill_fixture_setup"],
    },
    setting_operation: {
      tool_offset: ["skill_tool_offset_setting"],
      work_offset: ["skill_tool_offset_setting"],
      nose_radius: ["skill_tool_offset_setting"],
      jaw_change: ["skill_fixture_setup"],
      tailstock_set: ["skill_fixture_setup"],
      // `first_piece` here is "setting the first piece", not approving it. Nothing.
    },
    measuring_tools: {
      vernier: ["skill_measuring_instruments"],
      micrometer: ["skill_measuring_instruments"],
      bore_gauge: ["skill_measuring_instruments"],
      height_gauge: ["skill_measuring_instruments"],
      plug_gauge: ["skill_measuring_instruments"],
      dial_indicator: ["skill_measuring_instruments"],
    },
    drawing_reading: {
      basic_drawing: ["skill_drawing_reading"],
      gdt: ["skill_drawing_reading"],
      // `no_drawing` is an honest "nahi padh pata". It is an answer, not a skill.
    },
    programming_level: {
      offset_only: ["skill_tool_offset_setting"],
      edit_program: ["skill_program_editing"],
      // "Naya programme likh leta hoon" and "CAM software se banata hoon" are the posting-level
      // claims, in the worker's own words. These two are the only chips in the pack that reach a
      // vacancy other than a turner's.
      write_program: ["skill_cnc_programming"],
      cam: ["skill_cam_software"],
    },
    // DELIBERATELY ABSENT, each for a stated reason rather than by omission:
    //   turning_experience  a duration, already read from experience.total_years
    //   material_worked     what he cut, not what he can do
    //   tolerance_band      a precision claim, not a skill; §4.3 display-only
    //   sector_worked       §4.3 "Display only. Never a matching input — locked"
    //   advanced_capability live tooling / bar feeder / sub-spindle have no corpus ids
    //   quality_work        see the header: none of it claims a quality inspector's chair
    //   troubleshooting     symptoms he has handled, with no corpus id to carry them
  },
};

/** Every corpus id this map can emit — the surface a taxonomy retag has to keep covering. */
export function corpusSkillsEmitted(): string[] {
  const ids = new Set<string>();
  for (const attributes of Object.values(PACK_ATTRIBUTE_SKILLS)) {
    for (const options of Object.values(attributes)) {
      for (const skills of Object.values(options)) for (const id of skills) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * The corpus attribute ids implied by one worker's pack answers.
 *
 * Unknown attribute keys and unknown option keys are ignored rather than rejected: a pack that
 * grows a question must not stop an existing worker's reach from rebuilding. The exhaustiveness
 * that matters runs the other way and is a test — every id this map emits must be a key of
 * `ATTRIBUTE_TO_MATCH_SKILLS`, or it would contribute nothing and no one would notice.
 *
 * Deterministic: sorted, deduped, same input → same output.
 */
export function corpusSkillsForPackAttributes(
  /**
   * One entry per stored attribute, carrying the `pack_id` OFF ITS OWN ROW.
   *
   * PER-ROW RATHER THAN ONE PACK PER WORKER, and that is the correct granularity rather than
   * extra precision: a worker answers `qp_universal`'s tail AND a role pack, so his attribute
   * bag genuinely mixes provenances. Collapsing to a single pack id would either lose the role
   * pack's answers or apply the role pack's dictionary to the universal tail's — the same class
   * of error, one level up.
   *
   * A row with a null `pack_id` (the finishing form writes these) matches no entry and
   * contributes nothing, which is correct: no dictionary here covers form-written keys.
   */
  answers: readonly {
    packId: string | null;
    attributeKey: string;
    optionKeys: readonly string[];
  }[],
): string[] {
  const ids = new Set<string>();
  for (const { packId, attributeKey, optionKeys } of answers) {
    if (packId === null) continue;
    const options = PACK_ATTRIBUTE_SKILLS[packId]?.[attributeKey];
    if (!options) continue;
    for (const optionKey of optionKeys) {
      for (const id of options[optionKey] ?? []) ids.add(id);
    }
  }
  return [...ids].sort();
}
