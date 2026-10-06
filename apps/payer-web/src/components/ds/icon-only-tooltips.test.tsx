import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog, MaskedCandidate, Toast } from "./index";

/**
 * Final sweep C (F26 / F34) — the DS's icon-only controls are the shared icon-only control
 * (IconButtonBase, @badabhai/icons/button): the label is the ONE accessible name AND the visible
 * tooltip (`.bb-icon-tip`, hover + keyboard focus, Escape-dismissable — behaviour tested once in
 * packages/icons). Measured before: Dialog's ✕ and Toast's ✕ were named but had no tooltip.
 * Real SSR, asserting the exact control markup.
 */
describe("Dialog — the close ✕", () => {
  it("is the shared control: 'Close' as its name and its tooltip, opening inward from the corner", () => {
    const out = renderToStaticMarkup(
      <Dialog open title="Buy credits" onClose={() => {}}>
        Body
      </Dialog>,
    );
    expect(out).toContain(
      '<button type="button" class="bb-iconbtn" aria-label="Close">' +
        '<i class="ph-fill ph-x" aria-hidden="true"></i>' +
        '<span class="bb-icon-tip bb-icon-tip--bottom-end" aria-hidden="true">Close</span>' +
        "</button>",
    );
  });

  it("is absent without onClose (no ✕, no tooltip)", () => {
    const out = renderToStaticMarkup(
      <Dialog open title="Read only">
        Body
      </Dialog>,
    );
    expect(out).not.toContain("bb-iconbtn");
    expect(out).not.toContain("bb-icon-tip");
  });
});

describe("Toast — the dismiss ✕", () => {
  it("is the shared control in the toast's skin: 'Dismiss' as its name and its tooltip", () => {
    const out = renderToStaticMarkup(
      <Toast tone="success" title="Contact unlocked" onClose={() => {}}>
        Ready
      </Toast>,
    );
    expect(out).toContain(
      '<button type="button" class="bb-toast__close" aria-label="Dismiss">' +
        '<i class="ph-fill ph-x" aria-hidden="true"></i>' +
        '<span class="bb-icon-tip bb-icon-tip--top-end" aria-hidden="true">Dismiss</span>' +
        "</button>",
    );
  });

  it("is absent without onClose", () => {
    expect(renderToStaticMarkup(<Toast title="Saved" />)).not.toContain("bb-toast__close");
  });
});

describe("MaskedCandidate — the verified seal (F34)", () => {
  it("is a NAMED status image (role=img 'Verified'), drawn by the typed glyph at the sm size", () => {
    const out = renderToStaticMarkup(<MaskedCandidate name="Ramesh K." verified />);
    expect(out).toContain(
      '<i class="ph-fill ph-seal-check bb-icon--sm bb-candidate__verified" role="img" aria-label="Verified"></i>',
    );
    // No inline style: the colour is the stylesheet's (tokens), not a literal in the markup.
    expect(out).not.toMatch(/<i [^>]*style=/);
  });
});
