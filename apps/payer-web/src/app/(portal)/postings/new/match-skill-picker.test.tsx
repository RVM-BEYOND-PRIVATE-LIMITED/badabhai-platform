import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { MatchSelection } from "./match-skill-picker";

/**
 * THE RELATED-SKILL AFFORDANCE (#2104 / ADR-0050 Q2).
 *
 * The picker is shared by the company posting form and the agency job form, and they differ in
 * exactly one way: whether UNTICKING a related skill is offered.
 *
 *  - COMPANY (`relatedUnticks` default true): unticking is how a company narrows (ruling #4), so
 *    each related chip is a live control and a press reaches `onChange` with the untick.
 *  - AGENCY (`relatedUnticks={false}`): an agency job's reach is its system-owned V1 twin's, and
 *    the twin's `reach_skill_ids` is `match ∪ related(match)` with NO unticks (ADR-0050 Q2 —
 *    `jobs` has no column to store one). A control that could not take effect is worse than none,
 *    so the chips are shown ON and LOCKED, and the copy drops the "you keep ticked" promise.
 *
 * Node env, no DOM: the picker's hooks are injected (`useState` seeded POSITIONALLY — preview,
 * error, loading — `useRef` a plain cell, `useEffect` a no-op, so no preview is fetched) and the
 * component function is called directly. The DS `Chip` is a pure function component, so the
 * walker renders it one level to reach the native `<button>` it emits.
 */

let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  return [stateQueue[i] === undefined ? initial : stateQueue[i], vi.fn()] as [
    unknown,
    (v: unknown) => void,
  ];
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => undefined,
  };
});
// The live reach read is the picker's own I/O; this file asserts only what it RENDERS.
vi.mock("./match-actions", () => ({
  previewReachAction: vi.fn(async () => ({ ok: false, error: "x" })),
}));

const { MatchSkillPicker } = await import("./match-skill-picker");

const VOCAB = [
  {
    skill_id: "mskill_cnc_turning",
    label: "CNC turning",
    industry_id: "ind_manufacturing",
    related_skill_ids: ["mskill_vmc_operation"],
  },
];
/** A preview with one posted skill and one related one, PRE-TICKED (ruling #4). */
const PREVIEW = {
  skills: [
    {
      skill_id: "mskill_cnc_turning",
      label: "CNC turning",
      reach_count: 12,
      related: [
        { skill_id: "mskill_vmc_operation", label: "VMC operation", ticked: true, reach_count: 4 },
      ],
    },
  ],
  reach_skill_ids: ["mskill_cnc_turning", "mskill_vmc_operation"],
  reach_total: 16,
  reach_tier1: 12,
  zero_reach: false,
  applied_unticked_ids: [],
  max_skills_per_posting: 3,
};
const SELECTION: MatchSelection = {
  matchSkillIds: ["mskill_cnc_turning"],
  untickedRelatedIds: [],
};

interface Found {
  /** Every native button the picker draws: its label, pressed state and whether it is live. */
  buttons: Array<{ text: string; pressed: unknown; disabled: unknown; onClick?: () => void }>;
  text: string;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") return textOf((el.type as (p: unknown) => ReactNode)(el.props));
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function walk(node: ReactNode, acc: Found): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text += String(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "function") {
    walk((el.type as (p: unknown) => ReactNode)(el.props), acc);
    return;
  }
  if (el.type === "button") {
    acc.buttons.push({
      text: textOf(el.props.children as ReactNode).trim(),
      pressed: el.props["aria-pressed"],
      disabled: el.props.disabled,
      onClick: el.props.onClick as (() => void) | undefined,
    });
  }
  if ("children" in el.props) walk(el.props.children, acc);
}

function render(relatedUnticks?: boolean) {
  const onChange = vi.fn<(next: MatchSelection) => void>();
  stateQueue = [PREVIEW]; // preview seeded; error/loading keep their initials
  stateCursor = 0;
  const tree = MatchSkillPicker({
    vocabulary: VOCAB,
    selection: SELECTION,
    onChange,
    ...(relatedUnticks === undefined ? {} : { relatedUnticks }),
  }) as ReactElement;
  const acc: Found = { buttons: [], text: "" };
  walk(tree, acc);
  return { ...acc, onChange, related: acc.buttons.find((b) => b.text.includes("VMC operation"))! };
}

beforeEach(() => {
  useState.mockClear();
});

describe("MatchSkillPicker — the COMPANY default: unticking a related skill narrows", () => {
  it("the related chip is a LIVE control, and pressing it reaches onChange as an untick", () => {
    const { related, onChange } = render();
    expect(related.disabled).toBeUndefined();
    expect(related.pressed).toBe(true); // pre-ticked (ruling #4)
    related.onClick!();
    expect(onChange).toHaveBeenCalledWith({
      matchSkillIds: ["mskill_cnc_turning"],
      untickedRelatedIds: ["mskill_vmc_operation"],
    });
  });

  it("the copy promises the narrowing it offers", () => {
    const { text } = render();
    expect(text).toContain("you keep ticked");
    expect(text).toContain("Also show to");
  });
});

describe("MatchSkillPicker — relatedUnticks={false} (the agency form, ADR-0050 Q2)", () => {
  it("the related chip is ON and LOCKED: no handler, nothing to press, nothing to drop", () => {
    const { related } = render(false);
    expect(related.pressed).toBe(true);
    expect(related.disabled).toBe(true);
    expect(related.onClick).toBeUndefined();
  });

  it("NOTHING in this mode can produce an untick — onChange is never called with one", () => {
    const { buttons, onChange } = render(false);
    // Press every live control the picker drew (the vocabulary chips) — the only ones left.
    for (const b of buttons) b.onClick?.();
    for (const call of onChange.mock.calls) {
      expect(call[0].untickedRelatedIds).toEqual([]);
    }
  });

  it("the copy drops the promise it cannot keep, and says the related skills are included", () => {
    const { text } = render(false);
    expect(text).not.toContain("you keep ticked");
    expect(text).toContain("Also shown to");
    expect(text).toContain("always included");
  });

  it("the vocabulary chips stay live — the PICK itself is still the payer's", () => {
    const { buttons, onChange } = render(false);
    const posted = buttons.find((b) => b.text === "CNC turning")!;
    // `disabled={!selected && atCap}` — false for a picked chip, so it is live, not locked.
    expect(posted.disabled).toBe(false);
    posted.onClick!();
    // Pressing a picked skill un-picks it (and carries no untick).
    expect(onChange).toHaveBeenCalledWith({ matchSkillIds: [], untickedRelatedIds: [] });
  });
});
