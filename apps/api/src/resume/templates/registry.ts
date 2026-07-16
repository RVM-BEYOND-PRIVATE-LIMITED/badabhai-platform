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
  // v2 (ADR-0032): adds the {{#photo}} region — the worker's OWN photo, 0-or-1
  // items, collapses when absent (masked disclosures always pass no photo). The
  // v1 files stay on disk untouched (shipped versions are immutable); already-
  // rendered PDFs are never re-rendered (renderStatus idempotency).
  { id: "classic", version: 2, label: "Classic (single column)", file: "classic.v2.html" },
  { id: "modern", version: 2, label: "Modern (two column)", file: "modern.v2.html" },
  { id: "minimal", version: 2, label: "Minimal (compact)", file: "minimal.v2.html" },
  {
    id: "fallback",
    version: 2,
    label: "Generic fallback",
    file: "fallback.v2.html",
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
