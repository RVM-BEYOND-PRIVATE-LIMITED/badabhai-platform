import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../lib/auth/types";

/**
 * PORTAL SHELL (IA-1) — the chrome is now a levelled left rail, but the
 * AUTHORIZATION model is unchanged and SERVER-DRIVEN:
 *  - product LABELING (Companies vs Agencies) comes from `session.role`, not a client flag;
 *  - Owner-only affordances (Credits/Team) are driven by `getOrgRole` but are NOT the authz —
 *    the SERVER gate `requireOwner` is what 404s a Recruiter (proven in org-roles.test.ts);
 *  - the shared recruiter surfaces (Dashboard / Post / Manage / Capacity) show for everyone;
 *  - the balance chip is a fail-soft courtesy read (hidden, never fatal, on a credits error);
 *  - the agency items follow the agency-portal flag their pages check.
 */

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn();
const getCredits = vi.fn();
const flags = { agencyPortalEnabled: true };

vi.mock("../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("../../lib/payer-api", () => ({ getCredits: () => getCredits() }));
vi.mock("../../lib/config", () => ({ agencyFlags: () => flags }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// The nav (client) reads the active route via usePathname — pin it so the nav renders
// deterministically when the test walk expands the component.
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

/**
 * AppShell is a real client component: it holds the collapse/drawer state, so it calls
 * useState/useEffect/useId. The walker below expands function components by CALLING them,
 * which cannot run hooks outside a renderer.
 *
 * The stand-in keeps the property this suite actually tests. What is under test here is the
 * SERVER's decision — which destinations the shell offers this session, and how it labels
 * them — not the rail's open/closed behaviour (that is presentation, and the rail's own
 * markup is asserted in sidebar-nav/nav-model tests). So the stand-in renders the same
 * `sections` the server computed as plain anchors, plus the brand/header/footer slots
 * verbatim, and the walk sees exactly the hrefs and text the real rail would render.
 *
 * Every item is rendered as an anchor, as sidebar-nav.tsx does: the model holds only
 * destinations whose page renders for the session (there is no disabled item any more).
 */
vi.mock("./app-shell", () => ({
  AppShell: ({
    sections,
    brand,
    header,
    footer,
    children,
  }: {
    sections: {
      title?: string;
      items: { href: string; label: string }[];
    }[];
    brand: ReactNode;
    header: ReactNode;
    footer: ReactNode;
    children: ReactNode;
  }) => ({
    type: "div",
    props: {
      children: [
        brand,
        ...sections.flatMap((s) =>
          s.items.map((i) => ({ type: "a", key: i.href, props: { href: i.href, children: i.label } })),
        ),
        header,
        footer,
        children,
      ],
    },
  }),
}));
// ThemeToggle (client, hooks) — render an inert stand-in so the shell walk doesn't run real
// React hooks. The theme control's own behaviour is covered by theme-toggle.test.tsx.
vi.mock("../../components/ds", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ThemeToggle: () => null };
});
// AccountMenu is a client component (hooks) — render a thin stand-in that echoes its
// accessible name so the walk can assert the shell mounts the identity menu.
vi.mock("./account-menu", () => ({
  AccountMenu: ({ orgName, email }: { orgName: string; email?: string }) => ({
    type: "div",
    props: {
      "aria-label": `Signed in as ${orgName}${email ? ", " + email : ""}`,
      children: orgName,
    },
  }),
}));

// The balance chip is a client component (hooks: its tooltip's Escape listener); its own markup
// is balance-chip.test.tsx. Here the stand-in records what the LAYOUT hands it.
const chipCalls: Array<{ balance: number; linkToCredits: boolean }> = [];
vi.mock("./balance-chip", () => ({
  BalanceChip: (p: { balance: number; linkToCredits: boolean }) => {
    chipCalls.push(p);
    return { type: "span", props: { children: `chip:${p.balance}` } };
  },
}));

const { default: PortalLayout } = await import("./layout");

interface Collected {
  hrefs: string[];
  text: string;
  /** Every `aria-label` in the tree — the logo lockup is images named by its root label. */
  labels: string[];
}

/** Walk the rendered tree, expanding function components (all hookless here: BadaBhaiLogo,
 *  Badge, the mocked next/link → {type:"a"}), collecting every href, aria-label and all
 *  visible text. */
function collect(tree: ReactNode): Collected {
  const hrefs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === "a" && typeof el.props.href === "string") hrefs.push(el.props.href);
    if (typeof el.props?.["aria-label"] === "string") labels.push(el.props["aria-label"]);
    if (typeof el.type === "function") {
      w((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return { hrefs, text: parts.join(" "), labels };
}

async function render(opts: {
  role?: PayerSession["role"];
  orgRole?: "owner" | "recruiter";
  balance?: number | null;
  creditsThrows?: boolean;
}): Promise<Collected> {
  requirePayer.mockResolvedValue({
    payerId: "11111111-1111-4111-8111-111111111111",
    displayLabel: "Acme",
    role: opts.role ?? "employer",
    email: "ops@acme.example",
    phoneLast4: null,
    status: "active",
  });
  getOrgRole.mockReturnValue(opts.orgRole ?? "recruiter");
  if (opts.creditsThrows) getCredits.mockRejectedValue(new Error("credits unavailable"));
  else getCredits.mockResolvedValue({ payerId: "p", balance: opts.balance ?? 184 });
  const tree = (await PortalLayout({ children: null })) as ReactElement;
  return collect(tree);
}

beforeEach(() => {
  requirePayer.mockReset();
  getOrgRole.mockReset();
  getCredits.mockReset();
  flags.agencyPortalEnabled = true;
  chipCalls.length = 0;
});

describe("portal nav — Owner-only links by getOrgRole (affordance, NOT authz)", () => {
  it("(c) an Owner session shows Credits + Team links", async () => {
    const { hrefs } = await render({ orgRole: "owner" });
    expect(hrefs).toContain("/credits");
    expect(hrefs).toContain("/team");
  });

  it("(d) a Recruiter session HIDES Credits + Team (the gate, not the nav, is the decision)", async () => {
    const { hrefs } = await render({ orgRole: "recruiter" });
    expect(hrefs).not.toContain("/credits");
    expect(hrefs).not.toContain("/team");
  });

  it("both roles keep the shared recruiter surfaces (post / manage / plans+capacity)", async () => {
    for (const orgRole of ["owner", "recruiter"] as const) {
      const { hrefs } = await render({ orgRole });
      expect(hrefs).toContain("/dashboard");
      expect(hrefs).toContain("/postings/new");
      expect(hrefs).toContain("/postings");
      // Capacity now lives under the combined "Plans & capacity" entry.
      expect(hrefs).toContain("/plans");
    }
  });
});

describe("portal labeling — driven by session.role (server-side, not a client flag)", () => {
  it("employer → 'Companies' wordmark + 'New posting' on the company surface, no agency links", async () => {
    const { hrefs, text } = await render({ role: "employer", orgRole: "owner" });
    expect(text).toContain("Companies");
    expect(text).not.toMatch(/Employer/);
    expect(text).toContain("New posting");
    expect(hrefs).toContain("/postings/new");
    expect(hrefs).not.toContain("/agency/dashboard");
    expect(hrefs.filter((h) => h.startsWith("/agency"))).toEqual([]);
  });

  it("agent → 'Agencies' wordmark + 'New posting' on the AGENCY surface + referrals link", async () => {
    const { hrefs, text } = await render({ role: "agent", orgRole: "owner" });
    expect(text).toContain("Agencies");
    expect(text).toContain("New posting");
    // An agency posts AGENCY jobs only: the rail never opens the company posting surface.
    expect(hrefs).toContain("/agency/jobs/new");
    expect(hrefs).toContain("/agency/jobs");
    expect(hrefs.filter((h) => h.startsWith("/postings"))).toEqual([]);
    // MERGE-1: the agency dashboard is now the single /dashboard, so there is NO separate
    // "/agency/dashboard" nav entry for an agent (it would duplicate Dashboard). The referrals
    // deep page stays its own link.
    expect(hrefs).not.toContain("/agency/dashboard");
    expect(hrefs).toContain("/agency/referrals");
    expect(hrefs).toContain("/dashboard");
  });

  it("renders the BadaBhai lockup, captioned with the persona, in both roles", async () => {
    for (const role of ["employer", "agent"] as const) {
      const { text, labels } = await render({ role });
      // The wordmark is the brand kit's logotype IMAGE, so the lockup is named by its root
      // aria-label rather than by text; the persona caption stays text.
      expect(labels).toContain("BadaBhai");
      expect(text).toContain(role === "agent" ? "for Agencies" : "for Companies");
    }
  });
});

describe("portal identity — the compact account menu mounts in the shell", () => {
  it("renders the account menu (the org label now lives there, not a separate badge)", async () => {
    const { text } = await render({ role: "employer" });
    // The AccountMenu stand-in echoes the orgName; it is the only source of "Acme" now
    // that the old org-label/role badges were removed from the shell.
    expect(text).toContain("Acme");
  });
});

describe("portal balance chip — fail-soft courtesy read", () => {
  it("hands the chip the LIVE balance", async () => {
    const { text } = await render({ balance: 247 });
    expect(text).toContain("chip:247");
    expect(chipCalls.map((c) => c.balance)).toEqual([247]);
  });

  it("hides the chip (never throws) when the credits read fails", async () => {
    const { hrefs, text } = await render({ creditsThrows: true });
    // shell still renders — nav intact, no balance chip
    expect(hrefs).toContain("/dashboard");
    expect(chipCalls).toEqual([]);
    expect(text).not.toContain("chip:");
  });

  it("the chip links to Credits for an OWNER only (a recruiter's /credits is a 404)", async () => {
    await render({ orgRole: "owner", balance: 5 });
    await render({ orgRole: "recruiter", balance: 5 });
    expect(chipCalls.map((c) => c.linkToCredits)).toEqual([true, false]);
  });
});

describe("portal nav — the agency items follow the agency-portal flag", () => {
  it("flag OFF: an agent is offered no agency page (each would 404), the shared ones stay", async () => {
    flags.agencyPortalEnabled = false;
    const { hrefs } = await render({ role: "agent", orgRole: "owner" });
    expect(hrefs.filter((h) => h.startsWith("/agency"))).toEqual([]);
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/credits");
  });

  it("an agent's rail never offers Plans & capacity (a company page) — whatever the flag", async () => {
    for (const on of [true, false]) {
      flags.agencyPortalEnabled = on;
      for (const orgRole of ["owner", "recruiter"] as const) {
        const { hrefs } = await render({ role: "agent", orgRole });
        expect(hrefs, `flag ${on} ${orgRole}`).not.toContain("/plans");
      }
    }
  });
});
