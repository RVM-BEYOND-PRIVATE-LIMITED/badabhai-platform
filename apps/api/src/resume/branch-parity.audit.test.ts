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
  /**
   * WHAT WOULD MAKE THIS ROW FALSE — R16 §0, and it is required by the type on purpose.
   *
   * THE INCIDENT. This file's `buildVerdictLine.axes` row read "no pack asks for axes yet". That
   * was TRUE when it was written and FALSE four days later, when `qp_vmc_milling` shipped asking
   * exactly that — and nothing anywhere noticed, because a reason is prose and prose does not
   * expire. The row went on authorising the suppression it had stopped justifying.
   *
   * An allowlist row is a claim with an expiry date. Stating the expiry is what lets a reader
   * check it in one step instead of re-deriving the whole argument, and it is what
   * `scripts/list-open-pins.mjs` surfaces so the ledger shows the condition rather than only the
   * exception. Write the OBSERVABLE that would flip it — "a pack ships an `axis_capability`
   * question", not "if this changes".
   */
  readonly falsifiedBy: string;
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
    falsifiedBy:
      "`toExtractionOutput` starts writing a canonical_role_id or canonical_trade_id, so " +
      "`resolveTradeContent` can resolve an interview-led profile",
  },
  // §8.4's verbatim quotes. The candidates are `experiences[].work_done`, and the container is
  // the only shape that carries them — see `return.experiences` below for why the legacy branch
  // can never hold one.
  "return.ownWords": {
    starved: "legacy",
    reason: "candidates are resume_profile.experiences[].work_done",
    falsifiedBy:
      "the legacy answer-map shape gains a field carrying the worker's own sentences, so " +
      "`selectOwnWords` has candidates on that branch",
  },
  "return.ownWordsRejected": {
    starved: "legacy",
    reason: "the other half of the same selection",
    falsifiedBy: "`return.ownWords` becomes reachable on the legacy branch",
  },

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
  // R16 §1 — THE ROW IS GONE BECAUSE THE GAP IS. Both branches now pass `axes`, so its own
  // `falsifiedBy` ("either mapper branch passes `axes` to buildVerdictLine") has fired and the
  // staleness test would fail this file if the row stayed. That is the mechanism working: the
  // row before it read "no pack asks for axes yet" and sat here false for four days.
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

/**
 * The trade context BOTH probes are rendered with (R16 §2).
 *
 * WHY THE FIXTURE GREW. Without a `tradeSheet` the whole capability block, the phone, the QR, the
 * footer and the trust badge are null on both sides — and a key that is empty on both sides can
 * never report a difference, so the diff was looping over 44 keys while only 21 could speak. The
 * key set was complete and the INSTRUMENT was half blind, which is a distinction worth measuring
 * rather than assuming; see the observability test below.
 *
 * A MILLING PACK, DELIBERATELY. `qp_vmc_milling` is the only shipped pack that asks
 * `axis_capability`, so this is also the fixture that makes R16 §1's fourth headline segment
 * observable at all — the pre-existing axes pin used a TURNER sheet, which has no axis question
 * and therefore could not have noticed the wiring either way.
 */
const MILLING_SHEET = {
  packId: "qp_vmc_milling",
  attributes: {
    milling_machine: ["vmc"],
    controller_brand: ["fanuc", "siemens"],
    axis_capability: ["three_axis", "four_axis"],
  },
  phone: "+919876543210",
  qrDataUri: "data:image/png;base64,iVBORw0KGgo=",
  qrCaption: "Scan to open this worker's live profile",
  shortLink: "badabhai.ai/w/abc123",
  footerMeta: "Generated 29 Aug 2026 · Ref RK8M2Q",
  nameDevanagari: "रमेश कुमार यादव",
  qualification: { documents: ["aadhaar", "pan"] },
} as const;

const render = (snapshot: unknown) =>
  buildResumeRenderInput(snapshot, "Ramesh Kumar Yadav", "classic", null, false, "worker", {
    ...MILLING_SHEET,
    attributes: { ...MILLING_SHEET.attributes },
  });

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

  it("R16 §2 — the two branches pick the headline's TOOLS from the same source (Q17, RULED)", () => {
    // WAS AN it.fails, AND THIS IS THE FLIP. `buildVerdictLine` was handed
    // `headlineTools ?? legacyMachines` on one branch and `headlineTools ?? skillChips` on the
    // other, so with no role pack one worker's headline named his machines and another's named
    // his skills from identical answers. Both call `headlineToolsOrFallback` now, so the two
    // cannot drift apart again without deleting a shared function.
    const legacy = render(EQUIVALENT_LEGACY);
    const container = render(EQUIVALENT_CONTAINER);
    expect(container.headlineLine).toBe(legacy.headlineLine);
    // Vacuity: the fixture must actually reach the tools segment, or this passes on two nulls.
    // With a pack in play the PACK ROW wins on both branches, which is the agreed first arm.
    expect(legacy.headlineLine ?? "").toContain("Fanuc, Siemens");
  });

  it("R16 §2 — and they agree with NO pack, which is the arm Q17 was actually about", () => {
    // THE TEST ABOVE CANNOT SEE THE BUG IT EXISTS FOR. `MILLING_SHEET` fills `headlineTools`, so
    // the fallback arm never runs and reverting the container branch to `: skillChips` leaves it
    // green — mutation-verified, and it survived. Q17 was only ever about the case where NO pack
    // resolved, so that is the case this renders.
    const noPack = (snapshot: unknown) =>
      buildResumeRenderInput(snapshot, "Ramesh Kumar Yadav", "classic", null, false, "worker");
    const legacy = noPack(EQUIVALENT_LEGACY);
    const container = noPack(EQUIVALENT_CONTAINER);
    expect(container.headlineLine).toBe(legacy.headlineLine);
    // And it must be the MACHINES, not the skills — the fallback order the ruling picked.
    expect(legacy.headlineLine ?? "").toContain("Vertical Machining Center (VMC)");
    expect(legacy.headlineLine ?? "").not.toContain("Milling");
  });
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
interface RuntimeAllowed {
  readonly reason: string;
  /** R16 §0 — the observable that would make this row false. Required, like `Allowed`. */
  readonly falsifiedBy: string;
}

const RUNTIME_ALLOWED: Readonly<Record<string, RuntimeAllowed>> = {
  // Container-only by construction: §8.4's quotes are selected from
  // `resume_profile.experiences[].work_done`, and the legacy shape has no such field. The legacy
  // branch leaves the slot unset rather than empty, which is the honest signal — "no selection
  // ran" is not the same claim as "a selection ran and rejected nothing".
  ownWordsRejected: {
    reason: "the quote selection exists only on the container",
    falsifiedBy: "the legacy branch gains a source of the worker's own sentences to quote",
  },
  // TWO COMPOSERS, BY DESIGN — `buildSummary(draft, trade)` reads the taxonomy's trade content,
  // `summaryFor` reads the model's labels, and neither branch can run the other's.
  //
  // WORTH A LOOK ANYWAY, and recorded here rather than in a doc: the legacy composer drops the
  // ROLE. It renders "CNC machining with 8 years of experience." where the container renders
  // "CNC Operator with 8 years of experience in CNC machining." — so on the branch most existing
  // profiles take, the résumé's opening sentence never names the job the worker does. That is a
  // content question rather than a parity one, which is why it is a row and not a fix.
  summary: {
    reason: "composed by two different functions; the legacy one omits the role (reported)",
    falsifiedBy: "`buildSummary` and `summaryFor` are unified, or the legacy one names the role",
  },
};

describe("R15 §1 — the two branches render the SAME worker the same way, in either direction", () => {
  it("the two drafts really are the two branches, and really are equivalent", () => {
    // VACUITY, WRITTEN FIRST — AND THE FIRST VERSION DISCRIMINATED NOTHING.
    //
    // It read `expect(legacy.ownWords ?? []).toEqual([])` and
    // `expect(container.responsibilities).toEqual([])`, which look like branch markers and are
    // not: `ownWords` is `[]` on the CONTAINER too, because equivalence required emptying
    // `experiences` on both sides and `selectOwnWords` returns nothing without candidates; and
    // `responsibilities` is `[]` on the LEGACY branch too, because `role_cnc_operator` resolves
    // to no trade content. Both assertions passed for reasons unrelated to which branch ran, so
    // the guard headed "written first" would have gone on passing if the selector broke and both
    // probes took the same path. Caught by an adversarial read of this file, not by the file.
    //
    // THESE TWO DO DISCRIMINATE. `ownWordsRejected` is UNSET on the legacy branch and an array on
    // the container — the two are different claims ("no selection ran" vs "one ran and rejected
    // nothing"), which is exactly why it is an allowlist row. And the summary is composed by two
    // different functions that neither branch can run for the other.
    const legacy = render(EQUIVALENT_LEGACY);
    const container = render(EQUIVALENT_CONTAINER);
    expect(
      legacy.ownWordsRejected,
      "legacy must NOT have taken the container path",
    ).toBeUndefined();
    expect(
      container.ownWordsRejected,
      "container must NOT have taken the legacy path",
    ).toBeInstanceOf(Array);
    expect(legacy.summary, "the two summary composers must not agree").not.toBe(container.summary);
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

  it("R16 §1 — a worker who answers the axis question gets the segment, on BOTH branches", () => {
    // THE FOURTH HEADLINE SEGMENT, WHICH HAD NEVER RENDERED FOR ANYBODY.
    //
    // `buildVerdictLine` has accepted `axes` since the sheet shipped and `resume-renderer` has
    // documented `{{headline_line}}` as "role · years · controllers · axis" the whole time —
    // while neither mapper branch passed it. The value was captured all along: `qp_vmc_milling`
    // asks `axis_capability` and `trade-resume-map` already printed "VMC · 3-axis" on the machine
    // chip. It simply never travelled to the headline.
    //
    // ASSERTED ON THE COMPOSED LINE, not on `buildVerdictLine` in isolation. The pre-existing
    // pin in `verdict-line-collapse.render.test.ts` tested the function and then asserted the
    // segment was unreachable — using a TURNER sheet, which asks no axis question, so it could
    // not have observed the wiring either way. A unit test of the composer plus a fixture that
    // cannot reach it is exactly the pair that let this sit unnoticed.
    for (const [branch, snapshot] of [
      ["legacy", EQUIVALENT_LEGACY],
      ["container", EQUIVALENT_CONTAINER],
    ] as const) {
      const line = render(snapshot).headlineLine ?? "";
      // "3-axis" and "4-axis" share a non-digit suffix, so `axesPhrase` compresses them — this
      // is the ratified sheet's own string.
      expect(line, `${branch} branch`).toContain("3 & 4-axis");
      // And it is the LAST segment, after the tools, exactly as §6.2 orders it.
      expect(line.indexOf("3 & 4-axis"), `${branch}: axes must follow the tools`).toBeGreaterThan(
        line.indexOf("Fanuc"),
      );
    }
  });

  it("R16 §1 — the axes segment collapses WITH its separator when no pack asks", () => {
    // The other half, and the half a wiring change is most likely to break: the turner asks no
    // axis question, so his headline must be byte-identical to what it renders today — no
    // trailing separator, no empty segment.
    const turner = buildResumeRenderInput(
      EQUIVALENT_LEGACY,
      "Ramesh Kumar Yadav",
      "classic",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: { turning_machine: ["cnc_lathe"] } },
    );
    expect(turner.headlineLine ?? "").not.toMatch(/axis/i);
    expect(turner.headlineLine ?? "").not.toMatch(/·\s*$/);
  });

  it("R16 §1 — the axis labels are dictionary-ordered, not answer-ordered", () => {
    // A worker who taps four-axis first must still read "3 & 4-axis". Reading his answer order
    // would print "4 & 3-axis" — and `axesPhrase` would compress it just as happily, so the
    // sheet would look deliberate while being backwards.
    const reversed = buildResumeRenderInput(
      EQUIVALENT_LEGACY,
      "Ramesh Kumar Yadav",
      "classic",
      null,
      false,
      "worker",
      {
        ...MILLING_SHEET,
        attributes: {
          ...MILLING_SHEET.attributes,
          axis_capability: ["four_axis", "three_axis"],
        },
      },
    );
    expect(reversed.headlineLine ?? "").toContain("3 & 4-axis");
  });

  it("R16 §2 — how much of the render input this diff can actually SEE", () => {
    // THE OWNER ASKED DIRECTLY, so it is measured here rather than asserted in prose.
    //
    // The diff compares EVERY key on the rendered object — its key set is complete. Its
    // OBSERVABILITY is not: a key that is null/empty on BOTH sides cannot report a difference no
    // matter what the mapper does to it, so those keys are covered by the loop and unguarded in
    // practice. `experiences` is one of them — the very field this file's header names as the
    // reason the runtime half exists — because equivalence required emptying it on both sides.
    //
    // ASSERTED AS A FLOOR, NOT A CEILING. The number may rise; if it FALLS, a fixture stopped
    // exercising something and the diff quietly got weaker, which is exactly how a gate becomes
    // the most reassuring test in the repo.
    const legacy = render(EQUIVALENT_LEGACY) as unknown as Record<string, unknown>;
    const container = render(EQUIVALENT_CONTAINER) as unknown as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(legacy), ...Object.keys(container)])];
    const isEmpty = (v: unknown) =>
      v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === "";
    const observable = keys.filter((k) => !isEmpty(legacy[k]) || !isEmpty(container[k]));
    const blind = keys.filter((k) => !observable.includes(k)).sort();

    expect(keys.length, "the reader found no keys at all").toBeGreaterThan(40);
    expect(
      observable.length,
      `only ${observable.length} of ${keys.length} keys carry a value on either side; blind: ${blind.join(", ")}`,
    ).toBeGreaterThanOrEqual(23);
    // The honest record of what this instrument cannot see, kept where it is read.
    expect(blind, "a blind key gained a value — raise the floor above").toContain("experiences");
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
