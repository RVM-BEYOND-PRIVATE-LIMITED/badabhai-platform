import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * #1856 — web redesign wave-2 polish (payer-web). Node env, no layout engine: like the other
 * `*.css.test.ts` fences this pins the DECLARED geometry each fix depends on.
 *   · the last sub-44px controls get a 44px target on phones / coarse pointers only;
 *   · the batch-invite WhatsApp share is no longer captured by the url-truncation rule;
 *   · /postings/[id]/applicants and /agency/referrals keep their rhythm rules page-scoped.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RULES = parseRules(stripComments(readFileSync(join(here, "globals.css"), "utf8")));
const PHONE_OR_TOUCH = "@media (max-width: 600px), (pointer: coarse)";

const norm = (s: string) =>
  s
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();

/** The ONE rule whose selector list is exactly `selector` in the given at-rule context. */
function rule(selector: string, at = ""): Rule {
  const hits = RULES.filter((r) => norm(r.selector) === norm(selector) && r.at === at);
  expect(hits, `exactly one \`${selector}\` rule${at ? ` in ${at}` : ""}`).toHaveLength(1);
  return hits[0]!;
}

describe("#1856 · touch targets — 44px on phones and coarse pointers, desktop density unchanged", () => {
  it.each([
    [".pnav__link, .pshell__collapse", ".pnav__link"],
    [".login-mode", ".login-mode"],
    [".agency-batch__share", ".agency-batch__share"],
    [".agency-batch__item", ".agency-batch__item"],
  ])("%s is drawn at --control-md under the phone/touch query", (selector, base) => {
    expect(decl(rule(selector, PHONE_OR_TOUCH), "min-height")).toBe("var(--control-md)");
    // The top-level (mouse) rule keeps the dense 36px control.
    expect(decl(rule(base), "min-height")).toBe("var(--control-sm)");
  });

  it("the url link in a batch row takes the 44px line as its line-height (keeps its ellipsis)", () => {
    const url = rule(".agency-batch__item a:not(.agency-batch__share)", PHONE_OR_TOUCH);
    expect(decl(url, "line-height")).toBe("var(--control-md)");
    expect(decl(url, "display")).toBeNull();
  });
});

describe("#1856 · batch invite — the WhatsApp share is an action, never truncated", () => {
  it("the truncation rule excludes the share anchor", () => {
    const trunc = RULES.find(
      (r) =>
        decl(r, "text-overflow") === "ellipsis" && r.selector.includes(".agency-batch__item a"),
    );
    expect(trunc).toBeDefined();
    expect(norm(trunc!.selector)).toContain(".agency-batch__item a:not(.agency-batch__share)");
    expect(RULES.some((r) => norm(r.selector).split(",").includes(".agency-batch__item a"))).toBe(
      false,
    );
    expect(decl(rule(".agency-batch__share"), "overflow")).toBe("visible");
  });
});

describe("#1856 · /postings/[id]/applicants — header rhythm (layout only)", () => {
  it("the pipeline toolbar carries no margin of its own (the head's gap separates it)", () => {
    expect(decl(rule(".applicants-pipeline"), "margin-bottom")).toBeNull();
  });

  it("the list (or the empty-stage Card) opens a full section gap below the preamble alerts", () => {
    // Block flow: the margin collapses with the alert's --block-gap, so it must be the WHOLE
    // gap — a difference (section − block) would collapse into a no-op.
    const r = rule(".applicants-page .alert + :is(.applicants-list, .bb-card)");
    expect(decl(r, "margin-top")).toBe("var(--section-gap)");
    expect(decl(rule(".applicant__trade"), "letter-spacing")).toBe("var(--ui-h2-tracking)");
  });

  it("the card's trade headline is set in the display face", () => {
    expect(decl(rule(".applicant__trade"), "font-family")).toBe("var(--font-display)");
  });
});

describe("#1856 · /agency/referrals — one vertical rhythm, scoped to the page", () => {
  it("both invite tools are one --block-gap grid whose children drop their own margins", () => {
    const tool = rule(".agency-referrals-page .agency-section");
    expect(decl(tool, "display")).toBe("grid");
    expect(decl(tool, "gap")).toBe("var(--block-gap)");
    expect(decl(tool, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(decl(rule(".agency-referrals-page .agency-section > :not(.agency-batch__result)"), "margin")).toBe("0");
  });

  it("the consent note keeps the reading measure", () => {
    expect(decl(rule(".agency-referrals-page .agency-invite__note"), "max-width")).toBe(
      "var(--reading-max)",
    );
  });

  it("non-table panel bodies are a --block-gap grid; table panels are untouched", () => {
    const body = rule(".agency-referrals-page .panel:not(.panel--table) > .panel__body");
    expect(decl(body, "display")).toBe("grid");
    expect(decl(body, "gap")).toBe("var(--block-gap)");
    expect(decl(body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(
      decl(rule(".agency-referrals-page .panel:not(.panel--table) > .panel__body > *"), "margin"),
    ).toBe("0");
  });

  it("a funnel stat row steps to its progress bar by --block-gap", () => {
    expect(
      decl(rule(".agency-referrals-page .section > .stat-row:not(:last-child)"), "margin-bottom"),
    ).toBe("var(--block-gap)");
  });

  it("the shared, unscoped primitives were not restyled", () => {
    expect(decl(rule(".agency-section"), "display")).toBeNull();
    expect(decl(rule(".panel__body"), "display")).toBeNull();
    expect(decl(rule(".stat-row"), "margin-bottom")).toBe("var(--section-gap)");
  });
});
