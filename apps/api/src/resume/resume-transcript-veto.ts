import type { WorkerAttributeValues } from "./trade-resume-map";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE TRANSCRIPT VETO — a chip tick is a claim, and the worker's own words may withdraw it.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE HOLE THIS FILLS. §8.3's asymmetry rule — "mappings may resolve ambiguity downward but
 * never upward" — was written for free text: "chalata hoon" stays operating, "machine set karta
 * hoon" may raise the modifier. A CHIP GRID BYPASSES IT ENTIRELY. Ticking is free, there is no
 * phrasing to resolve, and every tick is a literal claim — so the asymmetry property test built
 * in R5 passes over a grid without seeing anything, because there is nothing ambiguous in it.
 * §5.3 calls an unclaimed capability upgrade the most damaging failure available to us, and it
 * surfaces at the machine trial, in front of the employer, with the worker holding the sheet.
 *
 * WHY NOT ANCHORING. R7 §5 tested the obvious fix — ask "what did you do AT Shakti Precision"
 * instead of "what can you do" — over five runs per arm on a one-employer and a three-employer
 * persona. The claim set did not move: 8 vs 8, and 18 vs 18. What the run DID show is that the
 * over-claims are contradicted by text we already hold. That is the constraint that bites.
 *
 * ── THE RULE, AND WHY IT LEANS THE WAY IT DOES ────────────────────────────────────────
 *
 * A claim is vetoed only when the worker EXPLICITLY negated that capability, in a clause of his
 * own transcript, and said nothing positive about it anywhere else.
 *
 * A FALSE VETO IS THE SAME FAILURE AS THE TOTAL-YEARS BUG: it takes a true claim off a man's
 * résumé and under-represents him against his own words. That is why every rule below is the
 * narrow version — clause scope rather than turn scope, an explicit marker list rather than
 * hedge detection, and a positive rescue that outranks the veto. The asymmetry runs the same
 * direction as §8.3's: when in doubt, keep the lower-risk outcome, and the lower-risk outcome
 * for a worker is the claim he made.
 *
 * NOT A MATCHING INPUT. This runs at the résumé boundary and changes what PRINTS. The stored
 * `worker_attributes` rows are untouched and the match engine still reads the tick as given —
 * deliberately, because a veto that silently narrowed a worker's reach would cost him postings
 * on a heuristic. Whether the same cross-check belongs in matching is a separate ruling.
 */

/** One withdrawn claim, with the worker's own sentence that withdrew it. */
export interface TranscriptVeto {
  readonly attributeKey: string;
  readonly slug: string;
  /** The clause that triggered it, verbatim — so every veto is auditable by a human. */
  readonly phrase: string;
}

/**
 * EXPLICIT NON-PERFORMANCE MARKERS. A closed list, matched as whole space-delimited phrases.
 *
 * "nahi" AND ITS SPELLINGS carry the weight. The rest are the specific Hinglish idioms that
 * state non-performance without the negative particle, and each earns its place by being
 * unambiguous in isolation:
 *
 *   "dekha hai"    — "I have seen it [done]". PERFECTIVE, and that is the whole distinction:
 *                    "dekh leta hoon" ("I do look at it") is a positive weak claim and is NOT
 *                    on this list. Matching whole phrases rather than the stem is what keeps
 *                    the two apart; a stemmer would collapse them and veto the wrong one.
 *   "sikh raha"    — "I am learning it", i.e. not yet doing it. Both common spellings.
 *
 * DELIBERATELY ABSENT: "sirf" (only), "thoda" (a little), "kabhi kabhi" (sometimes) and every
 * other hedge. §8.4 is explicit that "sab kar leta hoon" resolves to NOTHING rather than to a
 * claim — a hedge is not evidence in either direction, and treating one as a veto would delete
 * the honest, qualified answers this product exists to capture.
 */
const NEGATION_MARKERS = [
  "nahi",
  "nahin",
  "नहीं",
  "dekha hai",
  "dekha hua hai",
  "sikh raha",
  "seekh raha",
  "sikh rahi",
  "seekh rahi",
] as const;

/**
 * Clause boundaries.
 *
 * THE CONTRASTIVE CONJUNCTIONS ARE THE POINT, not the full stops. The sentence this was built
 * against is "Offset thoda bahut dekh leta hoon jab supervisor bolte hain, par khud se setting
 * nahi karta" — one sentence carrying a positive claim and a negation of a DIFFERENT capability.
 * Scoped to the sentence, the negation would reach back and cancel the offset claim. Scoped to
 * the clause after "par", it cancels only what follows it, which is what the worker meant.
 */
const CLAUSE_SPLIT_RE = /[.!?;।॥\n\r]+|\s+(?:par|lekin|magar|but)\s+/giu;

/** Normalised, space-padded clause: script-agnostic word boundaries without `\b`. */
function padded(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

function clausesOf(turns: readonly string[]): { raw: string; key: string }[] {
  return turns.flatMap((turn) =>
    turn
      .split(CLAUSE_SPLIT_RE)
      .map((c) => (c ?? "").trim())
      .filter((c) => c.length > 0)
      .map((raw) => ({ raw, key: padded(raw) })),
  );
}

function hasAny(clauseKey: string, terms: readonly string[]): boolean {
  return terms.some((t) => clauseKey.includes(` ${padded(t).trim()} `));
}

interface TermSpec {
  /** Terms that speak for the WHOLE attribute — "setting", "programme". */
  readonly attribute: readonly string[];
  /** Terms specific to one slug. A slug with none can only be reached attribute-wide. */
  readonly slugs: Readonly<Record<string, readonly string[]>>;
}

/**
 * THE GAZETTEER — how a turner names each capability in his own Hinglish.
 *
 * SCOPED TO THE CNC TURNING PACK, which is the only authored role track. A pack with no entry
 * here is not vetoed at all, which is the correct default: the cost of no veto is an over-claim
 * that reaches a trial, and the cost of a guessed veto is a true claim deleted from a man's
 * résumé by a term list nobody in that trade reviewed.
 *
 * THE ALIASES ARE THE MOAT, and this is the same asset §8.2 describes: "no model maps 'kharad'
 * to 'lathe operation' without a hand-seeded alias". Every term below is a phrase a turner
 * actually uses, not a translation of the English label.
 */
const CAPABILITY_TERMS: Readonly<Record<string, TermSpec>> = {
  setting_operation: {
    attribute: ["setting", "set karta", "set karta hoon", "setting karta", "seting"],
    slugs: {
      tool_offset: ["offset", "tool offset"],
      work_offset: ["work offset", "zero setting", "g54"],
      nose_radius: ["nose radius", "radius compensation"],
      jaw_change: ["jaw", "chuck change", "jaw change"],
      tailstock_set: ["tailstock", "centre set"],
      first_piece: ["first piece", "pehla piece", "first pc"],
    },
  },
  programming_level: {
    attribute: ["programme", "program", "programming", "programing", "g code", "m code"],
    slugs: {
      // "edit kar leta hoon" is how persona 3 actually says it, and "edit karta" alone missed
      // it. The affirmation list has to carry a worker's real phrasing or the rescue never fires.
      edit_program: ["programme edit", "program edit", "edit karta", "edit kar", "edit kar leta"],
      write_program: ["programme banata", "program banata", "programme likhta", "naya programme"],
      cam: ["cam", "mastercam", "cam software"],
    },
  },
  drawing_reading: {
    attribute: ["drawing", "drwaing", "naksha", "blueprint"],
    slugs: { gdt: ["gd t", "gdt", "geometric tolerance", "geometrical tolerance"] },
  },
  quality_work: {
    attribute: ["quality", "inspection", "checking"],
    slugs: {
      spc: ["spc", "spc chart"],
      rejection: ["rejection", "rejection analysis"],
      first_piece_check: ["first piece check", "first piece inspection"],
    },
  },
  troubleshooting: {
    attribute: ["troubleshoot", "troubleshooting", "problem solve"],
    slugs: {
      alarm: ["alarm", "alarm clear"],
      chatter: ["chatter", "vibration"],
      tool_wear: ["tool wear", "tool break", "tool breakage"],
    },
  },
  advanced_capability: {
    attribute: [],
    slugs: {
      live_tooling: ["live tooling", "live tool"],
      bar_feeder: ["bar feeder", "barfeeder"],
      sub_spindle: ["sub spindle", "subspindle"],
      c_axis: ["c axis"],
      y_axis: ["y axis"],
    },
  },
};

/** Every value the attribute holds, as slugs. Mirrors `slugsOf` in `trade-resume-map.ts`. */
function slugsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

/**
 * Withdraw the chip claims the worker's own transcript explicitly contradicts.
 *
 * PURE, and it returns a NEW attribute map — the stored rows are never mutated. An empty
 * transcript vetoes nothing, which is the ordinary case for a worker whose answers came through
 * the form rather than the chat.
 */
export function applyTranscriptVeto(args: {
  readonly attributes: WorkerAttributeValues;
  readonly workerSaid: readonly string[];
}): { attributes: WorkerAttributeValues; vetoes: TranscriptVeto[] } {
  const clauses = clausesOf(args.workerSaid);
  if (clauses.length === 0) return { attributes: args.attributes, vetoes: [] };

  const negated = clauses.filter((c) => hasAny(c.key, NEGATION_MARKERS));
  if (negated.length === 0) return { attributes: args.attributes, vetoes: [] };
  const affirmed = clauses.filter((c) => !hasAny(c.key, NEGATION_MARKERS));

  // A MUTABLE COPY, then frozen back into the readonly shape on return. `WorkerAttributeValues`
  // is `Readonly<Record<string, unknown>>` precisely so nothing downstream can edit a worker's
  // stored answers in place; this function's whole job is to produce a DIFFERENT map.
  const attributes: Record<string, unknown> = { ...args.attributes };
  const vetoes: TranscriptVeto[] = [];

  for (const [attributeKey, spec] of Object.entries(CAPABILITY_TERMS)) {
    const claimed = slugsOf(attributes[attributeKey]);
    if (claimed.length === 0) continue;

    const survivors: string[] = [];
    for (const slug of claimed) {
      const slugTerms = spec.slugs[slug] ?? [];

      // ── 1. A NEGATION THAT NAMES THIS SLUG IS FINAL. Nothing rescues it: the worker used the
      //       capability's own name and denied it.
      const specific =
        slugTerms.length > 0 ? negated.find((c) => hasAny(c.key, slugTerms)) : undefined;
      if (specific) {
        vetoes.push({ attributeKey, slug, phrase: specific.raw });
        continue;
      }

      // ── 2. AN ATTRIBUTE-WIDE NEGATION REACHES A SLUG ONLY WHEN THAT CLAUSE IS NOT ABOUT SOME
      //       OTHER SLUG. This rule was added after a MEASURED false veto, and it is the most
      //       load-bearing line in the file.
      //
      //       Persona 3 said: "Naya programme nahi likhta, par jo chal raha hai usme edit kar
      //       leta hoon" — I don't WRITE new programmes, but I EDIT the running one. The first
      //       clause carries the attribute-wide term "programme", and the first version of this
      //       function withdrew his `edit_program` chip on the strength of it. That is exactly
      //       the failure this file exists to prevent, pointed the wrong way: a true claim
      //       deleted from a man's résumé by his own honest qualification of it.
      //
      //       "naya programme" is a `write_program` term. A clause that names one slug is a
      //       statement about THAT slug, so the attribute-wide reach does not apply to any other.
      const namesAnotherSlug = (clauseKey: string): boolean =>
        Object.entries(spec.slugs).some(
          ([other, terms]) => other !== slug && hasAny(clauseKey, terms),
        );
      const wide =
        spec.attribute.length > 0
          ? negated.find((c) => hasAny(c.key, spec.attribute) && !namesAnotherSlug(c.key))
          : undefined;

      // ── 3. THE POSITIVE RESCUE. A slug the worker separately affirmed BY NAME survives an
      //       attribute-wide denial. "Setting nahi karta" reaches every Setting slug, including
      //       `tool_offset`, which the same worker supported two clauses earlier with "Offset
      //       thoda bahut dekh leta hoon" — and §8.3's own table maps that phrase to a setting
      //       capability, so deleting it would contradict the guideline that motivates this file.
      const rescued =
        wide !== undefined &&
        slugTerms.length > 0 &&
        affirmed.some((c) => hasAny(c.key, slugTerms));

      if (wide && !rescued) {
        vetoes.push({ attributeKey, slug, phrase: wide.raw });
      } else {
        survivors.push(slug);
      }
    }
    if (survivors.length !== claimed.length) attributes[attributeKey] = survivors;
  }

  return { attributes, vetoes };
}
