import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../lib/auth/types";

/**
 * PORTAL SHELL (DS0.3) — the chrome is rebuilt onto the design system, but the
 * AUTHORIZATION model is unchanged and SERVER-DRIVEN:
 *  - product LABELING (Employers vs Agencies) comes from `session.role`, not a client flag;
 *  - Owner-only affordances (Credits/Team) are driven by `getOrgRole` but are NOT the authz —
 *    the SERVER gate `requireOwner` is what 404s a Recruiter (proven in org-roles.test.ts);
 *  - the shared recruiter surfaces (Dashboard / Post / Manage / Capacity) show for everyone;
 *  - the balance chip is a fail-soft courtesy read (hidden, never fatal, on a credits error).
 */

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn();
const getCredits = vi.fn();

vi.mock("../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("../../lib/payer-api", () => ({ getCredits: () => getCredits() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// PortalNav (client) reads the active route via usePathname — pin it so the nav renders
// deterministically when the test walk expands the component.
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("./logout-button", () => ({ LogoutButton: () => null }));
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

const { default: PortalLayout } = await import("./layout");

interface Collected {
  hrefs: string[];
  text: string;
}

/** Walk the rendered tree, expanding function components (all hookless here: BadaBhaiLogo,
 *  Badge, the mocked next/link → {type:"a"}), collecting every href and all visible text. */
function collect(tree: ReactNode): Collected {
  const hrefs: string[] = [];
  const parts: string[] = [];
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
    if (typeof el.type === "function") {
      w((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return { hrefs, text: parts.join(" ") };
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

  it("both roles keep the shared recruiter surfaces (post / search / manage / capacity)", async () => {
    for (const orgRole of ["owner", "recruiter"] as const) {
      const { hrefs } = await render({ orgRole });
      expect(hrefs).toContain("/dashboard");
      expect(hrefs).toContain("/postings/new");
      expect(hrefs).toContain("/postings");
      expect(hrefs).toContain("/capacity");
    }
  });
});

describe("portal labeling — driven by session.role (server-side, not a client flag)", () => {
  it("employer → 'Employers' wordmark + 'Post a job', no agency links", async () => {
    const { hrefs, text } = await render({ role: "employer", orgRole: "owner" });
    expect(text).toContain("Employers");
    expect(text).toContain("Post a job");
    expect(hrefs).not.toContain("/agency/dashboard");
  });

  it("agent → 'Agencies' wordmark + 'Post a vacancy' + agency referrals link", async () => {
    const { hrefs, text } = await render({ role: "agent", orgRole: "owner" });
    expect(text).toContain("Agencies");
    expect(text).toContain("Post a vacancy");
    // MERGE-1: the agency dashboard is now the single /dashboard, so there is NO separate
    // "/agency/dashboard" nav entry for an agent (it would duplicate Dashboard). The referrals
    // deep page stays its own link.
    expect(hrefs).not.toContain("/agency/dashboard");
    expect(hrefs).toContain("/agency/referrals");
    expect(hrefs).toContain("/dashboard");
  });

  it("renders the BadaBhai wordmark lockup in both roles", async () => {
    for (const role of ["employer", "agent"] as const) {
      const { text } = await render({ role });
      // The shell logo waves per-letter (separate spans), so collapse inter-letter
      // whitespace before asserting the wordmark survives.
      expect(text.replace(/\s+/g, "")).toContain("BadaBhai");
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
  it("shows the live balance when the credits read succeeds", async () => {
    const { text } = await render({ balance: 247 });
    expect(text).toContain("247");
    expect(text).toContain("unlocks");
  });

  it("hides the chip (never throws) when the credits read fails", async () => {
    const { hrefs, text } = await render({ creditsThrows: true });
    // shell still renders — nav intact, no balance chip
    expect(hrefs).toContain("/dashboard");
    expect(text).not.toContain("unlocks");
  });
});
