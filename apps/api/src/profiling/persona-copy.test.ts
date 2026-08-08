/**
 * The engine's OWN words, held to the same rules as the authored pack prompts.
 *
 * WHAT THIS REPLACES. `persona_guard.check_turn` scanned every outgoing turn at runtime and
 * repaired it when a model broke a rule. The deterministic engine has no model in the loop,
 * so nothing scans its replies — and the replies below are hand-written TypeScript
 * constants, which is exactly the kind of copy that drifts off-persona during a refactor
 * with nothing to notice.
 *
 * The pack corpus is covered by `db:verify:packs` (466 prompts, gated in CI). These
 * constants are the other half of what a worker actually reads, and until this file existed
 * they were covered by nothing at all.
 */
import { describe, expect, it } from "vitest";
import { checkPersonaTokens, personaCorpus } from "@badabhai/profiling-lexicon";

import {
  CLOSING_REPLY,
  DE_ESCALATION_REPLY,
  HARDSHIP_REPLIES,
  UNAVAILABLE_REPLY,
} from "./orchestrator.service";

const ENGINE_COPY: ReadonlyArray<readonly [name: string, text: string]> = [
  ["DE_ESCALATION_REPLY", DE_ESCALATION_REPLY],
  ["CLOSING_REPLY", CLOSING_REPLY],
  ["UNAVAILABLE_REPLY", UNAVAILABLE_REPLY],
  ...HARDSHIP_REPLIES.map((t, i) => [`HARDSHIP_REPLIES[${i}]`, t] as const),
];

describe("the engine's own replies are on-persona", () => {
  it.each(ENGINE_COPY)("%s carries no banned token", (_name, text) => {
    expect(checkPersonaTokens(text)).toEqual([]);
  });

  it.each(ENGINE_COPY)("%s asks no question", (_name, text) => {
    // None of these replies is an ASK — they acknowledge, de-escalate or close. A question
    // mark here would mean the engine spent a turn asking something no pack authored, and
    // therefore something `answer-capture` cannot map to any field.
    expect((text.match(/\?/g) ?? []).length).toBe(0);
  });

  it.each(ENGINE_COPY)("%s has no exclamation mark", (_name, text) => {
    // Enthusiasm the worker did not ask for. Same rule the pack validator applies.
    expect(text).not.toContain("!");
  });

  it("hardship replies are a CLOSED set, chosen deterministically", () => {
    // The engine has no randomness by construction, so the same conversation must produce
    // the same words. A set that grew a random pick would break replay testing and make
    // two identical interviews differ.
    expect(HARDSHIP_REPLIES.length).toBeGreaterThan(0);
    expect(new Set(HARDSHIP_REPLIES).size).toBe(HARDSHIP_REPLIES.length);
  });

  it("uses the aap register — never tu/tum — across every reply", () => {
    // Law 6, and the single most visible persona rule to a Hindi speaker.
    for (const [name, text] of ENGINE_COPY) {
      for (const informal of personaCorpus().bannedInformal) {
        expect(` ${text.toLowerCase()} `, `${name} contains "${informal}"`).not.toContain(
          ` ${informal} `,
        );
      }
    }
  });
});
