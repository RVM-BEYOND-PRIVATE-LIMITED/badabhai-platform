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
vi.mock("./logout-button", () => ({ LogoutButton: () => null }));

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
  it("employer → 'Employers' wordmark + 'Post a job' + employer badge, no agency links", async () => {
    const { hrefs, text } = await render({ role: "employer", orgRole: "owner" });
    expect(text).toContain("Employers");
    expect(text).toContain("Post a job");
    expect(text).toContain("employer");
    expect(hrefs).not.toContain("/agency/dashboard");
  });

  it("agent → 'Agencies' wordmark + 'Post a vacancy' + agency links + agency badge", async () => {
    const { hrefs, text } = await render({ role: "agent", orgRole: "owner" });
    expect(text).toContain("Agencies");
    expect(text).toContain("Post a vacancy");
    expect(text).toContain("agency");
    expect(hrefs).toContain("/agency/dashboard");
    expect(hrefs).toContain("/agency/referrals");
  });

  it("renders the BadaBhai wordmark lockup in both roles", async () => {
    for (const role of ["employer", "agent"] as const) {
      const { text } = await render({ role });
      expect(text).toContain("Bada");
      expect(text).toContain("Bhai");
    }
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
