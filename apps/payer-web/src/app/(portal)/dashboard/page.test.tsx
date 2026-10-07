import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import { Icon } from "@badabhai/icons";
import { Badge, MaskedCandidate, StatTile } from "../../../components/ds";
import { unlockUnitPriceInr } from "../../../lib/pricing-config";
import { linkCues } from "../../../../test/link-cues";

/**
 * DASHBOARD (DS1.2) — server component rendered to an element tree in the node env and
 * walked. Asserts: three StatTiles whose counts come from the LIVE read, the ₹ price in
 * mono tabular, the recent-unlock rows (posting · dates · Unlocked/Expired status) kept
 * FACELESS (no worker name/phone/opaque id in the DOM or props), and the DS Card
 * empty/error states. requirePayer + the three reads (credits, unlocks, postings) are mocked —
 * each on its own, because the page reads them independently (F29: one failed read must not
 * blank the page).
 */
const requirePayer = vi.fn();
const getCredits = vi.fn();
const getUnlocks = vi.fn();
const getPostings = vi.fn();
const getOrgRole = vi.fn();
const getLiveCatalog = vi.fn();
const flags = { agencyPortalEnabled: true };
vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("../../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("../../../lib/payer-api", () => ({
  getCredits: () => getCredits(),
  getUnlocks: () => getUnlocks(),
  getPostings: () => getPostings(),
}));
// The per-unlock price is the LIVE catalog's (the same source as Credits).
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
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
      // As getUnlocks maps the wire: the current grant's time, and no posting context (a search
      // unlock, one made before #2033, or an agency unlock — whose `jobs` id is not carried).
      grantedAt: "2026-06-20T00:00:00.000Z" as string | null,
      jobPostingId: null as string | null,
    },
    {
      unlockId: "u2",
      workerId: "worker-uuid-BBBB",
      status: "expired",
      createdAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z",
      grantedAt: "2026-05-01T00:00:00.000Z" as string | null,
      jobPostingId: null as string | null,
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

type Read = "credits" | "unlocks" | "postings";

async function render(
  over?: Partial<typeof DATA> | { throws: true } | { fail: Read[] },
  role: "employer" | "agent" = "employer",
  orgRole: "owner" | "recruiter" = "owner",
): Promise<ReactElement> {
  requirePayer.mockResolvedValue({ payerId: "p", displayLabel: "Acme", role });
  getOrgRole.mockReturnValue(orgRole);
  // `throws` fails every read; `fail` fails just the named ones (F29).
  const failing: Read[] =
    over && "throws" in over
      ? ["credits", "unlocks", "postings"]
      : over && "fail" in over
        ? over.fail
        : [];
  const data = { ...DATA, ...(over && !("throws" in over) && !("fail" in over) ? over : {}) };
  const read =
    <T,>(name: Read, value: T) =>
    () =>
      failing.includes(name) ? Promise.reject(new Error(`${name} 500`)) : Promise.resolve(value);
  getCredits.mockImplementation(read("credits", data.credits));
  getUnlocks.mockImplementation(read("unlocks", data.unlocks));
  getPostings.mockImplementation(read("postings", data.postings));
  return (await DashboardPage()) as ReactElement;
}

beforeEach(() => {
  requirePayer.mockReset();
  getCredits.mockReset();
  getUnlocks.mockReset();
  getPostings.mockReset();
  getOrgRole.mockReset();
  getLiveCatalog.mockReset().mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
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
    const unit = unlockUnitPriceInr({ products: DEFAULT_CATALOG.products })!;
    expect(monos.map((m) => textOf(p(m).children as ReactNode)).join("")).toContain(`₹${unit}`);
  });

  it("the unlock price is DERIVED from the live catalog (an ops edit shows), never a literal", async () => {
    // Double every unlock pack's price (as Credits' own test edits it): the figure must follow.
    const EDITED = DEFAULT_CATALOG.products.map((x) =>
      x.kind === "credit_pack" && x.code === "contact_unlock"
        ? { ...x, tiers: x.tiers.map((t) => ({ ...t, priceInr: t.priceInr * 2 })) }
        : x,
    );
    const before = unlockUnitPriceInr({ products: DEFAULT_CATALOG.products })!;
    const after = unlockUnitPriceInr({ products: EDITED })!;
    expect(after).not.toBe(before);
    getLiveCatalog.mockResolvedValue({ products: EDITED, live: true });
    const tree = await render();
    const balance = findAll(tree, StatTile).find((t) => p(t).label === "Credit balance")!;
    expect(textOf(p(balance).caption as ReactNode)).toContain(`₹${after}`);
    expect(textOf(p(balance).caption as ReactNode)).not.toContain(`₹${before} `);
  });

  it("no unlock price on offer → no caption (never a made-up figure)", async () => {
    getLiveCatalog.mockResolvedValue({ products: [], live: true });
    const tree = await render();
    const balance = findAll(tree, StatTile).find((t) => p(t).label === "Credit balance")!;
    expect(p(balance).caption).toBeUndefined();
  });

  it("an agency session never asks for the company postings list", async () => {
    await render(undefined, "agent");
    expect(getPostings).not.toHaveBeenCalled();
    expect(getCredits).toHaveBeenCalledTimes(1);
    expect(getUnlocks).toHaveBeenCalledTimes(1);
    await render();
    expect(getPostings).toHaveBeenCalledTimes(1);
  });
});

describe("CARDS-1 · clickable tiles + cards link to their REAL routes", () => {
  it("every tile is a COUNT — the balance too (the header chip is the balance's door)", async () => {
    for (const orgRole of ["owner", "recruiter"] as const) {
      const tiles = findAll(await render(undefined, "employer", orgRole), StatTile);
      expect(tiles).toHaveLength(3);
      // "Open postings" repeated the panel's link; "Contacts unlocked" opened a list with no
      // unlocks on it; the balance repeated the header chip and the Buy credits card.
      for (const t of tiles) {
        expect(p(t).href, String(p(t).label)).toBeUndefined();
        expect(p(t).ariaLabel, String(p(t).label)).toBeUndefined();
      }
    }
  });

  /** The page's own links to Credits, and the ones that sit in a needs-you item's action. */
  const creditsDoors = (tree: ReactElement) => ({
    all: hrefsOf(tree).filter((h) => h === "/credits"),
    inAction: findByClass(tree, "attention__action").filter((a) => p(a).href === "/credits"),
  });
  // Only the granted unlock, so the wallet is the one needs-you item.
  const granted = { unlocks: [DATA.unlocks[0]!] };

  it("an OWNER at an empty or low balance gets exactly ONE 'Buy credits', in the needs-you item", async () => {
    // The page has no standing Credits door (no Buy credits card — F15), so the item's own
    // contextual action is the labelled way to buy when it matters.
    for (const balance of [0, 3]) {
      const tree = await render(
        { ...granted, credits: { payerId: "p", balance } },
        "employer",
        "owner",
      );
      const doors = creditsDoors(tree);
      expect(doors.all, `balance ${balance}`).toEqual(["/credits"]);
      expect(doors.inAction, `balance ${balance}`).toHaveLength(1);
      expect(textOf(doors.inAction[0]!).trim(), `balance ${balance}`).toBe("Buy credits");
    }
    // An agency owner the same.
    const agency = await render(
      { ...granted, credits: { payerId: "p", balance: 0 } },
      "agent",
      "owner",
    );
    expect(creditsDoors(agency).inAction).toHaveLength(1);
  });

  it("an OWNER with a healthy balance gets NO in-page door to Credits (the header chip is it)", async () => {
    const tree = await render(
      { ...granted, credits: { payerId: "p", balance: 247 } },
      "employer",
      "owner",
    );
    expect(findByClass(tree, "attention")).toEqual([]);
    expect(creditsDoors(tree).all).toEqual([]);
  });

  it("a RECRUITER gets the SAME doors as an owner — any member can buy (owner ruling 2026-10-07)", async () => {
    for (const role of ["employer", "agent"] as const) {
      for (const balance of [0, 3]) {
        const tree = await render(
          { ...granted, credits: { payerId: "p", balance } },
          role,
          "recruiter",
        );
        const doors = creditsDoors(tree);
        expect(doors.all, `${role} ${balance}`).toEqual(["/credits"]);
        expect(doors.inAction, `${role} ${balance}`).toHaveLength(1);
        expect(textOf(doors.inAction[0]!).trim(), `${role} ${balance}`).toBe("Buy credits");
        // Nobody is sent to ask an owner any more.
        expect(textOf(tree), `${role} ${balance}`).not.toMatch(/account owner/i);
      }
      // …and, like an owner, no in-page door at a healthy balance (the header chip is it).
      const healthy = await render(
        { ...granted, credits: { payerId: "p", balance: 247 } },
        role,
        "recruiter",
      );
      expect(creditsDoors(healthy).all, role).toEqual([]);
    }
  });

  it("all postings closed: the needs-you item says so, and the head's New posting is the door", async () => {
    const tree = await render({
      postings: DATA.postings.map((x) => ({ ...x, status: "closed" })),
      unlocks: [DATA.unlocks[0]!],
    });
    expect(textOf(findByClass(tree, "attention")[0]!)).toContain("No open postings");
    expect(findByClass(tree, "attention__action")).toEqual([]);
    expect(hrefsOf(tree).filter((h) => h === "/postings/new")).toHaveLength(1);
  });

  it("'No postings yet' is said ONCE, by the postings panel", async () => {
    const tree = await render({ postings: [], unlocks: [DATA.unlocks[0]!] });
    expect(textOf(tree).match(/No postings yet/g)).toHaveLength(1);
    // Zero postings is not a needs-you item (the panel says it right there).
    expect(findByClass(tree, "attention")).toEqual([]);
  });

  it("quick actions follow their destination's gate, and none repeats a door the page has", async () => {
    const labels = async (role: "employer" | "agent", orgRole: "owner" | "recruiter") =>
      findByClass(await render(undefined, role, orgRole), "quick__card").map((c) =>
        textOf(c).trim(),
      );
    // Plans & capacity is a COMPANY page; no "Buy credits" card (the shell's balance chip is the
    // door to Credits — F15); no "Invite workers" door (the agency's invite tools are
    // their own section).
    for (const orgRole of ["owner", "recruiter"] as const) {
      const company = await labels("employer", orgRole);
      expect(company, orgRole).toHaveLength(1);
      expect(company[0], orgRole).toMatch(/^Plans & capacity/);
      expect(await labels("agent", orgRole), orgRole).toEqual([]);
    }
    for (const role of ["employer", "agent"] as const) {
      expect(textOf(await render(undefined, role, "owner"))).not.toMatch(/Invite workers/);
    }
  });

  it("no quick actions at all → no empty 'Quick actions' band", async () => {
    const tree = await render(undefined, "agent", "recruiter");
    expect(findByClass(tree, "quick")).toEqual([]);
    expect(textOf(tree)).not.toContain("Quick actions");
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

  it("that one link names the list as the rail item and its H1 do: 'Postings'", async () => {
    // One label per destination: a navigation link says where it goes in the destination's own
    // name ("All postings" was a second name for the same page; the agency dashboard's says
    // "Postings" too).
    const toList: ReactElement[] = [];
    (function walk(node: ReactNode): void {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const el = node as ReactElement<{ href?: unknown; children?: ReactNode }>;
      if (el.props?.href === "/postings") toList.push(el);
      if (el.props && "children" in el.props) walk(el.props.children);
    })(await render());
    expect(toList).toHaveLength(1);
    expect(textOf(p(toList[0]!).children as ReactNode).trim()).toBe("Postings");
  });

  it("each 'Your postings' card opens THAT POSTING; its 'Applicants' action opens the feed (F12)", async () => {
    // One rule on every surface: a posting's title opens its details; applicants are reached
    // through the "Applicants" action (the card used to open the feed here and the details on
    // the agency dashboard).
    const tree = await render();
    const cards = findByClass(tree, "dash-posting");
    expect(cards.length).toBe(2);
    expect(cards.map((c) => p(c).href)).toEqual(["/postings/j1", "/postings/j2"]);
    expect(cards.map((c) => p(c).ariaLabel)).toEqual([
      "CNC Operator — view posting",
      "VMC Setter — view posting",
    ]);
    // Each card's "Applicants": the feed, icon + label, named for its posting (F13).
    const applicants = findByClass(tree, "dash-posting__applicants");
    expect(applicants.map((a) => p(a).href)).toEqual([
      "/postings/j1/applicants",
      "/postings/j2/applicants",
    ]);
    expect(applicants.map((a) => p(a)["aria-label"])).toEqual([
      "CNC Operator — Applicants",
      "VMC Setter — Applicants",
    ]);
    for (const a of applicants) {
      expect(textOf(a).trim()).toBe("Applicants");
      expect(findAll(a, Icon).map((i) => p(i).name)).toEqual(["users-three"]);
    }
    expect(textOf(tree)).not.toMatch(/view applicants/i);
  });

  it("a Recent-unlock row with no posting context is NOT a link and names no posting — company AND agency", async () => {
    // No posting context (a search unlock, or one made before #2033), and the page does not read
    // an agency's job titles — so no such row can name or open a posting. Both personas have
    // postings/jobs the row could have been wrongly tied to.
    for (const role of ["employer", "agent"] as const) {
      const tree = await render(undefined, role);
      const rows = findByClass(tree, "dash-unlock");
      expect(rows.length, role).toBe(2);
      for (const r of rows) {
        expect(p(r).href, role).toBeUndefined();
        expect(p(r).ariaLabel, role).toBeUndefined();
        expect(textOf(r)).toContain("Unlocked contact");
        expect(textOf(r)).not.toMatch(/CNC Operator|VMC Setter|View applicants/);
      }
    }
  });

  /** This payer's own company posting (a real uuid id), and an unlock made from a posting. */
  const OWN_ID = "bbbb2222-0000-4000-8000-000000000001";
  const FOREIGN_ID = "bbbb2222-0000-4000-8000-0000000000ff";
  const ownPostings = [{ ...DATA.postings[0]!, id: OWN_ID }];
  const madeFrom = (jobPostingId: string) => ({ ...DATA.unlocks[0]!, jobPostingId });

  it("#2033: a company unlock made from one of the payer's OWN postings names it and opens its applicants", async () => {
    const tree = await render({ postings: ownPostings, unlocks: [madeFrom(OWN_ID)] });
    const rows = findByClass(tree, "dash-unlock");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The whole card opens THAT posting's applicants, where the worker shows unlocked; the link
    // is named for its destination (F13).
    expect(p(row).href).toBe(`/postings/${OWN_ID}/applicants`);
    expect(p(row).ariaLabel).toBe("CNC Operator — Applicants");
    expect(textOf(findByClass(row, "dash-unlock__title")[0]!)).toBe("CNC Operator");
    expect(textOf(row)).not.toContain("Unlocked contact");
    const cta = findByClass(row, "dash-unlock__cta");
    expect(cta).toHaveLength(1);
    expect(textOf(cta[0]!).trim()).toBe("Applicants");
    expect(findAll(cta[0]!, Icon).map((i) => p(i).name)).toEqual(["arrow-right"]);
    // Still faceless: the dates and status stay, and no worker id reaches the row or its link.
    expect(findAll(row, Badge).map((b) => textOf(p(b).children as ReactNode).trim())).toEqual([
      "Unlocked",
    ]);
    expect(`${textOf(row)} ${String(p(row).href)} ${String(p(row).ariaLabel)}`).not.toContain(
      "worker-uuid",
    );
  });

  it("#2033: a posting id NOT in the payer's own list names nothing — never another payer's posting", async () => {
    const tree = await render({ postings: ownPostings, unlocks: [madeFrom(FOREIGN_ID)] });
    const rows = findByClass(tree, "dash-unlock");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(p(row).href).toBeUndefined();
    expect(p(row).ariaLabel).toBeUndefined();
    expect(textOf(row)).toContain("Unlocked contact");
    expect(textOf(row)).not.toContain("CNC Operator");
    expect(findByClass(row, "dash-unlock__cta")).toEqual([]);
    // The unresolved id goes nowhere: no href and no text on the page carries it.
    expect(hrefsOf(tree).filter((h) => h.includes(FOREIGN_ID))).toEqual([]);
    expect(textOf(tree)).not.toContain(FOREIGN_ID);
  });

  it("#2033 + F29: a FAILED postings read keeps the unlocks panel, and its rows stay plain", async () => {
    // The row's title comes only from the postings the page read; with that read failed, there is
    // nothing to name — the unlocks panel must still render (each part is read on its own).
    requirePayer.mockResolvedValue({ payerId: "p", displayLabel: "Acme", role: "employer" });
    getOrgRole.mockReturnValue("owner");
    getCredits.mockResolvedValue(DATA.credits);
    getUnlocks.mockResolvedValue([madeFrom(OWN_ID)]);
    getPostings.mockRejectedValue(new Error("postings 500"));
    const tree = (await DashboardPage()) as ReactElement;
    const errors = findByClass(tree, "state--error");
    expect(errors.map((e) => textOf(findByClass(e, "state__title")[0]!))).toEqual([
      "We couldn’t load your postings",
    ]);
    const rows = findByClass(tree, "dash-unlock");
    expect(rows).toHaveLength(1);
    expect(p(rows[0]!).href).toBeUndefined();
    expect(textOf(rows[0]!)).toContain("Unlocked contact");
  });

  it("NO worker PII (uuid / phone-shaped / +91) appears in ANY generated href", async () => {
    const tree = await render();
    const cards = findByClass(tree, "dash-posting");
    const unlockLinks = findByClass(tree, "dash-unlock");
    expect(unlockLinks).toHaveLength(2);
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
      // a full uuid only ever appears as a posting id: /postings/<id> or its /applicants
      const uuid = h.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuid) expect(h).toMatch(/^\/postings\/[^/]+(\/applicants)?$/);
    }
  });
});

describe("DS1.2 · recent-unlock rows are faceless", () => {
  it("renders one faceless row per recent unlock, with NO PII (and no decoy-name candidate row)", async () => {
    const tree = await render();
    const rows = findByClass(tree, "dash-unlock");
    expect(rows.length).toBe(2);
    // The rows are not the MaskedCandidate primitive any more: it drew a person (initials, a
    // name line, a green "Unlocked") for what is an access RECORD, so three rows read as three
    // identical "UC · Unlocked contact" people and an expired one still said "Unlocked".
    expect(findAll(tree, MaskedCandidate)).toHaveLength(0);
    for (const r of rows) expect(textOf(r)).toContain("Unlocked contact");

    // no opaque worker id or any phone-like run reaches the DOM or the row props
    const serialized =
      textOf(tree) +
      JSON.stringify(rows.map((r) => ({ href: p(r).href, ariaLabel: p(r).ariaLabel })));
    expect(serialized).not.toContain("worker-uuid");
    expect(serialized).not.toMatch(/\b\d{10}\b/);
    expect(serialized).not.toMatch(/\+91/);
  });
});

describe("F37 · a recent-unlock row says what, when, and whether access is still open", () => {
  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 864e5).toISOString();
  const badgesOf = (row: ReactElement) =>
    findAll(row, Badge).map((b) => ({
      tone: p(b).tone,
      text: textOf(p(b).children as ReactNode).trim(),
    }));

  it("an ENDED window is a neutral 'Expired' — never a green 'Unlocked' beside it", async () => {
    const tree = await render({
      unlocks: [
        { ...DATA.unlocks[0]!, unlockId: "live", status: "granted", expiresAt: day(7) },
        { ...DATA.unlocks[0]!, unlockId: "stored-expired", status: "expired", expiresAt: day(-30) },
        // The server derives `expired` at ITS read; a row it still sent as granted can lapse
        // before the page renders (or under clock skew) — its window end says it ended.
        { ...DATA.unlocks[0]!, unlockId: "lapsed", status: "granted", expiresAt: day(-1) },
      ],
    });
    const rows = findByClass(tree, "dash-unlock");
    expect(rows.map(badgesOf)).toEqual([
      [{ tone: "success", text: "Unlocked" }],
      [{ tone: "neutral", text: "Expired" }],
      [{ tone: "neutral", text: "Expired" }],
    ]);
  });

  it("each row carries its unlock day (the GRANT day) and its window end, as mono figures", async () => {
    const tree = await render({
      unlocks: [
        {
          ...DATA.unlocks[0]!,
          // A re-grant: the record is older than the grant it now holds.
          createdAt: "2026-05-01T00:00:00.000Z",
          expiresAt: day(7),
          grantedAt: "2026-10-01T10:00:00.000Z",
        },
        { ...DATA.unlocks[1]!, expiresAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    const [live, ended] = findByClass(tree, "dash-unlock");
    const t1 = textOf(live!).replace(/\s+/g, " ");
    expect(t1).toContain("Unlocked contact");
    expect(t1).toContain(`Unlocked 2026-10-01 · until ${day(7).slice(0, 10)}`);
    const t2 = textOf(ended!).replace(/\s+/g, " ");
    expect(t2).toContain("Unlocked 2026-05-01 · ended 2026-06-01");
    // The dates are mono figures, like every other date in the portal.
    const mono = findByClass(live!, "bb-mono").map((m) => textOf(m));
    expect(mono).toEqual(["2026-10-01", day(7).slice(0, 10)]);
  });

  it("rows run newest first BY THE DAY THEY PRINT, not by the API's record-creation order", async () => {
    // The API lists newest-created first; a re-grant moves granted_at, not created_at.
    const tree = await render({
      unlocks: [
        { ...DATA.unlocks[0]!, unlockId: "fresh", createdAt: "2026-09-20T09:00:00.000Z", grantedAt: "2026-09-20T09:00:00.000Z" },
        { ...DATA.unlocks[0]!, unlockId: "regrant", createdAt: "2026-07-01T09:00:00.000Z", grantedAt: "2026-10-05T09:00:00.000Z" },
      ],
    });
    const printed = findByClass(tree, "dash-unlock").map(
      (r) => findByClass(r, "bb-mono").map((m) => textOf(m))[0],
    );
    expect(printed).toEqual(["2026-10-05", "2026-09-20"]);
  });
});

describe("UI-1 · empty + error states", () => {
  // The empty/error surfaces used to be bare DS Cards carrying one line of text. They are
  // now the shared `.state` block (icon + what is empty + why + what to do), so these assert
  // the STATE blocks rather than counting Cards — same intent, at the layer that now owns it.
  it("renders an empty state per section (no teasers, no posting rows) when there is no data", async () => {
    const tree = await render({ unlocks: [], postings: [] });
    expect(findByClass(tree, "dash-unlock").length).toBe(0);
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

  it("every read failing: the head + New posting stay, and EACH panel says its own error (F29)", async () => {
    const tree = await render({ throws: true });
    // Never a blank page: the head and its one primary survive.
    expect(p(headOf(tree)).primaryAction).toMatchObject({ label: "New posting" });
    expect(textOf(tree)).not.toContain("We could not load your account");
    const errors = findByClass(tree, "state--error");
    expect(errors.map((e) => textOf(findByClass(e, "state__title")[0]!))).toEqual([
      "We couldn’t load your postings",
      "We couldn’t load your recent unlocks",
    ]);
    // The recovery action is part of the contract — an error with no way forward is a wall.
    for (const e of errors) expect(findByClass(e, "state__actions")).toHaveLength(1);
    // Every count is neutral — never a 0 that was not read.
    expect(findAll(tree, StatTile).map((t) => p(t).value)).toEqual(["—", "—", "—"]);
    // no candidate/posting data leaks on the error path, and no "No postings yet" claim
    expect(findByClass(tree, "dash-unlock").length).toBe(0);
    expect(textOf(tree)).not.toContain("No postings yet");
    expect(textOf(tree)).not.toContain("No contacts unlocked yet");
    // …and nothing is claimed about the unread account.
    expect(findByClass(tree, "attention")).toEqual([]);
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
    expect(tiles.length).toBe(2); // Credit balance + Contacts unlocked
    const labels = tiles.map((t) => p(t).label);
    expect(labels).toEqual(["Credit balance", "Contacts unlocked"]);
    // No "Revenue — Coming soon" placeholder in the KPI row (F21): the parked page is reached
    // from the rail's "Coming soon" group, not from a tile with no figure.
    expect(labels).not.toContain("Revenue");
    expect(hrefsOf(tree)).not.toContain("/agency/revenue");
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
    // recent-unlock rows are coherent (same unlocks read) and stay faceless
    expect(findByClass(tree, "dash-unlock").length).toBe(2);
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
    // balance 3 is below the pricing config's low-balance threshold (lowBalanceThreshold(),
    // default 5), so the needs-you band renders.
    const tree = await render({ credits: { payerId: "p", balance: 3 } });
    expect(bands(tree)).toEqual(["head", "needs-you", "position", "actions", "postings", "recent"]);
  });

  it("agent: the same spine minus the employer postings band, agency modules last", async () => {
    // (No quick actions for an agency — Credits' door is the shell's balance chip, F15 — so no
    // empty actions band either.)
    const tree = await render({ credits: { payerId: "p", balance: 3 } }, "agent");
    expect(bands(tree)).toEqual(["head", "needs-you", "position", "recent", "agency"]);
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

  it("the KPI row holds only counts that were read — no placeholder tile (F21)", async () => {
    for (const role of ["employer", "agent"] as const) {
      const tiles = findAll(await render(undefined, role), StatTile);
      for (const t of tiles) {
        // Every read succeeded here, so every tile carries a real figure and no door.
        expect(p(t).value, `${role} ${String(p(t).label)}`).not.toBe("—");
        expect(textOf(p(t).caption as ReactNode), `${role} ${String(p(t).label)}`).not.toMatch(
          /coming soon/i,
        );
        expect(p(t).href, `${role} ${String(p(t).label)}`).toBeUndefined();
      }
    }
  });

  it("a company dashboard never shows agency vocabulary", async () => {
    expect(textOf(await render())).not.toMatch(/vacanc/i);
    expect(textOf(await render(undefined, "agent"))).not.toMatch(/vacanc/i);
  });
});

/**
 * F29 (final sweep) — ONE failed read used to replace the whole dashboard with "We could not load
 * your account": the postings, the needs-you band AND the head's "New posting" were gone when only
 * the balance read failed. Each part is now read on its own; a failed part shows its own state.
 */
describe("F29 · one failed read never blanks the dashboard", () => {
  const tile = (tree: ReactElement, label: string) =>
    findAll(tree, StatTile).find((t) => p(t).label === label)!;
  const errorTitles = (tree: ReactElement) =>
    findByClass(tree, "state--error").map((e) => textOf(findByClass(e, "state__title")[0]!));

  it("BALANCE read fails: only the balance tile goes neutral; everything else renders", async () => {
    const tree = await render({ fail: ["credits"], credits: { payerId: "p", balance: 0 } });
    expect(p(headOf(tree)).primaryAction).toMatchObject({
      href: "/postings/new",
      label: "New posting",
    });
    expect(p(tile(tree, "Credit balance")).value).toBe("—");
    expect(textOf(p(tile(tree, "Credit balance")).caption as ReactNode)).toBe(
      "Not available right now",
    );
    expect(p(tile(tree, "Open postings")).value).toBe(1);
    expect(p(tile(tree, "Contacts unlocked")).value).toBe(2);
    expect(findByClass(tree, "dash-posting")).toHaveLength(2);
    expect(findByClass(tree, "dash-unlock")).toHaveLength(2);
    expect(errorTitles(tree)).toEqual([]);
    // The fixture's empty wallet was never READ, so nothing is said about it.
    expect(textOf(tree)).not.toMatch(/out of unlock credits|credits left/);
    // The expired unlock (a part that WAS read) is still said.
    expect(textOf(findByClass(tree, "attention")[0]!)).toContain("expired");
  });

  it("UNLOCKS read fails: the Recent unlocks panel says so (with Retry); the rest renders", async () => {
    const tree = await render({ fail: ["unlocks"] });
    expect(errorTitles(tree)).toEqual(["We couldn’t load your recent unlocks"]);
    expect(p(tile(tree, "Contacts unlocked")).value).toBe("—");
    expect(p(tile(tree, "Credit balance")).value).toBe(247);
    expect(findByClass(tree, "dash-posting")).toHaveLength(2);
    expect(findByClass(tree, "dash-unlock")).toHaveLength(0);
    expect(textOf(tree)).not.toContain("No contacts unlocked yet");
    expect(p(headOf(tree)).primaryAction).toMatchObject({ label: "New posting" });
  });

  it("POSTINGS read fails: the Your postings panel says so (with Retry); the rest renders", async () => {
    const tree = await render({
      fail: ["postings"],
      postings: DATA.postings.map((x) => ({ ...x, status: "closed" })),
    });
    expect(errorTitles(tree)).toEqual(["We couldn’t load your postings"]);
    expect(p(tile(tree, "Open postings")).value).toBe("—");
    expect(findByClass(tree, "dash-posting")).toHaveLength(0);
    expect(textOf(tree)).not.toContain("No postings yet");
    // Unread postings are not "all closed".
    expect(textOf(tree)).not.toContain("No open postings");
    // The panel keeps its one link to the Postings list, and the head its New posting.
    expect(hrefsOf(tree).filter((h) => h === "/postings")).toHaveLength(1);
    expect(p(headOf(tree)).primaryAction).toMatchObject({ label: "New posting" });
    expect(findByClass(tree, "dash-unlock")).toHaveLength(2);
  });

  it("an AGENCY dashboard survives a failed balance read too (agency modules still mount)", async () => {
    const tree = await render({ fail: ["credits"] }, "agent");
    expect(p(headOf(tree)).primaryAction).toMatchObject({ href: "/agency/jobs/new" });
    expect(p(tile(tree, "Credit balance")).value).toBe("—");
    expect(findAll(tree, AgentSectionsStub)).toHaveLength(1);
    expect(errorTitles(tree)).toEqual([]);
  });

  it("an error state names nothing it could not read (no raw backend detail)", async () => {
    const tree = await render({ throws: true });
    expect(textOf(tree)).not.toMatch(/500|credits 500|unlocks 500|postings 500/);
  });
});

describe("the navigation pending cue on the dashboard (components/portal-link.tsx)", () => {
  it("each posting card — its whole-card link and its Applicants link — carries it", async () => {
    const cues = linkCues(await render());
    expect(cues.get("/postings/j1/applicants")).toEqual(["Applicants"]);
    expect(cues.get("/postings/j2/applicants")).toEqual(["Applicants"]);
    expect(cues.get("/postings/j1")).toEqual([expect.any(String)]);
    expect(cues.get("/postings/j2")).toEqual([expect.any(String)]);
  });

  it("so do the quick card and the panel's Postings link — no link on the page goes without one", async () => {
    const cues = linkCues(await render());
    expect(cues.get("/plans")).toEqual(["Plans & capacity"]);
    expect(cues.get("/postings")).toEqual(["Postings"]);
    expect([...cues].filter(([, labels]) => labels.length === 0)).toEqual([]);
  });
});
