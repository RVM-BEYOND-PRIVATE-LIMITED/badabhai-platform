import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { IconButtonBase } from "@badabhai/icons/button";
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

const VALID = {
  tradeKey: "cnc_operator",
  roleKind: "cnc_turner",
  title: "CNC Operator",
  city: "Pune",
} as const;
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

// Focus moves are DOM work; record where the form sends them.
const focusControl = vi.fn();
vi.mock("../../../../lib/form-focus", () => ({
  focusControl: (id: string) => focusControl(id),
  revealWholeControl: () => undefined,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => useTransition(),
  };
});

const { AgencyJobForm } = await import("./agency-job-form");

// The form calls useState in source order: fields, fieldErrors, error, requirements, benefits,
// reqDraft, benDraft, gap, revealed (then useTransition; the preview rail's sheet state after).
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
  // The shared icon-only control (a chip's remove button) is the one HOOKED primitive: record it
  // as the native button it renders — named by its label — instead of calling it outside React.
  if (el.type === IconButtonBase) {
    acc.buttons.push({
      type: "button",
      disabled: el.props.disabled as boolean | undefined,
      text: String(el.props.label),
    });
    return;
  }
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
  if (el.type === "input" || el.type === "select" || el.type === "textarea") {
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
    const city = aria.find((a) => a.id === "job-city");
    expect(city!.ariaInvalid).toBeUndefined();
  });

  it("its City box is #job-city — the dashboard's invite panel owns #city (one id, one box)", () => {
    const { aria, ids } = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }));
    expect(aria.find((a) => a.id === "job-city")).toBeDefined();
    expect(ids).not.toContain("city");
    expect(ids).not.toContain("city-msg");
  });
});

/* ── 3. THE PREVIEW RAIL + the shared read (agency create == publish; edit highlights) ── */

const JOB = {
  id: "00000001-0000-4000-8000-000000000001",
  status: "open",
  tradeKey: "cnc_operator",
  roleKind: null,
  title: "CNC Operator",
  city: "Pune",
  area: "Chakan",
  payMin: 20000,
  payMax: 35000,
  payType: null,
  minExperienceYears: 1,
  maxExperienceYears: 5,
  neededBy: "soon",
  shift: null,
  description: null,
  requirements: [],
  benefits: [],
  applicantsReceived: 3,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
} as const;

const FULL_AGENCY = {
  tradeKey: "cnc_operator",
  roleKind: "cnc_turner",
  title: "CNC Turner",
  city: "Pune",
  area: "Chakan MIDC",
  payMin: "18,000",
  payMax: "26000",
  payType: "in_hand",
  minExperienceYears: "2",
  maxExperienceYears: "5",
  shift: "day",
  neededBy: "soon",
  description: "Two machines per shift.",
};

function renderWith(
  fields: Record<string, string>,
  opts: {
    mode?: "create" | "edit";
    chips?: unknown[];
    onSubmit?: (i: unknown) => Promise<{ ok: true }>;
    gap?: { title: string; message: string; field: string } | null;
    lead?: ReactNode;
    error?: string | null;
  } = {},
) {
  // fields, fieldErrors, error, requirements, benefits, reqDraft, benDraft, gap
  stateQueue = [fields, {}, opts.error ?? null, ...(opts.chips ?? [[], [], "", ""]), opts.gap ?? null];
  stateCursor = 0;
  return AgencyJobForm({
    mode: opts.mode ?? "create",
    job: opts.mode === "edit" ? (JOB as never) : undefined,
    submitLabel: opts.mode === "edit" ? "Save changes" : "Post vacancy",
    onSubmit: (opts.onSubmit ?? (async () => ({ ok: true }))) as never,
    lead: opts.lead,
  }) as ReactElement;
}

function formOf(node: ReactNode): ReactElement<{ onSubmit: (e: unknown) => void }> | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = formOf(c);
      if (f) return f;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === "form") return el as ReactElement<{ onSubmit: (e: unknown) => void }>;
  if (typeof el.type === "function") return null;
  return el.props && "children" in el.props ? formOf(el.props.children) : null;
}

describe("AgencyJobForm — the preview rail + the shared read", () => {
  it("is a plain form (no nested card) beside the worker card and 'Also in your posting'", () => {
    const tree = renderWith(FULL_AGENCY);
    expect(formOf(tree)!.props).toMatchObject({ id: "agency-job-form-new", className: "agency-job-form" });
    const text = collect(tree).texts.join(" ").replace(/\s+/g, " ");
    expect(text).toContain("Chakan MIDC, Pune");
    expect(text).toContain("Trade (matching)");
    expect(text).toContain("Also in your posting");
  });

  it("EDIT highlights every gap still open (it promised to, and rendered none)", () => {
    const text = collect(renderWith({ ...FULL_AGENCY, payType: "", shift: "" }, { mode: "edit" }))
      .texts.join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("Still to fill:");
    expect(text).toContain("pick the pay type");
    expect(text).toContain("pick the shift");
    expect(text).toContain("You can save now and finish later.");
  });

  it('submits the SAME values the card shows: "18,000" → 18000, a typed chip kept, text trimmed', async () => {
    const onSubmit = vi.fn(async (_i: unknown) => ({ ok: true as const }));
    const tree = renderWith(
      { ...FULL_AGENCY, title: "  CNC Turner " },
      { chips: [["Fanuc control"], [], "", " Canteen "], onSubmit },
    );
    await formOf(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      title: "CNC Turner",
      payMin: 18000,
      payMax: 26000,
      requirements: ["Fanuc control"],
      benefits: ["Canteen"],
      roleKind: "cnc_turner",
      tradeKey: "cnc_operator",
    });
  });

  it('"1.5" years blocks the submit — it is never sent as "not stated"', async () => {
    const onSubmit = vi.fn(async (_i: unknown) => ({ ok: true as const }));
    const tree = renderWith(
      { ...FULL_AGENCY, minExperienceYears: "1.5" },
      { chips: [["Fanuc control"], ["Canteen"], "", ""], onSubmit },
    );
    expect(collect(tree).texts.join(" ")).toContain("Min experience needs a whole number");
    await formOf(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/** The text of every LIVE region the form draws (`aria-live`, role alert / status). */
function liveTexts(tree: ReactNode): string[] {
  const out: string[] = [];
  (function visit(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === IconButtonBase) return;
    if (typeof el.type === "function") return visit((el.type as (p: unknown) => ReactNode)(el.props));
    const role = el.props.role;
    if (el.props["aria-live"] !== undefined || role === "alert" || role === "status") {
      out.push(textOf(el.props.children as ReactNode));
    }
    if ("children" in el.props) visit(el.props.children);
  })(tree);
  return out;
}

describe("AgencyJobForm — a refused create takes focus to ITS City box (#job-city)", () => {
  it("an empty city refuses the create and focuses #job-city, not the invite panel's #city", async () => {
    focusControl.mockClear();
    const tree = renderWith({ ...FULL_AGENCY, city: "" }, { chips: [["Fanuc control"], ["Canteen"], "", ""] });
    await formOf(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(focusControl).toHaveBeenCalledWith("job-city");
    expect(focusControl).not.toHaveBeenCalledWith("city");
  });

  it("a card GAP on any other field still goes to that field's own id (payType)", async () => {
    focusControl.mockClear();
    const tree = renderWith({ ...FULL_AGENCY, payType: "" }, { chips: [["Fanuc control"], ["Canteen"], "", ""] });
    await formOf(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(focusControl.mock.calls.flat()).toEqual(["payType"]);
  });
});

describe("AgencyJobForm — the editor's lead, the refused create's reason, and the number gate", () => {
  it("the lead (the create heading / the row's header) heads the FORM column, above the form", () => {
    const tree = renderWith(FULL_AGENCY, { lead: <h3 className="lead-probe">Post a vacancy</h3> });
    const main = (tree.props as { children: ReactElement[] }).children[0] as ReactElement<{
      className: string;
      children: ReactNode[];
    }>;
    expect(main.props.className).toBe("posting-layout__main");
    const [lead, form] = main.props.children as ReactElement[];
    expect((lead as ReactElement<{ className: string }>).props.className).toBe("lead-probe");
    expect(form!.type).toBe("form");
  });

  it("a refused create's gap is the TARGET control's own error (aria-invalid + message)", () => {
    const gap = { title: "Pick the shift", message: "Day, night or rotational — the card shows it as a chip.", field: "shift" };
    const { aria, texts } = collect(renderWith({ ...FULL_AGENCY, shift: "" }, { gap }));
    expect(aria.find((a) => a.id === "shift")!.ariaInvalid).toBe(true);
    expect(texts).toContain(gap.message);
    expect(aria.filter((a) => a.ariaInvalid === true).map((a) => a.id)).toEqual(["shift"]);
  });

  it("M3: the gap is the target's DESCRIPTION, and no live region repeats it (announced once)", () => {
    const gap = { title: "Pick the shift", message: "Day, night or rotational — the card shows it as a chip.", field: "shift" };
    const tree = renderWith({ ...FULL_AGENCY, shift: "" }, { gap });
    expect(collect(tree).aria.find((a) => a.id === "shift")!.ariaDescribedby).toBe("shift-msg");
    // Drawn by the button too (rail footer + dock)…
    expect(textOf(tree).split(gap.message)).toHaveLength(4); // field + footer + dock
    // …but not announced from there: focus lands on the field, whose description reads it.
    expect(liveTexts(tree).length).toBeGreaterThan(0);
    expect(liveTexts(tree).filter((t) => t.includes(gap.message))).toEqual([]);
  });

  it("M3: a refusal no field owns (the server's) IS announced, from the live slots", () => {
    const tree = renderWith(FULL_AGENCY, { error: "Could not save the posting." });
    expect(liveTexts(tree).filter((t) => t.includes("Could not save the posting."))).toHaveLength(2);
  });

  it("a number that is not a whole number keeps the submit DISABLED (isValid reads the issues)", () => {
    const ok = collect(renderWith(FULL_AGENCY)).buttons.find((b) => b.type === "submit");
    expect(ok!.disabled).toBe(false);
    const bad = collect(renderWith({ ...FULL_AGENCY, payMin: "21k" })).buttons.find((b) => b.type === "submit");
    expect(bad!.disabled).toBe(true);
  });
});
