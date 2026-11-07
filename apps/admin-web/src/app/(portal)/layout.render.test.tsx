import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NavSection } from "../../components/nav-model";

/**
 * The portal layout hands the shell what only the server may decide (A6, #2576): the sidebar and
 * the quick jump's record kinds, both filtered by the session's capabilities, and the environment
 * the API reports. The gating is presentation — every page keeps its own guard — but it must
 * match: a door shown to a role that cannot open it is one click from a refusal.
 */
const stub = vi.hoisted(() => ({
  capabilities: [] as string[],
  environment: "production" as string | null,
  shell: null as null | {
    sections: NavSection[];
    jumpKinds: readonly string[];
    environment: string | null;
    roleLabel: string;
  },
}));

vi.mock("../../lib/auth", () => ({
  requireSession: async () => ({
    adminId: "a1b2c3d4-0000-4000-8000-000000000001",
    role: "analyst",
    capabilities: stub.capabilities,
  }),
}));
vi.mock("../../lib/environment", () => ({ getApiEnvironment: async () => stub.environment }));
vi.mock("../../components/shell", () => ({
  Shell: (props: NonNullable<typeof stub.shell>) => {
    stub.shell = props;
    return null;
  },
}));
vi.mock("../../components/sign-out-button", () => ({ SignOutButton: () => null }));

const { default: PortalLayout } = await import("./layout");

const render = async () => renderToStaticMarkup(await PortalLayout({ children: null }));
const labels = () => stub.shell!.sections.flatMap((s) => s.items.map((i) => i.label));

beforeEach(() => {
  stub.shell = null;
  stub.environment = "production";
});

describe("the sidebar it hands the shell", () => {
  it("the read floor sees the Directory, Finance and most of Quality & AI — no admin doors", async () => {
    stub.capabilities = ["read_entities", "read_candidates", "read_events"];
    await render();
    expect(stub.shell!.sections.map((s) => s.title)).toEqual([
      "Home",
      "Directory",
      "Finance",
      "Quality & AI",
      "Audit & Admin",
    ]);
    expect(labels()).toEqual([
      "Dashboard",
      "Candidates",
      "Companies",
      "Postings",
      "Credits",
      "Payment orders",
      "Feedback",
      "Skill discovery",
      "Engine view",
      "Events",
      "Roles",
      "System",
    ]);
  });

  it("a super admin's capabilities open every item — at most 15", async () => {
    stub.capabilities = [
      "read_events",
      "read_entities",
      "read_candidates",
      "read_identity",
      "read_ai_traces",
      "manage_agency_match_skills",
      "manage_admins",
    ];
    await render();
    expect(labels()).toContain("AI calls");
    expect(labels()).toContain("Admin users");
    expect(labels().length).toBeLessThanOrEqual(15);
  });

  it("a group with nothing left in it is dropped, not drawn empty", async () => {
    stub.capabilities = [];
    await render();
    expect(stub.shell!.sections.map((s) => s.title)).toEqual(["Home", "Audit & Admin"]);
    expect(labels()).toEqual(["Dashboard", "Roles", "System"]);
  });
});

describe("the quick jump's record kinds", () => {
  it("are the kinds whose pages this session may open", async () => {
    stub.capabilities = ["read_entities"];
    await render();
    expect(stub.shell!.jumpKinds).toEqual(["candidate", "company", "posting"]);
    stub.capabilities = ["read_entities", "manage_agency_match_skills"];
    await render();
    expect(stub.shell!.jumpKinds).toEqual(["candidate", "company", "posting", "agency-posting"]);
  });
});

describe("the environment badge", () => {
  it("is what the API reports, or null — the badge says unknown", async () => {
    stub.capabilities = ["read_entities"];
    await render();
    expect(stub.shell!.environment).toBe("production");
    stub.environment = null;
    await render();
    expect(stub.shell!.environment).toBeNull();
  });

  it("the role goes to the avatar menu by its label", async () => {
    await render();
    expect(stub.shell!.roleLabel).toBe("Analyst");
  });
});
