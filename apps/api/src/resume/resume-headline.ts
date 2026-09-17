import { joinSegments, tenurePhrase, toolsPhrase } from "./resume-sheet-rows";

/**
 * Layer A (h) — the DETERMINISTIC headline and summary builders.
 *
 * ═══ WHAT THESE ARE ═══
 *
 * One place that composes the two text slots the generic layouts print (`{{headline}}` and
 * `{{summary}}`), from CONFIRMED data and nothing else:
 *
 *   headline = role · tenure · tools
 *   summary  = role · tenure · tools · city
 *
 * NO LLM, and that is not a style preference: the résumé's headline is the first thing a
 * supervisor reads, and §8 admits only three sources for a printed atom (a closed-vocabulary
 * label, a stated number, the worker's own words). Every segment here is one of those:
 * the role is the label the profile settled on, the tenure is the stated figure or §11 #3's
 * honest unknown, the tools are the worker's own machines/controllers/skill labels, the city is
 * the worker's own registration or interview answer.
 *
 * ═══ SAME SEGMENTS AS THE VERDICT LINE, DELIBERATELY ═══
 *
 * These helpers reuse `tenurePhrase` / `toolsPhrase` / `joinSegments` from `resume-sheet-rows`
 * — the exact functions the `bb_trade` verdict line composes with — so a worker's headline and
 * the trade sheet's top strip can never disagree about a tenure or name different tools. The
 * separators are the sheet's own (` · `, `, `), which is also what keeps every atom inside the
 * fabrication gate's closed vocabulary without a single new permission: each tool and the city
 * are independently worker-stated strings, and the tenure matches the licensed figure pattern.
 *
 * The domain/trade label is NOT a segment: it already prints in its own `{{trade}}` slot, and
 * repeating it here would say one thing twice while spending a segment the line needs.
 */

/** The facts both builders read. Every one is a settled field, never a re-derivation. */
export interface ProfileLineFacts {
  /** The settled role label (trade display name, taxonomy name, or the cased model label). */
  readonly role: string | null;
  /** The ONE total (see `renderedTotalYears`), or null when nobody stated one. */
  readonly years: number | null;
  /** §6.2's closed tenure STATUS ("Fresher") — consulted only where `years` is absent. */
  readonly tenureLabel?: string | null;
  /** Machines, controllers, skills — in that precedence, from the caller's own resolution. */
  readonly tools: readonly string[];
}

/**
 * `{{headline}}` — "CNC Turner · 5 yrs 3 mo · Fanuc, Siemens".
 *
 * NULL WITHOUT A ROLE, and that is a policy rather than a side effect: tenure, tools and city
 * are MODIFIERS of who the worker is, and "5 yrs · Fanuc · Pune" alone would be a headline about
 * nobody. With a role, an absent tenure or tool takes its separator with it and the role still
 * prints — the slot describes what is known.
 */
export function buildProfileHeadline(facts: ProfileLineFacts): string | null {
  const role = facts.role?.trim();
  if (!role) return null;
  return joinSegments([
    role,
    tenurePhrase(facts.years, facts.tenureLabel ?? null),
    toolsPhrase(facts.tools),
  ]);
}

/**
 * `{{summary}}` — the headline plus the city: role · tenure · tools · city.
 *
 * NOT A SENTENCE, and that is the ruling this function records: the sheet's own design language
 * is a middle-dot strip (the verdict line, the terms rows), every atom in it is independently
 * verifiable against what the worker stated, and a composed sentence would need either new
 * fabrication-gate permissions or an LLM — both of which cost more than the register is worth.
 * A supplier reading "CNC Turner · 5 yrs 3 mo · Fanuc · Pune" gets the four facts in one scan.
 *
 * The role-required policy is {@link buildProfileHeadline}'s, restated.
 */
export function buildProfileSummary(
  facts: ProfileLineFacts & { readonly city: string | null },
): string | null {
  const role = facts.role?.trim();
  if (!role) return null;
  return joinSegments([
    role,
    tenurePhrase(facts.years, facts.tenureLabel ?? null),
    toolsPhrase(facts.tools),
    facts.city,
  ]);
}
