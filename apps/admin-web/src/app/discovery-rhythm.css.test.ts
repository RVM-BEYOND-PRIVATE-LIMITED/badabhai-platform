import { describe, expect, it } from "vitest";
import { decl, globalsCss, rule, rules } from "../../test/css-rules";

/**
 * /skills/discovery's vertical rhythm (#1856). Each block of the page used to ride on whatever
 * margin its pieces happened to carry, measured in Chrome at 375 and 1280: four loose page
 * children for one metrics block (a full page gap apart), 0px between the tier caption and the
 * batch-order row, 0px between the filter form and the first result, 0px above the trailing
 * captions. These pin the stacks that replaced them. The markup side (which element carries
 * which class) is pinned in `(portal)/skills/discovery/page.render.test.tsx`.
 */
const CSS = globalsCss();
const own = (selector: string) => {
  const body = rule(CSS, selector);
  expect(body, `${selector} must be declared at top level`).not.toBeNull();
  return body!;
};

describe("discovery rhythm", () => {
  it("the metrics block and the queue controls are each one stack with one gap", () => {
    const stack = own(".queue-metrics, .queue-controls");
    expect(decl(stack, "display")).toBe("flex");
    expect(decl(stack, "flex-direction")).toBe("column");
    // The chip rows' old trailing margin, now owned by the stack.
    expect(decl(stack, "gap")).toBe("var(--space-4)");
    expect(decl(own(".queue-controls .filters--inline"), "margin-bottom")).toBe("0");
  });

  it("a caption sits closer to what it explains than to the next block", () => {
    // The tier tabs' caption group is gone (its caption is a foot note since AW-02); the foot
    // notes and the metrics' captions keep the tight step.
    const group = own(".queue-notes");
    expect(decl(group, "gap")).toBe("var(--space-2)");
  });

  it("More filters' body is one stack at the controls stack's own gap (AW-02)", () => {
    const body = own(".queue-filters__body");
    expect(decl(body, "display")).toBe("flex");
    expect(decl(body, "flex-direction")).toBe("column");
    expect(decl(body, "gap")).toBe(decl(own(".queue-metrics, .queue-controls"), "gap"));
  });

  it("the results and the trailing captions stand off the controls by the pager's step", () => {
    const pagerStep = decl(own(".pager"), "margin-top");
    expect(pagerStep).toBe("var(--space-5)");
    expect(decl(own(".queue-controls"), "margin-block-end")).toBe(pagerStep);
    expect(decl(own(".queue-notes--foot"), "margin-block-start")).toBe(pagerStep);
  });

  it("on a phone the two metric tile rows stay one grid (row gap = tile gap)", () => {
    const phone = (selector: string) =>
      rules(CSS, true).find(
        (r) => r.selector === selector && r.atRules.join() === "@media (max-width: 600px)",
      );
    expect(decl(phone(".queue-metrics")!.body, "gap")).toBe(decl(phone(".stats")!.body, "gap"));
  });

  it("an action label never breaks inside its button; the row wraps instead", () => {
    expect(decl(own(".queue-controls .filters__actions"), "flex-wrap")).toBe("wrap");
    expect(decl(own(".queue-controls .filters__actions .btn"), "white-space")).toBe("nowrap");
  });

  it("the two actions take a full row under the fields, never one 13rem track", () => {
    // In one track the pair stacked, Apply 56px above the last field row at 768-1280 (measured).
    // Spanning every track keeps both on one line at every width; on a one-track phone grid it
    // is the same single track, so the phone layout is unchanged.
    expect(decl(own(".queue-controls .filters__actions"), "grid-column")).toBe("1 / -1");
  });

  it("a batch card nested in the queue panel takes the small panel pad", () => {
    expect(decl(own(".reviewgroups > .panel"), "padding")).toBe("var(--panel-pad-sm)");
  });
});
