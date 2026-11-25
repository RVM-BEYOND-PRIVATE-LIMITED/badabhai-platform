/**
 * Trade catalogue consistency tests (#2998).
 *
 * Every trade is one catalogue row; about 14 hand-kept lists must agree with
 * it. For every entry at or below LOADED_WAVE this holds each list to its row.
 * Entries above the loaded wave are data only — present so waves have something
 * to check, not yet checked.
 *
 * Two live lists deviate from the same-key rule below, both pinned Track B
 * history with code comments at the deviation (not drift):
 * - fitter `senior` is stored as `senior_fitter` (sheet 6, Track B #1);
 * - electrician `senior_technician` is stored as `senior` (sheet 7, Track B #2).
 * Any other deviation — a removed TRADE_LEVEL_PACKS entry, a renamed rung, a
 * dropped pair — turns this red.
 */
import { describe, expect, it } from "vitest";
import { JOB_ROLE_LABELS, TRADE_FORM_KINDS_ALL } from "@badabhai/types";

import {
  isMatchSkillId,
  MATCH_SKILL_RELATION_PAIRS,
  MATCH_SKILLS,
  matchSkillForRole,
  matchSkillsForAttribute,
} from "./match-skills";
import { PACK_ANSWER_SKILLS } from "./pack-answer-skills";
import { POSTING_TRADES } from "./posting-trades";
import { LOADED_WAVE, TRADE_CATALOGUE } from "./trade-catalogue";
import {
  isLevelConfirmed,
  TRADE_LEVEL_CONFIRM_ITEMS,
  TRADE_LEVEL_PACKS,
  type TradeLevel,
} from "./trade-levels";

const loaded = TRADE_CATALOGUE.filter((e) => e.wave <= LOADED_WAVE);

/** Confirm items stored under a different key than the ladder rung (Track B). */
const STORED_KEY_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Track B #1 (sheet 6): the senior rung is stored as senior_fitter.
  qp_fitter: { senior: "senior_fitter" },
  // Track B #2 (sheet 7): the senior_technician rung is stored as senior.
  qp_industrial_electrician: { senior_technician: "senior" },
};

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

describe("trade catalogue", () => {
  it("holds 60 trades, T01..T60, with waves 0..3", () => {
    expect(TRADE_CATALOGUE).toHaveLength(60);
    expect(new Set(TRADE_CATALOGUE.map((e) => e.code))).toHaveLength(60);
    expect([...TRADE_CATALOGUE.map((e) => e.code)].sort()).toEqual(
      Array.from({ length: 60 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`),
    );
    expect(LOADED_WAVE).toBeGreaterThanOrEqual(0);
  });

  it("declares only known role kinds", () => {
    const kinds = new Set<string>(TRADE_FORM_KINDS_ALL);
    for (const e of loaded) {
      expect(kinds.has(e.roleKind), `${e.code} roleKind ${e.roleKind}`).toBe(true);
      expect(e.roleKind in JOB_ROLE_LABELS, `${e.code} label`).toBe(true);
    }
  });

  it("names a real match skill with paired relations", () => {
    const skills = new Set<string>(MATCH_SKILLS.map((s) => s.skillId));
    const pairs = new Set(MATCH_SKILL_RELATION_PAIRS.map(([a, b]) => pairKey(a, b)));
    for (const e of loaded) {
      expect(skills.has(e.matchSkillId), `${e.code} skill`).toBe(true);
      for (const r of e.relatedTo) {
        expect(skills.has(r), `${e.code} related ${r}`).toBe(true);
        expect(pairs.has(pairKey(e.matchSkillId, r)), `${e.code} pair ${r}`).toBe(true);
      }
    }
  });

  it("matches the level pack skill, key and confirm items", () => {
    for (const e of loaded) {
      const pack = TRADE_LEVEL_PACKS[e.packId];
      expect(pack, `${e.code} level pack`).toBeDefined();
      expect(pack?.skillId).toBe(e.matchSkillId);
      expect(pack?.levelKey).toBe(e.levelKey);

      // Every confirmed rung above the first carries a separating question —
      // except the ladder's top rung, which is confirmed by rule (the codebase
      // repeats "supervisor by rule (no confirm item)" on every live pack).
      const items = TRADE_LEVEL_CONFIRM_ITEMS[e.packId] ?? {};
      const rungs = e.ladder.map((l) => l.rung);
      for (const rung of rungs.slice(1, -1)) {
        if (!isLevelConfirmed(rung as TradeLevel)) continue;
        const key = STORED_KEY_ALIASES[e.packId]?.[rung] ?? rung;
        expect(rung in items || key in items, `${e.code} confirm item for ${rung}`).toBe(true);
      }
    }
  });

  it("matches the posting trade ladder order", () => {
    for (const e of loaded) {
      const posting = POSTING_TRADES.find((p) => p.roleKind === e.roleKind);
      expect(posting, `${e.code} posting trade`).toBeDefined();
      expect(posting?.packId).toBe(e.packId);
      expect(posting?.familyId).toBe(e.familyId);
      expect(posting?.matchSkillId).toBe(e.matchSkillId);
      expect(posting?.ladder.map((l) => l.rung)).toEqual(e.ladder.map((l) => l.rung));
    }
  });

  it("answers can yield the trade's base skill", () => {
    const pairs = new Set(MATCH_SKILL_RELATION_PAIRS.map(([a, b]) => pairKey(a, b)));
    for (const e of loaded) {
      const pack = PACK_ANSWER_SKILLS[e.packId];
      expect(pack, `${e.code} answer skills`).toBeDefined();
      const yielded = new Set<string>();
      for (const byOption of Object.values(pack ?? {})) {
        for (const ids of Object.values(byOption)) {
          for (const id of ids) {
            if (isMatchSkillId(id)) {
              yielded.add(id);
            } else if (id.startsWith("skill_")) {
              for (const s of matchSkillsForAttribute(id)) yielded.add(s);
            } else if (id.startsWith("role_")) {
              const s = matchSkillForRole(id);
              if (s) yielded.add(s);
            }
          }
        }
      }
      // Directly, or one pair away: the welder's process chips yield the process
      // skills, which pair tier-2 with the umbrella mskill_welder (#3001 keeps
      // those pairs).
      const direct = yielded.has(e.matchSkillId);
      const paired = [...yielded].some((s) => pairs.has(pairKey(e.matchSkillId, s)));
      expect(direct || paired, `${e.code} yields ${e.matchSkillId}`).toBe(true);
    }
  });
});

describe("claim question per trade (#3011)", () => {
  const claimed = TRADE_CATALOGUE.filter((e) => e.claimQuestionKey !== undefined);

  it("every recorded claim question has answer-skill rows, and each reaches exactly the base skill", () => {
    expect(claimed.length).toBeGreaterThan(0);
    for (const e of claimed) {
      const rows = PACK_ANSWER_SKILLS[e.packId]?.[e.claimQuestionKey!];
      expect(rows, `${e.code} ${e.packId}.${e.claimQuestionKey}`).toBeDefined();
      for (const [option, ids] of Object.entries(rows ?? {})) {
        const reached = new Set<string>();
        for (const id of ids) {
          if (isMatchSkillId(id)) reached.add(id);
          else if (id.startsWith("role_")) {
            const s = matchSkillForRole(id);
            if (s) reached.add(s);
          } else for (const s of matchSkillsForAttribute(id)) reached.add(s);
        }
        expect([...reached], `${e.code} ${e.claimQuestionKey}.${option}`).toEqual([e.matchSkillId]);
      }
    }
  });

  it("every Wave 1 trade records its claim question, except the foundry split still in #3009", () => {
    // T24-T26 are re-cut by #3009 (qp_foundry_casting, qp_die_casting, qp_forging); their rows
    // and claim keys land with or after it. Waves 2 and 3 record theirs in #3016 and #3017.
    const pending = new Set(["T24", "T25", "T26"]);
    for (const e of TRADE_CATALOGUE.filter((t) => t.wave === 1 && !pending.has(t.code))) {
      expect(e.claimQuestionKey, `${e.code} claim question`).toBeDefined();
    }
  });
});
