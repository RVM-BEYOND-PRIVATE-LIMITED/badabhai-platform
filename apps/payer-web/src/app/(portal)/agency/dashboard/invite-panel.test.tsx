import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { AgencyInvitePanel } from "./invite-panel";

/**
 * INVITE INTENT panel — CONSENT-FIRST, DISABLED, NON-FUNCTIONAL (there is NO agency
 * invite API). Asserts:
 *  - the consent copy is EXACT,
 *  - the only control is a DISABLED button (no link is generated, no success faked),
 *  - there is NO input/form/select/textarea (no phone/name/CSV is ever accepted).
 */

interface Collected {
  types: string[];
  text: string[];
  disabledButtons: { disabled: boolean; label: string }[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode; disabled?: boolean }>;
  if (typeof el.type === "string") {
    acc.types.push(el.type);
    if (el.type === "button") {
      const label: string[] = [];
      walk(el.props?.children, { types: [], text: label, disabledButtons: [] });
      acc.disabledButtons.push({ disabled: Boolean(el.props?.disabled), label: label.join("") });
    }
  }
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(node: ReactNode): Collected {
  const acc: Collected = { types: [], text: [], disabledButtons: [] };
  walk(node, acc);
  return acc;
}

describe("AgencyInvitePanel — consent-first, disabled, no input", () => {
  it("carries the EXACT consent requirement copy", () => {
    const { text } = collect(AgencyInvitePanel());
    expect(text.join(" ")).toContain(
      "Share this link with workers. They must self-onboard and accept consent before BadaBhai processes their data.",
    );
  });

  it("renders ONE disabled 'coming soon' button and generates no link", () => {
    const { disabledButtons, types } = collect(AgencyInvitePanel());
    expect(disabledButtons).toHaveLength(1);
    expect(disabledButtons[0]?.disabled).toBe(true);
    expect(disabledButtons[0]?.label).toContain("Generate invite link (coming soon)");
    // No anchor (no real link affordance) is rendered for the invite control.
    expect(types).not.toContain("a");
  });

  it("accepts NO input — no phone/name/CSV field (faceless + consent gate)", () => {
    const { types } = collect(AgencyInvitePanel());
    for (const t of ["input", "form", "select", "textarea"]) {
      expect(types).not.toContain(t);
    }
  });
});
