import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStuck, StuckCandidate } from "../lib/journey";
import { StuckPanel } from "./stuck-panel";

/**
 * What the stuck-question panel actually RENDERS.
 *
 * ══ THE REGRESSION THIS FILE GUARDS ════════════════════════════════════════════════════
 * On `outcome: "engine_advanced_past_all"` there was NO question on screen — the interview had
 * already closed, and a `close` decision advances past whatever was showing, so every unsettled
 * question ends up flagged that way. That is the MODAL shape for a session a worker finished.
 * A panel that headlines the top candidate there accuses a question the worker met on their way
 * to COMPLETING the interview, on most sessions.
 *
 * The candidates table still renders in that shape (those ARE the questions the worker never
 * settled), so "the key does not appear anywhere in the markup" would be the wrong assertion.
 * What must be absent is the HEADLINE treatment: the "Stuck on <key>" sentence and the named-
 * question tile block.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const CANDIDATE: StuckCandidate = {
  question_key: "salary_expected",
  asks: 1,
  ask_ceiling: 2,
  max_asks: 2,
  exhausted: false,
  unservable: false,
  engine_advanced_past: false,
  is_mandatory: true,
  is_core: true,
  pack_id: "universal_hi",
  pack_version: 5,
  display_order: 4,
};

const ADVANCED_PAST: StuckCandidate = {
  ...CANDIDATE,
  question_key: "language_spoken",
  engine_advanced_past: true,
  unservable: true,
  exhausted: true,
  asks: 1,
  ask_ceiling: 1,
  max_asks: 1,
  is_mandatory: false,
  is_core: false,
};

/** The tile label that exists ONLY when a question is being named. */
const NAMED_QUESTION_TILE = "The question on screen when it ended";

/** The label of the tile that answers the servability question, verbatim from the panel. */
const SERVABILITY_TILE = "Could the engine have served it again?";

/**
 * The VALUE rendered in the servability tile, or null when that tile is not on the page.
 *
 * Pinned to the tile the way `ai-spend-panel.render.test.tsx` pins the accrual date to its own
 * label. "unknown" reaches this markup from three independent places — this tile's ternary, the
 * candidates table's servability pill, and the notice body via `servability()` — so a bare
 * `toContain("unknown")` stays green after the tile's ternary is broken, which is the one thing
 * it is meant to catch.
 */
function servabilityTileValue(out: string): string | null {
  const m = out.match(
    new RegExp(
      `<span class="stat__value">([^<]*)</span><span class="stat__label">${SERVABILITY_TILE.replace("?", "\\?")}</span>`,
    ),
  );
  return m ? m[1]! : null;
}

function stuck(overrides: Partial<SessionStuck>): SessionStuck {
  return {
    outcome: "resolved",
    stuck_question: CANDIDATE,
    candidates: [CANDIDATE],
    asked_count: 14,
    settled_count: 8,
    unresolved_count: 0,
    ...overrides,
  };
}

describe("stuck panel — a real stall", () => {
  it("headlines the question, with asks against the ceiling and the servability", () => {
    const out = html(<StuckPanel stuck={stuck({})} />);
    expect(out).toContain("Stuck on salary_expected");
    expect(out).toContain(NAMED_QUESTION_TILE);
    expect(out).toContain("1 / 2");
    expect(out).toContain("Could the engine have served it again?");
    // Only a real stall is toned as a problem.
    expect(out).toContain("notice--warn");
  });

  it("shows the ranked candidates SUBORDINATE to the headline", () => {
    const out = html(
      <StuckPanel stuck={stuck({ candidates: [CANDIDATE, ADVANCED_PAST] })} />,
    );
    expect(out.indexOf("Stuck on salary_expected")).toBeLessThan(
      out.indexOf("language_spoken"),
    );
    expect(out).toContain("yes — recorded unanswered");
  });
});

describe("stuck panel — `engine_advanced_past_all` NAMES NOTHING", () => {
  const view = () =>
    html(
      <StuckPanel
        stuck={stuck({
          outcome: "engine_advanced_past_all",
          stuck_question: null,
          candidates: [ADVANCED_PAST],
        })}
      />,
    );

  it("renders no stuck-question headline and no named-question tile", () => {
    const out = view();
    expect(out).not.toContain("Stuck on");
    expect(out).not.toContain(NAMED_QUESTION_TILE);
    expect(out).toContain("No question was on screen");
    // Not toned as a problem: the interview finished.
    expect(out).not.toContain("notice--warn");
  });

  it("still lists the questions the worker never settled", () => {
    const out = view();
    expect(out).toContain("language_spoken");
    expect(out).toContain("never settled");
  });

  it("does not put the candidate's key in the headline sentence", () => {
    // The precise failure: promoting `candidates[0]` into the headline. The key may appear
    // in the TABLE; it must not appear before it.
    const out = view();
    const headlineEnd = out.indexOf("Questions this session never settled");
    expect(headlineEnd).toBeGreaterThan(-1);
    expect(out.slice(0, headlineEnd)).not.toContain("language_spoken");
  });
});

describe("stuck panel — the quiet outcomes", () => {
  it("`all_settled` renders no question and no candidates table", () => {
    const out = html(
      <StuckPanel stuck={stuck({ outcome: "all_settled", stuck_question: null, candidates: [] })} />,
    );
    expect(out).not.toContain(NAMED_QUESTION_TILE);
    expect(out).toContain("Every question asked was settled");
    expect(out).not.toContain("<table");
  });

  it("`no_conversation_state` explains the absence rather than showing an empty panel", () => {
    const out = html(
      <StuckPanel
        stuck={stuck({ outcome: "no_conversation_state", stuck_question: null, candidates: [] })}
      />,
    );
    expect(out).toContain("No interview state was saved");
    expect(out).not.toContain(NAMED_QUESTION_TILE);
  });

  it("an UNKNOWN outcome names nothing and says which outcome it was", () => {
    const out = html(
      <StuckPanel
        stuck={stuck({ outcome: "an_outcome_from_a_later_build", stuck_question: null })} />,
    );
    expect(out).not.toContain(NAMED_QUESTION_TILE);
    expect(out).toContain("an_outcome_from_a_later_build");
  });

  it("reports how far the engine got, in every shape", () => {
    for (const outcome of ["resolved", "engine_advanced_past_all", "all_settled"]) {
      const out = html(<StuckPanel stuck={stuck({ outcome, stuck_question: null })} />);
      expect(out, outcome).toContain("The engine served 14 questions");
    }
  });
});

describe("stuck panel — an unknown servability is shown as unknown", () => {
  const out = () =>
    html(
      <StuckPanel
        stuck={stuck({
          stuck_question: { ...CANDIDATE, unservable: null },
          candidates: [{ ...CANDIDATE, unservable: null }],
        })}
      />,
    );

  it("never renders a null `unservable` as a clean 'no' in the TILE", () => {
    // The tile specifically, not "the word appears somewhere": `servability()` and the
    // candidates pill both put "unknown" in this markup independently, so the loose form
    // survived breaking the very ternary this test is named for.
    expect(servabilityTileValue(out())).toBe("unknown");
  });

  it("never renders a null `unservable` as a clean 'no' in the candidates PILL", () => {
    // Toned `warn`, not muted: null is "the ranking could not judge this leg", which is not
    // the same fact as "the engine could never have served it again".
    expect(out()).toContain('<span class="pill pill--warn">unknown</span>');
  });
});
