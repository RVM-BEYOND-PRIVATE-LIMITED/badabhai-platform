import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The create-admin form (ADR-0060 A6). What it must render: email, full name, role, and a
 * temporary password with its confirmation — under `autocomplete="off"`, because the password
 * being typed is the NEW admin's and a password manager must not file it as the creator's — the
 * Generate helper, and the two-click Create. Submits are exercised in `actions.test.ts`.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const createAdminAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ createAdminAction }));

const { CreateAdminForm } = await import("./create-admin-form");

const html = renderToStaticMarkup(<CreateAdminForm mayReadEvents />);

describe("the create-admin form", () => {
  it("is a dialog body: the Dialog owns the title, so the form draws no heading of its own", () => {
    // A5 (#2575) — it opens in the header's "Create an admin" dialog (admin-access-dialogs.tsx).
    expect(html).not.toContain('id="ad-create"');
    expect(html).not.toContain("<h2");
    expect(html.startsWith('<form class="form"')).toBe(true);
  });

  it("asks for work email, full name and role", () => {
    expect(html).toContain("Work email");
    expect(html).toContain("Full name");
    expect(html).toMatch(/<input[^>]*maxLength="100"/i);
    for (const role of ["Super admin", "Ops admin", "Support", "Analyst"])
      expect(html).toContain(`>${role}</option>`);
  });

  it("takes a temporary password twice, never offered to the creator's password manager", () => {
    expect(html).toContain("Temporary password");
    expect(html).toContain("Confirm temporary password");
    const passwordInputs = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    expect(passwordInputs).toHaveLength(2);
    for (const input of passwordInputs) expect(input).toMatch(/autocomplete="off"/i);
    expect(html).not.toMatch(/autocomplete="new-password"/i);
  });

  it("offers Generate, and Create starts disabled until the form is complete", () => {
    expect(html).toContain("Generate a password");
    const create = /<button[^>]*>(?:(?!<\/button>).)*Create admin(?:(?!<\/button>).)*<\/button>/.exec(
      html,
    )?.[0];
    expect(create).toBeDefined();
    expect(create).toContain('disabled=""');
  });

  it("calls nothing on render and shows no banner yet", () => {
    expect(createAdminAction).not.toHaveBeenCalled();
    expect(html).not.toContain("alert");
  });

  it("shows no temporary password before an admin has been created", () => {
    expect(html).not.toContain("Copy password");
  });
});
