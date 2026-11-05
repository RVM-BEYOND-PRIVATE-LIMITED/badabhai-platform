import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiAlertBanner } from "./ai-alert-banner";
import type { AdminAiAlertsStatus } from "../lib/ai-alerts";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const QUIET: AdminAiAlertsStatus = {
  generated_at: "2026-11-05T00:00:00.000Z",
  window_hours: 24,
  thresholds: { min_calls: 20, fallback_share: 0.5 },
  tasks: [
    {
      task_type: "profiling",
      window_hours: 24,
      total_calls: 100,
      real_calls: 90,
      fallback_calls: 10,
      fallback_share: 0.1,
      breaching: false,
      last_alert: null,
      active: false,
    },
  ],
  spend_cap: { window_hours: 24, breach_count: 0, active: false },
  recent_alerts: [],
};

/**
 * A10 (#2580) — the banner renders if and only if an alert is active, and links the
 * list. Silence (or a failed read) renders nothing: a console that always shows a
 * banner teaches operators to stop reading banners.
 */
describe("AiAlertBanner", () => {
  it("renders nothing when nothing is active", () => {
    expect(html(<AiAlertBanner status={QUIET} />)).toBe("");
    expect(html(<AiAlertBanner status={null} />)).toBe("");
  });

  it("appears when a task is breaching, names it, and links the alerts list", () => {
    const out = html(
      <AiAlertBanner
        status={{
          ...QUIET,
          tasks: [{ ...QUIET.tasks[0]!, breaching: true, active: true }],
        }}
      />,
    );
    expect(out).toContain("profiling");
    expect(out).toContain('href="/alerts"');
    expect(out).toContain('role="alert"');
  });

  it("appears when only the spend cap tripped", () => {
    const out = html(
      <AiAlertBanner
        status={{ ...QUIET, spend_cap: { window_hours: 24, breach_count: 2, active: true } }}
      />,
    );
    expect(out).toContain("spend cap");
    expect(out).toContain('href="/alerts"');
  });

  it("renders the alert class for the slide-down entrance, not a new banner shape", () => {
    const out = html(
      <AiAlertBanner
        status={{
          ...QUIET,
          tasks: [{ ...QUIET.tasks[0]!, breaching: true, active: true }],
        }}
      />,
    );
    expect(out).toContain("ai-banner");
    expect(out).toContain("alert--warning");
  });
});
