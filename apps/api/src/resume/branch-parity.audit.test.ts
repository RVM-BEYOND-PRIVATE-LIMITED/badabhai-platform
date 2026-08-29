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

/**
 * The fields a branch hands a shared builder.
 *
 * RESOLVES A NAMED ARGUMENT, and it has to. The reader originally assumed every call site was
 * `builder({ … })` written inline, which is a silent assumption about how the code happens to be
 * shaped rather than anything the audit is about. R15 §1 gave the container branch a `zone5`
 * binding so its rows and its scalar slots read ONE expression — and the reader then parsed the
 * identifier, found the next object literal in the file, and reported seven fields as absent
 * that were being passed perfectly well. A parser that mis-reads a refactor is worse than no
 * parser, because it fails LOUDLY on the wrong thing and the fix looks like reverting the
 * refactor.
 */
function builderArgs(branchBody: string, builder: SharedBuilder): Field[] {
  const at = branchBody.indexOf(`${builder}(`);
  expect(at, `${builder} is not called on this branch`).toBeGreaterThan(-1);
  const open = at + builder.length + 1;
  const named = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(branchBody.slice(open));
  if (!named) return fieldsOf(literalAt(branchBody, at));
  // `builder(zone5)` — read the binding's own literal, from the whole file rather than the
  // branch body, since the declaration sits above the `return`.
  const decl = CODE.indexOf(`const ${named[1]} = {`);
  expect(decl, `${builder} is passed \`${named[1]}\`, which is declared nowhere`).toBeGreaterThan(
    -1,
  );
  return fieldsOf(literalAt(CODE, decl));
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
  // ── THE FIVE ARE GONE (R15 §1) ────────────────────────────────────────────────────────
  //
  // `machines`, `education`, `certifications`, `educationLevel` and `educationField` are filled
  // from the draft on the container branch now. Their rows are DELETED rather than flipped to a
  // "fixed" note, because the staleness test below requires every row to name a live asymmetry
  // — a row kept for its history would fail it, which is the property that makes this list
  // readable at all.

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
  // BOTH WIRED (R15 §2, Q15 ruled). `expectedSalary` carries `audience === "worker" ? … : null`
  // with it, which is the reason it was never the one-line change it looked like.

  // ── ACCEPTED BY THE BUILDER, PASSED BY NEITHER ────────────────────────────────────────
  //
  // R13 §2's third finding. There is no turner axis question, so it is correctly empty for every
  // worker who exists today; it stops being correct the moment a milling pack ships, which is
  // what `yadav-parity.contract.test.ts:577` pins.
  // R15 §6.1 — THE REASON THIS ROW GAVE IS NOW FALSE, and correcting it is the point.
  //
  // It read "no pack asks for axes yet". `qp_vmc_milling` shipped in #1309 and asks
  // `axis_capability` with three options, and `trade-resume-map.ts` already routes the answer
  // into the MACHINE chip as `configFrom` — the sheet prints "VMC · 3-axis" today. So the value
  // is captured, stored and rendered; what is still true is narrower and worse, because it can
  // no longer be waved off as a missing question: `buildVerdictLine` accepts a dedicated `axes`
  // segment, §6.2 of the sheet spec names it, and NEITHER mapper branch passes it. The milling
  // headline strip cannot print "3 & 4-axis" for a worker who answered exactly that.
  //
  // Kept as an allowlist row rather than fixed here: the Verdict Line's axes segment is a
  // second rendering of a fact the machine chip already carries, so wiring it is a layout
  // decision about duplication rather than a wiring gap. Pinned as behaviour in
  // verdict-line-collapse.render.test.ts:328.
  "buildVerdictLine.axes": {
    starved: "both",
    reason: "the milling pack ASKS it and the chip prints it; no mapper branch passes it here",
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

  it("the legacy branch prints the same fact in Zone 3 AND in the scalar slot (R15 §2)", () => {
    // WAS THE FINDING, IS NOW THE REGRESSION TEST. `classic.v3` renders BOTH
    // `{{#preferred_locations}}` and the availability rows; one was populated and the other was
    // not, from one draft. Asserted together, in one test, because the defect was never in
    // either value — it was in the two of them disagreeing.
    const input = render(MAXIMAL_LEGACY);
    expect(input.availFactRows?.map((r) => `${r.label}: ${r.value}`)).toEqual([
      "Available from: Immediate",
      "Salary expected: ₹24,000 – ₹28,000 / month",
      "Preferred locations: Gurugram, Noida",
    ]);
    expect(input.subheadLine).toContain("expects ₹24,000 – ₹28,000 / month");
    expect(input.preferredLocations, "the scalar slot, from the same draft").toEqual([
      "Gurugram",
      "Noida",
    ]);
    expect(input.expectedSalary, "the scalar slot, from the same draft").toBe(24000);
  });

  it("R15 §2 — the employer copy does NOT get the asking price through the new scalar", () => {
    // THE REASON Q15 WAS NOT A ONE-LINE CHANGE. The Verdict Line and the Terms row read
    // `legacySalary`, which is already gated; this slot takes a raw number off the draft, so
    // wiring it without the gate would have put the worker's asking price on the employer copy
    // — the exact disclosure ADR-0032 withholds, reached from the other side.
    const employer = buildResumeRenderInput(
      MAXIMAL_LEGACY,
      "R. K. Yadav",
      "classic",
      null,
      false,
      "employer",
    );
    expect(employer.expectedSalary, "the payer copy must never carry it").toBeNull();
    expect(employer.subheadLine ?? "").not.toContain("expects");
    expect(
      employer.availFactRows?.map((r) => r.label),
      "and it must not come back as a labelled row either",
    ).not.toContain("Salary expected");
    // Vacuity: the same draft on the worker copy DOES carry it, so this is a gate and not an
    // empty fixture.
    expect(render(MAXIMAL_LEGACY).expectedSalary).toBe(24000);
  });

  it("the legacy branch drops a populated draft.experiences", () => {
    // Unreachable through the processor today, and the mapper is what makes it a coupling
    // rather than a rule. If `experiences: interview?.experiences ?? []` ever preserves a prior
    // value, this is the line that was already wrong.
    expect(render(MAXIMAL_LEGACY).experiences).toEqual([]);
  });

  it("the container branch renders the qualification scalars too (R15 §1 — the five)", () => {
    // WAS THE MEASUREMENT OF THE 2026-08-12 RULING, IS NOW ITS REGRESSION TEST. On `classic.v3`
    // an interview-led worker's whole Education & Certifications section used to collapse while
    // the identical draft rendered it for a worker whose interview never ran.
    const container = render(MAXIMAL_CONTAINER);
    const legacy = render(MAXIMAL_LEGACY);
    for (const input of [legacy, container]) {
      expect(input.machines).toEqual(["Vertical Machining Center (VMC)"]);
      expect(input.education).toEqual(["ITI"]);
      expect(input.certifications).toEqual(["NCVT"]);
      expect(input.educationLevel).toBe("ITI / Diploma");
      expect(input.educationField).toBe("Machinist");
    }
  });

  it("R15 §1 — the rows and the scalars are ONE binding, so they cannot disagree again", () => {
    // THE DEFECT UNDERNEATH THE FIVE. `bb_trade` prints Zone 5 as `qualFactRows` and
    // `classic.v3` prints the same facts as `{{#education}}` / `{{#certifications}}`. They were
    // computed from two different expressions, which is how R9 wired the rows and left the
    // scalars empty with nothing anywhere reporting that one source gave two answers.
    for (const snapshot of [MAXIMAL_LEGACY, MAXIMAL_CONTAINER]) {
      const input = render(snapshot);
      const rows = Object.fromEntries(
        (input.qualFactRows ?? []).map((r) => [r.label, r.value]),
      ) as Record<string, string>;
      expect(rows["Certificates"], "the row and the scalar are the same fact").toBe(
        input.certifications.join(", "),
      );
      expect(rows["Education"] ?? "").toContain(input.education.join(", "));
    }
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
    "R15 §1 — the two branches pick the headline's TOOLS from different sources (REPORTED)",
    () => {
      // FOUND BY THE RUNTIME DIFF BELOW, and it is the twelfth asymmetry — the only one left.
      //
      // `buildVerdictLine` is handed `headlineTools.length > 0 ? headlineTools : legacyMachines`
      // on one branch and `… : skillChips` on the other. When a pack ran they agree; when none
      // did, one worker's headline strip names his MACHINES and the other's names his SKILLS,
      // from one draft. Neither expression is a bare literal and both branches pass the argument,
      // so all six static assertions pass it — this is the fourth shape.
      //
      // NOT FIXED HERE, DELIBERATELY, and it is the one place R15 §1 stops. Aligning them changes
      // what prints for profiles that already exist — on the legacy branch a worker with no
      // machines would newly show skills, and on the container branch machines would displace
      // skills — so it is an output ruling rather than a wiring gap, exactly as `expectedSalary`
      // was before Q15. Q17 in NEEDS_PRAKASH.md.
      const legacy = render(EQUIVALENT_LEGACY);
      const container = render(EQUIVALENT_CONTAINER);
      expect(container.headlineLine).toBe(legacy.headlineLine);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// R15 §1 — THE DIRECTION-AGNOSTIC DIFF, AND IT IS THE RUNTIME ONE THAT WAS MISSING
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// The static half above ALREADY fails in both directions — mutation-verified, four ways: a
// field added to one branch only is named "absent on the <other> branch" whichever branch it
// was added to, and a field stubbed on one side is named "hard-coded on <that side>" either
// way. It is what FOUND the five container-starved slots, so nothing about its direction
// needed correcting.
//
// WHAT WAS ONE-DIRECTIONAL IS THE RUNTIME HALF, and it was worse than one-directional: it was
// a list of hand-written probes, one per KNOWN finding. Every one of them asserts a value
// somebody had already gone looking for. A slot starved in either direction, by the fourth
// shape — present and derived on BOTH branches, from different sources, one of them thinner —
// had no assertion at all, because the static reader cannot see it and no probe had been
// written for it yet. That is the shape `experiences` is, and it was held by exactly one
// hand-authored line.
//
// SO THE DIFF IS TAKEN OVER THE WHOLE RENDERED OBJECT, from two drafts carrying the SAME
// answers, and every key must agree unless a row here says why. It is symmetric by
// construction — it compares two objects and reports the key, not the branch — so it cannot
// acquire a direction to be blind in.
//
// IT FOUND ONE NOBODY HAD LOOKED FOR: `qualFactRows`' certifications reached the container
// branch as RAW `draft.certifications` — `cert_ncvt` on a worker's résumé — while the legacy
// branch resolved the identical field through `labelForTaxonomyId`. Same source, same field,
// two answers, and neither branch was ABSENT or STUBBED, so all six static assertions passed.

/**
 * The same worker, answered identically, in each of the two shapes the mapper accepts.
 *
 * EQUIVALENCE IS THE WHOLE INSTRUMENT, and the first draft of this fixture was not equivalent:
 * it gave the legacy side a salary BAND and the container a single figure, a `shift` to one and
 * not the other, and different headline tools. Every one of those showed up as a "difference"
 * that was mine rather than the mapper's, and each would have had to be allowlisted — which is
 * how an allowlist stops meaning anything. The three below are pinned to the same values on both
 * sides so a delta is the code's.
 */
const EQUIVALENT_LEGACY = {
  ...MAXIMAL_LEGACY,
  // The one field the container cannot carry — see `return.experiences`. Dropped from BOTH
  // sides so the diff measures the mapper rather than a source the processor cannot produce.
  experiences: [],
  // ONE figure, because `ResumeProfileSchema.expected_salary` is a single number and the band's
  // upper end rides a finishing-form attribute neither probe supplies.
  salary_expectation: { amount_min: 26000, amount_max: null },
  shift: "day",
  // THE LEAK THE LEGACY BRANCH DEFENDS AGAINST AND THE CONTAINER DID NOT. `labelForTaxonomyId`
  // is a no-op on `NCVT` and on any `cert_*` id — it resolves `skill_*` and `mach_*` — so a
  // fixture full of plain labels CANNOT exercise the difference, and the first run of this diff
  // reported certifications as agreeing. `skill_milling` is exactly the id the legacy comment
  // says leaks in from the extraction path, and it is the only value here that can tell a
  // resolved list from a raw one.
  certifications: ["NCVT", "skill_milling"],
};

const EQUIVALENT_CONTAINER = {
  ...MAXIMAL_CONTAINER,
  certifications: ["NCVT", "skill_milling"],
  resume_profile: {
    ...MAXIMAL_CONTAINER.resume_profile,
    experiences: [],
    expected_salary: 26000,
    // The rendered value the legacy side produces from `skill_milling`, so the `skills` SLOT
    // compares. The headline TOOLS still diverge, and deliberately so — see the pin below.
    skills: ["Milling"],
    role_label: "CNC Operator",
    domain_label: "CNC machining",
  },
};

/**
 * Keys allowed to differ between the two renders, each with the reason.
 *
 * DELIBERATELY SMALL. Every row is a slot one branch can fill and the other structurally
 * cannot; anything else is a defect, in whichever direction it points.
 */
const RUNTIME_ALLOWED: Readonly<Record<string, string>> = {
  // THE ONLY ONE LEFT, AND IT IS PINNED ABOVE RATHER THAN ACCEPTED — see the `it.fails` for why
  // aligning the two is an output ruling and not a wiring gap. Q17.
  headlineLine: "R15 §1 — tools fall back to machines on one branch and skills on the other (Q17)",
  // Container-only by construction: §8.4's quotes are selected from
  // `resume_profile.experiences[].work_done`, and the legacy shape has no such field. The legacy
  // branch leaves the slot unset rather than empty, which is the honest signal — "no selection
  // ran" is not the same claim as "a selection ran and rejected nothing".
  ownWordsRejected: "the quote selection exists only on the container",
  // TWO COMPOSERS, BY DESIGN — `buildSummary(draft, trade)` reads the taxonomy's trade content,
  // `summaryFor` reads the model's labels, and neither branch can run the other's.
  //
  // WORTH A LOOK ANYWAY, and recorded here rather than in a doc: the legacy composer drops the
  // ROLE. It renders "CNC machining with 8 years of experience." where the container renders
  // "CNC Operator with 8 years of experience in CNC machining." — so on the branch most existing
  // profiles take, the résumé's opening sentence never names the job the worker does. That is a
  // content question rather than a parity one, which is why it is a row and not a fix.
  summary: "composed by two different functions; the legacy one omits the role (reported)",
};

describe("R15 §1 — the two branches render the SAME worker the same way, in either direction", () => {
  it("the two drafts really are the two branches, and really are equivalent", () => {
    // VACUITY, WRITTEN FIRST, TWICE OVER. A diff of two objects is trivially empty if both
    // renders came out of the same branch, and it is also trivially empty if both are blank.
    const legacy = render(EQUIVALENT_LEGACY);
    const container = render(EQUIVALENT_CONTAINER);
    expect(legacy.ownWords ?? [], "legacy must NOT have taken the container path").toEqual([]);
    expect(container.responsibilities, "container must NOT have taken the legacy path").toEqual([]);
    expect(legacy.headlineLine, "the fixture must actually render").toContain("8 yrs");
    expect(container.headlineLine, "the fixture must actually render").toContain("8 yrs");
    // And the diff must be capable of reporting something: these keys are read below.
    expect(Object.keys(legacy).length).toBeGreaterThan(20);
  });

  it("no rendered slot differs between the branches without a stated reason", () => {
    const legacy = render(EQUIVALENT_LEGACY) as unknown as Record<string, unknown>;
    const container = render(EQUIVALENT_CONTAINER) as unknown as Record<string, unknown>;
    const delta: string[] = [];
    for (const key of new Set([...Object.keys(legacy), ...Object.keys(container)])) {
      if (key in RUNTIME_ALLOWED) continue;
      const l = JSON.stringify(legacy[key] ?? null);
      const c = JSON.stringify(container[key] ?? null);
      if (l === c) continue;
      delta.push(`${key} — legacy ${l} vs container ${c}`);
    }
    expect(delta.sort(), "one worker, two shapes, two different résumés").toEqual([]);
  });

  it("no allowlist row may go stale", () => {
    // The same rule the static allowlist follows: a row that outlives its subject silently
    // re-authorises the next person to break the key it names.
    const legacy = render(EQUIVALENT_LEGACY) as unknown as Record<string, unknown>;
    const container = render(EQUIVALENT_CONTAINER) as unknown as Record<string, unknown>;
    const stale = Object.keys(RUNTIME_ALLOWED).filter(
      (k) => JSON.stringify(legacy[k] ?? null) === JSON.stringify(container[k] ?? null),
    );
    expect(stale, "these keys now agree — drop the row").toEqual([]);
  });
});
