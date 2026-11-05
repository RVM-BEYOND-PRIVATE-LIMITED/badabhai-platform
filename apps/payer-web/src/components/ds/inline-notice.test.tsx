import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineNotice } from "./index";

describe("InlineNotice — the one calm inline message surface", () => {
  it("renders a tinted notice with a solid decorative glyph", () => {
    const out = renderToStaticMarkup(
      <InlineNotice tone="danger" title="Couldn't save">
        Check the highlighted fields.
      </InlineNotice>,
    );
    expect(out).toContain('class="bb-inline-notice bb-inline-notice--danger"');
    expect(out).toContain("bb-inline-notice__title");
    expect(out).toContain("Couldn&#x27;t save");
    expect(out).toContain("Check the highlighted fields.");
    expect(out).toContain('aria-hidden="true"');
  });

  it("defaults to info and renders an optional action", () => {
    const out = renderToStaticMarkup(
      <InlineNotice action={<button type="button">Retry</button>}>Still processing.</InlineNotice>,
    );
    expect(out).toContain("bb-inline-notice--info");
    expect(out).toContain("bb-inline-notice__action");
    expect(out).toContain("Retry");
  });

  it("is not a live region of its own (the caller owns announcing)", () => {
    const out = renderToStaticMarkup(<InlineNotice tone="warning">Careful.</InlineNotice>);
    expect(out).not.toMatch(/role="(?:alert|status)"|aria-live/);
  });
});
