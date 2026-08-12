/**
 * Resume layout template registry (layer-1 skeletons).
 *
 * METADATA ONLY — the HTML/CSS lives in sibling `<id>.v<n>.html` files; data
 * binding / rendering (resume_json -> slots -> HTML/PDF) is a LATER layer. This
 * registry lets callers pick a layout by a stable `template_id` and always
 * resolve to *something* (the generic fallback) for unknown ids.
 *
 * Versioning: a shipped template file is immutable. To change a layout, add a new
 * `<id>.v<n+1>.html` and a registry entry — never mutate a version in use, so
 * resumes that recorded an older `template_id`+version still render the same.
 */
export interface ResumeTemplate {
  /** Stable id referenced by callers and stored on generated resumes. */
  readonly id: string;
  /** Bump by adding a new file; don't mutate a shipped version. */
  readonly version: number;
  readonly label: string;
  /** Filename within this directory. */
  readonly file: string;
  /** Exactly one template is the generic fallback. */
  readonly fallback?: boolean;
}

export const RESUME_TEMPLATES: readonly ResumeTemplate[] = [
  // v3: WORK HISTORY. The LLM-led interview produces `experiences[]` — real jobs with a role,
  // a duration in the worker's own words, and what they did — and the v2 layouts had nowhere
  // to put it. For an industrial or skilled-trade résumé that list is the most important thing
  // on the page after the name and title, so it sits directly under the summary, above skills.
  // Also new: the `{{trade}}` and `{{expected_salary}}` slots and the `{{#preferred_locations}}`
  // region, plus the slot engine's first OBJECT region (`{{#experiences}}` with per-entry
  // `{{role}}`/`{{duration}}`/`{{work}}`).
  //
  // THE v1 AND v2 FILES STAY ON DISK, UNTOUCHED. A shipped version is immutable by this
  // registry's own contract, and a résumé row records the `template_id` it was rendered with —
  // so every PDF already issued keeps rendering identically. Only NEW renders pick up v3.
  { id: "classic", version: 3, label: "Classic (single column)", file: "classic.v3.html" },
  { id: "modern", version: 3, label: "Modern (two column)", file: "modern.v3.html" },
  { id: "minimal", version: 3, label: "Minimal (compact)", file: "minimal.v3.html" },
  {
    id: "fallback",
    version: 3,
    label: "Generic fallback",
    file: "fallback.v3.html",
    fallback: true,
  },
];

export const FALLBACK_TEMPLATE_ID = "fallback";

/**
 * Resolve a template by id. An unknown, empty, or missing id returns the generic
 * fallback — this never throws, so resume generation degrades instead of failing.
 */
export function getResumeTemplate(id?: string | null): ResumeTemplate {
  const found = id ? RESUME_TEMPLATES.find((t) => t.id === id) : undefined;
  return found ?? RESUME_TEMPLATES.find((t) => t.fallback)!;
}
