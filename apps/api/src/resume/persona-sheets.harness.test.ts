import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildResumeRenderInput, type TradeSheetContext } from "./resume-render-input";
import { LINE_MM, sheetContentLines, SHEET_LINE_BUDGET } from "./resume-degradation";
import { ResumeRenderer } from "./resume-renderer.service";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE PERSONA SHEET HARNESS (R7 §3) — five synthetic turners, rendered end to end.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IS REAL HERE. Every module this file calls is the shipped one:
 * `buildResumeRenderInput` (both branches, the degradation ladder inside it) and
 * `ResumeRenderer.buildResumeHtml` (the real `bb_trade.v1` template and slot engine). The
 * DraftProfile it feeds them is built from a REAL Gemini extraction — `scripts/persona-harness/
 * extract_personas.py` writes those artifacts, and this file refuses to run without them.
 *
 * WHAT IS NOT. There is no Nest container, no Postgres and no queue: the persona's employments
 * and chip answers are handed in directly, exactly as `resume-render.processor.ts` hands them in
 * after loading them. So this proves the MAPPER and the SHEET against real model output; it does
 * not prove the two repository reads that precede them, which have their own tests.
 *
 * WHY IT IS A TEST FILE AND NOT A SCRIPT. It needs the workspace's TS resolution and it must
 * never run in CI (it reads artifacts that only exist after a paid model run), which is exactly
 * the `RUN_DB_TESTS` shape already used by `turner-reach.db.test.ts`. It is a DRIVER wearing a
 * test's clothes, and the assertions in it are guards on the artifacts rather than a spec.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   # 1. the real extraction (costs money, needs a provider key)
 *   cd apps/ai-service && AI_SYNTHETIC_PERSONA_MODE="..." SKILL_CANONICALIZE_ENABLED=false \
 *     ./.venv/Scripts/python.exe ../../scripts/persona-harness/extract_personas.py
 *   # 2. the sheets
 *   RUN_PERSONA_SHEETS=1 pnpm --filter @badabhai/api run test persona-sheets
 *   # 3. the PDFs
 *   docker run --rm -v "$PWD/scripts/persona-harness/out:/w" -w /w bb-weasy:local \
 *     sh -c 'for f in *.html; do weasyprint "$f" "${f%.html}.pdf"; done'
 */

const HARNESS_DIR = join(__dirname, "../../../../scripts/persona-harness");
const OUT_DIR = join(HARNESS_DIR, "out");

interface Persona {
  id: string;
  label: string;
  full_name: string;
  phone: string;
  city: string;
  chips: Record<string, unknown>;
  transcript: [string, string][];
  employments: {
    employer_name: string;
    employer_city: string | null;
    employer_state: string | null;
    start_ym: string | null;
    end_ym: string | null;
    role_label: string;
    work_done: string | null;
  }[];
}

interface ExtractArtifact {
  persona_id: string;
  run: { is_mock: boolean; real_call: boolean; model_name: string | null };
  extract: Record<string, unknown>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The chip answers, in the shape `worker_attributes` hands the mapper. */
function attributesOf(persona: Persona): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(persona.chips)) out[key] = value;
  return out;
}

/**
 * The persona's employments in the repository's shape.
 *
 * ONE ROLE PER EMPLOYMENT, matching the Q1 ruling and the form that writes them. Persona 4's
 * promotion is therefore NOT expressible here, which is itself a result: see the gap table.
 */
function employmentsOf(persona: Persona): WorkerEmploymentRecord[] {
  return persona.employments.map((e) => ({
    employer: e.employer_name,
    employerCity: e.employer_city,
    employerState: e.employer_state,
    startYm: e.start_ym,
    endYm: e.end_ym,
    durationStated: e.start_ym !== null,
    roles: [
      {
        roleLabel: e.role_label,
        startYm: e.start_ym,
        endYm: e.end_ym,
        workDone: e.work_done,
      },
    ],
  }));
}

/**
 * The snapshot the mapper reads, assembled the way `profile-extraction.processor.ts` assembles
 * it — the model's flat keys scattered into the legacy storage shape, with the résumé container
 * carried through untouched beside them.
 *
 * DELIBERATELY NOT A PARAPHRASE OF THE PROCESSOR. The two places that matter are named: the
 * container is the model's own object with no merge applied, and the scatter below fills only
 * the legacy fields the container cannot. If the processor's own mapping changes, this diverges
 * — which is why the harness reports which BRANCH the mapper took for each persona rather than
 * assuming.
 */
/**
 * `option_key` → the `value_text` the pack actually STORES for the education question.
 *
 * NOT COSMETIC. `answer-capture` stores `value_text`, not the option key, and
 * `humanizeEducationLevel`'s vocabulary is keyed on `value_text` — so a harness that passed
 * `tenth` printed a raw lowercase "tenth" on the sheet and looked exactly like a product bug.
 * It was a harness bug. Mapping here keeps the harness honest about what the pipeline stores.
 */
const EDUCATION_VALUE_TEXT: Record<string, string> = {
  below_tenth: "below_10",
  tenth: "10",
  twelfth: "12",
  iti_diploma: "iti_diploma",
  graduate: "graduate",
};

function snapshotOf(extract: Record<string, unknown>, persona: Persona): Record<string, unknown> {
  const salary = extract.expected_salary as number | null;
  const educationKey = (persona.chips.education as string[] | undefined)?.[0];
  return {
    resume_profile: extract,
    education_level: educationKey ? (EDUCATION_VALUE_TEXT[educationKey] ?? educationKey) : null,
    education_field: null,
    certifications: [],
    salary_expectation: salary ? { amount_min: salary } : {},
    location_preference: {
      current_city: (extract.current_city as string | null) ?? persona.city,
      preferred_cities: (extract.preferred_locations as string[] | undefined) ?? [],
    },
    availability: { status: "unknown" },
    experience: { total_years: persona.chips.experience_years ?? null },
  };
}

const ENABLED = process.env.RUN_PERSONA_SHEETS === "1";

describe.skipIf(!ENABLED)("persona sheets — five synthetic turners, rendered (R7 §3)", () => {
  const personas = readJson<{ personas: Persona[] }>(join(HARNESS_DIR, "personas.json")).personas;
  const renderer = new ResumeRenderer(null as never);
  mkdirSync(OUT_DIR, { recursive: true });

  /**
   * THE SAME MANIFEST SHAPE `sheet-shape-emit` WRITES, so `measure-sheet-headroom.py` runs over
   * this directory unchanged and holds the personas to the SAME non-circular contract as the 56
   * fixtures: real page count, the 5 mm floor, and the estimator's prediction checked against
   * the millimetres WeasyPrint produced. Five real extractions are the only senior profiles in
   * the repo that nobody fitted the estimator to.
   */
  const manifest: Record<string, unknown>[] = [];

  it("has a REAL extraction artifact for every persona", () => {
    // THE HONESTY GATE, AND IT RUNS FIRST. A mock extraction produces a plausible-looking
    // profile out of nothing, and a sheet rendered from one would be indistinguishable from a
    // real result by eye. R7 §2 is explicit that this must fail loudly rather than proceed.
    const bad: string[] = [];
    for (const p of personas) {
      const a = readJson<ExtractArtifact>(join(OUT_DIR, `${p.id}.extract.json`));
      if (a.run.is_mock || !a.run.real_call) bad.push(`${p.id} (model=${a.run.model_name})`);
    }
    expect(bad, "these personas have no real model output; rerun the extraction").toEqual([]);
  });

  for (const persona of personas) {
    it(`renders ${persona.id} — ${persona.label}`, () => {
      const artifact = readJson<ExtractArtifact>(join(OUT_DIR, `${persona.id}.extract.json`));
      const tradeSheet: TradeSheetContext = {
        packId: "qp_cnc_turning",
        attributes: attributesOf(persona),
        phone: persona.phone,
        employments: employmentsOf(persona),
        // R8 §2/§4 — his own turns, verbatim, exactly as `WorkerTranscriptRepository` returns
        // them. The quote block and the over-claim veto both read this and nothing else.
        workerSaid: persona.transcript
          .filter(([role]) => role === "worker")
          .map(([, text]) => text),
        // A FIXED CLOCK. "Jan 2023 – Present · 3 yrs 6 mo" is computed against this, so a
        // harness without it would produce a different sheet every day and the diffs between
        // runs would be noise rather than signal.
        asOf: new Date("2026-08-28T00:00:00Z"),
        nameDevanagari: null,
        trustBadge: null,
        qrDataUri: null,
        qrCaption: "Scan to open this worker's live profile",
        shortLink: "badabhai.ai",
        footerMeta: `Generated 28 August 2026 · Self-declared · Ref ${persona.id.slice(0, 6).toUpperCase()}`,
      };

      const input = buildResumeRenderInput(
        snapshotOf(artifact.extract, persona),
        persona.full_name,
        // `bb_trade`, NOT `bb_trade.v1`. THE REGISTRY ID IS THE FORMER AND THE FILE IS THE
        // LATTER, and `getResumeTemplate` resolves an unknown id to the GENERIC FALLBACK rather
        // than throwing — deliberately, so a bad id degrades a résumé instead of failing it. The
        // R7 run passed the file name, so all five persona PDFs were rendered on `fallback.v3`
        // and reported as trade sheets. The assertions below could not see it: a name and a
        // length are true of both layouts. See the marker assertion in the render body.
        "bb_trade",
        null,
        false,
        "worker",
        tradeSheet,
      );
      const html = renderer.buildResumeHtml(input);
      writeFileSync(join(OUT_DIR, `${persona.id}.html`), html, "utf8");

      // A summary artifact, so the gap table is derived from what actually rendered rather
      // than from reading the HTML by eye.
      writeFileSync(
        join(OUT_DIR, `${persona.id}.render.json`),
        JSON.stringify(
          {
            persona: persona.id,
            headlineLine: input.headlineLine,
            subheadLine: input.subheadLine,
            capSectionTitle: input.capSectionTitle,
            capChipRows: input.capChipRows?.map((r) => `${r.label}: ${r.values.join(", ")}`),
            capTickRows: input.capTickRows?.map((r) => `${r.label}: ${r.values.join(", ")}`),
            capFactRows: input.capFactRows?.map((r) => `${r.label}: ${r.value}`),
            availFactRows: input.availFactRows?.map((r) => `${r.label}: ${r.value}`),
            qualFactRows: input.qualFactRows?.map((r) => `${r.label}: ${r.value}`),
            qualTickRows: input.qualTickRows?.map((r) => `${r.label}: ${r.values.join(", ")}`),
            employments: input.employments?.map((e) => ({
              employer: e.employer + (e.location_suffix ?? ""),
              when: e.when,
              roles: e.roles.map((r) => `${r.role} · ${r.when}`),
              roleInline: e.role_inline ?? null,
              work: e.work,
            })),
            employmentsMore: input.employmentsMore,
            ownWords: input.ownWords,
            experiences: input.experiences?.map((e) => `${e.role} · ${e.duration} · ${e.work}`),
            skills: input.skills,
            degradationStage: input.degradationStage,
            degradationDropped: input.degradationDropped,
            transcriptVetoes: input.transcriptVetoes,
            // R8 §3 — the ESTIMATOR'S OWN PREDICTION, written beside the sheet so the Docker
            // measurement can be read against it. Without this the two numbers live in two
            // places and "the ladder said stage 0" and "the PDF is two pages" never meet.
            contentLines: Number(sheetContentLines(input).toFixed(2)),
            predictedHeadroomMm: Number(
              ((SHEET_LINE_BUDGET - sheetContentLines(input)) * LINE_MM).toFixed(2),
            ),
          },
          null,
          2,
        ),
        "utf8",
      );

      expect(html).toContain(persona.full_name);
      // THE LAYOUT IS PART OF THE CLAIM, and asserting it is what R7 was missing. "The sheet
      // renders" was true of the fallback layout too, so five PDFs were produced, measured,
      // reported and delivered against the wrong template. These two markers exist only in
      // `bb_trade.v1.html`: the trade sheet's zone heading and its masthead wordmark.
      // Both are static text in `bb_trade.v1.html` and in no other layout: the quote block's
      // class, and the Work-history zone heading the stylesheet writes with `::before`. Read
      // from the STYLESHEET rather than from a rendered value, so the assertion holds for a
      // sparse worker whose every section collapsed.
      expect(html, "this is not the bb_trade sheet").toContain("sec-words");
      expect(html).toContain('.sec-work::before { content: "Work history"; }');

      manifest.push({
        file: `${persona.id}.html`,
        shape: persona.id,
        name: persona.label,
        audience: "worker",
        variant: "persona",
        stage: input.degradationStage ?? 0,
        dropped: input.degradationDropped ?? [],
        trace: input.degradationTrace ?? [],
        lines: Number(sheetContentLines(input).toFixed(2)),
        predictedHeadroomMm: Number(
          ((SHEET_LINE_BUDGET - sheetContentLines(input)) * LINE_MM).toFixed(2),
        ),
      });
      writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    });
  }
});
