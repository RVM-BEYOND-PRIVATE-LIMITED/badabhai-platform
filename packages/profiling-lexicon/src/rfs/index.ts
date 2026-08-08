/**
 * The Resume Field Set — what each field id means, and what a human calls it.
 *
 * LIFTED BEFORE THE DELETE. `apps/ai-service/app/profiling/rfs.py` is removed in OIE Phase 8.
 * Most of that module was interview machinery the deterministic engine replaces — required/
 * optional lists, completeness checks, the prompt brief — but `FIELD_GUIDE` and `FIELD_LABEL`
 * are neither: they are reviewed English describing the platform's own vocabulary, and nothing
 * in the new engine regenerates them. Deleting the file without moving them would leave 466
 * pack prompts and one parse prompt with no shared definition of what `salary_expected` means.
 *
 * THE READERS CHANGED, THE WORDING DID NOT, and that is the useful part. `FIELD_GUIDE` was
 * written to tell a MODEL what to collect; it reads identically as instructions to a pack
 * AUTHOR writing the question, because it never described how to ask — only what is wanted.
 *
 * WHY THIS IS NOT `FIELD_CROSSWALK`. That table answers "where does this answer LAND" — a
 * mechanical routing question with an exhaustiveness test behind it. This one answers "what
 * IS this field", which is prose a human wrote and a human maintains. Merging them would put
 * reviewed copy inside a structure whose test asserts shape, and the copy would rot unnoticed.
 *
 * PRIVACY: reviewed vocabulary. No worker data reaches here, and there is deliberately no
 * field for a name, phone, address or employer — see the corpus header.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RfsField {
  /** A short human label — the missing-field nudge, an ops column header, a log line. */
  readonly label: string;
  /** What the field MEANS, phrased as the information wanted rather than as a question. */
  readonly guide: string;
}

/** The shape of `data/rfs-fields.json`. Keys prefixed `_` are prose rationale. */
interface RfsCorpus {
  readonly fields: Readonly<Record<string, RfsField>>;
}

/**
 * `data/` sits at the package root, one level above BOTH `src/` and `dist/`, so this relative
 * walk resolves identically from source (tsx) and from the build output. Same trick, same
 * reason, as `normalize/index.ts`'s `PARTICLES_PATH`.
 */
const RFS_PATH = join(__dirname, "..", "..", "data", "rfs-fields.json");

let cached: Readonly<Record<string, RfsField>> | null = null;

/** Every RFS field, keyed by id. Read once and memoized — the file never changes at runtime. */
export function rfsFields(): Readonly<Record<string, RfsField>> {
  if (cached === null) cached = (JSON.parse(readFileSync(RFS_PATH, "utf8")) as RfsCorpus).fields;
  return cached;
}

/**
 * The human label for a field id, falling back to the id itself.
 *
 * FALLS BACK RATHER THAN THROWING because the caller is usually rendering: a field id with no
 * label is a corpus gap worth fixing, not a reason to fail the screen a worker is looking at.
 */
export function rfsLabel(fieldId: string): string {
  return rfsFields()[fieldId]?.label ?? fieldId;
}

/** What the field means. Empty string when the id is not in the vocabulary at all. */
export function rfsGuide(fieldId: string): string {
  return rfsFields()[fieldId]?.guide ?? "";
}
