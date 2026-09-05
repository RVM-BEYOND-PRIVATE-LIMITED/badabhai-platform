import { canonicalCity } from "@badabhai/profiling-lexicon";
import CITIES_FILE from "@badabhai/profiling-lexicon/data/cities.json";
import STATES_FILE from "@badabhai/profiling-lexicon/data/states.json";

/**
 * The preferred-city option list, DERIVED from the same gazetteer that validates the answer
 * (#1406).
 *
 * WHY THIS EXISTS. `preferred_cities` on `PUT /workers/me/work-preferences` resolves every value
 * through `canonicalCity` and 400s on anything the gazetteer does not hold — and until now there
 * was no way for a client to know what that set contained. Every other closed-set field on the
 * trade form is a chip picker fed from a real options endpoint; city entry was the one exception,
 * still free-text-and-hope, so a worker learned his city was unrecognised only after submitting.
 * That is the miss #1406 reports, from a real device, on the word "Kota".
 *
 * SERVED AS ONE LIST, NOT A `?q=` SEARCH ROUTE, and the number is the argument. `cities.json` is
 * 1,754 bytes and resolves to 36 distinct values — a payload smaller than the response headers
 * carrying it. `trade-form.service.ts`'s `SEARCHABLE_OPTION_THRESHOLD` already ratified what the
 * product does with a list this size: past twelve options the server marks it `searchable` and
 * the client filters the DOWNLOADED list in memory with `BbSearchableMultiSelect`. A per-keystroke
 * route would instead put a network round trip between a worker on 3G and the next character he
 * types, on a surface whose only other failure mode is a dead-end retry screen. The list rides
 * the options response the preferences page already fetches on mount, so it costs no request at
 * all.
 *
 * ## The two properties this file exists to guarantee
 *
 * EVERY VALUE ROUND-TRIPS. Nothing here may be a string the validator would reject — an
 * autocomplete that suggests a value and then 400s on it is worse than no autocomplete, because
 * the worker has no reason left to distrust his own typing. The guarantee is BY CONSTRUCTION, not
 * by review: the display value is not spelled here, it is whatever `canonicalCity` itself returns
 * for the token, so the option list and the validator cannot disagree about casing or about which
 * spelling wins. `buildCatalogue` re-feeds each result through `canonicalCity` and throws if it
 * does not land on itself.
 *
 * THE ALIASES ARE ON THE WIRE, because they are the actual failure mode. A worker types "dilli",
 * "bombay", "banglore" or "poona" — the gazetteer resolves all four, and a client filtering on
 * display labels alone would show him an empty list for every one of them and reproduce the exact
 * dead end #1406 is about, one layer further out. They are search keys, never display text: the
 * chip says "Delhi" and the body sends "Delhi".
 *
 * ## Why the derivation lives here and not in the lexicon
 *
 * `packages/profiling-lexicon/src/values/` is Prakash's directory (see that package's barrel: the
 * subdirectory split IS the ownership boundary), so a search helper cannot be added beside
 * `canonicalCity`. It does not need to be. The package already declares `"./data/*"` in its
 * exports map, so the gazetteer is readable from here with NO second copy of the city list — the
 * one property that matters, since a duplicated list is the drift this whole file is guarding
 * against.
 *
 * That import reads the CANONICAL `data/cities.json`, while `canonicalCity` matches against the
 * copy embedded in the package's generated reader. `pnpm lexicon:verify` gates those two against
 * each other, but it runs in the lexicon package rather than here — so this module does not trust
 * it. Feeding every token back through `canonicalCity` at load makes a drift between the two a
 * BOOT FAILURE in this service, with the offending token named, rather than a live endpoint
 * quietly suggesting cities the validator rejects.
 */

/** The shape of the gazetteer file this module reads. Declared, not inferred, so a change to the file's shape is a compile error here rather than a silently different catalogue. */
interface CitiesFile {
  readonly canonical: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  /** Canonical token -> state display label (#1429). Covers every `canonical` member. */
  readonly states: Readonly<Record<string, string>>;
}

/** The shape of the state gazetteer this module reads. Only the picker list is consumed here. */
interface StatesFile {
  /**
   * The 28 states + 8 union territories, as display labels. DELIBERATELY NOT `names`: that key
   * is DETECTION data compiled into regexes that run over worker speech, it holds 22 entries and
   * no union territory, and `Delhi`/`Chandigarh` — both canonical cities — are absent from it.
   */
  readonly administrative: readonly string[];
}

/**
 * One city the worker may choose.
 *
 * `value` is BOTH the label and the submitted string, and that is deliberate: unlike every other
 * field on this form, `preferred_cities` has no slug layer — a city's identity in this system IS
 * its canonical display spelling, because that is what `canonicalCity` returns and what the
 * résumé prints. A slug→label map here would invent a key that exists nowhere in the write
 * contract and give a client two plausible things to submit.
 */
export interface CityOption {
  /** The canonical spelling — what the chip shows AND what `preferred_cities` must be sent. */
  readonly value: string;
  /**
   * The state this city is in, as a member of {@link STATE_CATALOGUE} (#1429).
   *
   * PURELY A FILTER KEY. It is not part of the write contract — `preferred_cities` still submits
   * `value` alone — so a client that ignores it behaves exactly as before. It exists so the
   * picker can be a state-then-city cascade instead of one flat list of 36.
   */
  readonly state: string;
  /**
   * Alternate spellings that resolve to `value`, lowercased. SEARCH KEYS ONLY — never rendered,
   * never submitted. Empty for a city nobody spells another way.
   */
  readonly aliases: readonly string[];
}

/**
 * The state/UT options, in the order the picker shows them.
 *
 * WHY IT IS SERVED AT ALL. #1429 asks for a state-then-city cascade, and a client cannot build
 * one from the city list alone: it would have to derive the state set by scanning the cities it
 * was given, which yields only the 13 states that happen to contain a manufacturing hub. That is
 * the right list for filtering the closed city set and the wrong one for the employer-location
 * field beside it, where a worker's previous employer can be anywhere in India.
 *
 * READ FROM `administrative`, NOT `names`. `names` is DETECTION data — signals.py compiles it
 * into a regex that runs over free worker speech — and it holds 22 entries with no union
 * territory, so `Delhi` and `Chandigarh`, both canonical cities in this very catalogue, are
 * absent from it. Adding them there to fill the picker would silently change what the profiler
 * reads out of a sentence, where "Delhi" is far more often the city than the state.
 *
 * FROZEN, because it is handed out by reference on a response every worker fetches on mount and
 * a caller mutating it would corrupt every later request in the process.
 */
export const STATE_CATALOGUE: readonly string[] = Object.freeze([
  ...(STATES_FILE as unknown as StatesFile).administrative,
]);

/**
 * Resolve one gazetteer token, or fail loudly.
 *
 * A token drawn from the gazetteer that the gazetteer's own matcher does not recognise means the
 * two copies have drifted, and there is no safe way to continue: the endpoint would advertise a
 * value the validator rejects. Fail closed, at module load, naming the token.
 */
function resolveOrThrow(token: string): string {
  const resolved = canonicalCity(token);
  if (resolved === null) {
    throw new Error(
      `city gazetteer drift: "${token}" is in data/cities.json but canonicalCity() does not ` +
        `resolve it. Run \`pnpm lexicon:verify\` — the embedded copy is stale.`,
    );
  }
  return resolved.value;
}

/**
 * Fold the gazetteer's canonical entries and aliases into one option per DISTINCT resolved city.
 *
 * THE TRAP THIS EXISTS TO SURVIVE: two tokens — "bengaluru" and "gurgaon" — are members of
 * `canonical` AND keys of `aliases`, and the alias map wins in `canonicalCity`. So the 38
 * canonical entries are only 36 distinct answers, and a list built naively from `canonical` would
 * offer the worker both "Bengaluru" and "Bangalore", store the same value for either, and print a
 * chip that disagrees with the sheet. Grouping by the RESOLVED value rather than by the token is
 * what makes that impossible to get wrong.
 */
function buildCatalogue(): readonly CityOption[] {
  const file = CITIES_FILE as unknown as CitiesFile;
  const aliasesByCity = new Map<string, Set<string>>();
  const tokensByCity = new Map<string, string[]>();

  // Every token the gazetteer can match, canonical entries and alias keys alike. Both are things
  // a worker might type, so both are search keys; which list a token came from says nothing about
  // whether it is the spelling we display.
  for (const token of [...file.canonical, ...Object.keys(file.aliases)]) {
    const city = resolveOrThrow(token);
    let aliases = aliasesByCity.get(city);
    if (!aliases) {
      aliases = new Set<string>();
      aliasesByCity.set(city, aliases);
      tokensByCity.set(city, []);
    }
    tokensByCity.get(city)!.push(token);
    // The token that IS the display spelling is not an alias of itself. Compared case-insensitively
    // because the gazetteer stores tokens lowercased and `canonicalCity` title-cases its output.
    if (token.toLowerCase() !== city.toLowerCase()) aliases.add(token.toLowerCase());
  }

  const grouped = [...aliasesByCity.entries()]
    .map(([value, aliases]) => ({ value, aliases: [...aliases].sort() }))
    // Alphabetical, because there is no ranking signal in the gazetteer to offer instead and an
    // arbitrary file order would read as a recommendation the product has not made.
    .sort((a, b) => a.value.localeCompare(b.value));

  // The round-trip guarantee, asserted rather than assumed. `canonicalCity` is case-insensitive,
  // so feeding it the title-cased display value must land back on that same value — if it ever
  // does not, the option list has become a set of strings the validator would 400 on.
  //
  // CHECKED BEFORE THE STATE TAGS BELOW, deliberately. This is the older and more fundamental
  // guarantee: if the matcher and the file disagree about which spelling wins, every state tag is
  // being folded onto a city that does not exist, and the resulting error would name the tag
  // rather than the drift that caused it.
  for (const city of grouped) {
    if (resolveOrThrow(city.value) !== city.value) {
      throw new Error(`city catalogue does not round-trip: "${city.value}"`);
    }
  }

  return grouped.map((city) => ({ ...city, state: stateOf(city.value, tokensByCity.get(city.value)!) }));
}

/**
 * The state for one resolved city, or fail loudly (#1429).
 *
 * TAKES THE TOKENS, NOT THE DISPLAY VALUE, because `states` is keyed by gazetteer token and two
 * tokens can reach one city: `bengaluru` and `gurgaon` are members of `canonical` AND keys of
 * `aliases`, so 38 canonical entries are only 36 distinct answers. A map keyed by token would give
 * Bangalore two entries and let whichever was written last win silently; folding onto the RESOLVED
 * value and REFUSING a disagreement makes that impossible rather than merely unlikely — the same
 * rule, and the same trap, as the alias grouping above.
 */
function stateOf(city: string, tokens: readonly string[]): string {
  const file = CITIES_FILE as unknown as CitiesFile;
  // Alias keys carry no tag of their own — they inherit the canonical member they resolve to.
  const tagged = [...new Set(tokens.map((t) => file.states[t]).filter((v): v is string => !!v))];

  if (tagged.length === 0) {
    // FAIL CLOSED rather than emitting `state: undefined`. A city with no state vanishes from every
    // state a worker can pick: it would show in the flat list and be unreachable through the
    // cascade — the #1406 dead end, one layer in.
    throw new Error(
      `city gazetteer gap: "${city}" has no entry in data/cities.json \`states\`. Every canonical ` +
        `city must carry a state (#1429). Tokens seen: ${tokens.join(", ")}.`,
    );
  }
  if (tagged.length > 1) {
    throw new Error(
      `city gazetteer conflict: "${city}" is tagged ${tagged.map((t) => `"${t}"`).join(" and ")} ` +
        `in data/cities.json \`states\` — tokens resolving to one city must agree.`,
    );
  }

  const state = tagged[0]!;
  // EVERY STATE MUST BE ONE THE PICKER OFFERS. A typo here ships a filter value matching no entry
  // in STATE_CATALOGUE, so the cascade offers a state whose cities can never be reached, and the
  // worker cannot tell that from "no cities here".
  if (!STATE_CATALOGUE.includes(state)) {
    throw new Error(
      `city gazetteer drift: "${city}" is tagged state "${state}", which is not a member of ` +
        `data/states.json \`administrative\`.`,
    );
  }
  return state;
}

/**
 * The option list, built once at module load.
 *
 * Static for the process's lifetime because the gazetteer is: it is a committed JSON file, not a
 * table, so there is nothing to invalidate and no request should pay to rebuild it.
 */
export const CITY_CATALOGUE: readonly CityOption[] = buildCatalogue();
