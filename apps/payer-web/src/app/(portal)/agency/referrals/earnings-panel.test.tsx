import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { StatTile } from "../../../../components/ds";
import type { AgencyEarnings } from "../../../../lib/contracts";
import { EarningsPanel } from "./earnings-panel";

/**
 * EarningsPanel is a SHARED (RSC) presentational component — no hooks — so we render it
 * directly and walk the element tree (node env, no DOM). Asserts: four ₹ StatTiles in
 * mono-via-DS, the config-sourced accrual basis sentence, and the always-visible
 * MOCK-money disclosure. StatTile carries its ₹ value in the `value` prop, so we expand it.
 */

const EARNINGS: AgencyEarnings = {
  totalAccruedInr: 1200,
  requestableInr: 800,
  inRequestInr: 0,
  paidInr: 400,
  accrualCount: 30,
  kycStatus: "verified",
  thresholdInr: 500,
  basisInr: 40,
  rateBps: 2500,
  windowDays: 90,
  payoutsEnabled: true,
  canRequest: true,
  blockedReason: null,
};

interface Collected {
  components: unknown[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") return void acc.text.push(node);
  if (typeof node === "number") return void acc.text.push(String(node));
  if (Array.isArray(node)) return void node.forEach((c) => walk(c, acc));
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type !== "string") acc.components.push(el.type);
  if (el.props) {
    if (el.type === StatTile) {
      if ("label" in el.props) walk(el.props.label as ReactNode, acc);
      if ("value" in el.props) walk(el.props.value as ReactNode, acc);
    }
    if ("children" in el.props) walk(el.props.children as ReactNode, acc);
  }
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { components: [], text: [] };
  walk(tree, acc);
  return acc;
}

describe("EarningsPanel", () => {
  it("renders four ₹ StatTiles with formatted amounts", () => {
    const { components, text } = collect(EarningsPanel({ earnings: EARNINGS }));
    expect(components.filter((c) => c === StatTile)).toHaveLength(4);
    const joined = text.join(" ");
    expect(joined).toContain("₹1,200"); // total accrued
    expect(joined).toContain("₹800"); // requestable
    expect(joined).toContain("₹400"); // paid
    for (const label of ["Total accrued", "Requestable", "In request", "Paid"]) {
      expect(joined).toContain(label);
    }
  });

  it("shows the config-sourced accrual basis sentence", () => {
    const { text } = collect(EarningsPanel({ earnings: EARNINGS }));
    expect(text.join(" ")).toContain(
      "25% × ₹40 per contact unlock on your referred workers within 90 days",
    );
  });

  it("shows the MOCK-money disclosure (no real money disbursed)", () => {
    const { text } = collect(EarningsPanel({ earnings: EARNINGS }));
    expect(text.join(" ")).toMatch(/No real money is disbursed/i);
  });
});
