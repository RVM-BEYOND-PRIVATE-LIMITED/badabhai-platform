import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "./index";

/**
 * The DS IconButton is payer-web's SKIN over the shared IconButtonBase (@badabhai/icons/button):
 * these tests pin the class vocabulary it maps its typed variants onto, and that the shared
 * contract reaches through the wrapper. The behaviour — Escape on a focus- AND a hover-opened
 * tooltip, listener cleanup on leave and unmount — is tested once, on IconButtonBase, in
 * packages/icons (button.behaviour.test.tsx).
 */
describe("IconButton (payer DS)", () => {
  it("renders the shared control with payer-web's class root and the shared tooltip", () => {
    expect(renderToStaticMarkup(<IconButton icon="x" label="Close" />)).toBe(
      '<button type="button" class="bb-iconbtn" aria-label="Close">' +
        '<i class="ph-fill ph-x" aria-hidden="true"></i>' +
        '<span class="bb-icon-tip bb-icon-tip--top" aria-hidden="true">Close</span>' +
        "</button>",
    );
  });

  it("maps variant and size onto .bb-iconbtn modifiers (defaults add none)", () => {
    const out = renderToStaticMarkup(
      <IconButton
        icon="plus"
        label="Add"
        size="sm"
        variant="outline"
        tooltipPlacement="bottom-end"
        className="extra"
      />,
    );
    expect(out).toContain('class="bb-iconbtn bb-iconbtn--outline bb-iconbtn--sm extra"');
    expect(out).toContain('<span class="bb-icon-tip bb-icon-tip--bottom-end"');
    expect(
      renderToStaticMarkup(<IconButton icon="plus" label="Add" variant="ghost" size="md" />),
    ).toContain('class="bb-iconbtn"');
  });

  it("the shared contract reaches through the wrapper's types", () => {
    // @ts-expect-error — `label` is required.
    const noLabel = <IconButton icon="x" />;
    // @ts-expect-error — `title` is not accepted.
    const titled = <IconButton icon="x" label="Close" title="Close" />;
    // @ts-expect-error — the name comes from `label` only.
    const relabelled = <IconButton icon="x" label="Close" aria-label="Shut" />;
    // @ts-expect-error — "pencl-simple" is not an IconName.
    const typo = <IconButton icon="pencl-simple" label="Edit" />;
    // @ts-expect-error — the class root is the wrapper's, not the caller's.
    const rerooted = <IconButton icon="x" label="Close" classBase="evil" />;
    // @ts-expect-error — admin-web's variant does not exist here.
    const wrongSize = <IconButton icon="x" label="Close" size="xl" />;
    expect([noLabel, titled, relabelled, typo, rerooted, wrongSize].every(Boolean)).toBe(true);
  });
});
