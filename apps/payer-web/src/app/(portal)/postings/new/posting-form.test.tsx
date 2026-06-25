import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { createPostingInputSchema } from "../../../../lib/contracts";

/**
 * EMPLOYER POSTING-FORM validation tests — the demand-schema-parity sibling of the agency
 * form tests. The form's inline `validate()` mirrors `createPostingInputSchema` (contracts.ts),
 * which the action's server Zod keeps as the AUTHORITY. Two layers, same as the agency form:
 *
 *  1. SCHEMA (the authority the form mirrors): trade enum, raw `vacancies` (required positive
 *     int), ordered C10-bounded pay, ordered bounded experience, and the description PII screen.
 *  2. FORM RENDER (UX parity): with hooks mocked to inject field state, assert a BLANK form
 *     renders submit DISABLED (disable-until-valid), an injected field error wires aria-* on the
 *     input + renders the error element id, and a fully-valid form renders submit ENABLED.
 *
 * Env is node (no DOM); React state is injected via a `useState` mock and the component function
 * is rendered to an element tree, then walked. `useTransition` → [pending=false, run-immediately];
 * `next/navigation` useRouter + the server action are mocked (the render path never calls them).
 */

/* ── 1. SCHEMA — the validation authority the form mirrors ──────────────────────── */

const VALID = { tradeKey: "cnc_operator", roleTitle: "CNC Machinist", vacancies: 5 } as const;
const PAY_MAX_INR = 10_000_000;
const EXPERIENCE_MAX_YEARS = 60;

describe("createPostingInputSchema — the demand-parity validation authority", () => {
  it("accepts a minimal valid input and a fully-populated one", () => {
    expect(createPostingInputSchema.safeParse(VALID).success).toBe(true);
    expect(
      createPostingInputSchema.safeParse({
        ...VALID,
        locationLabel: "Pune, MH",
        description: "Day shift, VMC line, helmet provided.",
        payMin: 20000,
        payMax: 35000,
        minExperienceYears: 1,
        maxExperienceYears: 5,
      }).success,
    ).toBe(true);
  });

  it("rejects a too-short role title", () => {
    expect(createPostingInputSchema.safeParse({ ...VALID, roleTitle: "A" }).success).toBe(false);
  });

  it("requires a positive integer vacancies count (0, negative, fractional all rejected)", () => {
    expect(createPostingInputSchema.safeParse({ ...VALID, vacancies: 0 }).success).toBe(false);
    expect(createPostingInputSchema.safeParse({ ...VALID, vacancies: -3 }).success).toBe(false);
    expect(createPostingInputSchema.safeParse({ ...VALID, vacancies: 2.5 }).success).toBe(false);
    // Omitting vacancies entirely is also rejected (it is required).
    expect(
      createPostingInputSchema.safeParse({ tradeKey: "cnc_operator", roleTitle: "CNC Machinist" })
        .success,
    ).toBe(false);
  });

  it("rejects an out-of-set trade key (cannot smuggle an arbitrary string)", () => {
    expect(createPostingInputSchema.safeParse({ ...VALID, tradeKey: "rocket_scientist" }).success).toBe(
      false,
    );
  });

  it("rejects payMax < payMin and maxExperienceYears < minExperienceYears (cross-field)", () => {
    expect(
      createPostingInputSchema.safeParse({ ...VALID, payMin: 50000, payMax: 40000 }).success,
    ).toBe(false);
    expect(
      createPostingInputSchema.safeParse({ ...VALID, minExperienceYears: 5, maxExperienceYears: 3 })
        .success,
    ).toBe(false);
  });

  it("rejects over-bound pay and experience", () => {
    expect(createPostingInputSchema.safeParse({ ...VALID, payMax: PAY_MAX_INR + 1 }).success).toBe(
      false,
    );
    expect(
      createPostingInputSchema.safeParse({ ...VALID, maxExperienceYears: EXPERIENCE_MAX_YEARS + 1 })
        .success,
    ).toBe(false);
  });

  it("screens an OBVIOUS phone/email in the description (PII heuristic), accepts a clean one", () => {
    expect(
      createPostingInputSchema.safeParse({ ...VALID, description: "Call me on 98765 43210" }).success,
    ).toBe(false);
    expect(
      createPostingInputSchema.safeParse({ ...VALID, description: "Email hr@acme.co to apply" })
        .success,
    ).toBe(false);
    expect(
      createPostingInputSchema.safeParse({ ...VALID, description: "Two-shift CNC role, PPE provided." })
        .success,
    ).toBe(true);
  });
});

/* ── 2. FORM RENDER — disable-until-valid + aria wiring (UX parity) ─────────────── */

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// The form imports the server action directly; the render path never calls it.
vi.mock("./actions", () => ({ createPostingAction: vi.fn() }));

const { PostingForm } = await import("./posting-form");

// useState call order in the source: fields, fieldErrors, error, navigating (then useTransition).
function render(seed: {
  fields: Record<string, string>;
  fieldErrors: Record<string, unknown>;
  navigating?: boolean;
}) {
  stateQueue = [seed.fields, seed.fieldErrors, null, seed.navigating ?? false];
  stateCursor = 0;
  return PostingForm() as ReactElement;
}

interface Collected {
  buttons: Array<{ type?: string; disabled?: boolean; text: string }>;
  aria: Array<{ id?: string; ariaInvalid?: unknown; ariaDescribedby?: unknown }>;
  ids: string[];
  /** id → host element tag (e.g. "input" | "select" | "textarea"), for the field-render test. */
  tagById: Record<string, string>;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
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
  if (typeof el.props.id === "string") {
    acc.ids.push(el.props.id);
    if (typeof el.type === "string") acc.tagById[el.props.id] = el.type;
  }
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], aria: [], ids: [], tagById: {} };
  walk(tree, acc);
  return acc;
}

const BLANK_FIELDS = {
  tradeKey: "cnc_operator",
  roleTitle: "",
  locationLabel: "",
  vacancies: "",
  payMin: "",
  payMax: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  description: "",
};
const VALID_FIELDS = { ...BLANK_FIELDS, roleTitle: "CNC Machinist", vacancies: "5" };

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
});

describe("PostingForm render — every demand field is present with the right control", () => {
  it("renders all nine fields (trade select, role/location/vacancies/pay/exp inputs, description textarea)", () => {
    const { tagById } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    // The trade enum is a <select>; the free-text/numeric fields are <input>; description is a <textarea>.
    expect(tagById.tradeKey).toBe("select");
    expect(tagById.description).toBe("textarea");
    for (const id of [
      "roleTitle",
      "locationLabel",
      "vacancies",
      "payMin",
      "payMax",
      "minExperienceYears",
      "maxExperienceYears",
    ]) {
      expect(tagById[id]).toBe("input");
    }
  });
});

describe("PostingForm render — disable-submit-until-valid", () => {
  it("a BLANK form (empty role title + vacancies) renders the submit button DISABLED", () => {
    const { buttons } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    const submit = buttons.find((b) => b.type === "submit");
    expect(submit).toBeDefined();
    expect(submit!.disabled).toBe(true);
  });

  it("a fully-valid form (role title + vacancies set) renders the submit button ENABLED", () => {
    const { buttons } = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }));
    const submit = buttons.find((b) => b.type === "submit");
    expect(submit!.disabled).toBe(false);
  });

  it("B7 navigate-latch: a valid form mid-navigation keeps submit DISABLED and reads 'Posting…'", () => {
    // navigating=true must override validity so the button can never be re-clicked across the
    // success→navigation window (no double create), even though the fields are otherwise valid.
    const { buttons } = collect(render({ fields: VALID_FIELDS, fieldErrors: {}, navigating: true }));
    const submit = buttons.find((b) => b.type === "submit");
    expect(submit!.disabled).toBe(true);
    expect(submit!.text).toBe("Posting…");
  });
});

describe("PostingForm render — aria-invalid / aria-describedby on an invalid field", () => {
  it("wires aria-invalid + aria-describedby on the role-title input and renders the error id", () => {
    const { aria, ids } = collect(
      render({ fields: BLANK_FIELDS, fieldErrors: { roleTitle: "Role title must be 2–120 characters." } }),
    );
    const role = aria.find((a) => a.id === "roleTitle");
    expect(role).toBeDefined();
    expect(role!.ariaInvalid).toBe(true);
    expect(role!.ariaDescribedby).toBe("roleTitle-error");
    expect(ids).toContain("roleTitle-error");
  });

  it("leaves aria-invalid UNSET on a valid field (no false error wiring)", () => {
    const { aria } = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }));
    const vacancies = aria.find((a) => a.id === "vacancies");
    expect(vacancies!.ariaInvalid).toBeUndefined();
    expect(vacancies!.ariaDescribedby).toBeUndefined();
  });
});
