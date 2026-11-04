import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentBadge, environmentLabel } from "./environment-badge";

/**
 * The topbar's environment badge (A6, #2576): what the API's health probe reports, never a label
 * baked into the portal — and "unknown" when the probe could not say.
 */
describe("environmentLabel", () => {
  it("names each environment the API reports (its NODE_ENV values)", () => {
    expect(environmentLabel("production")).toBe("Production");
    expect(environmentLabel("staging")).toBe("Staging");
    expect(environmentLabel("development")).toBe("Development");
    expect(environmentLabel("test")).toBe("Test");
  });

  it("shows a name it was not taught as the API wrote it, and none as unknown", () => {
    expect(environmentLabel("preview-7")).toBe("preview-7");
    expect(environmentLabel("constructor")).toBe("constructor");
    expect(environmentLabel(null)).toBe("Environment unknown");
  });
});

describe("EnvironmentBadge", () => {
  it("is the quiet pill, its environment named for assistive tech", () => {
    expect(renderToStaticMarkup(<EnvironmentBadge environment="staging" />)).toBe(
      '<span class="topbar__env" title="The environment the API behind this console reports.">' +
        '<span class="sr-only">Environment: </span>Staging</span>',
    );
  });

  it("production wears the navy variant", () => {
    expect(renderToStaticMarkup(<EnvironmentBadge environment="production" />)).toContain(
      'class="topbar__env topbar__env--production"',
    );
  });

  it("unknown says so, and why, in the quiet pill", () => {
    const out = renderToStaticMarkup(<EnvironmentBadge environment={null} />);
    expect(out).toContain('class="topbar__env"');
    expect(out).toContain(">Environment unknown</span>");
    expect(out).toContain("did not answer");
    expect(out).not.toContain("Environment: ");
  });
});
