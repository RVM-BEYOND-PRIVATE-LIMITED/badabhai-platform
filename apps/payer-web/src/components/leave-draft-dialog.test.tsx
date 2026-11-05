import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaveDraftDialog } from "./leave-draft-dialog";

describe("LeaveDraftDialog — the in-app leave confirmation", () => {
  it("names the action, the consequence, and offers Cancel + the verb", () => {
    const out = renderToStaticMarkup(
      <LeaveDraftDialog
        leave={{ open: true, confirm: vi.fn(), cancel: vi.fn() }}
      />,
    );
    expect(out).toContain("Leave this posting?");
    expect(out).toContain("A draft stays on this device");
    expect(out).toContain("Cancel");
    expect(out).toContain("Leave posting");
    expect(out).not.toContain("window.confirm");
  });

  it("renders nothing while closed", () => {
    const out = renderToStaticMarkup(
      <LeaveDraftDialog leave={{ open: false, confirm: vi.fn(), cancel: vi.fn() }} />,
    );
    expect(out).toBe("");
  });
});
