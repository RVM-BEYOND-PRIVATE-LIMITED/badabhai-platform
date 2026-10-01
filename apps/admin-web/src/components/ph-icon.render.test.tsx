import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhIcon } from "./ph-icon";

/**
 * The inline Phosphor glyph. Pinned whole: the path is Phosphor's `list` FILL weight verbatim
 * (`@phosphor-icons/core` 2.1.1, `assets/fill/list-fill.svg`) — the same glyph payer-web's
 * `ph-fill ph-list` webfont draws — and the element must stay decorative, since the control
 * around it carries the accessible name.
 */
const LIST_FILL =
  "M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Z" +
  "M192,184H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Zm0-48H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Z" +
  "m0-48H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Z";

describe("PhIcon", () => {
  it("renders the list FILL glyph as a decorative, unfocusable SVG", () => {
    expect(renderToStaticMarkup(<PhIcon name="list" />)).toBe(
      '<svg class="ph-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">' +
        `<path d="${LIST_FILL}"></path></svg>`,
    );
  });

  it("carries no stroke or colour of its own — it is a solid fill in the current colour", () => {
    // Colour and size are the CSS's (`.ph-icon`: 1em, fill: currentColor). A stroke attribute
    // would be the thin outline weight the brand does not allow.
    const out = renderToStaticMarkup(<PhIcon name="list" />);
    expect(out).not.toContain("stroke");
    expect(out).not.toContain("fill=");
    expect(out).not.toContain("width=");
  });
});
