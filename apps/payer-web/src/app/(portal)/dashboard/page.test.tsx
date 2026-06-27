import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { Card, MaskedCandidate, StatTile } from "../../../components/ds";

/**
 * DASHBOARD (DS1.2) — server component rendered to an element tree in the node env and
 * walked. Asserts: three StatTiles whose counts come from the LIVE read, the ₹ price in
 * mono tabular, the recent-unlock teasers rendered via the MaskedCandidate primitive and
 * kept FACELESS (no worker name/phone/opaque id in the DOM or props), and the DS Card
 * empty/error states. requirePayer + getDashboard are mocked.
 */
const requirePayer = vi.fn();
const getDashboard = vi.fn();
vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/payer-api", () => ({ getDashboard: () => getDashboard() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));

const { default: DashboardPage } = await import("./page");

const DATA = {
  credits: { payerId: "p", balance: 247 },
  unlocks: [
    {
      unlockId: "u1",
      workerId: "worker-uuid-AAAA",
      status: "granted",
      createdAt: "2026-06-20T00:00:00.000Z",
      expiresAt: "2026-12-20T00:00:00.000Z",
    },
    {
      unlockId: "u2",
      workerId: "worker-uuid-BBBB",
      status: "expired",
      createdAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  postings: [
    {
      id: "j1",
      roleTitle: "CNC Operator",
      locationLabel: "Pune",
      vacancyBand: "2-5",
      status: "open",
      applicantCount: 0,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "j2",
      roleTitle: "VMC Setter",
      locationLabel: null,
      vacancyBand: "1",
      status: "closed",
      applicantCount: 3,
      createdAt: "2026-05-15T00:00:00.000Z",
    },
  ],
};

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function findAll(node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findAll(c, type, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) acc.push(el);
  if (el.props && "children" in el.props) findAll(el.props.children, type, acc);
  return acc;
}

function findByClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findByClass(c, cls, acc));
    return acc;
  }
  const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
  const cn = el.props?.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
  if (el.props && "children" in el.props) findByClass(el.props.children, cls, acc);
  return acc;
}

const p = (el: ReactElement): Record<string, unknown> => el.props as Record<string, unknown>;

async function render(over?: Partial<typeof DATA> | { throws: true }): Promise<ReactElement> {
  requirePayer.mockResolvedValue({ payerId: "p", displayLabel: "Acme", role: "employer" });
  if (over && "throws" in over) getDashboard.mockRejectedValue(new Error("boom"));
  else getDashboard.mockResolvedValue({ ...DATA, ...over });
  return (await DashboardPage()) as ReactElement;
}

beforeEach(() => {
  requirePayer.mockReset();
  getDashboard.mockReset();
});

describe("DS1.2 · StatTiles read live counts (mono tabular)", () => {
  it("renders balance / open postings / unlocked from the live read", async () => {
    const tree = await render();
    const tiles = findAll(tree, StatTile);
    expect(tiles.length).toBe(3);
    const byLabel = (l: string) => tiles.find((t) => p(t).label === l);
    expect(p(byLabel("Credit balance")!).value).toBe(247);
    expect(p(byLabel("Open postings")!).value).toBe(1); // one open of two
    expect(p(byLabel("Contacts unlocked")!).value).toBe(2);
  });

  it("shows the ₹ unlock price in mono tabular (.bb-mono) inside the balance tile", async () => {
    const tree = await render();
    const balance = findAll(tree, StatTile).find((t) => p(t).label === "Credit balance")!;
    const monos = findByClass(p(balance).delta as ReactNode, "bb-mono");
    expect(monos.length).toBeGreaterThan(0);
    expect(monos.map((m) => textOf(p(m).children as ReactNode)).join("")).toContain("₹40");
  });
});

describe("CARDS-1 · clickable tiles + cards link to their REAL routes", () => {
  it("each StatTile is a whole-tile link to its mapped route, with an accessible name", async () => {
    const tree = await render();
    const tiles = findAll(tree, StatTile);
    const byLabel = (l: string) => tiles.find((t) => p(t).label === l)!;
    expect(p(byLabel("Credit balance")).href).toBe("/credits");
    expect(p(byLabel("Open postings")).href).toBe("/postings");
    expect(p(byLabel("Contacts unlocked")).href).toBe("/postings");
    // every linked tile carries a non-empty accessible name
    for (const t of tiles) {
      expect(typeof p(t).href).toBe("string");
      expect(String(p(t).ariaLabel ?? "").length).toBeGreaterThan(0);
    }
  });

  it("each 'Your postings' card links to THAT posting's applicants (real opaque id)", async () => {
    const tree = await render();
    const cards = findByClass(tree, "dash-posting");
    expect(cards.length).toBe(2);
    const hrefs = cards.map((c) => p(c).href as string);
    expect(hrefs).toContain("/postings/j1/applicants");
    expect(hrefs).toContain("/postings/j2/applicants");
    // accessible name present, no leftover inner "View" link (the stretched link is the target)
    expect(cards.every((c) => String(p(c).ariaLabel ?? "").includes("view applicants"))).toBe(true);
  });

  it("each Recent-unlock row is a whole-row link to /postings (faceless)", async () => {
    const tree = await render();
    const links = findByClass(tree, "dash-unlock-link");
    expect(links.length).toBe(2);
    expect(links.every((l) => p(l).href === "/postings")).toBe(true);
  });

  it("NO worker PII (uuid / phone-shaped / +91) appears in ANY generated href", async () => {
    const tree = await render();
    const cards = findByClass(tree, "dash-posting");
    const unlockLinks = findByClass(tree, "dash-unlock-link");
    const tileHrefs = findAll(tree, StatTile).map((t) => p(t).href as string | undefined);
    const cardHrefs = cards.map((c) => p(c).href as string | undefined);
    const unlockHrefs = unlockLinks.map((l) => p(l).href as string | undefined);
    const allHrefs = [...tileHrefs, ...cardHrefs, ...unlockHrefs].filter(Boolean) as string[];
    expect(allHrefs.length).toBeGreaterThan(0);
    for (const h of allHrefs) {
      // only the posting's OWN opaque id is allowed; never a worker id/phone
      expect(h).not.toContain("worker-uuid");
      expect(h).not.toMatch(/\b\d{10}\b/); // 10-digit phone run
      expect(h).not.toMatch(/\+91/);
      // a full uuid only ever appears as a posting id under /postings/<id>/applicants
      const uuid = h.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuid) expect(h).toMatch(/^\/postings\/[^/]+\/applicants$/);
    }
  });
});

describe("DS1.2 · recent-unlock teasers are faceless MaskedCandidate rows", () => {
  it("renders one MaskedCandidate per recent unlock, all unmasked, with NO PII", async () => {
    const tree = await render();
    const cands = findAll(tree, MaskedCandidate);
    expect(cands.length).toBe(2);
    expect(cands.every((c) => p(c).masked === false)).toBe(true);
    expect(cands.every((c) => p(c).name === "Unlocked contact")).toBe(true);

    // no opaque worker id or any phone-like run reaches the DOM or the component props
    const serialized = textOf(tree) + JSON.stringify(cands.map((c) => p(c)));
    expect(serialized).not.toContain("worker-uuid");
    expect(serialized).not.toMatch(/\b\d{10}\b/);
    expect(serialized).not.toMatch(/\+91/);
  });
});

describe("DS1.2 · DS Card empty + error states", () => {
  it("renders DS Card empty states (no teasers, no posting rows) when there is no data", async () => {
    const tree = await render({ unlocks: [], postings: [] });
    expect(findAll(tree, MaskedCandidate).length).toBe(0);
    expect(findAll(tree, Card).length).toBeGreaterThanOrEqual(2);
    expect(textOf(tree)).toContain("No contacts unlocked yet");
  });

  it("renders a neutral 'Service unavailable' DS Card when the read fails", async () => {
    const tree = await render({ throws: true });
    expect(textOf(tree)).toContain("Service unavailable");
    expect(findAll(tree, Card).length).toBeGreaterThanOrEqual(1);
    // no candidate/posting data leaks on the error path
    expect(findAll(tree, MaskedCandidate).length).toBe(0);
  });
});
