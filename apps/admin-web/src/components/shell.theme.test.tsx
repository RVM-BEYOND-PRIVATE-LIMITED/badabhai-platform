import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));

const { Shell } = await import("./shell");

const base = {
  sections: [
    { title: "Directory", items: [{ href: "/jobs", label: "Postings", icon: "briefcase" as const }] },
  ],
  roleLabel: "Ops admin",
  adminId: "a1b2c3d4-0000-4000-8000-000000000001",
  environment: "staging",
  jumpKinds: ["candidate", "company", "posting"] as const,
  onSignOut: <button type="button">Sign out</button>,
  children: <p>content</p>,
};

const render = (theme?: { open: boolean }) =>
  renderToStaticMarkup(<Shell {...base} theme={theme} />);

/**
 * #2821 — the toggle exists ONLY when the server-saved choice is open. While closed the topbar
 * is the pre-existing chrome, so admin-web is visually identical to today.
 */
describe("admin shell theme toggle", () => {
  it("renders no theme control when the theme prop is absent", () => {
    expect(render()).not.toContain('class="theme-toggle"');
  });

  it("renders no theme control while the switch is closed", () => {
    expect(render({ open: false })).not.toContain('class="theme-toggle"');
  });

  it("renders the shared toggle in the topbar when the switch is open", () => {
    const out = render({ open: true });
    expect(out).toContain('class="theme-toggle"');
    expect(out).toContain('role="switch"');
  });
});
