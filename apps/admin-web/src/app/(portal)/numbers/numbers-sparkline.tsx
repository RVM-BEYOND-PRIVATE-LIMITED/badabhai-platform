import type { NumbersWeeklyPoint } from "../../../lib/numbers";
import { describePoint } from "../../../lib/numbers-format";

/**
 * The small series chart for one metric (#2884).
 *
 * Content SVG, not an icon: it is a chart drawn in the table cell, carries no icon class, is not a
 * direct child of a link and is wider than it is tall. No dependency: a polyline per run of
 * computed points, a dot per point, and a dashed tick for a week that ended before real payments.
 */
export function NumbersSparkline({
  points,
  unit,
  label,
}: {
  points: readonly NumbersWeeklyPoint[];
  unit: string;
  label: string;
}) {
  const width = 180;
  const height = 44;
  const pad = 6;
  const usable = points.filter((p) => p.value !== null && !p.suppressed && !p.pending);
  const values = usable.map((p) => p.value as number);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;
  const span = max - min || 1;
  const x = (i: number) =>
    points.length <= 1 ? width / 2 : pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);

  const runs: { i: number; value: number }[][] = [];
  let current: { i: number; value: number }[] = [];
  points.forEach((point, i) => {
    if (point.value === null || point.suppressed || point.pending) {
      if (current.length > 1) runs.push(current);
      current = [];
      return;
    }
    current.push({ i, value: point.value });
  });
  if (current.length > 1) runs.push(current);

  const summary = points.map((p) => describePoint(p, unit)).join(", ");

  return (
    <figure className="numbers-spark">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label} series: ${summary}`}
      >
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="var(--border)"
        />
        {points.map((point, i) =>
          point.before_real_payments ? (
            <line
              key={`before-${point.week_start}`}
              x1={x(i)}
              y1={pad}
              x2={x(i)}
              y2={height - pad}
              stroke="var(--text-muted)"
              strokeDasharray="2 2"
              opacity={0.6}
            />
          ) : null,
        )}
        {runs.map((run, index) => (
          <polyline
            key={`run-${index}`}
            points={run.map((p) => `${x(p.i)},${y(p.value)}`).join(" ")}
            fill="none"
            stroke="var(--brand)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {points.map((point, i) => {
          if (point.value === null || point.suppressed || point.pending) {
            return (
              <circle
                key={point.week_start}
                cx={x(i)}
                cy={height - pad}
                r={2}
                fill="var(--border)"
              >
                <title>{describePoint(point, unit)}</title>
              </circle>
            );
          }
          return (
            <circle
              key={point.week_start}
              cx={x(i)}
              cy={y(point.value)}
              r={point.before_real_payments ? 2 : 2.5}
              fill={point.before_real_payments ? "var(--text-muted)" : "var(--brand)"}
            >
              <title>{`${point.week_start}: ${describePoint(point, unit)}${
                point.before_real_payments ? " (before real payments)" : ""
              }${point.frozen ? " · frozen" : " · still running"}`}</title>
            </circle>
          );
        })}
      </svg>
    </figure>
  );
}
