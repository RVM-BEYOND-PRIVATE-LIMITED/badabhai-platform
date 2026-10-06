import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The portal's two fallback screens — the error boundary and not-found.
 *
 *  - They render the shared page header: a title and its one sentence, like every page (header
 *    rule 2). Each was an h1 styled as a state title inside the state block (sweep AW-20).
 *  - The error boundary's button is "Retry", the console's one name for that action — it read
 *    "Try again" (AW-14).
 *  - Directly below a section (`/workers/<id>`) they keep the back link to that section's list:
 *    the topbar crumb leaves the section unlinked there because the back link is the link to it
 *    (AW-16), so a fallback screen without one would leave no way to the list on the page.
 */
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { default: PortalError } = await import("./error");
const { default: PortalNotFound } = await import("./not-found");

const WORKER = "5eeded00-0001-4a00-8000-000000000001";

beforeEach(() => {
  nav.pathname = "/";
});

const renderError = (digest?: string) =>
  renderToStaticMarkup(
    <PortalError error={Object.assign(new Error("boom"), { digest })} reset={() => {}} />,
  );

describe("the error boundary", () => {
  it("renders the page header: its title as the h1, and one sentence under it", () => {
    const out = renderError();
    expect(out).toContain('<header class="page__head">');
    expect(out).toContain('<h1 class="page__title">Something went wrong</h1>');
    expect(out).toMatch(/<p class="page__sub">[^<]*\.<\/p>/);
    // The h1 is no longer a state title inside the error block.
    expect(out).not.toContain('<h1 class="state__title">');
  });

  it("its alert region says what failed on its own — the h1 sits outside it", () => {
    // Assistive tech announces a role="alert" region's own text. With the title moved into the
    // page header, the region opened on "It does not mean your session ended" — a reassurance
    // about a failure it never named.
    const out = renderError();
    const alert = out.slice(out.indexOf('role="alert"'));
    const body = /<p class="state__body">([^<]*)<\/p>/.exec(alert)?.[1] ?? "";
    expect(body.startsWith("This screen failed to load.")).toBe(true);
  });

  it("names its button Retry — never Try again", () => {
    const out = renderError();
    expect(out).toMatch(/<button[^>]*>(<i [^>]*><\/i>)?Retry<\/button>/);
    expect(out).not.toMatch(/try again/i);
  });

  it("still prints the digest, never the error's own message", () => {
    const out = renderError("d1g3st");
    expect(out).toContain("<code>d1g3st</code>");
    expect(out).not.toContain("boom");
  });

  it("directly below a section, links back to its list", () => {
    nav.pathname = `/workers/${WORKER}`;
    expect(renderError()).toContain(
      '<a class="backlink" href="/workers"><i class="ph-fill ph-arrow-left" aria-hidden="true"></i><span>Workers</span></a>',
    );
  });

  it("on a top-level page, has no back link — the sidebar is its way back", () => {
    nav.pathname = "/workers";
    expect(renderError()).not.toContain("backlink");
  });

  it("deeper down, claims no parent it cannot name — the crumb links the section there", () => {
    nav.pathname = `/workers/${WORKER}/journey`;
    expect(renderError()).not.toContain("backlink");
  });
});

describe("not found", () => {
  it("renders the page header: its title as the h1, and one sentence under it", () => {
    const out = renderToStaticMarkup(<PortalNotFound />);
    expect(out).toContain('<h1 class="page__title">Not found</h1>');
    expect(out).toContain(
      '<p class="page__sub">That record does not exist, or it has been removed.</p>',
    );
    expect(out).not.toContain('<h1 class="state__title">');
    expect(out).toMatch(/href="\/">(<i [^>]*><\/i>)?Back to dashboard<\/a>/);
  });

  it("for a mistyped id below a section, links back to that section's list", () => {
    nav.pathname = `/jobs/${WORKER}`;
    const out = renderToStaticMarkup(<PortalNotFound />);
    expect(out).toContain('<a class="backlink" href="/jobs">');
  });
});
