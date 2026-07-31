import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { WorkerActivityList } from "./worker-activity-list";
import type { AgencyWorker } from "../../../../lib/contracts";

/**
 * WORKER-ACTIVITY-LIST tests — the faceless engagement table (ADR-0022 B5).
 *
 * What is pinned here:
 *  - EMPTY is the state this page actually ships in (no client requests the
 *    `agent_activity_visibility` consent yet), so the empty copy must be honest: it explains
 *    the two conditions, does NOT claim the feature is broken, and does NOT promise data soon.
 *  - a populated row renders ALL FIVE fields and NOTHING else.
 *  - `lastActiveOn: null` renders "Not seen yet" — never a fabricated date and never a vague
 *    relative time.
 *  - FACELESS: no name/phone/employer/job/unlocker, and no link or drill-down on the handle.
 *
 * Env is node (no DOM); the component is hookless, so we render it to an element tree and walk
 * it (the house pattern from agency-jobs-manager.test.tsx / referral-funnel.test.tsx).
 */

interface Collected {
  types: string[];
  text: string[];
  hrefs: unknown[];
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
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  if (el.props && "href" in el.props) acc.hrefs.push(el.props.href);
  if (el.props && "children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], text: [], hrefs: [] };
  walk(tree, acc);
  return acc;
}

const WORKER: AgencyWorker = {
  ref: "9f3a71c40b28de55",
  profileComplete: true,
  appliedCount: 4,
  unlockedCount: 2,
  lastActiveOn: "2026-07-28",
};

describe("WorkerActivityList — EMPTY state (the state this ships in) is honest", () => {
  it("explains BOTH conditions: joined through your invite AND agreed to share activity", () => {
    const joined = collect(WorkerActivityList({ workers: [] })).text.join(" ");
    expect(joined).toContain("No workers to show yet");
    expect(joined).toMatch(/join BadaBhai through your\s+invite/);
    expect(joined).toContain("agree to share their activity with you");
  });

  it("does NOT imply the feature is broken (no error/unavailable/retry language)", () => {
    const joined = collect(WorkerActivityList({ workers: [] })).text.join(" ");
    expect(joined).toContain("Nothing is broken");
    expect(joined).not.toMatch(/unavailable|failed|went wrong/i);
    // "there is nothing to retry" is the only permitted use of the word.
    expect(joined).toMatch(/nothing\s+to retry/);
  });

  it("does NOT promise imminent data (no 'soon', no date, no count)", () => {
    const joined = collect(WorkerActivityList({ workers: [] })).text.join(" ");
    expect(joined).not.toMatch(/coming soon|shortly|any day now|in the next/i);
    expect(joined).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("renders NO table and no fabricated zero rows when the list is empty", () => {
    const { types, text } = collect(WorkerActivityList({ workers: [] }));
    expect(types).not.toContain("table");
    expect(types).not.toContain("tr");
    expect(text.join(" ")).not.toMatch(/\b0\b/);
  });
});

describe("WorkerActivityList — a populated list renders every field", () => {
  it("renders the handle, profile status, both counts and the coarse day", () => {
    const { text, types } = collect(WorkerActivityList({ workers: [WORKER] }));
    const joined = text.join(" ");
    expect(types).toContain("table");
    expect(joined).toContain("9f3a71c40b28de55"); // the per-agency pseudonym
    expect(joined).toContain("Complete"); // profileComplete: true
    expect(text).toContain("4"); // appliedCount — its own text node
    expect(text).toContain("2"); // unlockedCount — its own text node
    expect(joined).toContain("2026-07-28"); // lastActiveOn, verbatim
  });

  it("renders an incomplete profile as 'In progress', never as a failure", () => {
    const joined = collect(
      WorkerActivityList({ workers: [{ ...WORKER, profileComplete: false }] }),
    ).text.join(" ");
    expect(joined).toContain("In progress");
    expect(joined).not.toMatch(/incomplete|abandoned|failed/i);
  });

  it("renders one row per worker", () => {
    const rows = collect(
      WorkerActivityList({
        workers: [WORKER, { ...WORKER, ref: "aaaa1111bbbb2222" }],
      }),
    ).types.filter((t) => t === "tr");
    // 1 header row + 2 body rows
    expect(rows.length).toBe(3);
  });
});

describe("WorkerActivityList — a null lastActiveOn is honest, never a fabricated date", () => {
  it("renders 'Not seen yet' and NO date at all", () => {
    const { text } = collect(
      WorkerActivityList({ workers: [{ ...WORKER, lastActiveOn: null }] }),
    );
    const joined = text.join(" ");
    expect(joined).toContain("Not seen yet");
    // No ISO day, and no invented relative time.
    expect(joined).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(joined).not.toMatch(/recently|today|just now|a while ago/i);
  });

  it("drops the mono-tabular class on the fallback (it is text, not a number)", () => {
    const tree = WorkerActivityList({ workers: [{ ...WORKER, lastActiveOn: null }] });
    const cells: ReactElement[] = [];
    const find = (node: ReactNode): void => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(find);
      const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
      if (String(el.props?.className ?? "").includes("agency-workers__last")) cells.push(el);
      if (el.props && "children" in el.props) find(el.props.children);
    };
    find(tree);
    expect(cells.length).toBe(1);
    expect(String((cells[0]!.props as Record<string, unknown>).className)).not.toContain(
      "bb-mono",
    );
  });
});

describe("WorkerActivityList — FACELESS guardrails", () => {
  it("renders no PII vocabulary and no phone-shaped digits", () => {
    const joined = collect(WorkerActivityList({ workers: [WORKER] })).text.join(" ");
    expect(joined).not.toMatch(/\bname\b|phone|\bemail\b|employer|address/i);
    expect(joined).not.toMatch(/\+?\d{7,}/);
  });

  it("has NO link/drill-down on a handle (a pseudonym must not be a pivot)", () => {
    const { types, hrefs } = collect(WorkerActivityList({ workers: [WORKER] }));
    expect(types).not.toContain("a");
    expect(hrefs).toHaveLength(0);
  });

  it("renders no 'which job' or 'who unlocked' column", () => {
    const joined = collect(WorkerActivityList({ workers: [WORKER] })).text.join(" ");
    expect(joined).not.toMatch(/which job|unlocked by|company name|job title/i);
  });
});
