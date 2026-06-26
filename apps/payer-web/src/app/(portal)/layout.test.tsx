import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { PayerSession } from "../../lib/auth/types";

/**
 * (c)/(d) PORTAL NAV — Owner-only affordances are driven by getOrgRole, but are NOT the
 * authorization. An Owner sees Credits (billing/wallet) + Team (user management); a Recruiter
 * sees neither link (affordance only — the SERVER gate `requireOwner` is what actually 404s a
 * Recruiter who navigates straight there; proven in org-roles.test.ts). The shared recruiter
 * surfaces (Dashboard / Post / Manage / Capacity) show for everyone.
 */

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn();

vi.mock("../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("./logout-button", () => ({ LogoutButton: () => null }));

const { default: PortalLayout } = await import("./layout");

const session: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme",
  role: "employer",
};

function hrefs(tree: ReactNode): string[] {
  const out: string[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === "a" && typeof el.props.href === "string") out.push(el.props.href);
    // Expand a function component (e.g. the mocked next/link → { type: "a", … }) to reach its output.
    if (typeof el.type === "function") {
      w((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
}

async function navHrefs(orgRole: "owner" | "recruiter"): Promise<string[]> {
  getOrgRole.mockReturnValue(orgRole);
  const tree = (await PortalLayout({ children: null })) as ReactElement;
  return hrefs(tree);
}

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(session);
  getOrgRole.mockReset();
});

describe("portal nav — Owner-only links by getOrgRole (affordance, NOT authz)", () => {
  it("(c) an Owner session shows Credits + Team links", async () => {
    const links = await navHrefs("owner");
    expect(links).toContain("/credits");
    expect(links).toContain("/team");
  });

  it("(d) a Recruiter session HIDES Credits + Team (the gate, not the nav, is the decision)", async () => {
    const links = await navHrefs("recruiter");
    expect(links).not.toContain("/credits");
    expect(links).not.toContain("/team");
  });

  it("both roles keep the shared recruiter surfaces (post / search / manage / capacity)", async () => {
    for (const role of ["owner", "recruiter"] as const) {
      const links = await navHrefs(role);
      expect(links).toContain("/dashboard");
      expect(links).toContain("/postings/new");
      expect(links).toContain("/postings");
      expect(links).toContain("/capacity");
    }
  });
});
