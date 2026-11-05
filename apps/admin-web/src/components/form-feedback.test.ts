import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";

/**
 * #2689 rule 1 — the validation TIMING: no error on a first edit, blur/submit starts reporting,
 * the first invalid field is focused on submit, and a fixed field clears live.
 */
const h = vi.hoisted(() => ({ harness: null as unknown }));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useRef: () => ({ current: null }),
  };
});

const { useFormValidation: useValidation } = await import("./form-feedback");

let values = { email: "", password: "" };
let focused: string[] = [];

const useForm = () =>
  useValidation({
    order: ["email", "password"] as const,
    focus: (field) => focused.push(field),
    validate: () => {
      const errors: Partial<Record<"email" | "password", string>> = {};
      if (!values.email.includes("@")) errors.email = "Enter a valid email address.";
      if (values.password.length < 6) errors.password = "Use at least 6 characters.";
      return errors;
    },
  });

const render = () => harness().render(() => useForm());

beforeEach(() => {
  h.harness = createHookHarness();
  values = { email: "", password: "" };
  focused = [];
});

describe("useFormValidation timing", () => {
  it("shows nothing while the operator makes a first edit", () => {
    render();
    values.email = "nope";
    render();
    expect(render().visible).toEqual([]);
  });

  it("starts reporting after the field is blurred", () => {
    const first = render();
    values.email = "nope";
    first.onBlur("email");
    expect(render().errors.email).toBe("Enter a valid email address.");
  });

  it("keeps reporting live after the first error and clears the moment it is fixed", () => {
    const first = render();
    first.onBlur("email");
    values.email = "nope";
    render();
    expect(render().errors.email).toBe("Enter a valid email address.");
    values.email = "ops@example.com";
    expect(render().errors.email).toBeUndefined();
    expect(render().visible).toEqual([]);
  });

  it("on submit reports every invalid field, focuses the first and shakes once", () => {
    values = { email: "", password: "" };
    const form = render();
    expect(form.submit()).toBe("email");
    expect(focused).toEqual(["email"]);
    const after = render();
    expect(after.visible.map((e) => e.field)).toEqual(["email", "password"]);
    expect(after.shaking).toBe(true);
  });

  it("a valid submit returns null and focuses nothing", () => {
    values = { email: "ops@example.com", password: "hunter22" };
    const form = render();
    expect(form.submit()).toBeNull();
    expect(focused).toEqual([]);
  });

  it("the summary line appears only when several fields need attention", () => {
    values = { email: "", password: "" };
    const form = render();
    form.submit();
    expect(render().visible).toHaveLength(2);
    values.password = "hunter22";
    expect(render().visible).toHaveLength(1);
  });
});
