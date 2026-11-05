import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PasswordField } from "./password-field";

/**
 * #2587 — the password field as the browser receives it (real React SSR, the real DS Input and the
 * shared IconButton): the label names the input, the input is a masked, UNNAMED, autocomplete-hinted
 * password, and the eye is the shared icon-only control — named, tooltipped, controlling the input,
 * and a 52px (`lg`) target beside a 52px input.
 */
function markup(props: Partial<Parameters<typeof PasswordField>[0]> = {}): string {
  return renderToStaticMarkup(
    <PasswordField
      id="login-password"
      label="Password"
      value=""
      onChange={() => {}}
      autoComplete="current-password"
      {...props}
    />,
  );
}
const inputTag = (html: string) => /<input[^>]*>/.exec(html)![0];

describe("PasswordField — the markup", () => {
  it("the label names the input (for ↔ id)", () => {
    const html = markup();
    expect(html).toContain('<label class="bb-field__label" for="login-password">Password</label>');
    expect(inputTag(html)).toContain('id="login-password"');
  });

  it("a masked password with the autocomplete hint, never auto-corrected, and NO name", () => {
    const tag = inputTag(markup());
    expect(tag).toContain('type="password"');
    expect(tag).toContain('autoComplete="current-password"');
    expect(tag).toContain('autoCapitalize="none"');
    expect(tag).toContain('autoCorrect="off"');
    expect(tag).toContain('spellCheck="false"');
    // Unnamed: a native (pre-hydration) submit can never serialize it into a URL or request.
    expect(tag).not.toMatch(/\bname=/);
    expect(inputTag(markup({ autoComplete: "new-password" }))).toContain('autoComplete="new-password"');
  });

  it("the eye: the shared icon-only control, named 'Show password' (its tooltip too), controlling the input", () => {
    const html = markup();
    expect(html).toContain(
      '<button aria-controls="login-password" type="button" class="bb-iconbtn bb-iconbtn--outline bb-iconbtn--lg login-secret__toggle" aria-label="Show password">' +
        '<i class="ph-fill ph-eye" aria-hidden="true"></i>' +
        '<span class="bb-icon-tip bb-icon-tip--top-end" aria-hidden="true">Show password</span>' +
        "</button>",
    );
    // No morph on arrival.
    expect(html).not.toContain("data-morph");
  });

  it("an error is the input's description and marks it invalid; extra description ids come first", () => {
    const html = markup({ error: "Enter your password.", describedBy: "rules" });
    const tag = inputTag(html);
    expect(tag).toContain('aria-invalid="true"');
    expect(tag).toContain('aria-describedby="rules login-password-msg"');
    expect(html).toContain('id="login-password-msg"');
    expect(html).toContain("Enter your password.");
  });

  it("the show/hide status region is present and silent until the payer toggles", () => {
    expect(markup()).toContain('<span class="sr-only" aria-live="polite"></span>');
  });
});
