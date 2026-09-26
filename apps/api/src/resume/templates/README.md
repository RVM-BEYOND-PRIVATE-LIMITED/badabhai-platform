# Resume layout templates (layer 1)

Pure HTML/CSS layout **skeletons** for the generated resume. **No AI, no data
binding, no render engine yet** — this is layer 1 (markup + a registry). A later
layer wires `resume_json` → the slots below → HTML/PDF and copies these assets
into the build.

## Files & registry

The LIVE version of each id (older `v<n>` files stay on disk, untouched):

| template_id | version | file | notes |
| ----------- | ------- | ---- | ----- |
| `classic`   | 3 | `classic.v3.html` | single column, serif, print-first — **selected for nobody since 2026-09-26**; renders rows already stored with it |
| `modern`    | 3 | `modern.v3.html`  | two column (sidebar + main) |
| `minimal`   | 3 | `minimal.v3.html` | compact, label/value rows |
| `fallback`  | 3 | `fallback.v3.html` | **generic fallback** — plain, robust, sparse-data safe |
| `bb_trade`  | 2 | `bb_trade.v2.html` | **the locked BadaBhai trade sheet** — the **21 predefined roles**; see below |
| `bb_general` | 1 | `bb_general.v1.html` | **the BadaBhai general sheet** — **every other pack, and no pack**; see below |

Which id a worker gets is `templateIdForPack` in `../resume-document.ts`, decided once at
generation and stored on the row; every re-render and employer disclosure reuses the stored id —
with one upgrade, `renderTemplateId`: a stored `bb_general` renders as `bb_trade` once the
worker's elected pack is one of the 21 (he took a role form after his last generation). Never the
other way.

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

**`bb_trade.v1` is the standing exception, and the reason is mechanical rather than a licence.**
`getResumeTemplate` resolves by **id only** — the registry holds one entry per id (see `classic`,
whose v1/v2 files sit on disk while every render takes v3) — so a `bb_trade.v2` would re-point
every existing `bb_trade` row at the new file exactly as an in-place edit does. It buys no
isolation, and costs a 400-line duplicate plus a second copy of every structural guard. So this
sheet is amended in place while it is pre-production, ADDITIVELY: #1403 added the `emp-more`
region, the 2026-09-08 ruling added `{{location_line}}`, and both collapse when their slot is
empty, so any sheet that does not supply them renders byte-identically. #1547 replaced the
uppercase text mark with the brand lockup, and a later owner correction put the same lockup on
the masthead stripe: the mark is the app's own SHIPPED artwork (embedded as a PNG data URI —
no vector of it exists, and the design-system SVG is a slimmer variant that blobs into one
shape at this print size) plus the mixed-case "BadaBhai" on the left, the "BADABHAI बड़ाभाई"
lockup on the right — on **both** v1 and v2, since the owner required the twins to match; it
adds no slot and the QR/caption/link/meta/disclaimer are untouched. The day a stored resume
must be re-renderable exactly as issued, that guarantee needs version-aware resolution in
`registry.ts` — not a v2 file, which would not deliver it.

## Privacy

No contact PII (phone/address/employer) appears in `classic`, `modern`, `minimal`
or `fallback` — only `{{full_name}}`. **Keep it that way for those four.**

`bb_trade` is the documented exception and the scope of the rule is now per-template,
not global. **`bb_general` carries the same exception on the same terms** — every bullet below
applies to it too. That is not new exposure: until `bb_general` existed, the same workers'
résumés rendered through `bb_trade` and printed all of it.

- **Phone renders**, on *both* the worker copy and the employer disclosure (owner
  ruling 2026-08-28). A sheet handed over at a factory gate is useless without a
  number. The protections that remain mandatory are the short-TTL signed URL and the
  absence of any bulk/list route.
- **Employer names render.** The value is captured by a worker-typed pack question and
  written straight to Postgres; it never passes through the AI service, whose
  pseudonymisation gateway still masks employers on every call.
- **The worker's registered city and state render** under the name, on both audiences (owner
  ruling 2026-09-08). `workers.current_city` / `current_state` are plaintext columns by an earlier
  ruling — "cities as PII (→ a 20-point matching input; never redact)", 2026-07-31 — and the
  Verdict Line has printed a city on both copies since this sheet shipped. Coarse by construction:
  the columns hold a city and a state, never an address, a pincode or a coordinate. Both halves go
  through `cleanScalar` on the way to the page, because the write side accepts free text — screen
  one of onboarding may not refuse a worker whose city is outside the 36-hub gazetteer — so an
  email shape or a 7+ digit run drops its half instead of printing on the employer's copy.
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
| `{{whatsapp_line}}` | scalar | **v2.** "WhatsApp: +91 98765 43210" under the location line, **worker copy only** (ADR-0042 D9 / Layer A (a)): composed by `composeWhatsappLine` from `workers.whatsapp_enc` (decrypted by the render worker) and forced null on the employer audience by the mapper. Collapses when no number is on file. |
| `{{location_line}}` | scalar | "Faridabad, Haryana" under the name, 9pt (owner ruling 2026-09-08). Composed by `buildLocationLine` from `workers.current_city` / `current_state` — the worker's own registration answer, **not** the snapshot's `{{location}}`. Collapses when he gave neither. |
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

**THE MASTHEAD GAINED A LINE AFTER THIS MEASUREMENT (owner ruling 2026-09-08).** `{{location_line}}`
prints for every worker who registered a city, and the 68 renders above predate it. It has NOT been
re-rendered; what follows is the line model, not WeasyPrint.

The charge is one line. Measured from the stylesheet: `.loc` is 9 pt inheriting `line-height: 1.32`
= 11.88 pt = 4.19 mm, plus `margin-top: 0.8 mm` = **4.99 mm** against the body line's 4.89 — an
under-count of 0.10 mm, ~2% of a line, two orders of magnitude inside the 5 mm headroom floor.

**Only shape 1 carries the fields in the fixtures**, so the matrix still measures the sheets these
68 renders measured. The production delta is asserted separately, in `sheet-shape-matrix.test.ts`
("the masthead location line's cost to the page"), which re-measures all fourteen shapes WITH the
line. Three cross from one page to two, all of them synthetic stress shapes sitting at 40.19 lines:

| sheet | before | with the line | why |
| --- | --- | --- | --- |
| `shape-11-worker` | 40.19, fits | 41.19, spills | nine employers; 0.81 lines of headroom was all it had |
| `shape-05-employer` | fitted at stage 1 | spills at stage 0 | the "employers beyond three" collapse used to reach 41.19 exactly; now it cannot buy the page, so under the 2026-09-03 ruling the collapse is discarded and the sheet goes back uncompressed |
| `shape-06-employer` | fitted at stage 1 | spills at stage 0 | same |

The ratified corpus is unaffected — the real personas measure 24–37 lines against the 41-line
budget — so this is confined to dense multi-employer profiles, which is what shapes 5, 6 and 11
exist to represent, and it is the outcome the 2026-09-03 ruling prescribes rather than a defect.

**`SHEET_LINE_BUDGET` was deliberately NOT raised on this evidence.** The measurement is 68
fixtures on one font stack, and the cost of the two disagreements is a needless second page —
cosmetic, and no content is lost. The cost of raising the budget and being wrong is a sheet
that overflows unpredictably. A conservative budget fails in the direction that keeps the
worker's résumé intact, so it stays until there is a reason better than "we found 2 lines".

**Re-running it.** Emit with `EMIT_SHEETS=<dir> npx vitest run src/resume/sheet-shape-emit`,
then render the directory with the recipe above; count pages through the WeasyPrint API
rather than a PDF page-object grep, which miscounts.

## `bb_general` — the general sheet

The owner's format of 2026-09-25 ("Standard Professional Resume Template v3") for every worker
whose pack is **not** one of the 21 predefined roles (`ROLE_FORM_DESCRIPTORS`) — the universal
fallback pack and every family pack without a trade form. Until it existed these workers rendered
through `bb_trade` with its capability section collapsed; the 21 roles keep `bb_trade` unchanged.

**A profile with no pack at all gets it too (2026-09-26).** The first release sent a null pack to
`classic`, on the assumption that pack-less profiles were legacy rows. They are not: a chat
interview for a role outside the taxonomy writes its answers with no `pack_id`, and the first
production résumé after release — a "Captain", seven attribute rows, every one pack-less — came
out in the old serif `classic` layout. `classic` is now selected for nobody.

**A layout change, not a data change.** It reads only slots the renderer already fills for every
template. Nothing in the mapper, the row composers or their separators changed for it, so the
parts of the sample the data does not carry are absent rather than approximated: there is no
summary paragraph (no prose source exists), no skill categories (the Skills rows are the worker's
own `skills` / `machines` / `controllers` lists), and separators are the mapper's own
("Employer · City", "Generated … · Ref …", certificates joined in one row).

Layout, top to bottom: navy band with the lockup at the **left**; name (22pt) with the phone on the
right; location line; WhatsApp line (worker copy only); the verdict line's first line as the
headline; then grey section bars — **Skills**, **Availability & Terms**, **Work History**,
**Education**, **Certifications & Training** — and the footer (framed QR, mark, caption, link,
reference, disclaimer). A faint diagonal "BADABHAI" watermark sits behind every page.

**Skills prints the worker's full `skills` / `machines` / `controllers` lists on both audiences**
— `bb_trade` showed at most three of them, in the headline. Both mapper paths therefore screen
those lists with `cleanList` (blanks, email shapes and 7+ digit runs drop); the legacy path did
not until this sheet made it matter.

Not printed, because the format has no place for them and each fact is on the page already: the
verdict **subhead** (city, availability, pay — all Availability & Terms rows) and the **own words**
quotes (the same sentences the Work History entries print).

### How the qualification rows are split

The qualification rows arrive as ONE list (Education, Certificates, Training, Languages spoken)
and the format spreads them over three sections. The slot engine has no filter, so the region is
repeated in each section and CSS keeps each section's own rows by `data-label`. Routing defaults
to **visible**: Education keeps Education, Availability keeps Languages spoken, and Certifications
& Training keeps everything else — so a label added later prints there with its label rather than
nowhere. Because hidden rows are still child nodes, those sections cannot use `.sec:empty`; their
heading rides the first visible row (`::before`) and is withdrawn from later rows by sibling
combinators. `bb-general-template.test.ts` pins the routed labels against `buildQualificationRows`.

### Print details

- **Watermark:** the word as SVG outlines in the `@page` background, 159.5 mm square and
  `#f6f6f6` — both measured off the owner's PDF. Outlines, not text, so nothing enters the text layer that résumé re-import and an
  employer's ATS read. It repeats on every page and costs no layout.
- **QR:** 18 mm, as on `bb_trade`, inside the sample's 1.5pt black frame, whose 2.9 mm white
  padding (every edge) is the four-module quiet zone (the symbol is generated with no margin of its own). Pinned in
  `sheet-qr.gate.test.ts`.
- **Type:** the sample's sizes (body 10pt, name 22pt, bars 11pt); margins stay at 12mm, not the
  sample's 7.4mm, because gate-desk printers clip.
- **Footer flows:** nothing is positioned, so a two-page sheet ends with its footer on page 2.

### Rendered — 2026-09-25, WeasyPrint 69.0

`EMIT_GENERAL_SHEETS=<dir> npx vitest run src/resume/bb-general-sheet` writes 4 generalized
personas (chat-road jobs, employer records, sparse, and a legacy-path worker with skills,
machines and two PII-shaped entries) and all 14 `SHEET_SHAPES`, each for both audiences — 36
sheets. Every one was rendered and its **text layer** checked: each qualification
value prints exactly once, no section heading prints twice or with nothing under it, and
"BADABHAI" never appears in extracted text.

All eight persona sheets are **one page**; the masthead band measures 19.9pt against the
sample's 19.5pt. Seven synthetic stress sheets spill to two (shapes 5, 6 and 9 on both audiences,
11 on the worker copy) — every one a fully-answered CNC form pack whose capability rows a
`bb_general` sheet never carries in production (`renderTemplateId` sends such a worker to
`bb_trade`). A spilled sheet takes its last section onto page 2 with the footer.

**The line model is `bb_trade`'s and is not calibrated to this layout.** It predicted one page for
three of those spills (40.19 lines each: shapes 5 and 6 employer, 11 worker). Its only effects
are the spill warning in the render log and the "employers beyond three" collapse, which may
therefore not fire where it would have bought the page; the sheet spills instead, which the
2026-09-03 ruling accepts. The history card's page count is measured from the PDF and is exact.

### Rolling back

Revert the routing, not the template: point `templateIdForPack` back at `bb_trade` and keep the
`bb_general` registry entry and file. Rows already stored as `bb_general` keep rendering as
issued. Deleting the registry entry instead sends those rows to `fallback.v3` — no phone, no
employer blocks, no QR — on every re-render and employer disclosure; if it must go, first
`UPDATE generated_resumes SET template_id = 'bb_trade' WHERE template_id = 'bb_general'`, which
renders them exactly as these workers' sheets rendered before (bar the three skill lists).
