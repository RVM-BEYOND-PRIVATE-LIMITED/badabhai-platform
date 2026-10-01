import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { MaskedCandidate, StatTile } from "../../../components/ds";

/**
 * DASHBOARD (DS1.2) — server component rendered to an element tree in the node env and
 * walked. Asserts: three StatTiles whose counts come from the LIVE read, the ₹ price in
 * mono tabular, the recent-unlock teasers rendered via the MaskedCandidate primitive and
 * kept FACELESS (no worker name/phone/opaque id in the DOM or props), and the DS Card
 * empty/error states. requirePayer + getDashboard are mocked.
 */
const requirePayer = vi.fn();
const getDashboard = vi.fn();
const getOrgRole = vi.fn();
const flags = { agencyPortalEnabled: true };
vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("../../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("../../../lib/payer-api", () => ({ getDashboard: () => getDashboard() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// MERGE-1: AgentSections (the agency demand modules) is the AGENT-only branch. It does its own
// agency reads + role gate; here we stub it to a marker so this PAGE test asserts the COMPOSITION
// (an agent mounts it, an employer never does). AgentSections has its own unit test.
const AgentSectionsStub = () => null;
vi.mock("./agent-sections", () => ({ AgentSections: AgentSectionsStub }));

const { default: DashboardPage } = await import("./page");
const { PageHeader } = await import("../../../components/page-header");

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

async function render(
  over?: Partial<typeof DATA> | { throws: true },
  role: "employer" | "agent" = "employer",
  orgRole: "owner" | "recruiter" = "owner",
): Promise<ReactElement> {
  requirePayer.mockResolvedValue({ payerId: "p", displayLabel: "Acme", role });
  getOrgRole.mockReturnValue(orgRole);
  if (over && "throws" in over) getDashboard.mockRejectedValue(new Error("boom"));
  else getDashboard.mockResolvedValue({ ...DATA, ...over });
  return (await DashboardPage()) as ReactElement;
}

beforeEach(() => {
  requirePayer.mockReset();
  getDashboard.mockReset();
  getOrgRole.mockReset();
  flags.agencyPortalEnabled = true;
});

/** Every `href` in the tree, including link-bearing props (Card / StatTile `href`). */
function hrefsOf(node: ReactNode, acc: string[] = []): string[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => hrefsOf(c, acc));
    return acc;
  }
  const el = node as ReactElement<{ href?: unknown; children?: ReactNode }>;
  if (typeof el.props?.href === "string") acc.push(el.props.href);
  if (el.type === PageHeader) {
    const hp = el.props as { primaryAction?: { href: string } };
    if (hp.primaryAction) acc.push(hp.primaryAction.href);
  }
  if (el.props && "children" in el.props) hrefsOf(el.props.children, acc);
  return acc;
}

const headOf = (tree: ReactNode) => findAll(tree, PageHeader)[0]!;

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

  it("shows the ₹ unlock price in mono tabular (.bb-mono) inside the balance tile caption", async () => {
    const tree = await render();
    const balance = findAll(tree, StatTile).find((t) => p(t).label === "Credit balance")!;
    const monos = findByClass(p(balance).caption as ReactNode, "bb-mono");
    expect(monos.length).toBeGreaterThan(0);
    expect(monos.map((m) => textOf(p(m).children as ReactNode)).join("")).toContain("₹40");
  });
});

describe("CARDS-1 · clickable tiles + cards link to their REAL routes", () => {
  it("only the balance tile is a link (owner → Credits); the counts are counts", async () => {
    const tree = await render();
    const tiles = findAll(tree, StatTile);
    const byLabel = (l: string) => tiles.find((t) => p(t).label === l)!;
    expect(p(byLabel("Credit balance")).href).toBe("/credits");
    expect(String(p(byLabel("Credit balance")).ariaLabel ?? "").length).toBeGreaterThan(0);
    // "Open postings" repeated the panel's link; "Contacts unlocked" opened a list with no
    // unlocks on it. Neither is a door any more.
    expect(p(byLabel("Open postings")).href).toBeUndefined();
    expect(p(byLabel("Contacts unlocked")).href).toBeUndefined();
    for (const t of tiles) {
      if (p(t).href !== undefined) expect(String(p(t).ariaLabel ?? "").length).toBeGreaterThan(0);
    }
  });

  it("a RECRUITER is never linked to /credits (Owner-only — it 404s for them)", async () => {
    const tree = await render({ credits: { payerId: "p", balance: 0 } }, "employer", "recruiter");
    const balance = findAll(tree, StatTile).find((t) => p(t).label === "Credit balance")!;
    expect(p(balance).href).toBeUndefined();
    expect(p(balance).ariaLabel).toBeUndefined();
    expect(hrefsOf(tree)).not.toContain("/credits");
    // …while an owner on the same data gets the tile link, the quick card and the alert's action.
    const owner = await render({ credits: { payerId: "p", balance: 0 } }, "employer", "owner");
    expect(hrefsOf(owner).filter((h) => h === "/credits").length).toBeGreaterThanOrEqual(2);
  });

  it("ONE link to the Postings list and ONE New posting entry point (the head)", async () => {
    const tree = await render();
    const all = hrefsOf(tree);
    expect(all.filter((h) => h === "/postings")).toHaveLength(1);
    // A healthy account has no attention item, so the head is the only door to the form.
    const healthy = await render({ unlocks: [DATA.unlocks[0]!] });
    expect(hrefsOf(healthy).filter((h) => h === "/postings/new")).toHaveLength(1);
    expect(p(headOf(healthy)).primaryAction).toEqual({
      href: "/postings/new",
      label: "New posting",
      icon: "plus",
    });
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

  it("each Recent-unlock row is a faceless row, NOT a link to a list that shows no unlocks", async () => {
    const tree = await render();
    const rows = findByClass(tree, "dash-unlock-link");
    expect(rows.length).toBe(2);
    expect(rows.every((l) => p(l).href === undefined && p(l).ariaLabel === undefined)).toBe(true);
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

describe("UI-1 · empty + error states", () => {
  // The empty/error surfaces used to be bare DS Cards carrying one line of text. They are
  // now the shared `.state` block (icon + what is empty + why + what to do), so these assert
  // the STATE blocks rather than counting Cards — same intent, at the layer that now owns it.
  it("renders an empty state per section (no teasers, no posting rows) when there is no data", async () => {
    const tree = await render({ unlocks: [], postings: [] });
    expect(findAll(tree, MaskedCandidate).length).toBe(0);
    expect(findByClass(tree, "dash-posting").length).toBe(0);
    // One for "Your postings", one for "Recent unlocks".
    expect(findByClass(tree, "state").length).toBeGreaterThanOrEqual(2);
    expect(textOf(tree)).toContain("No contacts unlocked yet");
    expect(textOf(tree)).toContain("No postings yet");
    // PHASE 16 — an empty state must say what to do next, not just that it is empty: it names
    // the page's one primary action, which the head carries.
    expect(textOf(tree)).toContain("use New posting above");
    expect(p(headOf(tree)).primaryAction).toMatchObject({ label: "New posting" });
  });

  it("renders a neutral error state (no raw backend detail) when the read fails", async () => {
    const tree = await render({ throws: true });
    expect(textOf(tree)).toContain("We could not load your account");
    expect(findByClass(tree, "state--error").length).toBe(1);
    // The recovery action is part of the contract — an error with no way forward is a wall.
    expect(findByClass(tree, "state__actions").length).toBe(1);
    // no candidate/posting data leaks on the error path
    expect(findAll(tree, MaskedCandidate).length).toBe(0);
  });
});

describe("MERGE-1 · single role-aware dashboard composition (agent vs employer)", () => {
  it("an EMPLOYER dashboard mounts NO agency module (AgentSections never renders)", async () => {
    const tree = await render(undefined, "employer");
    expect(findAll(tree, AgentSectionsStub).length).toBe(0);
    // the employer keeps all THREE shared StatTiles + the 'Your postings' section
    const tiles = findAll(tree, StatTile);
    expect(tiles.length).toBe(3);
    const labels = tiles.map((t) => p(t).label);
    expect(labels).toContain("Open postings");
    expect(findByClass(tree, "dash-posting").length).toBe(2);
  });

  it("an AGENT dashboard mounts the agency demand modules (AgentSections) below the shared top", async () => {
    const tree = await render(undefined, "agent");
    expect(findAll(tree, AgentSectionsStub).length).toBe(1);
  });

  it("an AGENT dashboard DROPS the duplicate 'Open postings' tile + employer 'Your postings' list", async () => {
    const tree = await render(undefined, "agent");
    // DATA-COHERENCE: the employer job-postings-derived vacancy tile + list are omitted for
    // agents (the agency Demand summary + manager in AgentSections are the source of truth),
    // so they can never contradict.
    const tiles = findAll(tree, StatTile);
    expect(tiles.length).toBe(3); // Credit balance + Revenue (agent-only) + Contacts unlocked
    const labels = tiles.map((t) => p(t).label);
    expect(labels).toContain("Revenue"); // agent-only tile, no posting-derived data
    // The ONE way to Revenue on the dashboard (AgentSections no longer repeats it).
    expect(hrefsOf(tree).filter((h) => h === "/agency/revenue")).toHaveLength(1);
    expect(labels).not.toContain("Open postings");
    expect(labels).not.toContain("Open vacancies");
    // the employer-postings list does NOT render for an agent (no contradictory second list)
    expect(findByClass(tree, "dash-posting").length).toBe(0);
  });

  it("an AGENT still sees the COHERENT shared reads (credit balance + recent unlocks)", async () => {
    const tree = await render(undefined, "agent");
    const tiles = findAll(tree, StatTile);
    const byLabel = (l: string) => tiles.find((t) => p(t).label === l);
    expect(p(byLabel("Credit balance")!).value).toBe(247);
    expect(p(byLabel("Contacts unlocked")!).value).toBe(2);
    // recent-unlock teasers are coherent (same unlocks read) and stay faceless
    expect(findAll(tree, MaskedCandidate).length).toBe(2);
  });
});

/**
 * PR-D2 — the five-band reading order is the dashboard's whole design (see the page header):
 * NEEDS YOU → POSITION → DO SOMETHING → YOUR WORK → RECENT. The polish pass restyled every band,
 * so the order is pinned here at the top level of the rendered tree, for both personas.
 */
describe("PR-D2 · hierarchy + KPI variant", () => {
  /** Name each TOP-LEVEL band of the page fragment, in render order. */
  function bands(tree: ReactElement): string[] {
    const kids = (tree.props as { children?: ReactNode }).children;
    const list = (Array.isArray(kids) ? kids : [kids]).flat(Infinity) as ReactNode[];
    const out: string[] = [];
    for (const k of list) {
      if (k === null || k === undefined || typeof k !== "object") continue;
      const el = k as ReactElement<{ className?: unknown }>;
      if (el.type === AgentSectionsStub) {
        out.push("agency");
        continue;
      }
      if (el.type === PageHeader) {
        out.push("head");
        continue;
      }
      const cn = typeof el.props?.className === "string" ? el.props.className : "";
      const words = cn.split(/\s+/);
      if (words.includes("page-head")) out.push("head");
      else if (words.includes("attention")) out.push("needs-you");
      else if (words.includes("stat-row")) out.push("position");
      else if (words.includes("quick")) out.push("actions");
      else if (words.includes("panel")) {
        const t = textOf(el);
        out.push(
          t.includes("Your postings")
            ? "postings"
            : t.includes("Recent unlocks")
              ? "recent"
              : "panel?",
        );
      } else out.push(`?${cn}`);
    }
    return out;
  }

  it("employer: head → needs-you → position → actions → postings → recent", async () => {
    // balance 3 < LOW_BALANCE_THRESHOLD, so the needs-you band renders.
    const tree = await render({ credits: { payerId: "p", balance: 3 } });
    expect(bands(tree)).toEqual(["head", "needs-you", "position", "actions", "postings", "recent"]);
  });

  it("agent: the same spine minus the employer postings band, agency modules last", async () => {
    const tree = await render({ credits: { payerId: "p", balance: 3 } }, "agent");
    expect(bands(tree)).toEqual(["head", "needs-you", "position", "actions", "recent", "agency"]);
  });

  it("needs-you is ABSENT (not an empty band) when nothing needs the payer", async () => {
    // Balance 247 (above the low threshold), an open posting, and ONLY the granted unlock —
    // the fixture's expired unlock would itself raise an item.
    const tree = await render({ unlocks: [DATA.unlocks[0]!] });
    expect(bands(tree)).not.toContain("needs-you");
    expect(bands(tree)[1]).toBe("position");
  });

  it("the POSITION band is the opt-in KPI variant and holds exactly the StatTiles", async () => {
    const tree = await render();
    const rows = findByClass(tree, "stat-row");
    expect(rows).toHaveLength(1);
    expect(String(p(rows[0]!).className).split(/\s+/)).toEqual(["stat-row", "stat-row--kpi"]);
    expect(findAll(rows[0], StatTile)).toHaveLength(3);
  });
});

describe("AGENCY posting entry point — the agency form, never the company one", () => {
  it("an agent's head 'New posting' opens /agency/jobs/new; no link reaches /postings*", async () => {
    const tree = await render(undefined, "agent");
    expect(p(headOf(tree)).primaryAction).toEqual({
      href: "/agency/jobs/new",
      label: "New posting",
      icon: "plus",
    });
    expect(hrefsOf(tree).filter((h) => h.startsWith("/postings"))).toEqual([]);
  });

  it("with the agency-portal flag OFF an agent gets no posting door and no agency tiles", async () => {
    // Every agency page 404s with the flag off, so nothing here may link to one.
    flags.agencyPortalEnabled = false;
    const tree = await render(undefined, "agent");
    expect(p(headOf(tree)).primaryAction).toBeUndefined();
    const hrefs = hrefsOf(tree);
    expect(hrefs.filter((h) => h.startsWith("/agency"))).toEqual([]);
    expect(hrefs.filter((h) => h.startsWith("/postings"))).toEqual([]);
    expect(findAll(tree, StatTile).map((t) => p(t).label)).not.toContain("Revenue");
  });

  it("a company dashboard never shows agency vocabulary", async () => {
    expect(textOf(await render())).not.toMatch(/vacanc/i);
    expect(textOf(await render(undefined, "agent"))).not.toMatch(/vacanc/i);
  });
});
