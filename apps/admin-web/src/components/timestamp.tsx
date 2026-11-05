import { formatDate, formatTimestamp, formatTimestampUtc } from "../lib/format";

/**
 * A visible timestamp in the console's one shape (#2572): IST on screen ("19 Aug 2026, 13:08
 * IST", or just the day with `dateOnly`), the exact UTC instant on hover, and the machine value
 * in `dateTime`. Server-safe — no hooks.
 */
export function Timestamp({ iso, dateOnly }: { iso: string; dateOnly?: boolean }) {
  return (
    <time dateTime={iso} title={formatTimestampUtc(iso)}>
      {dateOnly ? formatDate(iso) : formatTimestamp(iso)}
    </time>
  );
}
