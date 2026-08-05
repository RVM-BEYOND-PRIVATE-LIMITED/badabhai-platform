/**
 * Occupation-text normalization — the ONE function the alias seeder and the retrieval
 * query path both call.
 *
 * The classic failure mode this exists to prevent: two normalizers that drift. If the
 * seeder writes `job_domain_alias.text_norm` with one set of rules and the query path
 * normalizes the worker's phrase with another, exact-match retrieval (L0) silently
 * degrades to zero hits and every turn falls through to a paid embedding call.
 *
 * SYMMETRY IS THE SAFETY PROPERTY. Both sides of the comparison go through this
 * function, so a rule that "loses information" cannot break a match — `"Main Header
 * Colliery"` and a worker typing `"main header colliery"` land on the same key either
 * way. The only real risk is CONFLATION: two different aliases of the SAME domain
 * normalizing identically, which the `0068` unique index turns into a hard failure.
 * That is why `data/particles.json` carries a measured collision budget.
 *
 * REGEX DISCIPLINE (README.md guard #1): every pattern here uses explicit character
 * classes. No `\d`, no `\w`, no `\b`. JS `\d` is ASCII-only while Python's is
 * Unicode-aware, so a `\d` here would mean the future Python reader of this same
 * `particles.json` disagrees with this file about Devanagari digits.
 *
 * Owner: Divyanshu (Occupation Intelligence). Implemented in Phase 1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A stripped occupational particle, kept for diagnostics. */
export interface NormalizationTrace {
  /** The input, unchanged. */
  readonly input: string;
  /** The normalized output — what is stored in `text_norm` and what L0 looks up. */
  readonly normalized: string;
  /** Particles removed, in the order they were stripped (e.g. `["wala", "ka kaam"]`). */
  readonly strippedParticles: readonly string[];
  /** Script detected. Devanagari is NEVER transliterated — both scripts are separate alias rows. */
  readonly script: "latin" | "devanagari" | "mixed";
}

/** The shape of `data/particles.json`. Keys prefixed `_` are prose rationale. */
interface ParticleCorpus {
  readonly minStemLength: number;
  readonly phrases: readonly (readonly string[])[];
  readonly tokens: readonly string[];
  readonly suffixes: readonly string[];
}

/**
 * Devanagari letters and combining marks, EXCLUDING the two dandas (U+0964 `।`,
 * U+0965 `॥`) which are sentence punctuation and must be stripped like a full stop.
 * U+0966–U+096F are the Devanagari digits and are kept.
 *
 * Written as `\uXXXX` escapes, not as literal characters. Two reasons, and both bite:
 * U+0963 is a COMBINING mark, so a literal here renders as though it were attached to the
 * neighbouring `-` and the range becomes unreadable (eslint's
 * `no-misleading-character-class` rejects it outright); and escapes are what the
 * README's common-subset rule means by "explicit character classes" — this exact string
 * has to be readable by the future Python twin, where a pasted combining mark would be a
 * silent behaviour difference rather than a syntax error.
 */
const DEVANAGARI_CLASS = "\\u0900-\\u0963\\u0966-\\u097F";

/**
 * Everything NOT kept becomes a space. `-` is last in the class so it is a literal.
 *
 * `no-misleading-character-class` is disabled here deliberately, not worked around. The
 * rule's concern is that a character class matches CODE POINTS while a reader may expect
 * GRAPHEMES — `ऀ-ॣ` spans Devanagari combining marks, so it matches a nukta or a
 * matra on its own. For a character FILTER that is precisely the required semantics: this
 * class decides, per code point, what survives. Excluding the combining marks to satisfy
 * the rule would strip them off their base letters and garble every Devanagari alias —
 * "बढ़ई" (which carries U+093C) would come out wrong. Pinned by the Devanagari tests in
 * `normalize.test.ts`.
 */
// eslint-disable-next-line no-misleading-character-class -- code-point semantics is intended; see above
const NON_KEPT = new RegExp(`[^a-z0-9${DEVANAGARI_CLASS} /-]+`, "gu");

const HAS_DEVANAGARI = new RegExp(`[${DEVANAGARI_CLASS}]`, "u");
const HAS_LATIN = /[a-z]/;

/** Leading/trailing `-` and `/` on a token: kept INTRA-word, dropped at the edges. */
const EDGE_JOINERS_LEAD = /^[-/]+/;
const EDGE_JOINERS_TRAIL = /[-/]+$/;

/**
 * `data/` sits at the package root, one level above BOTH `src/` and `dist/`, so this
 * relative walk resolves identically whether the module is executed from source (tsx)
 * or from the build output. Same trick, same reason, as
 * `packages/db/src/job-domain-corpus.ts`'s `JOB_DOMAIN_DATA_DIR`.
 *
 * Read via `node:fs` rather than `import ... from "../../data/particles.json"` because
 * `data/` is outside this package's `rootDir: ./src` — a JSON import would raise TS6059
 * and force the corpus into `src/`, where the Python side (which resolves it by path)
 * could no longer find it.
 */
const PARTICLES_PATH = join(__dirname, "..", "..", "data", "particles.json");

let cachedCorpus: ParticleCorpus | null = null;

function corpus(): ParticleCorpus {
  if (cachedCorpus === null) {
    cachedCorpus = JSON.parse(readFileSync(PARTICLES_PATH, "utf8")) as ParticleCorpus;
  }
  return cachedCorpus;
}

/** Longest phrases first, so `["ka","kaam","karta","hun"]` wins over `["ka","kaam"]`. */
function phrasesByLength(c: ParticleCorpus): readonly (readonly string[])[] {
  return [...c.phrases].sort((a, b) => b.length - a.length);
}

/** NFKC → lowercase → keep-set → per-token edge trim → collapse whitespace. */
function baseNormalize(input: string): string[] {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(NON_KEPT, " ")
    .split(" ")
    .map((token) => token.replace(EDGE_JOINERS_LEAD, "").replace(EDGE_JOINERS_TRAIL, ""))
    .filter((token) => token.length > 0);
}

function stripParticles(tokens: string[], stripped: string[]): string[] {
  const c = corpus();
  let out = tokens;

  // 1. Multi-token phrases, longest first. Whole-sequence match only.
  for (const phrase of phrasesByLength(c)) {
    for (let i = 0; i + phrase.length <= out.length; ) {
      const matches = phrase.every((word, k) => out[i + k] === word);
      if (matches) {
        stripped.push(phrase.join(" "));
        out = [...out.slice(0, i), ...out.slice(i + phrase.length)];
        continue; // re-test at the same index — the phrase may repeat
      }
      i += 1;
    }
  }

  // 2. Whole tokens. NEVER a substring match: `ke` must not gut `kekada`.
  out = out.filter((token) => {
    if (!c.tokens.includes(token)) return true;
    stripped.push(token);
    return false;
  });

  // 3. Suffixes glued to a stem (`silaiwala`), guarded by a minimum stem length so a
  //    short word is never destroyed.
  out = out.map((token) => {
    for (const suffix of c.suffixes) {
      if (!token.endsWith(suffix)) continue;
      const stem = token.slice(0, token.length - suffix.length);
      if (stem.length < c.minStemLength) continue;
      stripped.push(suffix);
      return stem;
    }
    return token;
  });

  return out;
}

function detectScript(text: string): NormalizationTrace["script"] {
  const devanagari = HAS_DEVANAGARI.test(text);
  const latin = HAS_LATIN.test(text);
  if (devanagari && latin) return "mixed";
  if (devanagari) return "devanagari";
  return "latin";
}

/**
 * NFKC → lowercase → strip punctuation (keeping intra-word `-` and `/`) → collapse
 * whitespace → strip Indian occupational particles (`wala/wale/wali`, `ka kaam`,
 * `karta hun`, `ki/ka/ke`).
 *
 * The particle list is DATA (`data/particles.json`), not code, so adding one is a
 * corpus edit and a re-run of `db:normalize:aliases` — never a deploy.
 *
 * Deliberately NOT a Postgres `GENERATED` column: the particle list changes, a generated
 * column would force a full table rewrite on every rule change, and Postgres forbids
 * non-IMMUTABLE expressions there anyway.
 *
 * NEVER RETURNS EMPTY for input that had any kept character. A phrase made entirely of
 * particles (`"ka kaam"`) falls back to its pre-particle form rather than becoming `""` —
 * an empty `text_norm` would collide with every other empty one under the `0068` unique
 * index's `NULLS NOT DISTINCT`, turning a harmless input into a seed failure.
 */
export function normalizeOccupationText(input: string): string {
  return normalizeOccupationTextTraced(input).normalized;
}

/** As {@link normalizeOccupationText}, but returns what it did. For the seeder's audit output. */
export function normalizeOccupationTextTraced(input: string): NormalizationTrace {
  const base = baseNormalize(input);
  const stripped: string[] = [];
  const kept = stripParticles([...base], stripped);

  // Empty-guard: particles alone are not an occupation, but they are also not nothing.
  const normalized = (kept.length > 0 ? kept : base).join(" ");

  return {
    input,
    normalized,
    strippedParticles: kept.length > 0 ? stripped : [],
    script: detectScript(normalized),
  };
}

/**
 * Digraphs folded to one consonant BEFORE vowels are dropped, so `kh`/`k` and `sh`/`s`
 * cannot survive as distinct skeletons. Order matters: two-character keys only.
 */
const DIGRAPH_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/kh/g, "k"],
  [/gh/g, "g"],
  [/sh/g, "s"],
  [/ch/g, "c"],
  [/ph/g, "f"],
  [/th/g, "t"],
  [/dh/g, "d"],
  [/bh/g, "b"],
];

/** Single-character confusions common in Hinglish transliteration. */
const LETTER_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/w/g, "v"],
  [/z/g, "j"],
  [/y/g, "i"],
];

const VOWELS = "aeiou";
const REPEATED_CHAR = /(.)\1+/g;

/**
 * The Hinglish confusion folder used by retrieval layer L1.
 *
 * Folds the digraphs (`kh→k`, `sh→s`, `ch→c`, `ph→f`, `th→t`, `dh→d`, `bh→b`, `gh→g`)
 * and the single-letter confusions (`w→v`, `z→j`, `y→i`), then **drops every vowel except
 * a word-initial one** and collapses repeated characters. Applied to an already-normalized
 * string.
 *
 * WHY A CONSONANT SKELETON, and not the vowel-substitution rules this contract originally
 * described (`aa→a`, `ee→i`, `oo→u`, drop trailing `-a`). Those rules were measured against
 * all 8,695 seeded aliases and they do NOT achieve what they promise — they reach one key
 * for `kharad/kharaad` and `silai/silaai`, but MISS the headline case `welder/waelder/velder`
 * (`velder | vaelder | velder`) and also miss `mistri/mistry` and `driver/draiver`. Scored
 * 2/5 on its own stated examples. A consonant skeleton scores 5/5.
 *
 * The cost is measured, not assumed: 37 skeleton keys are shared by more than one distinct
 * alias, covering 75 of 8,695 texts (0.9%). Most of those are foldings we WANT
 * (`glazier|glazer`, `brakes man|breaks man`, `waitress|waiters`, `crewman|crewwoman`).
 * L1 GENERATES candidates for L2/L3 to score rather than deciding anything, so recall is
 * worth far more here than precision — and the skeleton is never a uniqueness key
 * (`text_norm` is), so a collision costs one extra candidate, never a lost row.
 *
 * Devanagari is untouched by every fold above (none of the classes match it) and is
 * therefore NOT transliterated — both scripts stay separate alias rows, by design.
 */
export function skeletonKey(normalized: string): string {
  return normalized
    .split(" ")
    .map((token) => {
      let t = token;
      for (const [pattern, replacement] of DIGRAPH_FOLDS) t = t.replace(pattern, replacement);
      for (const [pattern, replacement] of LETTER_FOLDS) t = t.replace(pattern, replacement);

      // A leading vowel is informative ("operator" vs "perator"); interior ones are not.
      const head = t.length > 0 && VOWELS.includes(t[0] as string) ? (t[0] as string) : "";
      const tail = t
        .slice(head.length)
        .split("")
        .filter((character) => !VOWELS.includes(character))
        .join("");

      return (head + tail).replace(REPEATED_CHAR, "$1");
    })
    .filter((token) => token.length > 0)
    .join(" ");
}
