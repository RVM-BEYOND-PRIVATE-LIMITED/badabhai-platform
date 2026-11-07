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

// W4 — the local draft + leave guard runs effects (a real hook outside a render); its rules are
// lib/posting-draft.test.ts's and components/use-posting-draft.test.ts's. Here it is idle (nothing
// saved yet; restored only when a test says so) and keeps the options the form called it with.
const discardDraft = vi.fn();
interface DraftOptions {
  storageKey: string;
  isDirty?: (saved: unknown) => boolean;
  onRestore?: (saved: unknown) => void;
  onLeave?: (href: string) => void;
}
const draftHook: { restored: boolean; storageKey: string; options?: DraftOptions } = {
  restored: false,
  storageKey: "",
};
vi.mock("../../../../components/use-posting-draft", () => ({
  usePostingDraft: (options: DraftOptions) => {
    draftHook.storageKey = options.storageKey;
    draftHook.options = options;
    return {
      saved: false,
      restored: draftHook.restored,
      discard: discardDraft,
      leave: { open: false, confirm: discardDraft, cancel: discardDraft },
    };
  },
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  // The DS fields mint their auto ids with `useId`, which needs a renderer; the walks below call
  // them as plain functions, so it answers from a counter (unique per call, like the hook).
  let ids = 0;
  return {
    ...actual,
    useId: () => `:r${(ids += 1)}:`,
    useState: (initial: unknown) => useState(initial),
    // The voice-description control holds its recogniser/status in refs; the
    // plain-function walk has no React dispatcher, so answer it locally.
    useRef: (initial: unknown) => ({ current: initial }),
    useTransition: () => useTransition(),
  };
});
// The publish navigates through the shared helper (components/portal-navigation.ts — the shell's
// "Opening …" cue); its router mechanics are that module's own suite.
const navigate = vi.fn();
vi.mock("../../../../components/portal-navigation", () => ({
  usePortalNavigation: () => ({ pending: false, navigate }),
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
// #2645 — the trade's own fields are the company form's only match input now, always mounted. Its
// live reach read is its own suite's (effects + refs); here a hookless stand-in records what the
// form HANDS it. `derivedMatchSkills` (the form's match rule) stays real.
const tradeFieldsProps = vi.fn();
vi.mock("../trade-fields", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TradePostingFields: (props: Record<string, unknown>) => {
    tradeFieldsProps(props);
    return { type: "div", props: { className: "trade-fields-stub" } };
  },
}));
// The trade picker's Retry re-reads on the server (`router.refresh`); its own suite covers that.
vi.mock("../../../../components/retry-button", () => ({
  RetryButton: () => ({ type: "button", props: { type: "button", children: "Retry" } }),
}));

const { PostingForm } = await import("./posting-form");
const { observeDockHeight } = await import("../../../../lib/dock-reserve");

/** The signed-in payer (the page passes the session's opaque id). */
const PAYER_ID = "11111111-1111-4111-8111-111111111111";

const MSKILL = {
  skill_id: "mskill_cnc_turning",
  label: "CNC turning",
  industry_id: "ind_manufacturing",
  related_skill_ids: ["mskill_vmc_operating"],
};

/** One 16-trade catalogue row (`GET /payer/posting-trades`), no chip questions. */
const tradeRow = (roleKind: string, roleLabel: string, matchSkillId: string) => ({
  role_kind: roleKind,
  role_label: roleLabel,
  pack_id: `qp_${roleKind}`,
  match_skill_id: matchSkillId,
  ladder: [],
  questions: [],
});
/** The catalogue the page served — two of the 16 are enough to pin "only what the API lists". */
const TRADES = [
  tradeRow("cnc_turner", "CNC Turner", "mskill_cnc_turner"),
  tradeRow("welder", "Welder", "mskill_welder"),
];

/**
 * useState order in the source: fields, fieldErrors, error, navigating, selection, preview,
 * requirements, benefits, reqDraft, benDraft, gap, revealed, step, trade (then useTransition; the
 * preview rail's own sheet state comes after, at its initial value). New state is APPENDED so this
 * positional seeding keeps working.
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
  error?: string | null;
  /** #2645 — index 12. */
  step?: number;
  /** #2645 — index 13: the trade form's rung + answers. */
  trade?: { tradeLevel: string; answers: Record<string, string[]>; matchSkillIds: string[] };
  /** #2645 — the 16-trade catalogue the page served (default: two trades). */
  postingTrades?: Array<ReturnType<typeof tradeRow>>;
  postingTradesProblem?: unknown;
}) {
  stateQueue = [
    seed.fields,
    seed.fieldErrors,
    seed.error ?? null,
    seed.navigating ?? false,
    seed.selection ?? { matchSkillIds: [MSKILL.skill_id], untickedRelatedIds: [] },
    seed.preview ?? null,
    seed.requirements ?? [],
    seed.benefits ?? [],
    seed.reqDraft ?? "",
    seed.benDraft ?? "",
    seed.gap ?? null,
    seed.revealed ?? {},
    seed.step ?? 1,
    seed.trade ?? { tradeLevel: "", answers: {}, matchSkillIds: [] },
  ];
  setters = [];
  stateCursor = 0;
  return PostingForm({
    payerId: PAYER_ID,
    quotaStep: seed.quotaStep ?? null,
    matchSkills: (seed.matchSkills ?? [MSKILL]) as never,
    postingTrades: (seed.postingTrades ?? TRADES) as never,
    postingTradesProblem: (seed.postingTradesProblem ?? null) as never,
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
  navigate.mockClear();
  draftHook.restored = false;
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

  it("#2645 — the picker lists ONLY the trades the API served, never the long role list", () => {
    const { texts } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    const joined = texts.join(" ");
    // The option LABELS are rendered children; the optgroup family headings are `label` props.
    expect(joined).toContain("CNC Turner");
    expect(joined).toContain("Welder");
    // Declared role kinds the catalogue did not list are not offered (a polymer role, a 27-list one).
    expect(joined).not.toContain("Injection Moulding Operator");
    expect(joined).not.toContain("Production Supervisor");
    expect(joined).toContain("— pick one of the 16 trades —");
  });
});

describe("PostingForm render — disable-submit-until-valid", () => {
  it("a BLANK form keeps the submit button CLICKABLE — a click names what is missing", () => {
    const submit = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} })).buttons.find(
      (b) => b.type === "submit",
    );
    expect(submit!.disabled).toBe(false);
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

  it("a form with every demand field set but NO match skill keeps submit CLICKABLE so the click can explain", () => {
    const { buttons } = collect(
      render({
        fields: VALID_FIELDS,
        fieldErrors: {},
        selection: { matchSkillIds: [], untickedRelatedIds: [] },
      }),
    );
    expect(buttons.find((b) => b.type === "submit")!.disabled).toBe(false);
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

describe("PostingForm render — #2645: the trade's fields are the only match surface", () => {
  beforeEach(() => tradeFieldsProps.mockClear());

  it("hands the trade fields the catalogue, the vocabulary and the job's role for the reach preview", () => {
    collect(render({ fields: { ...VALID_FIELDS, roleKind: "cnc_turner" }, fieldErrors: {} }));
    const props = tradeFieldsProps.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.trades).toBe(TRADES);
    expect(props.roleKind).toBe("cnc_turner");
    expect(props.vocabulary).toEqual([MSKILL]);
    // POST /payer/match/reach-preview carries the company job's trade (#2635).
    expect(props.reachRoleKind).toBe("cnc_turner");
  });

  it("no flat skill picker and no 'could not load the skill list' fallback, whatever loaded", () => {
    for (const matchSkills of [[MSKILL], []]) {
      const tree = render({ fields: VALID_FIELDS, fieldErrors: {}, matchSkills });
      const { classes, texts } = collect(tree);
      expect(classes).not.toContain("match-picker");
      expect(texts.join(" ")).not.toContain("Could not load the skill list");
      // The vocabulary only labels chips now: an empty one never holds Publish disabled.
      expect(collect(tree).buttons.find((b) => b.type === "submit")!.disabled).toBe(false);
    }
  });
});

describe("PostingForm — #2645: the trade is REQUIRED, one of the 16", () => {
  const TRADE_MSG = "Pick one of the 16 trades";

  it("Next on step 1 without a trade refuses at the picker (index 1 — fieldErrors) and stays", () => {
    const tree = render({ fields: { ...FULL_FIELDS, roleKind: "" }, fieldErrors: {} });
    const next = hosts(tree).find(
      (el) => el.type === "button" && textOf(el.props.children as ReactNode).includes("Next: Pay"),
    )!;
    (next.props.onClick as () => void)();
    const merge = setters[1]!.mock.calls[0]![0] as (p: object) => Record<string, string>;
    expect(merge({})).toMatchObject({ roleKind: TRADE_MSG });
    expect(setters[12]).not.toHaveBeenCalled();
  });

  it("a role the catalogue does not list (a restored draft's) is refused the same way", () => {
    const tree = render({ fields: { ...FULL_FIELDS, roleKind: "production_supervisor" }, fieldErrors: {} });
    const next = hosts(tree).find(
      (el) => el.type === "button" && textOf(el.props.children as ReactNode).includes("Next: Pay"),
    )!;
    (next.props.onClick as () => void)();
    const merge = setters[1]!.mock.calls[0]![0] as (p: object) => Record<string, string>;
    expect(merge({})).toMatchObject({ roleKind: TRADE_MSG });
  });

  it("Publish without a trade is refused AT the picker and sends nothing", async () => {
    const tree = render({
      fields: { ...FULL_FIELDS, roleKind: "" },
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
    });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(createPostingAction).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // The picker is the first control in the refusal, so it is where focus goes.
    const errs = setters[1]!.mock.calls[0]![0] as Record<string, string>;
    expect(Object.keys(errs)[0]).toBe("roleKind");
    expect(errs.roleKind).toBe(TRADE_MSG);
  });

  it("…from a later step it switches back to step 1, where the picker is (index 12)", async () => {
    const tree = render({ fields: { ...FULL_FIELDS, roleKind: "" }, fieldErrors: {}, step: 3 });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(setters[12]).toHaveBeenCalledWith(1);
    expect(createPostingAction).not.toHaveBeenCalled();
  });

  it("the refusal is the picker's own error (aria-invalid + its feedback line)", () => {
    const tree = render({ fields: BLANK_FIELDS, fieldErrors: { roleKind: TRADE_MSG } });
    expect(byId(tree, "roleKind").props["aria-invalid"]).toBe(true);
    expect(textOf(byId(tree, "roleKind-msg"))).toBe(TRADE_MSG);
  });

  it("the create always carries role_kind + the trade form ({} untouched, no rung) + its derived skill", async () => {
    const tree = render({
      fields: FULL_FIELDS,
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
    });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    const input = createPostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.roleKind).toBe("cnc_turner");
    expect(input.tradeAnswers).toEqual({});
    expect(input.tradeLevel).toBeUndefined();
    // The match set is the trade's own (base skill), derived from the catalogue — never a flat pick.
    expect(input.matchSkillIds).toEqual(["mskill_cnc_turner"]);
    expect(input.untickedRelatedIds).toEqual([]);
  });

  it("a picked rung and chip ride the create as they were picked", async () => {
    const tree = render({
      fields: FULL_FIELDS,
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
      trade: { tradeLevel: "setter", answers: { controller_brand: ["fanuc"] }, matchSkillIds: [] },
    });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    const input = createPostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.tradeLevel).toBe("setter");
    expect(input.tradeAnswers).toEqual({ controller_brand: ["fanuc"] });
  });

  it("a publish the API refused for want of a trade opens the new draft's edit page at the picker", async () => {
    createPostingAction.mockResolvedValueOnce({
      ok: true,
      postingId: "p1",
      published: false,
      reached: null,
      tradeRequired: true,
    } as never);
    const tree = render({
      fields: FULL_FIELDS,
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
    });
    findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith("/postings/p1/edit?trade=required", {
      pendingLabel: "Edit posting",
      refresh: true,
    });
  });
});

describe("PostingForm — #2645: the 16 trades did not load", () => {
  const FAILED = { kind: "http", status: 503 } as const;

  it("the picker names the real cause and offers Retry — no select, no free role list", () => {
    const tree = render({
      fields: BLANK_FIELDS,
      fieldErrors: {},
      postingTrades: [],
      postingTradesProblem: FAILED,
    });
    const { tagById, texts, buttons } = collect(tree);
    expect(tagById.roleKind).toBe("div"); // the focus target that stands in for the picker
    const joined = texts.join(" ");
    expect(joined).toContain("The 16 trades did not load: the BadaBhai server had a problem (error 503).");
    expect(joined).not.toContain("CNC Turner");
    expect(buttons.map((b) => b.text)).toContain("Retry");
  });

  it("an answer with no trade in it says so, with the same Retry", () => {
    const tree = render({
      fields: BLANK_FIELDS,
      fieldErrors: {},
      postingTrades: [],
      postingTradesProblem: { kind: "empty" },
    });
    expect(collect(tree).texts.join(" ")).toContain("No trades are open for posting right now.");
  });

  it("posting is refused at the picker's spot — the refusal is described there", async () => {
    const tree = render({
      fields: FULL_FIELDS,
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
      postingTrades: [],
      postingTradesProblem: FAILED,
    });
    await findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    expect(createPostingAction).not.toHaveBeenCalled();
    const refused = render({
      fields: BLANK_FIELDS,
      fieldErrors: { roleKind: "Pick one of the 16 trades" },
      postingTrades: [],
      postingTradesProblem: FAILED,
    });
    expect(byId(refused, "roleKind").props["aria-describedby"]).toBe("roleKind-cause roleKind-msg");
    expect(textOf(byId(refused, "roleKind-msg"))).toBe("Pick one of the 16 trades");
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

  it('a pay of "21k" shows "needs a whole number" AT ONCE; the click reports it', () => {
    const { texts, aria, buttons } = collect(
      render({ fields: { ...FULL_FIELDS, payMin: "21k" }, fieldErrors: {} }),
    );
    expect(texts.join(" ")).toContain("Min pay needs a whole number");
    expect(texts.join(" ")).toContain("Pay needs a whole number"); // the card names the fix
    expect(texts.join(" ")).not.toContain("Up to ₹26,000/mah");
    expect(aria.find((a) => a.id === "payMin")!.ariaInvalid).toBe(true);
    expect(buttons.find((b) => b.type === "submit")!.disabled).toBe(false);
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
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a publish lands on the posting's Applicants (?reached=N) with the shell's 'Opening Applicants…' cue — latched busy first", async () => {
    createPostingAction.mockResolvedValueOnce({
      ok: true,
      postingId: "p1",
      published: true,
      reached: 42,
    } as never);
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {}, requirements: ["Fanuc control"], benefits: ["PF + ESI"] });
    findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith("/postings/p1/applicants?reached=42", {
      pendingLabel: "Applicants",
      refresh: true,
    });
    // The button stays "Publishing…" through the navigation: `navigating` (index 3) latched on.
    expect(setters[3]).toHaveBeenCalledWith(true);
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

  it("ONE status per breakpoint: the desktop rail, the hidden rail footer and the dock; the form's end does not", () => {
    const { classes } = collect(render({ fields: FULL_FIELDS, fieldErrors: {}, gap: GAP }));
    // Three DOM copies: the designer rail (desktop), the shared hidden rail footer, and the dock.
    // CSS shows exactly one at each breakpoint (the rail on desktop; the dock below 1024px).
    expect(classes.filter((c) => c === "posting-actions__status")).toHaveLength(2);
    expect(classes.filter((c) => c === "posting-dock__status")).toHaveLength(1);
    expect(classes.filter((c) => c === "posting-actions")).toHaveLength(2);
  });
});

/** The text of every LIVE region the form draws (`aria-live`, role alert / status). */
function liveTexts(tree: ReactNode): string[] {
  const out: string[] = [];
  (function visit(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (typeof el.type === "function") return visit((el.type as (p: unknown) => ReactNode)(el.props));
    const role = el.props.role;
    if (el.props["aria-live"] !== undefined || role === "alert" || role === "status") {
      out.push(textOf(el.props.children as ReactNode));
    }
    if ("children" in el.props) visit(el.props.children);
  })(tree);
  return out;
}

describe("PostingForm — M3: a refused publish's reason is announced ONCE", () => {
  const GAP = {
    title: "Pick the pay type",
    message: "Say what the band means — in-hand, gross or CTC. We never guess it for you.",
    field: "payType",
  };

  it("the target field is DESCRIBED by its own error — what focus reads when it lands there", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {}, gap: GAP });
    expect(byId(tree, "payType").props["aria-describedby"]).toBe("payType-msg");
    expect(textOf(byId(tree, "payType-msg"))).toBe(GAP.message);
  });

  it("…so NO live region repeats it: the copy by the button is visible, not announced", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {}, gap: GAP });
    // Drawn by the button (desktop rail + hidden rail footer + dock): title, then the message…
    expect(collect(tree).texts.filter((t) => t === GAP.title)).toHaveLength(3);
    expect(liveTexts(tree).filter((t) => t.includes(GAP.message))).toEqual([]);
  });

  it("a refusal no field owns (the server's) IS announced — from the live slot, one per breakpoint", () => {
    const ERR = "Could not publish right now — try again.";
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {}, error: ERR });
    expect(liveTexts(tree).filter((t) => t.includes(ERR))).toHaveLength(3); // desktop rail + rail footer + dock
  });

  it("a typed number problem is the box's own description too (aria-describedby → its line)", () => {
    const tree = render({ fields: { ...FULL_FIELDS, payMin: "21k" }, fieldErrors: {} });
    expect(byId(tree, "payMin").props["aria-describedby"]).toBe("payMin-msg");
    expect(byId(tree, "payMin").props["aria-invalid"]).toBe(true);
  });
});

describe("PostingForm — the rail knows when a publish is in flight", () => {
  const railOf = (tree: ReactElement) =>
    (tree.props as { children: ReactElement[] }).children.find(
      (c) => typeof c?.type === "function" && (c.type as { name?: string }).name === "PostingPreviewRail",
    ) as ReactElement<{ busy?: boolean }>;

  it("busy while publishing/navigating (the dock's preview waits), idle otherwise", () => {
    expect(railOf(render({ fields: FULL_FIELDS, fieldErrors: {} })).props.busy).toBe(false);
    expect(railOf(render({ fields: FULL_FIELDS, fieldErrors: {}, navigating: true })).props.busy).toBe(true);
  });
});

describe("PostingForm — the phone dock publishes its real height (the page's reserve for it)", () => {
  it("the dock element is observed by observeDockHeight", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {} });
    let dock: ReactElement<{ ref?: unknown }> | null = null;
    (function visit(node: ReactNode): void {
      if (dock || node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
      if (typeof el.type === "function") return visit((el.type as (p: unknown) => ReactNode)(el.props));
      if (el.props.className === "posting-dock") {
        dock = el as ReactElement<{ ref?: unknown }>;
        return;
      }
      if ("children" in el.props) visit(el.props.children);
    })(tree);
    expect(dock).not.toBeNull();
    expect(dock!.props.ref).toBe(observeDockHeight);
  });
});

describe("PostingForm — owner naming ruling (labels)", () => {
  it("the description hint says 'applicant', never 'candidate'", () => {
    const hint = textOf(byId(render({ fields: FULL_FIELDS, fieldErrors: {} }), "description-msg"));
    expect(hint).toContain("share contact only after you unlock an applicant.");
    expect(hint).not.toContain("candidate");
  });

  it("the description hint names the entity 'posting', never 'job' (F36)", () => {
    const hint = textOf(byId(render({ fields: FULL_FIELDS, fieldErrors: {} }), "description-msg"));
    expect(hint).toContain("Workers read this when they open the posting.");
    expect(hint).not.toMatch(/\bjob\b/i);
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

/* ── W4 (#2584): the posting flow on phones ──────────────────────────────────── */

/** Every DOM-level element (function components expanded), depth-first. */
function hosts(tree: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  const out: Array<ReactElement<Record<string, unknown>>> = [];
  (function visit(node: ReactNode): void {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (typeof el.type === "function") {
      return visit((el.type as (p: unknown) => ReactNode)(el.props));
    }
    if (typeof el.type === "string") out.push(el);
    if ("children" in el.props) visit(el.props.children);
  })(tree);
  return out;
}

describe("PostingForm — W4: steps, the phone publish bar and the draft", () => {
  it("the active step carries aria-current='step'; the others carry none", () => {
    const steps = hosts(render({ fields: BLANK_FIELDS, fieldErrors: {} })).filter(
      (el) => el.type === "li" && String(el.props.className).startsWith("mw-step "),
    );
    expect(steps.map((s) => s.props["aria-current"])).toEqual(["step", undefined, undefined]);
  });

  it("each step's heading is a focus target (id + tabIndex -1) for a step change", () => {
    const tree = render({ fields: BLANK_FIELDS, fieldErrors: {} });
    for (const n of [1, 2, 3]) {
      const heading = byId(tree, `posting-step-${n}-title`);
      expect(heading.type).toBe("h2");
      expect(heading.props.tabIndex).toBe(-1);
    }
  });

  it("Next on a complete step moves to the next one (index 12 — the step)", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {} });
    const next = hosts(tree).find(
      (el) => el.type === "button" && textOf(el.props.children as ReactNode).includes("Next: Pay"),
    )!;
    (next.props.onClick as () => void)();
    expect(setters[12]).toHaveBeenCalledWith(2);
  });

  it("the phone dock (the publish bar) carries the ONE primary — Publish", () => {
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {} });
    const dock = hosts(tree).find((el) => el.props.className === "posting-dock")!;
    expect(dock.props["data-mw-hidden"]).toBe(""); // shown by CSS at ≤1100px only (css fence)
    const inDock = hosts(dock).filter((el) => el.type === "button");
    expect(inDock.map((b) => textOf(b.props.children as ReactNode).trim())).toContain(
      "Publish posting",
    );
  });

  it("the step-3 hint names where Publish is at each width", () => {
    const { texts } = collect(render({ fields: BLANK_FIELDS, fieldErrors: {} }));
    const joined = texts.join(" ");
    expect(joined).toContain("Publish from the panel on the right →");
    expect(joined).toContain("Publish from the bar at the bottom of the screen ↓");
  });

  it("the 'Draft saved' cue is drawn but hidden until a save lands", () => {
    const cue = hosts(render({ fields: BLANK_FIELDS, fieldErrors: {} })).find(
      (el) => el.props.className === "mw-draft-cue",
    )!;
    expect(cue.props["data-shown"]).toBe("false");
    expect(cue.props["aria-hidden"]).toBe(true);
  });

  it("a successful publish drops the local draft", async () => {
    discardDraft.mockClear();
    const tree = render({
      fields: FULL_FIELDS,
      fieldErrors: {},
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
    });
    findForm(tree)!.props.onSubmit({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(discardDraft).toHaveBeenCalledTimes(1);
  });

  it("the draft is kept under the signed-in payer's own key (a shared browser never mixes them)", () => {
    render({ fields: BLANK_FIELDS, fieldErrors: {} });
    expect(draftHook.storageKey).toBe(`bb:posting-draft:${PAYER_ID}:new`);
  });

  it("no restored draft, no 'Restored' line", () => {
    const tree = render({ fields: BLANK_FIELDS, fieldErrors: {} });
    expect(hosts(tree).some((el) => el.props.className === "mw-draft-restored")).toBe(false);
  });

  it("a restored draft is said, and Discard drops it and reseeds a fresh form from step 1", () => {
    draftHook.restored = true;
    discardDraft.mockClear();
    const tree = render({ fields: FULL_FIELDS, fieldErrors: {} });
    const notice = hosts(tree).find((el) => el.props.className === "mw-draft-restored")!;
    expect(notice.props.role).toBe("status");
    expect(textOf(notice)).toContain("Restored unsaved changes from this device");
    const discard = hosts(notice).find((el) => el.type === "button")!;
    expect(textOf(discard).trim()).toBe("Discard");

    (discard.props.onClick as () => void)();
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(setters[0]).toHaveBeenCalledWith(BLANK_FIELDS); // fields
    expect(setters[4]).toHaveBeenCalledWith({ matchSkillIds: [], untickedRelatedIds: [] });
    expect(setters[6]).toHaveBeenCalledWith([]); // requirements
    expect(setters[7]).toHaveBeenCalledWith([]); // benefits
    expect(setters[12]).toHaveBeenCalledWith(1); // step
    expect(setters[13]).toHaveBeenCalledWith({ tradeLevel: "", answers: {}, matchSkillIds: [] });
  });
});

describe("PostingForm — #2645: a device draft that changes nothing is not restored", () => {
  /** A draft as this page kept it: a blank form, plus a pick from the old flat skill list. */
  const OLD_PICK = { matchSkillIds: ["mskill_cnc_turning"], untickedRelatedIds: [] };
  const SAVED = {
    fields: BLANK_FIELDS,
    requirements: [],
    benefits: [],
    reqDraft: "",
    benDraft: "",
    selection: OLD_PICK,
    trade: { tradeLevel: "", answers: {}, matchSkillIds: [] },
  };

  it("the form hands the hook its dirty test, so a draft whose one change is the old pick is dropped", () => {
    render({ fields: BLANK_FIELDS, fieldErrors: {} });
    const isDirty = draftHook.options!.isDirty!;
    expect(isDirty(SAVED)).toBe(false);
    expect(isDirty({ ...SAVED, fields: { ...BLANK_FIELDS, city: "Pune" } })).toBe(true);
    // A draft is read the way it is restored: a part it lacks starts blank (never a throw).
    expect(isDirty({ selection: OLD_PICK })).toBe(false);
    expect(isDirty({ fields: { city: "Pune" } })).toBe(true);
  });

  it("onRestore applies that same reading of the draft", () => {
    render({ fields: BLANK_FIELDS, fieldErrors: {} });
    draftHook.options!.onRestore!({ fields: { city: "Pune" } });
    expect(setters[0]).toHaveBeenCalledWith({ ...BLANK_FIELDS, city: "Pune" }); // fields
    expect(setters[4]).toHaveBeenCalledWith({ matchSkillIds: [], untickedRelatedIds: [] });
    expect(setters[13]).toHaveBeenCalledWith({ tradeLevel: "", answers: {}, matchSkillIds: [] });
  });
});

describe("isNewPostingDirty — what makes leaving ask first (W4)", () => {
  const blank = {
    fields: BLANK_FIELDS,
    requirements: [],
    benefits: [],
    reqDraft: "",
    benDraft: "",
    selection: { matchSkillIds: [], untickedRelatedIds: [] },
    trade: { tradeLevel: "", answers: {}, matchSkillIds: [] },
  };

  it("a blank form is clean", async () => {
    const { isNewPostingDirty } = await import("./posting-form");
    expect(isNewPostingDirty(blank)).toBe(false);
    expect(isNewPostingDirty({ ...blank, fields: { ...BLANK_FIELDS, city: "  " } })).toBe(false);
  });

  it("any typed field, chip, chip draft or trade answer makes it dirty", async () => {
    const { isNewPostingDirty } = await import("./posting-form");
    expect(isNewPostingDirty({ ...blank, fields: { ...BLANK_FIELDS, city: "Pune" } })).toBe(true);
    expect(isNewPostingDirty({ ...blank, requirements: ["ITI"] })).toBe(true);
    expect(isNewPostingDirty({ ...blank, benDraft: "PF" })).toBe(true);
    expect(
      isNewPostingDirty({
        ...blank,
        trade: { tradeLevel: "lead", answers: {}, matchSkillIds: [] },
      }),
    ).toBe(true);
  });

  it("#2645 — an old flat skill pick restored from this device is no change: nothing shows or sends it", async () => {
    const { isNewPostingDirty } = await import("./posting-form");
    expect(
      isNewPostingDirty({ ...blank, selection: { matchSkillIds: ["s1"], untickedRelatedIds: [] } }),
    ).toBe(false);
  });
});
