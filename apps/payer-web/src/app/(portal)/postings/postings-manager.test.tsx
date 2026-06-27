import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button } from "../../../components/ds";

/**
 * POSTINGS-MANAGER tests (DS2.2 re-skin) — STATUS RENDERING + GATED-TRIO + A11Y (B8).
 *
 * The manager is now a PURE presentational DS surface (no hooks, no server actions): each
 * posting renders as a DS Card with its REAL `status` Badge and the pause/resume/quota
 * top-up GATED TRIO as DISABLED DS Buttons + a "coming soon" note (no payer-authed
 * lifecycle route exists yet). These tests assert:
 *  - the status Badge reflects the posting's real `status` (open → success tone, etc.);
 *  - every gated-trio Button renders DISABLED (never fires a fake live action);
 *  - the "coming soon" note is present;
 *  - each row keeps an `aria-live="polite"` region (B8 — announces a row failure).
 *
 * Env is node (no DOM); the component is a plain function we render to an element tree and
 * walk. DS Button/Badge are HOOKLESS pure components — collected by `el.type === Button`/
 * `Badge` and expanded ONE level (calling the function) to read `disabled` / the rendered
 * native host. `next/link` resolves to an `<a>` so its text is reachable.
 */

const { PostingsManager } = await import("./postings-manager");

const OPEN: PostingSummary = {
  id: "bbbb2222-0000-4000-8000-000000000001",
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  vacancyBand: "6-20",
  status: "open",
  applicantCount: 2,
  applicantQuota: 10,
  createdAt: "2026-06-22T00:00:00.000Z",
};

interface CollectedButton {
  text: string;
  disabled: boolean;
}
interface CollectedBadge {
  text: string;
  tone: string;
}
interface Collected {
  buttons: CollectedButton[];
  badges: CollectedBadge[];
  ariaLiveCount: number;
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

  // DS Button — a hookless wrapper. Read its props directly (disabled + label); don't recurse
  // into its rendered native <button>, the props ARE the contract.
  if (el.type === Button) {
    acc.buttons.push({
      text: textOf(el.props.children).trim(),
      disabled: el.props.disabled === true,
    });
    return;
  }
  // DS Badge — the REAL status chip. Record its text + tone.
  if (el.type === Badge) {
    acc.badges.push({
      text: textOf(el.props.children).trim(),
      tone: typeof el.props.tone === "string" ? el.props.tone : "neutral",
    });
    return;
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], badges: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

function render(postings: PostingSummary[]) {
  return PostingsManager({ postings }) as ReactElement;
}

describe("PostingsManager — STATUS RENDERING reflects the real status", () => {
  it("an open posting renders a success-tone status Badge with the real status text", () => {
    const { badges } = collect(render([OPEN]));
    const status = badges.find((b) => b.text === "open");
    expect(status).toBeDefined();
    expect(status!.tone).toBe("success");
  });

  it("a paused posting renders a warning-tone status Badge; draft/closed render neutral", () => {
    const paused = collect(render([{ ...OPEN, status: "paused" }])).badges.find(
      (b) => b.text === "paused",
    );
    expect(paused?.tone).toBe("warning");

    const draft = collect(render([{ ...OPEN, status: "draft" }])).badges.find(
      (b) => b.text === "draft",
    );
    expect(draft?.tone).toBe("neutral");

    const closed = collect(render([{ ...OPEN, status: "closed" }])).badges.find(
      (b) => b.text === "closed",
    );
    expect(closed?.tone).toBe("neutral");
  });
});

describe("PostingsManager — GATED TRIO renders DISABLED with a coming-soon note", () => {
  it("Pause + Top up applicant quota render as DISABLED DS Buttons (no fake live action)", () => {
    const { buttons } = collect(render([OPEN]));
    const pause = buttons.find((b) => b.text === "Pause");
    const topUp = buttons.find((b) => b.text.includes("Top up applicant quota"));
    expect(pause).toBeDefined();
    expect(pause!.disabled).toBe(true);
    expect(topUp).toBeDefined();
    expect(topUp!.disabled).toBe(true);
  });

  it("a paused posting offers a DISABLED Resume button (still gated, not wired)", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "paused" }]));
    const resume = buttons.find((b) => b.text === "Resume");
    expect(resume).toBeDefined();
    expect(resume!.disabled).toBe(true);
  });

  it("EVERY gated-trio button on the row is disabled (never a fake live route)", () => {
    const { buttons } = collect(render([OPEN]));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("renders the 'coming soon' gated note", () => {
    expect(textOf(render([OPEN]))).toContain("coming soon");
  });
});

describe("PostingsManager — A11Y-OF-FAILURE: per-row error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' error container per row", () => {
    const { ariaLiveCount } = collect(render([OPEN]));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });

  it("renders one aria-live region per posting row (announces a row failure)", () => {
    const second = { ...OPEN, id: "bbbb2222-0000-4000-8000-000000000002" };
    const { ariaLiveCount } = collect(render([OPEN, second]));
    expect(ariaLiveCount).toBe(2);
  });

  it("renders a faceless empty state when there are no postings", () => {
    expect(textOf(render([]))).toContain("haven");
  });
});
