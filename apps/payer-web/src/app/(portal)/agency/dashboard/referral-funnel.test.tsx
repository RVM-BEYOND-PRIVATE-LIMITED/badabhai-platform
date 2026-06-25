import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ReferralFunnel } from "./referral-funnel";
import type { AgencyReferralsSummary } from "../../../../lib/contracts";

/**
 * REFERRAL-FUNNEL guardrail test — k-anon surfacing NOT regressed.
 *
 * The backend already suppresses any stage count strictly below `minBucket` to 0. The funnel
 * must render that suppressed 0 as "<minBucket", NEVER a literal "0" — so a single named
 * invitee's consent can never be inferred (no oracle). A non-zero count (>= the floor) shows
 * as-is. There are NO per-invitee rows by construction (aggregate counts only).
 *
 * ReferralFunnel is a plain (non-hook) component; we render it to an element tree and walk
 * the text. RetryButton (in the null-summary branch) is a client hook component — stub it.
 */

vi.mock("../../../../components/retry-button", () => ({ RetryButton: () => null }));

function collectText(node: ReactNode, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((c) => collectText(c, out));
    return out;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.props && "children" in el.props) collectText(el.props.children, out);
  return out;
}

describe("ReferralFunnel — k-anon: a suppressed stage shows '<minBucket', never a literal 0", () => {
  it("renders below-floor stages as '<5' (the backend suppressed them to 0)", () => {
    const summary: AgencyReferralsSummary = { created: 7, clicked: 0, accepted: 0, minBucket: 5 };
    const text = collectText(ReferralFunnel({ summary }));
    expect(text).toContain("<5"); // clicked + accepted were suppressed to 0 → "<5".
    expect(text).toContain("7"); // created is >= the floor → shown as-is.
    // A bare "0" must never be rendered as a stage value (no single-invitee oracle).
    expect(text).not.toContain("0");
  });

  it("renders all-above-floor counts as-is (no spurious suppression)", () => {
    const summary: AgencyReferralsSummary = { created: 30, clicked: 12, accepted: 5, minBucket: 5 };
    const text = collectText(ReferralFunnel({ summary }));
    expect(text).toContain("30");
    expect(text).toContain("12");
    expect(text).toContain("5");
  });

  it("states the aggregate-only / '<floor' privacy note (no per-worker breakdown)", () => {
    const summary: AgencyReferralsSummary = { created: 7, clicked: 0, accepted: 0, minBucket: 5 };
    const joined = collectText(ReferralFunnel({ summary })).join(" ");
    expect(joined.toLowerCase()).toContain("aggregate only");
    expect(joined).toContain("no per-worker breakdown");
  });
});
