/**
 * The product's voice — the closed sets a human signed off, and the scan that enforces them.
 *
 * LIFTED BEFORE THE DELETE. `apps/ai-service/app/profiling/persona.py` is removed in OIE
 * Phase 8. Its acknowledgement and appreciation sets, its softeners, its honest-refusal line
 * and its five banned-token lists are the product's actual voice; deleting the file without
 * moving them regresses the interview in a way nothing fails on. So they move to
 * `data/persona.json` first, and this module is the one reader.
 *
 * THE ENFORCEMENT MOVES FROM RUNTIME TO BUILD TIME, and that is an upgrade rather than a
 * translation. `persona_guard.check_turn` ran per turn against a model's output and repaired
 * it on a violation — necessary when a model writes the words, and pure cost once it does
 * not. The deterministic engine's words are AUTHORED: 466 reviewed pack prompts plus a
 * handful of constants in the orchestrator. A rule checked once, in CI, over text that
 * cannot change at runtime is strictly stronger than one checked on every turn forever.
 *
 * WHY A SCAN AND NOT A REGEX PER RULE. The banned lists are DATA — a reviewer adds a word by
 * editing JSON, not by shipping code. That is the same argument `data/particles.json` makes,
 * and it is why neither file is a TypeScript constant.
 *
 * PRIVACY: operates on authored catalogue and engine copy. Worker text never reaches here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The shape of `data/persona.json`. Keys prefixed `_` are prose rationale. */
export interface PersonaCorpus {
  readonly acknowledgements: readonly string[];
  readonly appreciations: readonly string[];
  readonly maxAppreciationsPerConversation: number;
  readonly minTurnBeforeAppreciation: number;
  readonly softenerDontKnow: string;
  readonly softenerHardship: string;
  readonly guaranteeLine: string;
  readonly bannedVocatives: readonly string[];
  readonly bannedInformal: readonly string[];
  readonly bannedGush: readonly string[];
  readonly bannedPromise: readonly string[];
  readonly bannedDeictics: readonly string[];
  readonly maxAckWords: number;
  readonly maxQuestionMarks: number;
  readonly maxChips: number;
  readonly stripBeforeScan: readonly string[];
}

/**
 * `data/` sits at the package root, one level above BOTH `src/` and `dist/`, so this
 * relative walk resolves identically from source (tsx) and from the build output. Same
 * trick, same reason, as `normalize/index.ts`'s `PARTICLES_PATH`.
 */
const PERSONA_PATH = join(__dirname, "..", "..", "data", "persona.json");

let cached: PersonaCorpus | null = null;

export function personaCorpus(): PersonaCorpus {
  if (cached === null) cached = JSON.parse(readFileSync(PERSONA_PATH, "utf8")) as PersonaCorpus;
  return cached;
}

/**
 * Every banned token, with the list it came from — so a violation report can say WHY.
 *
 * "contains a banned word" sends a reviewer hunting. "banned vocative: bhai" tells them
 * what to change and, because the list names the rule, why the rule exists.
 */
export function bannedTokenGroups(): ReadonlyArray<readonly [group: string, tokens: readonly string[]]> {
  const c = personaCorpus();
  return [
    ["vocative", c.bannedVocatives],
    ["informal address", c.bannedInformal],
    ["gush", c.bannedGush],
    ["promise", c.bannedPromise],
    ["deictic", c.bannedDeictics],
  ];
}

/**
 * Normalize for scanning: lowercase, collapse whitespace, drop the sanctioned phrases.
 *
 * THE STRIP IS LOAD-BEARING AND NARROW. "Bada Bhai" is the product's own name and contains
 * a banned vocative; the honest-refusal line contains a banned promise. Both are sanctioned
 * copy, so both are removed BEFORE the scan rather than special-cased inside it — otherwise
 * the guard forbids the two phrases it exists to protect.
 *
 * Punctuation becomes whitespace so a token at the end of a sentence ("...bhai.") is still a
 * whole word. Devanagari is left alone: none of the banned tokens are in that script, and
 * mangling it here would silently change what the scan sees for a Hindi prompt.
 */
function scannable(text: string): string {
  let out = text.toLowerCase();
  for (const phrase of personaCorpus().stripBeforeScan) {
    out = out.split(phrase).join(" ");
  }
  // `\p{L}\p{N}` — keep letters and digits in ANY script, turn everything else into a
  // separator. Written as Unicode property escapes rather than an explicit range because a
  // literal Devanagari range here spans combining marks, which is what
  // `no-misleading-character-class` objects to and what forced `normalize/index.ts` to spell
  // its class out in `\uXXXX` escapes with a disable comment.
  //
  // The README's common-subset rule (no `\w`, no `\d`) exists so a Python twin reading the
  // same JSON cannot disagree with the TypeScript reader. `sync-mirror` DOES copy
  // `persona.json` into the ai-service image, but after this phase no Python code implements
  // this scan — `persona_guard.check_turn` was the only one and it is deleted here. So the
  // rule does not bind this regex today. If a Python reader is ever added, note that
  // `\p{L}` needs the `regex` module rather than `re`.
  return ` ${out.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/ +/g, " ").trim()} `;
}

/**
 * Scan authored copy for banned tokens. Returns every violation, never throws.
 *
 * WHOLE-WORD MATCHING, and the reason is in the corpus comment: "tu" as a substring fires
 * inside "status" and "tube", and a guard that rejects the word "status" is a guard nobody
 * can keep switched on. Multi-word tokens ("pakka job") are matched as padded substrings,
 * which is whole-word by the same construction.
 */
export function checkPersonaTokens(text: string): string[] {
  const haystack = scannable(text);
  const problems: string[] = [];
  for (const [group, tokens] of bannedTokenGroups()) {
    for (const token of tokens) {
      if (haystack.includes(` ${token} `)) problems.push(`banned ${group}: ${JSON.stringify(token)}`);
    }
  }
  return problems;
}
