import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { MatchSkillWire, PostingTradeFormWire } from "../../../lib/contracts";

/**
 * #2645 — THE "Matched as:" LINE NAMES SKILLS, NEVER IDS. The trade panel lists the posting's
 * derived match set by name: the match vocabulary's label when `GET /payer/match/skills` loaded,
 * else the catalogue's own words (the trade's name for its own skill, a picked chip's label for the
 * skill it adds). That read no longer blocks a company post, so its failure must not print a raw
 * `mskill_*` id.
 *
 * Node env: hooks are injected — `useState` answers its initial value, `useRef` is a plain cell and
 * `useEffect` runs at once (the reach read is stubbed) — and the returned tree is walked as data.
 */

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => [initial, () => undefined],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: (effect: () => void) => effect(),
  };
});
vi.mock("./new/match-actions", () => ({
  previewReachAction: async () => ({ ok: false, error: "x" }),
}));

const { TradePostingFields } = await import("./trade-fields");

const chip = (option_key: string, label: string, match_skill_ids: string[]) => ({
  option_key,
  value: option_key,
  label,
  match: match_skill_ids.length > 0,
  match_skill_ids,
});
const TRADE: PostingTradeFormWire = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  pack_id: "qp_cnc_turning",
  match_skill_id: "mskill_cnc_turner",
  ladder: [],
  questions: [
    {
      question_key: "machine_type",
      prompt: "Which machine?",
      answer_type: "multi_select",
      options: [
        chip("vmc", "VMC", ["mskill_vmc_operating"]),
        chip("five_axis", "5-axis centre", ["mskill_five_axis_a", "mskill_five_axis_b"]),
        chip("manual", "Manual lathe", []),
      ],
    },
  ],
};
const skill = (skill_id: string, label: string): MatchSkillWire =>
  ({ skill_id, label, industry_id: "ind_x", related_skill_ids: [] }) as unknown as MatchSkillWire;

/** The text of the panel's "Matched as:" line (host elements only; no component is invoked). */
function matchedAsLine(answers: Record<string, string[]>, vocabulary: MatchSkillWire[]): string {
  const tree = TradePostingFields({
    trades: [TRADE],
    roleKind: "cnc_turner",
    value: { tradeLevel: "", answers },
    onChange: () => undefined,
    onMatchSkillIdsChange: () => undefined,
    vocabulary,
    reachRoleKind: "cnc_turner",
  }) as ReactElement;
  const line = find(tree, "trade-fields__summary-line");
  expect(line).not.toBeNull();
  return text(line);
}

function find(node: ReactNode, className: string): ReactElement | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, className);
      if (hit !== null) return hit;
    }
    return null;
  }
  const el = node as ReactElement<{ className?: string; children?: ReactNode }>;
  if (el.props.className === className) return el;
  return find(el.props.children, className);
}

function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("TradePostingFields — the 'Matched as:' line (#2645)", () => {
  it("names each skill by the match vocabulary when it loaded", () => {
    const vocabulary = [
      skill("mskill_cnc_turner", "CNC Turning"),
      skill("mskill_vmc_operating", "VMC Operating"),
    ];
    expect(matchedAsLine({ machine_type: ["vmc"] }, vocabulary)).toBe(
      "Matched as: CNC Turning, VMC Operating (2/3)",
    );
  });

  it("with no vocabulary: the trade names its own skill, the picked chip names the one it adds", () => {
    const line = matchedAsLine({ machine_type: ["vmc", "manual"] }, []);
    expect(line).toBe("Matched as: CNC Turner, VMC (2/3)");
    expect(line).not.toContain("mskill_");
  });

  it("a chip that adds two skills is named once; the count still counts both", () => {
    const line = matchedAsLine({ machine_type: ["five_axis"] }, []);
    expect(line).toBe("Matched as: CNC Turner, 5-axis centre (3/3)");
    expect(line).not.toContain("mskill_");
  });

  it("a vocabulary missing one skill names only that one from the catalogue", () => {
    const line = matchedAsLine({ machine_type: ["vmc"] }, [skill("mskill_cnc_turner", "CNC Turning")]);
    expect(line).toBe("Matched as: CNC Turning, VMC (2/3)");
  });
});
