import { formatCount, formatExactRupees } from "./format";

/**
 * Display rules for the numbers screen (#2884).
 *
 * A number here is never silently turned into 0: a suppressed cell, a pending cohort, a week not
 * computed and a metric with no source yet each render a different statement. Paise are divided by
 * 100 for display; ratios keep up to two decimals; a share is the fraction the API serves, printed
 * as a percentage.
 */
export type MetricUnit = "count" | "paise" | "share" | "ratio";

export function formatMetricValue(value: number, unit: string): string {
  switch (unit) {
    case "paise":
      return formatExactRupees((value / 100).toFixed(2));
    case "share":
      return `${(value * 100).toFixed(1)}%`;
    case "ratio":
      return value.toFixed(2).replace(/\.?0+$/, "");
    default:
      return formatCount(value);
  }
}

/** The absolute change in the metric's own unit, with an explicit sign. */
export function formatMetricChange(absolute: number, unit: string): string {
  const sign = absolute < 0 ? "\u2212" : "+";
  return `${sign}${formatMetricValue(Math.abs(absolute), unit)}`;
}

export function formatPercent(percent: number | null): string {
  if (percent === null) return "—";
  const sign = percent < 0 ? "\u2212" : "+";
  return `${sign}${Math.abs(percent).toFixed(1)}%`;
}

/**
 * A point on a series, in the order the four states must be told apart:
 * suppressed → pending → not computed → the figure.
 */
export function describePoint(point: {
  value: number | null;
  suppressed: boolean;
  pending: boolean;
  definition_version: number | null;
}, unit: string): string {
  if (point.suppressed) return "fewer than 5";
  if (point.pending) return "Window not closed";
  if (point.value !== null) return formatMetricValue(point.value, unit);
  if (point.definition_version === null) return "Not computed";
  return "Not available";
}

/** "fewer than 5" — the floor the API applies to a worker cell. */
export function suppressedText(floor: number): string {
  return `fewer than ${floor}`;
}
