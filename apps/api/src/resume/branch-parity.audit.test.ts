import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildResumeRenderInput } from "./resume-render-input";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO SOURCE BRANCHES MUST HAND THE RENDERER THE SAME SHAPE (R14 §1).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT THE THREE BUGS IT WAS BORN FROM. `buildUndegraded` has
 * two return paths — the résumé container (`fromResumeProfile`) and the legacy answer-map shape
 * — and a worker reaches one or the other depending on whether their LLM interview ran. Three
 * defects have been found on that seam, one per packet, each by a different question:
 *
 *     R12 §1.4  the Verdict Line's `salary` was a literal `null` on the legacy branch while the
 *               row beneath it printed the figure. Found by a test written to prove the OPPOSITE.
 *     R13 §2    `legacy.years` could be silenced with the whole suite green — four of six
 *               segments could, and seven of twelve call-site mutations survived.
 *     R13 §2    `axes` is accepted by `buildVerdictLine` and passed by NEITHER branch, so a
 *               headline segment the slot contract has documented since the sheet shipped has
 *               never rendered for anybody.
 *
 * Three instances of one class, found three times over. THE CLASS IS: a fact that reaches the
 * page by two independent paths, wired on one of them. Finding the fourth by waiting for someone
 * to ask the right question is not a strategy, so this enumerates the whole seam mechanically.
 *
 * TWO HALVES, AND BOTH ARE NECESSARY.
 *
 *   STATIC — parse the two return literals and the argument objects of every builder they share,
 *   and require the field sets to be identical. This is what catches a field ADDED to one branch
 *   and forgotten on the other, which is how all three arrived.
 *
 *   RUNTIME — build a maximal draft down each branch and assert what actually comes out. This is
 *   what catches a field that is present on both branches and hard-coded on one, which is what
 *   `salary` was: structurally identical, semantically absent.
 *
 * EVERY EXCEPTION IS A ROW WITH A REASON, and a stale row fails this file just as loudly as a
 * new asymmetry does — see "no allowlist entry may go stale". An allowlist that outlives its
 * subject is the ledger nobody reads, which is the failure `scripts/list-open-pins.mjs` exists
 * for one layer up.
 *
 * THE FOURTH SHAPE, WHICH THE STATIC HALF CANNOT SEE, and it is named here rather than left for
 * someone to trust the gate blindly. Three shapes are catchable by reading the source: a field
 * ABSENT on one branch, a field STUBBED to a bare literal on one branch, and a parameter a
 * builder accepts that NEITHER branch passes. The fourth is a field that is present and derived
 * on both branches from DIFFERENT sources, one of them thinner — `experiences` is exactly that,
 * and the staleness check refused the allowlist row for it, correctly. Nothing static can rule
 * on whether two different expressions carry the same fact, so that shape is held by the runtime
 * probes below and by nothing else. A green static half is not a claim that the seam is whole.
 */

const SOURCE = readFileSync(join(__dirname, "resume-render-input.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────────────────
// A source reader, not a TypeScript compiler
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Blank out comments and string bodies, preserving offsets.
 *
 * WHY BLANK RATHER THAN DELETE: this file's comments are longer than its code and several of
 * them contain braces and the word `null`. Deleting would shift every offset; replacing each
 * character with a space keeps `indexOf` anchors meaningful and makes the brace counting below
 * see code only.
 */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (inBlock) {
      if (two === "*/") {
        inBlock = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += text[i] === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (two === "/*") {
      inBlock = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (two === "//") {
      const nl = text.indexOf("\n", i);
      const stop = nl === -1 ? text.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") {
          out += " ";
          i += 1;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const CODE = codeOnly(SOURCE);

/** The body of the object/type literal opening at the first `{` at or after `from`. */
function literalAt(code: string, from: number): string {
  const open = code.indexOf("{", from);
  expect(open, "no object literal after the anchor").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced literal");
}

interface Field {
  readonly name: string;
  /** The right-hand side, whitespace-collapsed. For shorthand, the name itself. */
  readonly expr: string;
}

/** Top-level members of an object literal or a type literal. Splits on `,` AND `;` at depth 0. */
function fieldsOf(body: string): Field[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if ("{[(".includes(c)) depth += 1;
    else if ("}])".includes(c)) depth -= 1;
    else if ((c === "," || c === ";") && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  const fields: Field[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith("...")) continue; // spreads are resolved by the caller
    const named = /^(readonly\s+)?([A-Za-z_$][\w$]*)\??\s*(?::([\s\S]*))?$/.exec(part);
    if (!named) continue;
    const name = named[2]!;
    const expr = (named[3] ?? name).replace(/\s+/g, " ").trim();
    fields.push({ name, expr });
  }
  return fields;
}

/**
 * Is this expression a LITERAL EMPTY rather than something derived from the worker's data?
 *
 * THE PREDICATE IS THE WHOLE POINT OF THE STATIC HALF. `salary: null` and `salary: legacySalary`
 * are indistinguishable to a field-name diff and are the entire difference between a résumé that
 * carries the worker's asking price and one that does not.
 */
function isLiteralEmpty(expr: string): boolean {
  return ["null", "[]", "{}", '""', "''", "0", "false"].includes(expr);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The two branches, and the builders they share
// ─────────────────────────────────────────────────────────────────────────────────────────

const LEGACY_ANCHOR = CODE.indexOf("return {", CODE.indexOf("const legacySalary ="));
const CONTAINER_ANCHOR = CODE.indexOf("return {", CODE.indexOf("function fromResumeProfile"));
const SHARED_ANCHOR = CODE.indexOf("const capabilitySlots =");

const LEGACY_BODY = literalAt(CODE, LEGACY_ANCHOR);
const CONTAINER_BODY = literalAt(CODE, CONTAINER_ANCHOR);
const SHARED_BODY = literalAt(CODE, SHARED_ANCHOR);

/** The builders both branches call with a composed argument object. */
const SHARED_BUILDERS = [
  "buildVerdictLine",
  "buildAvailabilityRows",
  "buildQualificationRows",
] as const;
type SharedBuilder = (typeof SHARED_BUILDERS)[number];

function builderArgs(branchBody: string, builder: SharedBuilder): Field[] {
  const at = branchBody.indexOf(`${builder}(`);
  expect(at, `${builder} is not called on this branch`).toBeGreaterThan(-1);
  return fieldsOf(literalAt(branchBody, at));
}

const ROWS_SOURCE = codeOnly(readFileSync(join(__dirname, "resume-sheet-rows.ts"), "utf8"));

/** The parameters a builder ACCEPTS — the other direction, and where `axes` hides. */
function builderParams(builder: SharedBuilder): Field[] {
  const at = ROWS_SOURCE.indexOf(`export function ${builder}(`);
  expect(at, `${builder} is not exported from resume-sheet-rows.ts`).toBeGreaterThan(-1);
  return fieldsOf(literalAt(ROWS_SOURCE, at));
}

/** The two source paths, named once. The bodies are read through the constants above. */
type Branch = "legacy" | "container";

// ─────────────────────────────────────────────────────────────────────────────────────────
// The allowlist — every known asymmetry, each with the reason it is allowed to stand
// ─────────────────────────────────────────────────────────────────────────────────────────

interface Allowed {
  /** Which branch is the one carrying nothing. `both` = neither branch supplies it. */
  readonly starved: Branch | "both";
  /** Why this is not a defect, or what ruling holds it open. */
  readonly reason: string;
}

/**
 * KEYED `<scope>.<field>`, where scope is `return` or the builder name.
 *
 * THE R14 §1 DELTA, IN FULL. Eleven asymmetries across the seam, of which three were already
 * known. Every row here was measured — by the runtime probes at the bottom of this file, or by
 * reading the writer that makes the field unreachable — never inferred from the shape of the
 * code.
 */
const ALLOWED: Readonly<Record<string, Allowed>> = {
  // ── OWNER-RULED, 2026-08-12: an accepted TEMPORARY loss ────────────────────────────────
  //
  // `ResumeProfileSchema`'s own docstring records it: "Education, certifications, languages,
  // tools and relocation are captured by the template tail and live on `DraftProfile` — they
  // are NOT rendered from here, and that is an accepted, temporary loss (owner decision
  // 2026-08-12): the pipeline is being proven end-to-end on a narrow field set first."
  //
  // MEASURED CONSEQUENCE, because "temporary loss" understates it and the probe below prints
  // the number: on `classic.v3` — the template `resume.service.ts` names for every production
  // render — an interview-led worker's `{{#machines}}`, `{{#education}}`, `{{#certifications}}`
  // and `{{#education_headline}}` regions ALL collapse, while the same draft renders them for a
  // worker whose interview never ran. The Education & Certifications section is empty for the
  // NEWER path.
  //
  // AND THE RULING IS ALREADY BEING UNWOUND PIECEMEAL, which is the part worth a ruling of its
  // own: R9's `qualFactRows` reads `draftQualification.certifications` and the composed
  // `educationHeadline` on this very branch, so Zone 5 of `bb_trade` prints the certificates
  // that `classic.v3`'s scalar slot two lines below does not. One source, two answers.
  "return.machines": {
    starved: "container",
    reason: "owner ruling 2026-08-12 — narrow field set first",
  },
  "return.education": {
    starved: "container",
    reason: "owner ruling 2026-08-12 — narrow field set first",
  },
  "return.certifications": {
    starved: "container",
    reason: "owner ruling 2026-08-12; NOTE qualFactRows on this same branch already reads it",
  },
  "return.educationLevel": { starved: "container", reason: "owner ruling 2026-08-12" },
  "return.educationField": { starved: "container", reason: "owner ruling 2026-08-12" },

  // ── NO SOURCE ON THE STARVED BRANCH ────────────────────────────────────────────────────
  //
  // `responsibilities` is TRADE-level copy keyed by a canonical taxonomy id, and
  // `toExtractionOutput` hardcodes both canonical ids to null on the interview-led path — so
  // `resolveTradeContent` returns undefined for every container-branch profile that exists.
  // Correctly empty, and it would stay empty even if the draft were threaded in.
  "return.responsibilities": {
    starved: "container",
    reason: "trade copy is keyed by a canonical id the OIE path never writes",
  },
  // §8.4's verbatim quotes. The candidates are `experiences[].work_done`, and the container is
  // the only shape that carries them — see `return.experiences` below for why the legacy branch
  // can never hold one.
  "return.ownWords": {
    starved: "legacy",
    reason: "candidates are resume_profile.experiences[].work_done",
  },
  "return.ownWordsRejected": { starved: "legacy", reason: "the other half of the same selection" },

  // `return.experiences` IS DELIBERATELY NOT HERE, and its absence is the honest record of what
  // the static half cannot see — see "THE FOURTH SHAPE" in the header. It is on both branches
  // and neither expression is a bare literal, so nothing above flags it; the legacy branch
  // simply reads a THINNER source (`fresherRows`, never `draft.experiences`). Only the runtime
  // probe "the legacy branch drops a populated draft.experiences" holds that line.

  // ── THE THIRD SALARY INSTANCE, AND ITS TWIN. REPORTED, NOT FIXED (R14 §1) ─────────────
  //
  // Both have a source in scope and both are hard-coded. `legacySalary` is computed forty lines
  // above and is already audience-gated; `draft.location_preference.preferred_cities` is read by
  // `buildAvailabilityRows` in the same object literal. Measured, on `classic.v3`:
  //
  //     preferredLocations  []    while  availFactRows prints "Preferred locations: Gurugram, Noida"
  //     expectedSalary      null  while  subheadLine  prints "expects ₹24,000 – ₹28,000 / month"
  //
  // R12 §1.4 fixed exactly this shape one slot over and R13 §2 gave every collapse rule its
  // other half; neither looked at the scalars. They are held open here rather than fixed because
  // R14 §1 says report the size of it first — see the two `it.fails` at the bottom, which are
  // the executable form of this paragraph and go GREEN the day someone wires them.
  "return.preferredLocations": {
    starved: "legacy",
    reason: "R14 §1 — reported, awaiting the word; source is draft.location_preference",
  },
  "return.expectedSalary": {
    starved: "legacy",
    reason: "R14 §1 — reported, awaiting the word; source is legacySalary's own inputs",
  },

  // ── ACCEPTED BY THE BUILDER, PASSED BY NEITHER ────────────────────────────────────────
  //
  // R13 §2's third finding. There is no turner axis question, so it is correctly empty for every
  // worker who exists today; it stops being correct the moment a milling pack ships, which is
  // what `yadav-parity.contract.test.ts:577` pins.
  "buildVerdictLine.axes": {
    starved: "both",
    reason: "no pack asks for axes yet — pinned in verdict-line-collapse.render.test.ts",
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────

describe("R14 §1 — the two source branches hand the renderer the same shape", () => {
  it("the reader actually parsed both branches", () => {
    // THE VACUITY CHECK, WRITTEN FIRST. Every assertion below is of the form "nothing was
    // found", and an `indexOf` that missed would satisfy all of them in silence. This is the
    // one that turns a broken reader into a red suite.
    const legacy = fieldsOf(LEGACY_BODY);
    const container = fieldsOf(CONTAINER_BODY);
    expect(legacy.length, "legacy return literal").toBeGreaterThan(20);
    expect(container.length, "container return literal").toBeGreaterThan(20);
    expect(fieldsOf(SHARED_BODY).length, "shared capabilitySlots").toBeGreaterThan(10);
    // Anchored on real content, not just a count: these three are the seam's own history.
    expect(legacy.map((f) => f.name)).toContain("expectedSalary");
    expect(container.map((f) => f.name)).toContain("ownWords");
    for (const builder of SHARED_BUILDERS) {
      expect(builderArgs(LEGACY_BODY, builder).length, builder).toBeGreaterThan(3);
      expect(builderArgs(CONTAINER_BODY, builder).length, builder).toBeGreaterThan(3);
      expect(builderParams(builder).length, `${builder} params`).toBeGreaterThan(3);
    }
    // Comments must be blanked, or every `null` quoted in prose reads as a hard-coded value.
    expect(CODE).not.toContain("WAS HARD");
    expect(CODE.length, "offsets preserved").toBe(SOURCE.length);
  });

  it("no field is set on one branch and ABSENT on the other", () => {
    const legacy = new Set(fieldsOf(LEGACY_BODY).map((f) => f.name));
    const container = new Set(fieldsOf(CONTAINER_BODY).map((f) => f.name));
    const missing: string[] = [];
    for (const name of new Set([...legacy, ...container])) {
      const starved: Branch | null = legacy.has(name)
        ? container.has(name)
          ? null
          : "container"
        : "legacy";
      if (starved === null) continue;
      if (ALLOWED[`return.${name}`]?.starved === starved) continue;
      missing.push(`${name} — absent on the ${starved} branch`);
    }
    expect(missing, "a render slot reaches the page on one branch only").toEqual([]);
  });

  it("no field is DERIVED on one branch and a bare literal on the other", () => {
    // THE HALF THAT WOULD HAVE CAUGHT THE SALARY BUG. `salary: null` beside `salary:
    // salaryText` is a field-name match and a total loss of the value.
    const legacy = fieldsOf(LEGACY_BODY);
    const container = fieldsOf(CONTAINER_BODY);
    const starvedRows: string[] = [];
    for (const l of legacy) {
      const c = container.find((f) => f.name === l.name);
      if (!c) continue;
      const lEmpty = isLiteralEmpty(l.expr);
      const cEmpty = isLiteralEmpty(c.expr);
      if (lEmpty === cEmpty) continue;
      const starved: Branch = lEmpty ? "legacy" : "container";
      if (ALLOWED[`return.${l.name}`]?.starved === starved) continue;
      starvedRows.push(`${l.name} — hard-coded \`${lEmpty ? l.expr : c.expr}\` on ${starved}`);
    }
    expect(starvedRows, "a render slot is wired on one branch and stubbed on the other").toEqual(
      [],
    );
  });

  it.each(SHARED_BUILDERS)("both branches pass %s the same arguments", (builder) => {
    const legacy = builderArgs(LEGACY_BODY, builder);
    const container = builderArgs(CONTAINER_BODY, builder);
    const names = new Set([...legacy, ...container].map((f) => f.name));
    const delta: string[] = [];
    for (const name of names) {
      const l = legacy.find((f) => f.name === name);
      const c = container.find((f) => f.name === name);
      const starved: Branch | null = !l ? "legacy" : !c ? "container" : null;
      const emptied: Branch | null =
        l && c && isLiteralEmpty(l.expr) !== isLiteralEmpty(c.expr)
          ? isLiteralEmpty(l.expr)
            ? "legacy"
            : "container"
          : null;
      const problem = starved ?? emptied;
      if (!problem) continue;
      if (ALLOWED[`${builder}.${name}`]?.starved === problem) continue;
      delta.push(`${name} — ${starved ? "absent" : "stubbed"} on the ${problem} branch`);
    }
    expect(delta, `${builder} receives different facts depending on the branch`).toEqual([]);
  });

  it.each(SHARED_BUILDERS)("%s accepts no parameter that neither branch passes", (builder) => {
    // THE `axes` DIRECTION. A slot can also go missing by being accepted, documented, rendered
    // — and never handed a value by anybody. A field-set diff between the branches is blind to
    // it, because the two branches agree perfectly about not passing it.
    const passed = new Set([
      ...builderArgs(LEGACY_BODY, builder).map((f) => f.name),
      ...builderArgs(CONTAINER_BODY, builder).map((f) => f.name),
    ]);
    const orphans = builderParams(builder)
      .map((f) => f.name)
      .filter((name) => !passed.has(name))
      .filter((name) => ALLOWED[`${builder}.${name}`]?.starved !== "both");
    expect(orphans, `${builder} accepts a fact nothing ever gives it`).toEqual([]);
  });

  it("no allowlist entry may go stale", () => {
    // A ROW THAT OUTLIVES ITS SUBJECT IS THE LEDGER NOBODY READS. When someone wires
    // `preferredLocations`, this file must go red and force the row out — otherwise the
    // exception silently re-authorises the next person to break it.
    const legacy = fieldsOf(LEGACY_BODY);
    const container = fieldsOf(CONTAINER_BODY);
    const live = new Set<string>();
    for (const name of new Set([...legacy, ...container].map((f) => f.name))) {
      const l = legacy.find((f) => f.name === name);
      const c = container.find((f) => f.name === name);
      if (!l || !c) live.add(`return.${name}`);
      else if (isLiteralEmpty(l.expr) !== isLiteralEmpty(c.expr)) live.add(`return.${name}`);
    }
    for (const builder of SHARED_BUILDERS) {
      const l = builderArgs(LEGACY_BODY, builder);
      const c = builderArgs(CONTAINER_BODY, builder);
      const passed = new Set([...l, ...c].map((f) => f.name));
      for (const name of passed) {
        const lf = l.find((f) => f.name === name);
        const cf = c.find((f) => f.name === name);
        if (!lf || !cf) live.add(`${builder}.${name}`);
        else if (isLiteralEmpty(lf.expr) !== isLiteralEmpty(cf.expr))
          live.add(`${builder}.${name}`);
      }
      for (const p of builderParams(builder)) {
        if (!passed.has(p.name)) live.add(`${builder}.${p.name}`);
      }
    }
    expect(Object.keys(ALLOWED).filter((entry) => !live.has(entry))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The runtime half — what actually comes out, per branch, from a maximal draft
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Every legacy-reachable field answered, so an empty slot is the mapper's doing and nothing else. */
const MAXIMAL_LEGACY = {
  canonical_role_id: "role_cnc_operator",
  machines: ["mach_vmc"],
  skills: ["skill_milling"],
  education: ["ITI"],
  certifications: ["NCVT"],
  education_level: "iti_diploma",
  education_field: "Machinist",
  domain_label: "CNC machining",
  experience: { total_years: 8 },
  salary_expectation: { amount_min: 24000, amount_max: 28000 },
  location_preference: { current_city: "Faridabad", preferred_cities: ["Gurugram", "Noida"] },
  availability: { status: "immediate" },
  // NOT PRODUCIBLE BY THE WRITER — see `return.experiences` above. Present so the probe measures
  // what the MAPPER does with it rather than what the processor happens to prevent.
  experiences: [{ role_label: "VMC Operator", duration_text: "3 saal", work_done: "setting" }],
};

/** The same worker, as the interview's own container. */
const MAXIMAL_CONTAINER = {
  machines: ["mach_vmc"],
  education: ["ITI"],
  certifications: ["NCVT"],
  education_level: "iti_diploma",
  education_field: "Machinist",
  experience: { total_years: 8 },
  resume_profile: {
    domain_label: "CNC machining",
    role_label: "VMC Operator",
    skills: ["Milling"],
    experiences: [
      { role_label: "VMC Operator", duration_text: "3 saal", work_done: "setting karta hu" },
    ],
    shift: "day",
    current_city: "Faridabad",
    preferred_locations: ["Gurugram", "Noida"],
    availability: "immediate",
    expected_salary: 26000,
  },
};

const render = (snapshot: unknown) =>
  buildResumeRenderInput(snapshot, "Ramesh Kumar Yadav", "classic", null, false, "worker");

describe("R14 §1 — measured, per branch, on the template production actually renders", () => {
  it("the probes really do take the two different branches", () => {
    // The fixture must contain the thing the detector detects. `ownWords` is container-only and
    // `education` is legacy-only, so these two reads prove which path each snapshot took.
    expect(render(MAXIMAL_CONTAINER).canonicalRole).toBe("VMC Operator");
    expect(render(MAXIMAL_LEGACY).canonicalRole).toBe("CNC Operator");
  });

  it("the legacy branch prints the same fact in Zone 3 and drops it from the scalar slot", () => {
    // MEASURED, AND THIS IS THE FINDING. `classic.v3` renders BOTH `{{#preferred_locations}}`
    // and the availability rows; one of them is populated and the other is not, from one draft.
    const input = render(MAXIMAL_LEGACY);
    expect(input.availFactRows?.map((r) => `${r.label}: ${r.value}`)).toEqual([
      "Available from: Immediate",
      "Salary expected: ₹24,000 – ₹28,000 / month",
      "Preferred locations: Gurugram, Noida",
    ]);
    expect(input.subheadLine).toContain("expects ₹24,000 – ₹28,000 / month");
    expect(input.preferredLocations, "the scalar slot, from the same draft").toEqual([]);
    expect(input.expectedSalary, "the scalar slot, from the same draft").toBeNull();
  });

  it("the legacy branch drops a populated draft.experiences", () => {
    // Unreachable through the processor today, and the mapper is what makes it a coupling
    // rather than a rule. If `experiences: interview?.experiences ?? []` ever preserves a prior
    // value, this is the line that was already wrong.
    expect(render(MAXIMAL_LEGACY).experiences).toEqual([]);
  });

  it("the container branch drops the qualification scalars the legacy branch renders", () => {
    // The 2026-08-12 ruling, measured rather than quoted.
    const container = render(MAXIMAL_CONTAINER);
    const legacy = render(MAXIMAL_LEGACY);
    expect(legacy.machines).toEqual(["Vertical Machining Center (VMC)"]);
    expect(legacy.education).toEqual(["ITI"]);
    expect(legacy.certifications).toEqual(["NCVT"]);
    expect(legacy.educationLevel).toBe("ITI / Diploma");
    expect(container.machines).toEqual([]);
    expect(container.education).toEqual([]);
    expect(container.certifications).toEqual([]);
    expect(container.educationLevel).toBeNull();
    expect(container.educationField).toBeNull();
  });

  it("the Verdict Line itself is symmetric — R12 §1.4 and R13 §2 hold", () => {
    // The three fixed instances, asserted from the outside so a revert is visible here too.
    for (const snapshot of [MAXIMAL_LEGACY, MAXIMAL_CONTAINER]) {
      const input = render(snapshot);
      expect(input.headlineLine).toContain("8 yrs");
      expect(input.subheadLine).toContain("Faridabad");
      expect(input.subheadLine).toContain("expects ₹");
    }
  });

  it.fails(
    "R14 §1 — the legacy branch fills {{#preferred_locations}} (REPORTED, not fixed)",
    () => {
      // ONE LINE: `preferredLocations: preferences.preferredLocations.length > 0 ? … :
      // draft.location_preference.preferred_cities`, the same expression `buildAvailabilityRows`
      // is already handed twelve lines above. Held for the owner's word — R14 §1 asks for the size
      // of the delta before anything beyond the known three is fixed.
      expect(render(MAXIMAL_LEGACY).preferredLocations).toEqual(["Gurugram", "Noida"]);
    },
  );

  it.fails("R14 §1 — the legacy branch fills {{expected_salary}} (REPORTED, not fixed)", () => {
    // ONE LINE, and it must carry the audience gate with it: `audience === "worker" ?
    // draft.salary_expectation.amount_min : null`. `legacySalary` is already gated, which is why
    // the Verdict Line and the fact row are safe and this scalar would not be by default.
    expect(render(MAXIMAL_LEGACY).expectedSalary).toBe(24000);
  });
});
