import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Input, Select, Textarea } from "./index";

/**
 * #2588 (W8) — a DS field rendered WITHOUT an `id` takes one from `useId`: the same on every render
 * of the same tree (so the server's HTML and the browser's hydration agree), unique per field, and
 * shared by the label, the control and the feedback line.
 *
 * The module-level counter it replaced kept counting across requests on the server and restarted
 * in the browser: the second render of the same form minted new ids, so the hydrated control's id
 * no longer matched the `<label for>` / `aria-describedby` the server had sent.
 */
function Form() {
  return (
    <form>
      <Input label="Company name" hint="As on your GST certificate." />
      <Select label="Pay type" error="Pick one.">
        <option value="">—</option>
      </Select>
      <Textarea label="About the role" hint="Two lines is enough." />
    </form>
  );
}

/** Every `attr="value"` in the markup, in document order. */
const values = (out: string, attr: string) =>
  Array.from(out.matchAll(new RegExp(`\\s${attr}="([^"]+)"`, "g")), (m) => m[1]!);

describe("DS fields — an auto id is stable across renders and shared by its parts", () => {
  it("the same form renders the SAME ids twice (a second request; a hydration)", () => {
    const first = renderToString(<Form />);
    const second = renderToString(<Form />);
    expect(values(first, "id").length).toBeGreaterThanOrEqual(3);
    expect(second).toBe(first);
  });

  it("each field's label, control and feedback line share ONE id, unique across the fields", () => {
    const out = renderToString(<Form />);
    const labels = values(out, "for");
    const controls = Array.from(
      out.matchAll(/<(?:input|select|textarea)\b[^>]*\sid="([^"]+)"[^>]*>/g),
      (m) => m[1]!,
    );
    expect(labels).toEqual(controls);
    expect(new Set(controls).size).toBe(3);
    expect(controls[0]).toMatch(/^bb-input-/);
    expect(controls[1]).toMatch(/^bb-select-/);
    expect(controls[2]).toMatch(/^bb-textarea-/);
    // The hint / error line is the control's description, keyed off the same id.
    expect(values(out, "aria-describedby")).toEqual(controls.map((id) => `${id}-msg`));
    for (const id of controls) expect(out).toContain(`<span id="${id}-msg"`);
  });

  it("a caller's id wins, and the fields around it keep their own stable ids", () => {
    const out = renderToString(
      <form>
        <Input id="email" label="Work email" />
        <Input label="Phone" />
      </form>,
    );
    const ids = values(out, "id");
    expect(ids[0]).toBe("email");
    expect(values(out, "for")).toEqual(["email", ids[1]]);
    expect(ids[1]).toMatch(/^bb-input-/);
    expect(renderToString(
      <form>
        <Input id="email" label="Work email" />
        <Input label="Phone" />
      </form>,
    )).toBe(out);
  });
});
