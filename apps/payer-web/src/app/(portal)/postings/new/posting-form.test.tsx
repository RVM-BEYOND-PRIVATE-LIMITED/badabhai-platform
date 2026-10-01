import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { createPostingInputSchema } from "../../../../lib/contracts";
import { TRADE_FORM_KINDS_ALL } from "../../../../lib/job-roles";

/**
 * EMPLOYER POSTING-FORM tests (PR-B). The form is the traceable SOURCE of every card field, so
 * `createPostingInputSchema` now carries `roleKind` (one of the 21) + the worker-visible card
 * fields and NO `tradeKey`. Two layers:
 *
 *  1. SCHEMA (the authority the form mirrors): roleKind is one of the 21 (never a tradeKey),
 *     ordered C10-bounded pay/experience, the description PII screen, and the screened chips.
 *  2. FORM RENDER (UX parity): with hooks mocked to inject field state, a BLANK form renders submit
 *     DISABLED, an injected error sets aria-invalid + shows the DS error, a fully-valid form (role
 *     title + vacancies + a picked skill) renders submit ENABLED, and the role picker is a <select>.
 */

/* ── 1. SCHEMA ──────────────────────────────────────────────────────────────────── */

const VALID = { roleTitle: "CNC Machinist", vacancies: 5 } as const;
const PAY_MAX_INR = 10_000_000;
const EXPERIENCE_MAX_YEARS = 60;

describe("createPostingInputSchema — the PR-B card-lineage validation authority", () => {
  it("accepts a minimal valid input and a fully-populated one (roleKind + every card field)", () => {
    expect(createPostingInputSchema.safeParse(VALID).success).toBe(true);
    expect(
      createPostingInputSchema.safeParse({
        ...VALID,
        roleKind: "cnc_turner",
        locationLabel: "Pune, MH",
        description: "Day shift, VMC line, helmet provided.",
        city: "Pune",
        area: "Chakan",
        payMin: 20000,
        payMax: 35000,
        payType: "in_hand",
        minExperienceYears: 1,
        maxExperienceYears: 5,
        shift: "day",
        neededBy: "immediate",
        requirements: ["Fanuc control"],
        benefits: ["PF + ESI"],
      }).success,
    ).toBe(true);
  });

  it("rejects a tradeKey where a roleKind is expected (the company form no longer takes a trade)", () => {
    // roleKind is a role kind (`cnc_turner`), NOT a trade key (`cnc_operator`). A trade key value
    // must not validate as a role kind — the two vocabularies are distinct.
    expect(createPostingInputSchema.safeParse({ ...VALID, roleKind: "cnc_operator" }).success).toBe(
      false,
    );
  });

  it("accepts every one of the 21 role kinds", () => {
    for (const kind of TRADE_FORM_KINDS_ALL) {
      expect(createPostingInputSchema.safeParse({ ...VALID, roleKind: kind }).success).toBe(true);
    }
  });

  it("rejects a too-short role title and a non-positive vacancies", () => {
    expect(createPostingInputSchema.safeParse({ ...VALID, roleTitle: "A" }).success).toBe(false);
    expect(createPostingInputSchema.safeParse({ ...VALID, vacancies: 0 }).success).toBe(false);
    expect(createPostingInputSchema.safeParse({ roleTitle: "CNC Machinist" }).success).toBe(false);
  });

  it("rejects payMax < payMin and maxExperienceYears < minExperienceYears (cross-field)", () => {
    expect(createPostingInputSchema.safeParse({ ...VALID, payMin: 50000, payMax: 40000 }).success).toBe(
      false,
    );
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

  it("screens an OBVIOUS phone/email in the description AND in a chip", () => {
    expect(
      createPostingInputSchema.safeParse({ ...VALID, description: "Call me on 98765 43210" }).success,
    ).toBe(false);
    expect(
      createPostingInputSchema.safeParse({ ...VALID, requirements: ["call 98765 43210"] }).success,
    ).toBe(false);
    expect(
      createPostingInputSchema.safeParse({ ...VALID, benefits: ["Acme Pvt Ltd perks"] }).success,
    ).toBe(false);
  });
});

/* ── 2. FORM RENDER ─────────────────────────────────────────────────────────────── */

let stateQueue: unknown[] = [];
let stateCursor = 0;
// Setters are kept by state index so a test can see what an input handler set.
let setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const setter = vi.fn();
  setters[i] = setter;
  return [seeded, setter] as [unknown, (v: unknown) => void];
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
const createPostingAction = vi.fn(async (_input: unknown) => ({ ok: true, postingId: "p1", published: true }));
vi.mock("./actions", () => ({ createPostingAction: (i: unknown) => createPostingAction(i) }));
vi.mock("./match-actions", () => ({ previewReachAction: vi.fn(async () => ({ ok: false, error: "x" })) }));
// The interactive, hook-using picker is replaced with a hookless stand-in that still renders the
// vocabulary it was HANDED, so "the form passes the server list down" stays a real assertion.
vi.mock("./match-skill-picker", () => ({
  MatchSkillPicker: ({ vocabulary }: { vocabulary: Array<{ skill_id: string; label: string }> }) => ({
    type: "div",
    props: {
      className: "match-picker",
      children: vocabulary.map((v) => ({ type: "span", props: { id: v.skill_id, children: v.label } })),
    },
  }),
}));

const { PostingForm } = await import("./posting-form");

const MSKILL = {
  skill_id: "mskill_cnc_turning",
  label: "CNC turning",
  industry_id: "ind_manufacturing",
  related_skill_ids: ["mskill_vmc_operating"],
};

/**
 * useState order in the source: fields, fieldErrors, error, navigating, selection, preview,
 * requirements, benefits, reqDraft, benDraft, gap, revealed (then useTransition; the preview rail's
 * own sheet state comes after, at its initial value). New state is APPENDED so this positional
 * seeding keeps working.
 */
function render(seed: {
  fields: Record<string, string>;
  fieldErrors: Record<string, unknown>;
  navigating?: boolean;
  quotaStep?: number | null;
  selection?: { matchSkillIds: string[]; untickedRelatedIds: string[] };
  preview?: unknown;
  requirements?: string[];
  benefits?: string[];
  reqDraft?: string;
  benDraft?: string;
  revealed?: Record<string, true>;
  gap?: { title: string; message: string; field: string } | null;
  matchSkills?: Array<Record<string, unknown>>;
}) {
  stateQueue = [
    seed.fields,
    seed.fieldErrors,
    null,
    seed.navigating ?? false,
    seed.selection ?? { matchSkillIds: [MSKILL.skill_id], untickedRelatedIds: [] },
    seed.preview ?? null,
    seed.requirements ?? [],
    seed.benefits ?? [],
    seed.reqDraft ?? "",
    seed.benDraft ?? "",
    seed.gap ?? null,
    seed.revealed ?? {},
  ];
  setters = [];
  stateCursor = 0;
  return PostingForm({
    quotaStep: seed.quotaStep ?? null,
    matchSkills: (seed.matchSkills ?? [MSKILL]) as never,
  }) as ReactElement;
}

interface Collected {
  classes: string[];
  buttons: Array<{ type?: string; disabled?: boolean; text: string }>;
  aria: Array<{ id?: string; ariaInvalid?: unknown }>;
  tagById: Record<string, string>;
  texts: string[];
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") {
    const fn = el.type as (props: unknown) => ReactNode;
    return textOf(fn(el.props));
  }
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

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
    acc.aria.push({ id: el.props.id as string | undefined, ariaInvalid: el.props["aria-invalid"] });
  }
  if (typeof el.props.className === "string") acc.classes.push(el.props.className);
  if (typeof el.props.id === "string" && typeof el.type === "string") {
    acc.tagById[el.props.id] = el.type;
  }
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { classes: [], buttons: [], aria: [], tagById: {}, texts: [] };
  walk(tree, acc);
  return acc;
}

const BLANK_FIELDS = {
  roleKind: "",
  roleTitle: "",
  locationLabel: "",
  vacancies: "",
  city: "",
  area: "",
  payMin: "",
  payMax: "",
  payType: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  shift: "",
  neededBy: "",
  description: "",
};
const VALID_FIELDS = { ...BLANK_FIELDS, roleTitle: "CNC Machinist", vacancies: "5" };

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
  createPostingAction.mockClear();
});

describe("PostingForm render — the role picker and the card fields are present", () => {
  it("renders the role as a <select>, plus the card inputs (role title/city/pay/exp/description)", () => {
    const { tagById } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    expect(tagById.roleKind).toBe("select");
    expect(tagById.payType).toBe("select");
    expect(tagById.shift).toBe("select");
    expect(tagById.neededBy).toBe("select");
    expect(tagById.description).toBe("textarea");
    for (const id of ["roleTitle", "city", "area", "vacancies", "payMin", "payMax"]) {
      expect(tagById[id]).toBe("input");
    }
  });

  it("renders the 21 role kinds as options in the picker (labels are rendered text)", () => {
    const { texts } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    const joined = texts.join(" ");
    // The option LABELS are rendered children; the optgroup family headings are `label` props.
    expect(joined).toContain("CNC Turner");
    expect(joined).toContain("Injection Moulding Operator");
    expect(joined).toContain("Welder");
  });
});

describe("PostingForm render — disable-submit-until-valid", () => {
  it("a BLANK form renders the submit button DISABLED", () => {
    const submit = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} })).buttons.find(
      (b) => b.type === "submit",
    );
    expect(submit!.disabled).toBe(true);
  });

  it("a fully-valid form (role title + vacancies + a skill) renders submit ENABLED", () => {
    const submit = collect(render({ fields: VALID_FIELDS, fieldErrors: {} })).buttons.find(
      (b) => b.type === "submit",
    );
    expect(submit!.disabled).toBe(false);
  });

  it("B7 navigate-latch keeps submit DISABLED and reads 'Publishing…'", () => {
    const submit = collect(
      render({ fields: VALID_FIELDS, fieldErrors: {}, navigating: true }),
    ).buttons.find((b) => b.type === "submit");
    expect(submit!.disabled).toBe(true);
    expect(submit!.text).toBe("Publishing…");
  });

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

describe("PostingForm render — the live card preview + the DS error wiring", () => {
  it("renders the JobCardPreview with the ADR-0024 caption (never 'what workers see')", () => {
    const text = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }))
      .texts.join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("Card preview — built from what you entered");
    expect(text).not.toContain("what workers see");
  });

  it("sets aria-invalid on the role-title DS Input host and renders the DS error text", () => {
    const errorMsg = "Role title must be 2–120 characters.";
    const { aria, texts } = collect(
      render({ fields: BLANK_FIELDS, fieldErrors: { roleTitle: errorMsg } }),
    );
    const role = aria.find((a) => a.id === "roleTitle");
    expect(role!.ariaInvalid).toBe(true);
    expect(texts).toContain(errorMsg);
  });
});

describe("PostingForm render — ADR-0036 match surface (fail-closed)", () => {
  it("renders the vocabulary the SERVER passed", () => {
    const text = collect(render({ fields: VALID_FIELDS, fieldErrors: {} }))
      .texts.join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("CNC turning");
  });

  it("an EMPTY vocabulary shows a reload prompt and blocks submit", () => {
    const seed = {
      fields: VALID_FIELDS,
      fieldErrors: {},
      matchSkills: [],
      selection: { matchSkillIds: [], untickedRelatedIds: [] },
    };
    const text = collect(render(seed)).texts.join(" ").replace(/\s+/g, " ");
    expect(text).toContain("Could not load the skill list");
    expect(collect(render(seed)).buttons.find((b) => b.type === "submit")!.disabled).toBe(true);
  });
});

/* ── 3. THE PREVIEW RAIL + the shared read ─────────────────────────────────────── */

const FULL_FIELDS = {
  ...BLANK_FIELDS,
  roleKind: "cnc_turner",
  roleTitle: "CNC Turner",
  locationLabel: "Chakan plant",
  vacancies: "5",
  city: "Pune",
  area: "Chakan MIDC",
  payMin: "18000",
  payMax: "26000",
  payType: "in_hand",
  minExperienceYears: "2",
  maxExperienceYears: "5",
  shift: "day",
  neededBy: "soon",
  description: "Run two Fanuc turning centres per shift.",
};

function findForm(node: ReactNode): ReactElement<{ onSubmit: (e: unknown) => void; id?: string }> | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = findForm(c);
      if (f) return f;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === "form") return el as ReactElement<{ onSubmit: (e: unknown) => void; id?: string }>;
  if (typeof el.type === "function") return null;
  return el.props && "children" in el.props ? findForm(el.props.children) : null;
}

describe("PostingForm — the preview rail is the worker card, built from the shared read", () => {
  it("draws the card (Area, City), 'Also in your posting' (role, openings, note) and the phone dock", () => {
    const text = collect(render({ fields: FULL_FIELDS, fieldErrors: {} })).texts.join(" ").replace(/\s+/g, " ");
    expect(text).toContain("Chakan MIDC, Pune");
    expect(text).toContain("Also in your posting");
    expect(text).toContain("Openings");
    expect(text).toContain("Chakan plant");
    expect(text).toContain("Preview the card");
    expect(text).toContain("Publish posting");
  });

  it("the rail's primary button submits THIS form (form attribute), so it works outside the <form>", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {} });
    const form = findForm(tree);
    expect(form!.props.id).toBe("posting-form");
    const ids = new Set<string>();
    (function walkForm(node: ReactNode): void {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walkForm);
      const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
      if (typeof el.type === "function") return walkForm((el.type as (p: unknown) => ReactNode)(el.props));
      if (el.type === "button" && el.props.type === "submit") ids.add(String(el.props.form));
      if ("children" in el.props) walkForm(el.props.children);
    })(tree);
    expect([...ids]).toEqual(["posting-form"]);
  });

  it('a pay of "21k" shows "needs a whole number" AT ONCE and keeps publish disabled', () => {
    const { texts, aria, buttons } = collect(
      render({ fields: { ...FULL_FIELDS, payMin: "21k" }, fieldErrors: {} }),
    );
    expect(texts.join(" ")).toContain("Min pay needs a whole number");
    expect(texts.join(" ")).toContain("Pay needs a whole number"); // the card names the fix
    expect(texts.join(" ")).not.toContain("Up to ₹26,000/mah");
    expect(aria.find((a) => a.id === "payMin")!.ariaInvalid).toBe(true);
    expect(buttons.find((b) => b.type === "submit")!.disabled).toBe(true);
  });

  it("max below min: the card says so at once; the FIELD error waits until the payer leaves the box", () => {
    const typing = collect(render({ fields: { ...FULL_FIELDS, payMax: "1800" }, fieldErrors: {} }));
    expect(typing.texts.join(" ")).toContain("Max pay is below min pay");
    expect(typing.texts.join(" ")).not.toContain("Max pay must be greater than or equal to min pay.");
    const left = collect(
      render({ fields: { ...FULL_FIELDS, payMax: "1800" }, fieldErrors: {}, revealed: { payMin: true, payMax: true } }),
    );
    expect(left.texts.join(" ")).toContain("Max pay must be greater than or equal to min pay.");
  });

  it('submits the SAME values the card shows: "18,000" → 18000 and a typed-not-added chip is kept', async () => {
    const tree = render({
      fields: { ...FULL_FIELDS, payMin: "18,000" },
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benDraft: "  PF + ESI ",
    });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(createPostingAction).toHaveBeenCalledTimes(1);
    const input = createPostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.payMin).toBe(18000);
    expect(input.requirements).toEqual(["Fanuc control"]);
    expect(input.benefits).toEqual(["PF + ESI"]);
    expect(input.vacancies).toBe(5);
    expect(input.roleTitle).toBe("CNC Turner");
  });

  it("a thin card is refused BEFORE the action (the gap rule reads the same values)", async () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {}, requirements: ["Fanuc control"] });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(createPostingAction).not.toHaveBeenCalled();
  });
});

/** The DOM-level element with this id in the (function-expanded) tree, with its handlers. */
function byId(tree: ReactNode, id: string): ReactElement<Record<string, unknown>> {
  let found: ReactElement<Record<string, unknown>> | null = null;
  (function visit(node: ReactNode): void {
    if (found || node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (typeof el.type === "function") return visit((el.type as (p: unknown) => ReactNode)(el.props));
    if (el.props.id === id && typeof el.type === "string") {
      found = el;
      return;
    }
    if ("children" in el.props) visit(el.props.children);
  })(tree);
  if (found === null) throw new Error(`no #${id}`);
  return found;
}

describe("PostingForm — a refused publish says why AT the field focus moves to (M2)", () => {
  const GAP = {
    title: "Pick the pay type",
    message: "Say what the band means — in-hand, gross or CTC. We never guess it for you.",
    field: "payType",
  };

  it("the gap's message is the target control's own error (aria-invalid), not only a far-off status", () => {
    const { aria, texts } = collect(render({ fields: FULL_FIELDS, fieldErrors: {}, gap: GAP }));
    expect(aria.find((a) => a.id === "payType")!.ariaInvalid).toBe(true);
    expect(texts).toContain(GAP.message);
    // Only the target is marked: the other controls stay clean.
    expect(aria.filter((a) => a.ariaInvalid === true).map((a) => a.id)).toEqual(["payType"]);
  });

  it("a pay-band gap points at the end that is empty (payMax here), and so does its error", () => {
    const { aria } = collect(
      render({
        fields: { ...FULL_FIELDS, payMax: "" },
        fieldErrors: {},
        gap: { title: "Add the pay band", message: "Both ends of the band.", field: "payMax" },
      }),
    );
    expect(aria.find((a) => a.id === "payMax")!.ariaInvalid).toBe(true);
    expect(aria.find((a) => a.id === "payMin")!.ariaInvalid).toBeUndefined();
  });

  it("changing the flagged control clears the gap (index 10); changing another does not", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {}, gap: GAP });
    (byId(tree, "city").props.onChange as (e: unknown) => void)({ target: { value: "Nashik" } });
    expect(setters[10]).not.toHaveBeenCalled();
    (byId(tree, "payType").props.onChange as (e: unknown) => void)({ target: { value: "gross" } });
    expect(setters[10]).toHaveBeenCalledWith(null);
  });

  it("ONE status per breakpoint: the rail footer and the dock carry it; the form's end does not", () => {
    const { classes } = collect(render({ fields: FULL_FIELDS, fieldErrors: {}, gap: GAP }));
    expect(classes.filter((c) => c === "posting-actions__status")).toHaveLength(1); // rail footer
    expect(classes.filter((c) => c === "posting-dock__status")).toHaveLength(1); // phone dock
    expect(classes.filter((c) => c === "posting-actions")).toHaveLength(2); // footer + form end
  });
});

describe("PostingForm — typing in a pay box stands its order error down again (reward early)", () => {
  it("onChange of payMax conceals the revealed pay pair (index 11); a non-number field does not", () => {
    const tree = render({
      fields: { ...FULL_FIELDS, payMax: "1800" },
      fieldErrors: {},
      revealed: { payMin: true, payMax: true },
    });
    (byId(tree, "payMax").props.onChange as (e: unknown) => void)({ target: { value: "18" } });
    const conceal = setters[11]!.mock.calls[0]![0] as (prev: Record<string, true>) => Record<string, true>;
    expect(conceal({ payMin: true, payMax: true, minExperienceYears: true })).toEqual({
      minExperienceYears: true,
    });
    setters[11]!.mockClear();
    (byId(tree, "city").props.onChange as (e: unknown) => void)({ target: { value: "Pune" } });
    expect(setters[11]).not.toHaveBeenCalled();
  });

  it("leaving a pay box reveals the pair (onBlur)", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {} });
    (byId(tree, "payMin").props.onBlur as () => void)();
    const reveal = setters[11]!.mock.calls[0]![0] as (prev: Record<string, true>) => Record<string, true>;
    expect(reveal({})).toEqual({ payMin: true, payMax: true });
  });
});
