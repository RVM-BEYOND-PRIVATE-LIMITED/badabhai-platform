import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The worker detail header's governed actions (final sweep AW-17). Flag and Unflag both drew
 * the `flag` glyph, side by side, so the two opposite verbs looked like one control twice. Unflag
 * now draws the console's REINSTATE glyph — the same reversal Suspend ↔ Reinstate already uses
 * (`ACTION_ICON`, one concept one icon). Which of the two is offered is unchanged: the read model
 * exposes no flag state, so both stay (see the component's own doc).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("./actions", () => ({
  flagWorkerAction: async () => ({ ok: true }),
  unflagWorkerAction: async () => ({ ok: true }),
}));

const { WorkerDetailHeader } = await import("./worker-detail-header");
const { ACTION_ICON } = await import("@badabhai/icons");

const render = (canFlag: boolean) =>
  renderToStaticMarkup(
    <WorkerDetailHeader
      header={{ title: "Ramesh Kumar", back: { href: "/workers", label: "Workers" } }}
      workerId="5eeded00-0001-4a00-8000-000000000001"
      canFlag={canFlag}
      timelineHref="/workers/5eeded00-0001-4a00-8000-000000000001/timeline"
      journeyHref="/workers/5eeded00-0001-4a00-8000-000000000001/journey"
    />,
  );

/** The glyph class drawn inside the button labelled `label`. */
function glyphOf(out: string, label: string): string | null {
  const end = out.indexOf(`${label}</`);
  expect(end, label).toBeGreaterThanOrEqual(0);
  const start = out.lastIndexOf("<button", end);
  return /ph-fill (ph-[\w-]+)/.exec(out.slice(start, end))?.[1] ?? null;
}

describe("Flag and Unflag", () => {
  it("draw two different glyphs", () => {
    const out = render(true);
    expect(glyphOf(out, "Flag")).toBe("ph-flag");
    expect(glyphOf(out, "Unflag")).not.toBe(glyphOf(out, "Flag"));
  });

  it("Unflag draws the reversal glyph the console already uses for Reinstate", () => {
    expect(glyphOf(render(true), "Unflag")).toBe(`ph-${ACTION_ICON.reinstate}`);
  });

  it("both are still offered to a flagging role, and neither to a reader", () => {
    const flagger = render(true);
    expect(flagger).toContain(">Flag</");
    expect(flagger).toContain(">Unflag</");
    const reader = render(false);
    expect(reader).not.toContain(">Flag</");
    expect(reader).not.toContain(">Unflag</");
  });
});
