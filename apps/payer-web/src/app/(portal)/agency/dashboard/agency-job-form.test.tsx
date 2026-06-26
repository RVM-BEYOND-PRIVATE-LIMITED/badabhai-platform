import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { agencyJobInputSchema } from "../../../../lib/contracts";

/**
 * AGENCY-JOB-FORM validation tests (C9). The form's inline `validate()` mirrors the shared
 * `agencyJobInputSchema` (contracts.ts), which the server Zod + backend DTO keep as the
 * AUTHORITY. We cover C9 at two layers:
 *
 *  1. SCHEMA (the authority the form mirrors): empty title/city, payMax<payMin, maxExp<minExp,
 *     and over-bound pay/experience are rejected; a complete valid input is accepted.
 *  2. FORM RENDER (UX parity, DS3.1): with hooks mocked to inject field state, assert that
 *     - a BLANK form (empty title/city) renders the submit button DISABLED (disable-until-valid),
 *     - an injected field error sets `aria-invalid` on the DS Input host AND surfaces the error
 *       TEXT in the DS Input's `.bb-field__error` slot (no id'd error element — the DS Input
 *       owns its error slot, mirroring the employer posting-form re-skin),
 *     - a fully-valid form renders the submit button ENABLED.
 *
 * Env is node (no DOM, no @testing-library); we inject React state via a `useState` mock and
 * render the component function to an element tree, then walk it. The fields are now DESIGN-
 * SYSTEM primitives (`Input`/`Select`/`Button`/`Card` from components/ds) — pure, hookless
 * function components — so the walker RENDERS each function component one level deep
 * (`el.type(el.props)`) to reach the native `<input>`/`<select>`/`<button>` host each DS
 * field still emits (with the SAME explicit `id`). `useTransition` → [pending=false,
 * run-immediately] so the form is never stuck "Saving…".
 */

/* ── 1. SCHEMA — the validation authority the form mirrors (C9) ───────────────── */

const VALID = { tradeKey: "cnc_operator", title: "CNC Operator", city: "Pune" } as const;
const PAY_MAX_INR = 10_000_000;
const EXPERIENCE_MAX_YEARS = 60;

describe("agencyJobInputSchema — the C9 validation authority", () => {
  it("accepts a complete valid input", () => {
    expect(agencyJobInputSchema.safeParse(VALID).success).toBe(true);
    expect(
      agencyJobInputSchema.safeParse({
        ...VALID,
        payMin: 20000,
        payMax: 35000,
        minExperienceYears: 1,
        maxExperienceYears: 5,
        neededBy: "soon",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(agencyJobInputSchema.safeParse({ ...VALID, title: "" }).success).toBe(false);
  });

  it("rejects an empty city", () => {
    expect(agencyJobInputSchema.safeParse({ ...VALID, city: "" }).success).toBe(false);
  });

  it("rejects payMax < payMin (cross-field)", () => {
    expect(
      agencyJobInputSchema.safeParse({ ...VALID, payMin: 50000, payMax: 40000 }).success,
    ).toBe(false);
  });

  it("rejects maxExperienceYears < minExperienceYears (cross-field)", () => {
    expect(
      agencyJobInputSchema.safeParse({
        ...VALID,
        minExperienceYears: 5,
        maxExperienceYears: 3,
      }).success,
    ).toBe(false);
  });

  it("rejects over-bound pay (> ₹ ceiling) and over-bound experience (> years ceiling)", () => {
    expect(agencyJobInputSchema.safeParse({ ...VALID, payMax: PAY_MAX_INR + 1 }).success).toBe(false);
    expect(agencyJobInputSchema.safeParse({ ...VALID, payMin: PAY_MAX_INR + 1 }).success).toBe(false);
    expect(
      agencyJobInputSchema.safeParse({ ...VALID, maxExperienceYears: EXPERIENCE_MAX_YEARS + 1 })
        .success,
    ).toBe(false);
    expect(
      agencyJobInputSchema.safeParse({ ...VALID, minExperienceYears: EXPERIENCE_MAX_YEARS + 1 })
        .success,
    ).toBe(false);
  });

  it("rejects an out-of-set trade key (cannot smuggle an arbitrary string)", () => {
    expect(agencyJobInputSchema.safeParse({ ...VALID, tradeKey: "rocket_scientist" }).success).toBe(
      false,
    );
  });
});

/* ── 2. FORM RENDER — disable-until-valid + aria wiring (C9 UX parity) ──────────── */

// Injected per-render state queue; each useState() call pops the next seed in order.
let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => useTransition(),
  };
});

const { AgencyJobForm } = await import("./agency-job-form");

// The form calls useState in source order: fields, fieldErrors, error, pending(useTransition).
function render(seed: { fields: Record<string, string>; fieldErrors: Record<string, unknown> }) {
  stateQueue = [seed.fields, seed.fieldErrors, null];
  stateCursor = 0;
  return AgencyJobForm({
    mode: "create",
    submitLabel: "Post vacancy",
    onSubmit: async () => ({ ok: true }),
  }) as ReactElement;
}

interface Collected {
  buttons: Array<{ type?: string; disabled?: boolean; text: string }>;
  aria: Array<{ id?: string; ariaInvalid?: unknown; ariaDescribedby?: unknown }>;
  ids: string[];
  /** Every rendered text fragment (DS error/hint slots have no id) — for error-shown assertions. */
  texts: string[];
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  // Render a function component one level so its text children (e.g. a Button label) are reachable.
  if (typeof el.type === "function") {
    const fn = el.type as (props: unknown) => ReactNode;
    return textOf(fn(el.props));
  }
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

/**
 * DS3.1: the form's fields are DESIGN-SYSTEM primitives — pure, hookless function components
 * (`Input`/`Select`/`Button`/`Card`). The component function returns an element TREE of those
 * (not yet the native hosts), so the walker RENDERS each function component one level deep to
 * reach the `<input>`/`<select>`/`<button>` host each still emits (with the SAME explicit
 * `id`), keeping the aria + button + error-text assertions valid.
 */
function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  // A DS primitive (function component) — render it one level, then walk its output.
  if (typeof el.type === "function") {
    const fn = el.type as (props: unknown) => ReactNode;
    walk(fn(el.props), acc);
    return;
  }
  if (el.type === "button") {
    acc.buttons.push({
      type: el.props.type as string | undefined,
      disabled: el.props.disabled as boolean | undefined,
      text: textOf(el.props.children).trim(),
    });
  }
  if (el.type === "input") {
    acc.aria.push({
      id: el.props.id as string | undefined,
      ariaInvalid: el.props["aria-invalid"],
      ariaDescribedby: el.props["aria-describedby"],
    });
  }
  if (typeof el.props.id === "string") acc.ids.push(el.props.id);
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], aria: [], ids: [], texts: [] };
  walk(tree, acc);
  return acc;
}

const BLANK_FIELDS = {
  tradeKey: "cnc_operator",
  title: "",
  city: "",
  area: "",
  payMin: "",
  payMax: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  neededBy: "",
};
const VALID_FIELDS = { ...BLANK_FIELDS, title: "CNC Operator", city: "Pune" };

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
});

describe("AgencyJobForm render — disable-submit-until-valid (C9)", () => {
  it("a BLANK form (empty title/city) renders the submit button DISABLED", () => {
    const { buttons } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    const submit = buttons.find((b) => b.type === "submit");
    expect(submit).toBeDefined();
    expect(submit!.disabled).toBe(true);
  });

  it("a fully-valid form (title + city set) renders the submit button ENABLED", () => {
    const { buttons } = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }));
    const submit = buttons.find((b) => b.type === "submit");
    expect(submit!.disabled).toBe(false);
  });
});

describe("AgencyJobForm render — aria-invalid + visible DS error on an invalid field (C9)", () => {
  it("sets aria-invalid on the title DS Input host and surfaces the DS error text", () => {
    // DS3.1: the DS Input renders its error in a `.bb-field__error` slot (no id'd element), so we
    // assert the error TEXT is shown + aria-invalid is set on the host — the disable-until-valid +
    // body-shape guarantees (asserted elsewhere) are untouched.
    const errorMsg = "Enter a role title.";
    const { aria, texts } = collect(
      render({ fields: BLANK_FIELDS, fieldErrors: { title: errorMsg } }),
    );
    const title = aria.find((a) => a.id === "title");
    expect(title).toBeDefined();
    expect(title!.ariaInvalid).toBe(true);
    // The DS Input surfaces the error message via its error slot (visible to the user).
    expect(texts).toContain(errorMsg);
  });

  it("leaves aria-invalid UNSET on a valid field (no false error wiring)", () => {
    const { aria } = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }));
    const city = aria.find((a) => a.id === "city");
    expect(city!.ariaInvalid).toBeUndefined();
  });
});
