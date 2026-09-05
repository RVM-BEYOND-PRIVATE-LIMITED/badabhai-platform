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

Then confirm the page count — but confirm it **against what the sheet said it would be**,
not against a flat "one page". A structural test cannot do this at all: page count is a
layout outcome and the Node test environment has no renderer.

Since the owner ruling of 2026-09-03 the invariant is **one page unless preserving a
row the ratified corpus prints required two**. So read the render input's two degradation
fields first, then check the PDF against them:

| `degradationOverflows` | expected pages | a different result means |
| --- | --- | --- |
| `false` | 1 | the line model under-counts — `SHEET_LINE_BUDGET` or the per-row costs in `resume-degradation.ts` are wrong |
| `true` | 2 | 1 page means the model over-counts (the sheet was spilled needlessly); 3+ means content has grown far past anything measured |

`degradationOverBudgetLines` says by how much, in lines of 4.89 mm. The corpus's worst is
under 3.2 lines, so a spilling sheet should show only a little content on page 2.

### CONFIRMED BY A REAL RENDER — 2026-09-05

This section used to say "not yet confirmed by a real render". It has now been done, on
**WeasyPrint 69.0** in a container carrying the same native stack `apps/api/Dockerfile`
installs (Pango/cairo + `fonts-noto-core` — the font package is load-bearing, see above).
Page counts come from `len(HTML(...).render().pages)`, not from eyeballing a viewer.

**68 sheets rendered, 0 in the dangerous direction.**

| set | sheets | result |
| --- | --- | --- |
| the 6 shipped roles, at persona AND widest answers | 12 | predicted 1 page, **rendered 1** — all 12 |
| `SHEET_SHAPES` × both audiences × shape/future | 56 | 42 predicted 1 and rendered 1; 12 predicted 2 and **rendered 2** |

**The two-page branch works.** Twelve spilling sheets were rendered and every one produced
exactly two pages, with the footer flowing to the end of the last page as the template
intends. That is the behaviour the owner's 2026-09-03 ruling depends on, and it had never
been executed.

**The model NEVER under-counts.** Not one sheet rendered MORE pages than predicted, which is
the failure that would matter: a sheet that spills when the model said it would not is
content arriving where nobody checked it.

**It over-counts slightly, twice, and that is the safe direction.** Two sheets predicted to
spill fitted on one page after all:

| sheet | lines | over budget | rendered |
| --- | --- | --- | --- |
| `shape-05-worker` | 43.19 | 2.19 | **1 page** |
| `shape-09-employer` | 42.93 | 1.93 | **1 page** |

So the real budget is **at least ~43.2 lines** for the worker audience, against the fitted
`SHEET_LINE_BUDGET = 41`. Everything at or under 41 is safe with margin; a sheet between 41
and ~43 may take a second page it did not need.

**`SHEET_LINE_BUDGET` was deliberately NOT raised on this evidence.** The measurement is 68
fixtures on one font stack, and the cost of the two disagreements is a needless second page —
cosmetic, and no content is lost. The cost of raising the budget and being wrong is a sheet
that overflows unpredictably. A conservative budget fails in the direction that keeps the
worker's résumé intact, so it stays until there is a reason better than "we found 2 lines".

**Re-running it.** Emit with `EMIT_SHEETS=<dir> npx vitest run src/resume/sheet-shape-emit`,
then render the directory with the recipe above; count pages through the WeasyPrint API
rather than a PDF page-object grep, which miscounts.
