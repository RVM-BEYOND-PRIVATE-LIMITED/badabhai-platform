import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingFunnel } from "./onboarding-funnel";
import type { AdminFunnelStepCounts } from "../lib/funnel";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const STEPS: AdminFunnelStepCounts[] = [
  { key: "login", order: 1, done: 10, in_progress: 0, not_done: 0 },
  { key: "profiling", order: 2, done: 6, in_progress: 1, not_done: 3 },
  { key: "resume", order: 3, done: 5, in_progress: 0, not_done: 5 },
  { key: "profile_confirmed", order: 4, done: 3, in_progress: 1, not_done: 6 },
  { key: "job_search_apply", order: 5, done: 3, in_progress: 0, not_done: 7 },
  { key: "photo", order: 6, done: 2, in_progress: 0, not_done: 8 },
  { key: "interview_kit", order: 7, done: 1, in_progress: 0, not_done: 9 },
];

/**
 * A10 (#2580) — what the all-workers funnel actually RENDERS.
 *
 * 1. ALL SEVEN STEPS RENDER in the server's order, zeros included — hiding a zero row
 *    would turn a funnel into a list of achievements and remove exactly the information
 *    this screen exists for (where the base stops).
 * 2. The bar is decorative: the counts beside it are the content, so the markup carries
 *    the numbers as text and hides the fill from assistive tech.
 */
describe("OnboardingFunnel", () => {
  it("renders all seven steps in the server's order", () => {
    const out = html(<OnboardingFunnel steps={STEPS} total={10} />);
    expect(out.match(/funnel__row--bar/g)).toHaveLength(7);
    expect(out.indexOf("AI profiling interview")).toBeLessThan(out.indexOf("Resume generated"));
    expect(out).toContain("Interview kit downloaded");
  });

  it("carries the numbers as text, with the bar hidden from assistive tech", () => {
    const out = html(<OnboardingFunnel steps={STEPS} total={10} />);
    expect(out).toContain("6");
    expect(out).toContain("1 in progress");
    expect(out).toContain('aria-hidden="true"');
  });

  it("says so rather than rendering an empty list when no step came back", () => {
    const out = html(<OnboardingFunnel steps={[]} total={0} />);
    expect(out).toContain("not a cohort");
  });

  it("staggers only the first eight rows, so a long list enters together after them", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      key: `step_${i}`,
      order: i + 1,
      done: 1,
      in_progress: 0,
      not_done: 0,
    }));
    const out = html(<OnboardingFunnel steps={many} total={10} />);
    expect(out.match(/animation-delay/g)).toHaveLength(8);
  });
});
