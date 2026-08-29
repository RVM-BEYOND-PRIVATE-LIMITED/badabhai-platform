import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";

import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { buildResumeRenderInput } from "./resume-render-input";
import { buildVerdictLine } from "./resume-sheet-rows";
import { ResumeRenderer } from "./resume-renderer.service";

/**
 * EVERY §6.2 COLLAPSE RULE, ASSERTED IN BOTH DIRECTIONS, ON BOTH BRANCHES (R13 §2).
 *
 * THE FINDING THIS FILE EXISTS FOR. §6.2 says "never render an empty segment — the segment and
 * its separator are dropped". Every check the sheet had asked only the empty half, and one of
 * them passed for four hundred lines while the legacy branch handed `buildVerdictLine` a literal
 * `null` for the salary it was simultaneously printing in Zone 3. `expects ₹24,000` never
 * rendered for any worker on the path the mapper itself calls "the path most existing profiles
 * still take", and every collapse assertion in the suite was green throughout.
 *
 * PROVING A SEGMENT COLLAPSES WHEN EMPTY IS HALF A TEST. A function that returns null for
 * everything satisfies all seven collapse rules perfectly. The other half — with a value
 * present, the segment renders, in the right place, on EVERY branch — is what has teeth, and it
 * is the half that was missing. So each segment below is asserted four ways: present on legacy,
 * absent on legacy, present on container, absent on container.
 *
 * ORDER IS PART OF THE RULE. §6.2 fixes the sequence (`role · years · tools · axes`, then
 * `city · available … · expects …`), and a segment that renders in the wrong position is a
 * different defect that "does the text appear" cannot see. Asserted by relative index.
 *
 * ── HOW MANY RULES WERE MISSING THE OTHER HALF — MEASURED, NOT COUNTED BY READING ─────────────
 *
 * Silencing a segment inside `buildVerdictLine` itself is caught for all seven, and that is the
 * comfortable answer to the wrong question: the function was never the defect. The defect was
 * one CALL SITE passing a literal while the other passed a value. So the measurement appends a
 * duplicate key to each call site's argument object (last one wins) — twelve mutations, six
 * segments times two branches — and runs the resume suite without this file:
 *
 *     survivors BEFORE this file: 7 of 12
 *       legacy.role  legacy.years  legacy.tools  legacy.availability
 *       container.role             container.tools  container.availability
 *     survivors AFTER:            0 of 12
 *
 * SO: FOUR of the six segments could be silenced on a branch with the whole suite green, and
 * `legacy.years` is the salary defect's exact shape a second time — caught on the container
 * branch, invisible on the legacy one. Both surviving asymmetries are on the legacy path, which
 * is the path the mapper's own comment calls "the path most existing profiles still take".
 * Only `city` and `salary` were guarded on both, and `salary` only because R12 §1.4 had just
 * been burned by it.
 *
 * `EMIT_VERDICT_COLLAPSE=<dir>` writes the pages out, because the instruction was render it and
 * look, and a human has to be able to.
 */

const RENDERER = new ResumeRenderer(
  new PdfRenderer({ RESUME_RENDER_ENABLED: true } as ServerConfig),
);

/** Everything §6.2 can print, populated, so any one of them can be taken away in isolation. */
const FULL_LEGACY = {
  role_label: "CNC Turner",
  experience: { total_years: 6 },
  location_preference: { current_city: "Faridabad", preferred_cities: ["Faridabad"] },
  availability: { status: "notice_period", notice_period_days: 15 },
  salary_expectation: { amount_min: 24000, amount_max: 28000 },
  skills: ["CNC lathe operation"],
  experiences: [],
};

const FULL_CONTAINER = {
  role_label: "CNC Turner",
  skills: ["CNC lathe operation"],
  current_city: "Faridabad",
  // The container stores the model's own closed vocabulary; "15_days" is the token, "15 days"
  // is the label. `bareAvailabilityLabel` is what turns one into the other, and printing the
  // token instead was the #963 defect.
  availability: "15_days",
  expected_salary: 24000,
  experiences: [],
  preferred_locations: ["Faridabad"],
};

const TRADE_SHEET = {
  packId: "qp_cnc_turning",
  attributes: { turning_machine: ["cnc_lathe"], controller_brand: ["fanuc"] },
};

type Branch = "legacy" | "container";
const BRANCHES: Branch[] = ["legacy", "container"];

type Snapshot = Record<string, unknown>;
type TradeSheet = typeof TRADE_SHEET | null;

function render(branch: Branch, snapshot: Snapshot, tradeSheet: TradeSheet = TRADE_SHEET) {
  // The container branch still rides on the same draft — `resume_profile` only decides WHICH
  // mapper runs. Total years in particular is read off the draft on both branches, because the
  // container has no field for it, which is why the `years` rule below drops it in one place.
  const draft =
    branch === "legacy"
      ? snapshot
      : { ...snapshot, resume_profile: snapshot.resume_profile ?? FULL_CONTAINER };
  const input = buildResumeRenderInput(
    draft,
    "Ramesh Kumar",
    "bb_trade",
    null,
    false,
    "worker",
    tradeSheet,
  );
  return { input, html: RENDERER.buildResumeHtml(input) };
}

/**
 * Each segment, and how to take exactly that one away on each branch.
 *
 * `line` matters: a segment asserted against the wrong line would pass on a page that renders it
 * in the wrong half of the strip, which is precisely the class of defect the order assertion
 * below exists for.
 */
interface SegmentRule {
  readonly id: string;
  readonly line: "headline" | "subhead";
  /** The text the segment puts on the page when it has a value. */
  readonly present: RegExp;
  /**
   * `false` where an ABSENT value does not collapse but SUBSTITUTES — §11 #3 requires "duration
   * not stated" rather than silence, because an employer reading a résumé with no tenure on it
   * assumes the worst.
   */
  readonly collapses: boolean;
  /** What replaces it when the rule substitutes instead of collapsing. */
  readonly substitute?: RegExp;
  readonly drop: (branch: Branch) => { snapshot: Snapshot; tradeSheet: TradeSheet };
}

const withoutLegacy = (patch: Snapshot): Snapshot => ({ ...FULL_LEGACY, ...patch });
const withoutContainer = (patch: Snapshot): Snapshot => ({
  ...FULL_LEGACY,
  resume_profile: { ...FULL_CONTAINER, ...patch },
});
const drop =
  (patch: Snapshot, tradeSheet: TradeSheet = TRADE_SHEET) =>
  (branch: Branch) => ({
    snapshot: branch === "legacy" ? withoutLegacy(patch) : withoutContainer(patch),
    tradeSheet,
  });

const SEGMENTS: readonly SegmentRule[] = [
  {
    id: "role",
    line: "headline",
    present: /CNC Turner/,
    collapses: true,
    drop: drop({ role_label: null }),
  },
  {
    id: "years",
    line: "headline",
    present: /6 yrs/,
    collapses: false,
    substitute: /duration not stated/,
    // ONE PLACE ON BOTH BRANCHES. `statedYears` is read off `draft.experience.total_years` even
    // on the container path, because the résumé container has no field for it — so dropping a
    // container-shaped key here would have "passed" while the segment still rendered.
    drop: () => ({
      snapshot: withoutLegacy({ experience: { total_years: null } }),
      tradeSheet: TRADE_SHEET,
    }),
  },
  {
    id: "tools",
    line: "headline",
    // The pack's headline row: a turner's controller. Dropping it means dropping BOTH sources,
    // the pack answers and the free-text skills, or the fallback quietly keeps the segment alive
    // and the "absent" case would never be absent.
    present: /Fanuc/i,
    collapses: true,
    drop: drop({ skills: [] }, null),
  },
  {
    id: "city",
    line: "subhead",
    present: /Faridabad/,
    collapses: true,
    drop: (branch) => ({
      snapshot:
        branch === "legacy"
          ? withoutLegacy({ location_preference: { current_city: null, preferred_cities: [] } })
          : withoutContainer({ current_city: null }),
      tradeSheet: TRADE_SHEET,
    }),
  },
  {
    id: "availability",
    line: "subhead",
    present: /available in 15 days/i,
    collapses: true,
    drop: (branch) => ({
      snapshot:
        branch === "legacy"
          ? withoutLegacy({ availability: { status: "unknown" } })
          : withoutContainer({ availability: null }),
      tradeSheet: TRADE_SHEET,
    }),
  },
  {
    id: "salary",
    line: "subhead",
    present: /expects/i,
    collapses: true,
    drop: (branch) => ({
      snapshot:
        branch === "legacy"
          ? withoutLegacy({ salary_expectation: { amount_min: null, amount_max: null } })
          : withoutContainer({ expected_salary: null }),
      tradeSheet: TRADE_SHEET,
    }),
  },
];

function lineOf(input: ReturnType<typeof render>["input"], line: "headline" | "subhead"): string {
  return (line === "headline" ? input.headlineLine : input.subheadLine) ?? "";
}

/** The §6.2 failure mode, stated once: a separator with nothing on one side of it. */
function expectNoDanglingSeparator(text: string): void {
  expect(text).not.toMatch(/·\s*·/);
  expect(text).not.toMatch(/·\s*$/);
  expect(text).not.toMatch(/^\s*·/);
}

describe.each(BRANCHES)("§6.2 collapse rules, both halves [%s branch]", (branch) => {
  describe.each(SEGMENTS)("the $id segment", (segment) => {
    it("RENDERS when it has a value, on the line §6.2 puts it on", () => {
      // THE HALF THAT WAS MISSING. Everything below this was already asserted somewhere; this
      // is the assertion that caught a segment silently hardcoded to null on one branch.
      const { input } = render(branch, FULL_LEGACY);
      expect(lineOf(input, segment.line)).toMatch(segment.present);
    });

    it("is on the RENDERED PAGE, not just in the mapper's output", () => {
      // Between the mapper and the page sit `joinSegments`, the slot engine, the degradation
      // ladder and the template's own literals. Reading the mapper is reading the intent.
      const { html } = render(branch, FULL_LEGACY);
      expect(html).toMatch(segment.present);
    });

    it(
      segment.collapses
        ? "takes its SEPARATOR with it when it has no value"
        : "SUBSTITUTES rather than collapsing, because silence would read as a claim",
      () => {
        const { snapshot, tradeSheet } = segment.drop(branch);
        const { input } = render(branch, snapshot, tradeSheet);
        const text = lineOf(input, segment.line);
        if (segment.collapses) {
          expect(text).not.toMatch(segment.present);
        } else {
          expect(text).toMatch(segment.substitute!);
        }
        expectNoDanglingSeparator(text);
        // NOT VACUOUS: the line must still carry its other segments. Every collapse assertion
        // above is satisfied by rendering nothing at all, which is the failure this whole file
        // is a response to.
        expect(text.length).toBeGreaterThan(0);
      },
    );
  });

  it("keeps §6.2's segment ORDER on both lines", () => {
    // A segment in the wrong position passes every "does the text appear" check ever written.
    const { input } = render(branch, FULL_LEGACY);
    for (const line of ["headline", "subhead"] as const) {
      const text = lineOf(input, line);
      const positions = SEGMENTS.filter((s) => s.line === line).map((s) => ({
        id: s.id,
        at: text.search(s.present),
      }));
      for (const p of positions) {
        expect(p.at, `${p.id} is missing from the ${line} line`).toBeGreaterThanOrEqual(0);
      }
      const ordered = [...positions].sort((a, b) => a.at - b.at).map((p) => p.id);
      expect(ordered).toEqual(positions.map((p) => p.id));
    }
  });

  it("renders the whole strip with no dangling separator when EVERY segment is empty", () => {
    // The other end of the range. A sheet for a worker who answered almost nothing must still
    // be a sheet, not a row of orphaned dots.
    const empty =
      branch === "legacy"
        ? { experiences: [] }
        : { experiences: [], resume_profile: { experiences: [] } };
    const { input, html } = render(branch, empty, null);
    expectNoDanglingSeparator(lineOf(input, "headline"));
    expectNoDanglingSeparator(lineOf(input, "subhead"));
    const text = html.replace(/<[^>]*>/g, " ").replace(/&middot;|&#183;/g, "·");
    expect(text).not.toMatch(/·\s*·/);

    const outDir = process.env.EMIT_VERDICT_COLLAPSE;
    if (outDir) {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `verdict-empty-${branch}.html`), html, "utf8");
      writeFileSync(
        join(outDir, `verdict-full-${branch}.html`),
        render(branch, FULL_LEGACY).html,
        "utf8",
      );
    }
  });
});

/**
 * THE FOURTH HEADLINE SEGMENT, WHICH NO MAPPER BRANCH CAN FILL.
 *
 * `buildVerdictLine` takes `axes` and the renderer's slot contract has documented the headline as
 * "role · years · controllers · axis" since the sheet shipped — but NEITHER call site in
 * `resume-render-input.ts` passes it, so the segment has never rendered for anybody. That is not
 * the same class of bug as the salary one: there is no turner source for it (`qp_cnc_turning` has
 * no axis question — axes are a MILLING fact), so the segment is correctly empty today and
 * incorrectly UNREACHABLE tomorrow.
 *
 * Asserted at the function, which is the only layer that can hold a value for it, plus a pin on
 * the reachability itself. When milling lands, the pin's second half goes red and the wiring is
 * what turns it green again.
 *
 * R16 §1 — MILLING LANDED AND THE WIRING IS DONE, so the second half is gone. What it was
 * guarding is now asserted where it can actually be observed: `branch-parity.audit.test.ts`
 * renders a `qp_vmc_milling` sheet down BOTH mapper branches and requires the segment. This
 * file keeps the function-level composition and the turner's collapse.
 */
describe("the axes segment (§6.2's fourth — wired on both branches in R16 §1)", () => {
  it("renders and collapses correctly at the function level", () => {
    const facts = {
      role: "VMC Operator",
      years: 6,
      tools: ["Fanuc"],
      city: "Faridabad",
      availability: "Immediate",
      salary: null,
    };
    const withAxes = buildVerdictLine({ ...facts, axes: ["3-axis", "4-axis"] });
    expect(withAxes.headlineLine).toContain("3 & 4-axis");
    // Order: it is the LAST headline segment.
    expect(withAxes.headlineLine!.indexOf("3 & 4-axis")).toBeGreaterThan(
      withAxes.headlineLine!.indexOf("Fanuc"),
    );

    const without = buildVerdictLine(facts);
    expect(without.headlineLine).not.toMatch(/axis/);
    expectNoDanglingSeparator(without.headlineLine ?? "");
  });

  it("is still absent for a TURNER, whose pack asks no axis question", () => {
    // WAS "is NOT reachable from a stored profile — measured, and this is the pin", and the pin
    // said to delete it rather than loosen it if it ever went green. R16 §1 wired both branches,
    // so it is deleted — but the turner half of it is kept, because that is the assertion with a
    // future: the segment must still COLLAPSE for a trade that asks no axis question, separator
    // and all.
    //
    // AND THE OLD PIN COULD NEVER HAVE SEEN THE FIX. Its fixture is a turner sheet, and
    // `qp_cnc_turning` has no `axis_capability` question — so it would have gone on passing,
    // green and reassuring, on the day the wiring landed. A pin whose fixture cannot reach the
    // thing it pins is a claim about the fixture, not about the code. The reachability assertion
    // now lives in `branch-parity.audit.test.ts` against a MILLING sheet, on both branches.
    const { input } = render("container", FULL_LEGACY);
    expect(input.headlineLine ?? "").not.toMatch(/axis/i);
    expectNoDanglingSeparator(input.headlineLine ?? "");
  });
});
