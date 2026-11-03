import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NewPasswordFields, CONFIRM_MISMATCH } from "./new-password-fields";

/**
 * The new-password pair: the rule is shown before the first keystroke, a problem only once there
 * is something to judge, and every message is tied to its field (`aria-describedby`) so a screen
 * reader hears it with the field rather than somewhere else on the page.
 */
const render = (value: string, confirm: string) =>
  renderToStaticMarkup(
    <NewPasswordFields
      value={value}
      confirm={confirm}
      onChange={() => undefined}
      onConfirmChange={() => undefined}
    />,
  );

const inputs = (html: string) => html.match(/<input[^>]*>/g) ?? [];

describe("NewPasswordFields", () => {
  it("untouched: the rule as help, no error, nothing marked invalid", () => {
    const html = render("", "");
    expect(html).toContain("8–128 characters, with at least one letter and one digit.");
    expect(html).not.toContain("field__error");
    expect(html).not.toContain('aria-invalid="true"');
    for (const input of inputs(html)) expect(input).toMatch(/autocomplete="new-password"/i);
  });

  it("a failing value names the unmet rule and ties it to the field", () => {
    const html = render("abcdefgh", "");
    expect(html).toContain("Add at least one digit.");
    const field = inputs(html)[0]!;
    expect(field).toContain('aria-invalid="true"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(field)?.[1] ?? "";
    const problemId = /<p class="field__error" id="([^"]+)">Add at least one digit\./.exec(html)?.[1];
    expect(problemId).toBeDefined();
    expect(describedBy.split(" ")).toContain(problemId);
  });

  it("a mismatched confirmation says so on the confirmation field", () => {
    const html = render("MyOwnPass9", "MyOwnPass8");
    // React escapes the apostrophe in text.
    expect(html).toContain(CONFIRM_MISMATCH.replace("'", "&#x27;"));
    expect(inputs(html)[1]).toContain('aria-invalid="true"');
    expect(inputs(html)[0]).not.toContain('aria-invalid="true"');
  });

  it("a passing, matching pair shows no error", () => {
    const html = render("MyOwnPass9", "MyOwnPass9");
    expect(html).not.toContain("field__error");
  });
});
