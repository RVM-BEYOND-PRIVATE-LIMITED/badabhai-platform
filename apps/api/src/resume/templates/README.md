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
| `bb_trade`  | 1 | `bb_trade.v1.html` | **the locked BadaBhai trade sheet** — see below |

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
- `{{#education_headline}}` — 0-or-1-item leading Education line (level + field, e.g.
  "12th — Electronics"); collapses when both are null

The token syntax is mustache-style and documents the slots; the actual renderer
(and its escaping rules) is a later layer. **The renderer MUST output-encode every
slot** — `{{full_name}}` is attacker-controlled worker input (see risk R11).

## Versioning

A shipped `<id>.v<n>.html` is immutable. To change a layout, add
`<id>.v<n+1>.html` + a registry entry; don't mutate a version in use, so resumes
that recorded an older `template_id`+version keep rendering identically.

## Privacy

No contact PII (phone/address/employer) appears in `classic`, `modern`, `minimal`
or `fallback` — only `{{full_name}}`. **Keep it that way for those four.**

`bb_trade` is the documented exception and the scope of the rule is now per-template,
not global:

- **Phone renders**, on *both* the worker copy and the employer disclosure (owner
  ruling 2026-08-28). A sheet handed over at a factory gate is useless without a
  number. The protections that remain mandatory are the short-TTL signed URL and the
  absence of any bulk/list route.
- **Employer names render.** The value is captured by a worker-typed pack question and
  written straight to Postgres; it never passes through the AI service, whose
  pseudonymisation gateway still masks employers on every call.
- **Address and email still never render**, on any template. Nor does an unmasked phone
  number on the *public web profile* — a different surface, and that prohibition is
  absolute.

## `bb_trade` — the locked trade sheet

One A4 page, one column, section order fixed by the Resume Engine Design Guideline
v1.0 (Terms deliberately sits **above** Work history). Additional slots beyond the
contract above:

| slot | kind | notes |
| ---- | ---- | ----- |
| `{{phone}}`, `{{name_devanagari}}`, `{{trust_badge}}` | scalar | badge collapses when absent; no tier is hardcoded |
| `{{headline_line}}`, `{{subhead_line}}` | scalar | the two-line Verdict Line, composed by the mapper |
| `{{cap_section_title}}` | **attribute** | per-trade heading, read back via `attr(data-title)` |
| `{{#cap_chip_rows}}`, `{{#cap_tick_rows}}`, `{{#cap_fact_rows}}` | object regions | `{{label}}` + `{{#values}}` / `{{value}}` |
| `{{#avail_fact_rows}}`, `{{#qual_fact_rows}}`, `{{#qual_tick_rows}}` | object regions | same shape |
| `{{#own_words}}` | string region | verbatim Hinglish, never composed |
| `{{#employments}}` → `{{#roles}}` | **nested** object region | two-level work history |
| `{{employments_more}}` | scalar | the overflow tail, e.g. "2 earlier employers · 22 months total" |
| `{{#qr}}`, `{{qr_caption}}`, `{{short_link}}`, `{{footer_meta}}` | scalar / 0-or-1 | QR is a `data:` URI |

### Binding constraints (guideline §6.3) — enforced by `bb-trade-template.test.ts`

One column · one page · body ≥ **10.5pt** · name ≥ **18pt** · section label ≥ **9pt**
uppercase letter-spaced · margins ≥ **12mm** · rules ≥ **0.5pt** · no information
carried by colour alone · fonts embedded · target < 300 KB.

**Sizes are in `pt`, and that is enforced.** An earlier draft was authored in `px` and
sat at 7.6pt body / 16.5pt name — below two floors at once and invisible as such,
because `px` hides the floors behind WeasyPrint's 0.75 conversion.

### Skins

The guideline specifies one HTML + one CSS + a custom-property set per skin. `:root`
in `bb_trade.v1.html` is **Neela** (navy bar, navy section labels, filled chips).
Adding *Saada* / *Kaagaz* / *Loha* is a replacement token block — no new markup and
no new template id. Never hard-code a colour outside `:root`.

### Verifying a change

WeasyPrint is not installed on a bare Windows/macOS host. To see a real PDF:

```bash
docker build -t bb-weasy:local <dir with a weasyprint Dockerfile>
docker run --rm -v "<abs-dir>:/work" bb-weasy:local weasyprint /work/sheet.html /work/sheet.pdf
```

Then confirm it is **one page**. A structural test cannot: page count is a layout
outcome, and the Node test environment has no renderer.
