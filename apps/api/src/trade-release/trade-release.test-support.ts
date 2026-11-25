import type { TradeReleaseRow } from "@badabhai/db";
import { LIVE_POSTING_TRADE_KINDS } from "@badabhai/taxonomy";
import type { EventsService } from "../events/events.service";
import type { TradeReleaseRepository } from "./trade-release.repository";
import { TradeReleaseService } from "./trade-release.service";

/**
 * A real {@link TradeReleaseService} over an in-memory table, for tests of its readers. The
 * default rows are migration 0198's seed: the 16 live kinds with `posting_enabled = true`.
 * Pass `"missing"` for a database where the table does not exist yet (SQLSTATE 42P01).
 */
export function releaseServiceFor(
  postingEnabled: readonly string[] | "missing" = LIVE_POSTING_TRADE_KINDS,
): TradeReleaseService {
  const rows: TradeReleaseRow[] =
    postingEnabled === "missing"
      ? []
      : postingEnabled.map((roleKind) => ({
          roleKind,
          postingEnabled: true,
          formEnabled: false,
          updatedBy: null,
          updatedAt: new Date("2026-11-24T10:00:00.000Z"),
        }));
  const repo = {
    all: async () => {
      if (postingEnabled === "missing") throw Object.assign(new Error("relation"), { code: "42P01" });
      return rows;
    },
  } as unknown as TradeReleaseRepository;
  return new TradeReleaseService(repo, {} as EventsService);
}
