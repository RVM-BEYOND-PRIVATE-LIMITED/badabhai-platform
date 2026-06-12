# Resume layout templates (layer 1)

Pure HTML/CSS layout **skeletons** for the generated resume. **No AI, no data
binding, no render engine yet** — this is layer 1 (markup + a registry). A later
layer wires `resume_json` → the slots below → HTML/PDF and copies these assets
into the build.

## Files & registry

| template_id | version | file | notes |
| ----------- | ------- | ---- | ----- |
| `classic`   | 1 | `classic.v1.html` | single column, serif, print-first |
| `modern`    | 1 | `modern.v1.html`  | two column (sidebar + main) |
| `minimal`   | 1 | `minimal.v1.html` | compact, label/value rows |
| `fallback`  | 1 | `fallback.v1.html` | **generic fallback** — plain, robust, sparse-data safe |

[`registry.ts`](./registry.ts) is the source of truth. `getResumeTemplate(id)`
resolves a stable `template_id` and returns the **fallback** for any unknown /
empty id (never throws).

## Slot contract

Single-value slots — `{{token}}`:

- `{{full_name}}` — the only PII on the resume; injected server-side **after** the
  AI call (TD21), so it never reaches the LLM. May be empty.
- `{{headline}}` — role title (e.g. "VMC Operator")
- `{{summary}}` — short professional summary
- `{{experience_years}}`, `{{location}}`, `{{availability}}`

Repeat regions — `{{#list}}…{{.}}…{{/list}}`:

- `{{#machines}}`, `{{#skills}}`, `{{#controllers}}`, `{{#education}}`, `{{#certifications}}`

The token syntax is mustache-style and documents the slots; the actual renderer
(and its escaping rules) is a later layer. **The renderer MUST output-encode every
slot** — `{{full_name}}` is attacker-controlled worker input (see risk R11).

## Versioning

A shipped `<id>.v<n>.html` is immutable. To change a layout, add
`<id>.v<n+1>.html` + a registry entry; don't mutate a version in use, so resumes
that recorded an older `template_id`+version keep rendering identically.

## Privacy

No contact PII (phone/address/employer) appears in any template — only
`{{full_name}}`. Keep it that way.
