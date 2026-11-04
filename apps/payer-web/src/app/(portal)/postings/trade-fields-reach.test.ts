import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { PostingTradeFormWire } from "../../../lib/contracts";

/**
 * #2635 / #2645 — THE LIVE "Reaches N workers" IS SCOPED AS PUBLISH WILL BE. A company form hands
 * the trade fields its job's role (`reachRoleKind`), and the reach-preview read carries it as
 * `role_kind`; an agency form hands none, and its read carries none (the API scopes only company
 * jobs by trade).
 *
 * Node env: hooks are injected — `useState` answers its initial value, `useRef` is a plain cell
 * and `useEffect` runs its effect at once — so calling the component fires the preview read the
 * real one fires after mount.
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
const previewReachAction = vi.fn(async (_input: unknown) => ({ ok: false, error: "x" }));
vi.mock("./new/match-actions", () => ({
  previewReachAction: (input: unknown) => previewReachAction(input),
}));

const { TradePostingFields } = await import("./trade-fields");

const TRADE: PostingTradeFormWire = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  pack_id: "qp_cnc_turning",
  match_skill_id: "mskill_cnc_turner",
  ladder: [],
  questions: [],
};

function mount(reachRoleKind?: string) {
  TradePostingFields({
    trades: [TRADE],
    roleKind: "cnc_turner",
    value: { tradeLevel: "", answers: {} },
    onChange: () => undefined,
    onMatchSkillIdsChange: () => undefined,
    vocabulary: [],
    ...(reachRoleKind !== undefined ? { reachRoleKind } : {}),
  });
}

beforeEach(() => previewReachAction.mockClear());

describe("TradePostingFields — the reach preview's role_kind", () => {
  it("a company form's trade rides the preview read", () => {
    mount("cnc_turner");
    expect(previewReachAction).toHaveBeenCalledWith({
      matchSkillIds: ["mskill_cnc_turner"],
      untickedRelatedIds: [],
      roleKind: "cnc_turner",
    });
  });

  it("an agency form passes none, and the read carries none", () => {
    mount();
    expect(previewReachAction).toHaveBeenCalledTimes(1);
    expect(previewReachAction.mock.calls[0]![0]).not.toHaveProperty("roleKind");
  });
});
