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
 *  2. FORM RENDER (UX parity, DS2.1): with hooks mocked to inject field state, assert a BLANK form
 *     renders submit DISABLED (disable-until-valid), an injected field error sets aria-invalid on the
 *     DS Input host + renders the DS error text, and a fully-valid form renders submit ENABLED.
 *
 * Env is node (no DOM); React state is injected via a `useState` mock and the component function
 * is rendered to an element tree, then walked. The fields are now DESIGN-SYSTEM primitives
 * (`Input`/`Select`/`Textarea`/`Button` from components/ds) — pure, hookless function components —
 * so the walker RENDERS each function component one level deep (`el.type(el.props)`) to reach the
 * native `<input>`/`<select>`/`<textarea>`/`<button>` host each DS field still emits. `useTransition`
 * → [pending=false, run-immediately]; `next/navigation` useRouter + the server action are mocked.
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
// The trade picker is now the interactive (hook-using) SelectMenu combobox. This test renders
// DS primitives directly in a DOM-less env, so mock it to the equivalent hookless native
// <select id="tradeKey"> host — keeping the "trade enum is a <select>" assertion + the form's
// value/validation contract intact (the combobox's own behaviour is its concern, not this suite).
vi.mock("../../../../components/ds/select-menu", () => ({
  SelectMenu: ({
    id,
    value,
    options,
  }: {
    id?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
  }) => ({
    type: "select",
    props: {
      id,
      value,
      children: options.map((o) => ({
        type: "option",
        props: { value: o.value, children: o.label },
      })),
    },
  }),
}));

// The picker fires the reach-preview Server Action from an effect. `useEffect` is a no-op
// in this DOM-less tree-walking harness, but the module is mocked so an accidental call
// can never reach the network — and so a future change that DOES invoke it fails loudly
// here rather than hanging.
vi.mock("./match-actions", () => ({ previewReachAction: vi.fn(async () => ({ ok: false, error: "x" })) }));
// `MatchSkillPicker` is the interactive, hook-using half (useState/useEffect/useRef for
// the live reach counter). The walker below RENDERS every function component one level
// deep to reach its native hosts, which would call those hooks outside a renderer — the
// same reason `SelectMenu` is mocked above. Replaced with a hookless stand-in that still
// renders the vocabulary it was HANDED, so "the form passes the server list down" stays a
// real assertion rather than one about a stub's own hardcoded text. The picker's own
// behaviour (debounced preview, tick state, cap) is covered by its own suite.
vi.mock("./match-skill-picker", () => ({
  MatchSkillPicker: ({ vocabulary }: { vocabulary: Array<{ skill_id: string; label: string }> }) => ({
    type: "div",
    props: {
      className: "match-picker",
      children: vocabulary.map((v) => ({
        type: "span",
        props: { id: v.skill_id, children: v.label },
      })),
    },
  }),
}));

const { PostingForm } = await import("./posting-form");

/** One entry of the closed ADR-0036 vocabulary, shaped exactly like the wire row. */
const MSKILL = {
  skill_id: "mskill_cnc_turning",
  label: "CNC turning",
  industry_id: "ind_manufacturing",
  related_skill_ids: ["mskill_vmc_operating"],
};

/**
 * useState call order in the source: fields, fieldErrors, error, navigating, selection,
 * preview (then useTransition). The ADR-0036 match state is declared LAST on purpose so
 * this positional seeding keeps working — a mid-list insert would hand `selection` the
 * value meant for `navigating`.
 *
 * `quotaStep` is the D-6 prop: the SERVER page resolves it from the LIVE catalog and
 * passes it down (this client form never fetches the catalog). `matchSkills` is the
 * ADR-0036 sibling — the closed match vocabulary, also server-fetched. Both are injected
 * like any other prop.
 */
function render(seed: {
  fields: Record<string, string>;
  fieldErrors: Record<string, unknown>;
  navigating?: boolean;
  quotaStep?: number | null;
  /** The ADR-0036 selection. Defaults to one picked skill — i.e. a postable form. */
  selection?: { matchSkillIds: string[]; untickedRelatedIds: string[] };
  preview?: unknown;
  matchSkills?: Array<Record<string, unknown>>;
}) {
  stateQueue = [
    seed.fields,
    seed.fieldErrors,
    null,
    seed.navigating ?? false,
    seed.selection ?? { matchSkillIds: [MSKILL.skill_id], untickedRelatedIds: [] },
    seed.preview ?? null,
  ];
  stateCursor = 0;
  return PostingForm({
    quotaStep: seed.quotaStep ?? null,
    matchSkills: (seed.matchSkills ?? [MSKILL]) as never,
  }) as ReactElement;
}

interface Collected {
  buttons: Array<{ type?: string; disabled?: boolean; text: string }>;
  aria: Array<{ id?: string; ariaInvalid?: unknown; ariaDescribedby?: unknown }>;
  ids: string[];
  /** id → host element tag (e.g. "input" | "select" | "textarea"), for the field-render test. */
  tagById: Record<string, string>;
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
 * DS2.1: the form's fields are DESIGN-SYSTEM primitives — pure, hookless function components
 * (`Input`/`Select`/`Textarea`/`Button`/`Card`/`Chip`/`Badge`). The component function returns
 * an element TREE of those (not yet the native hosts), so the walker RENDERS each function
 * component one level deep to reach the `<input>`/`<select>`/`<textarea>`/`<button>` host each
 * still emits (with the SAME explicit `id`), keeping the host-tag + aria + button assertions valid.
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
  if (typeof el.props.id === "string") {
    acc.ids.push(el.props.id);
    if (typeof el.type === "string") acc.tagById[el.props.id] = el.type;
  }
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], aria: [], ids: [], tagById: {}, texts: [] };
  walk(tree, acc);
  return acc;
}

/**
 * Every STATIC className token in the form's own markup. Deliberately does NOT render the DS
 * function components (unlike `walk`): this asserts the SCREEN's structure — the UI-1 form
 * spine and the shared alert — not the internal classes a DS primitive happens to emit.
 */
function classTokens(tree: ReactNode): Set<string> {
  const out = new Set<string>();
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    const cls = el.props?.className;
    if (typeof cls === "string") for (const t of cls.split(/\s+/)) if (t) out.add(t);
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
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

describe("PostingForm render — UI-1 form spine (the fields are grouped, not a flat stack)", () => {
  it("composes onto .form / .form__section / .form-grid / .form-actions / .form-status", () => {
    const tree = render({ fields: BLANK_FIELDS, fieldErrors: {} });
    // The root is the form primitive itself — the DS Card wrapper and the bespoke
    // `.posting-form` column it duplicated are retired.
    expect((tree.props as { className?: string }).className).toBe("form");
    const tokens = classTokens(tree);
    for (const c of ["form__section", "form__legend", "form-grid", "form-actions", "form-status"]) {
      expect(tokens.has(c), `missing ${c}`).toBe(true);
    }
    expect(tokens.has("posting-form")).toBe(false);
    expect(tokens.has("posting-form__pair")).toBe(false);
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

  /**
   * ADR-0036 — the demand fields alone are NOT a postable job any more.
   *
   * A posting with no match skill publishes fine and reaches NOBODY, and on the postings
   * list it is indistinguishable from one reaching hundreds. So "valid" now includes a
   * skill, and the button is the place a payer finds that out — not the empty feed a week
   * later.
   */
  it("a form with every demand field set but NO match skill keeps submit DISABLED", () => {
    const { buttons } = collect(
      render({
        fields: VALID_FIELDS,
        fieldErrors: {},
        selection: { matchSkillIds: [], untickedRelatedIds: [] },
      }),
    );
    expect(buttons.find((b) => b.type === "submit")!.disabled).toBe(true);
  });
});

describe("PostingForm render — D-6: the applicant-quota badge follows the SERVER-passed live step", () => {
  /** The rendered text fragments joined (JSX splits "Band " + the band into two fragments). */
  const joined = (seed: Parameters<typeof render>[0]) =>
    collect(render(seed)).texts.join("").replace(/\s+/g, " ");

  it("renders the derived quota from the passed step (a live ops edit changes it, no rebuild)", () => {
    // The server page resolves the step from the LIVE catalog. Band "1-5" (5 vacancies) → 1× step.
    const text = joined({ fields: VALID_FIELDS, fieldErrors: {}, quotaStep: 25 });
    expect(text).toContain("Band 1-5");
    // The LIVE step drives the badge — a compile-time DEFAULT_CATALOG read would render 10.
    expect(text).toContain("25 applicant slots");
  });

  it("omits the quota badge when no step was resolvable (fail-closed display, still no crash)", () => {
    const text = joined({ fields: VALID_FIELDS, fieldErrors: {}, quotaStep: null });
    // The band chip still renders (it is not catalog-derived); the quota badge does not.
    expect(text).toContain("Band 1-5");
    expect(text).not.toContain("applicant slots");
  });
});

describe("PostingForm render — DS error on an invalid field (aria-invalid + visible error)", () => {
  it("sets aria-invalid on the role-title DS Input host and renders the DS error text", () => {
    // DS2.1: the DS Input renders its error in a `.bb-field__error` slot (no id'd element), so we
    // assert the error TEXT is shown + aria-invalid is set on the host — the disable-until-valid +
    // body-shape guarantees (asserted elsewhere) are untouched.
    const errorMsg = "Role title must be 2–120 characters.";
    const { aria, texts } = collect(
      render({ fields: BLANK_FIELDS, fieldErrors: { roleTitle: errorMsg } }),
    );
    const role = aria.find((a) => a.id === "roleTitle");
    expect(role).toBeDefined();
    expect(role!.ariaInvalid).toBe(true);
    // The DS Input surfaces the error message via its error slot (visible to the user).
    expect(texts).toContain(errorMsg);
  });

  it("leaves aria-invalid UNSET on a valid field (no false error wiring)", () => {
    const { aria } = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }));
    const vacancies = aria.find((a) => a.id === "vacancies");
    expect(vacancies!.ariaInvalid).toBeUndefined();
  });
});

describe("PostingForm render — ADR-0036 match surface", () => {
  const joined = (seed: Parameters<typeof render>[0]) =>
    collect(render(seed)).texts.join("").replace(/\s+/g, " ");

  it("renders the vocabulary the SERVER passed, never a hardcoded skill list", () => {
    // The label comes from the injected wire row: a compile-time list in the client would
    // drift from `GET /payer/match/skills` the moment ops seed a new skill.
    expect(joined({ fields: VALID_FIELDS, fieldErrors: {} })).toContain("CNC turning");
  });

  it("an EMPTY vocabulary (the fetch failed) shows a reload prompt and blocks submit", () => {
    // Fail-closed: an empty picker would read as "there are no skills" rather than "we
    // could not load them", and a payer would post a job that reaches nobody.
    const seed = {
      fields: VALID_FIELDS,
      fieldErrors: {},
      matchSkills: [],
      selection: { matchSkillIds: [], untickedRelatedIds: [] },
    };
    expect(joined(seed)).toContain("Could not load the skill list");
    expect(collect(render(seed)).buttons.find((b) => b.type === "submit")!.disabled).toBe(true);
    // UI-1: that failure is the shared inline `.alert` (danger tone + a recovery line),
    // not the bespoke `.posting-form__error` paragraph it used to be.
    const tokens = classTokens(render(seed));
    expect(tokens.has("alert")).toBe(true);
    expect(tokens.has("alert--danger")).toBe(true);
  });

  it("E13: a zero-reach preview relabels the submit button so nobody posts into a void unknowingly", () => {
    // It does NOT disable — the payer may know supply is coming, and refusing outright
    // would override their judgement. It removes the SURPRISE.
    const { buttons } = collect(
      render({
        fields: VALID_FIELDS,
        fieldErrors: {},
        preview: {
          skills: [],
          reach_skill_ids: [],
          reach_total: 0,
          reach_tier1: 0,
          zero_reach: true,
          applied_unticked_ids: [],
          max_skills_per_posting: 3,
        },
      }),
    );
    const submit = buttons.find((b) => b.type === "submit")!;
    expect(submit.text).toBe("Post anyway — reaches nobody yet");
    expect(submit.disabled).toBe(false);
  });
});
