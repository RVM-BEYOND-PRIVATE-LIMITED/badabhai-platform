import { vi } from "vitest";
import type { CompanionHistoryItem } from "./chat-companion.dto";
import type { HistoryRead, KeptTurn } from "./companion-history.service";
import type { CompanionFoldJob } from "./v2/companion-summary.service";

/**
 * #2297 — spies for the two collaborators `ChatCompanionService` stores its conversation through,
 * for the suites that construct the service by hand. The window read answers `stored` (an empty,
 * readable store by default); every write is recorded, never run.
 */
export function fakeCompanionHistory(
  stored: HistoryRead<CompanionHistoryItem[]> = { ok: true, value: [] },
) {
  const history = {
    window: vi.fn(async (_workerId: string, _now: Date) => stored),
    keepTurn: vi.fn((_kept: KeptTurn, _afterStored?: () => Promise<void>) => undefined),
    keepRecap: vi.fn((..._args: unknown[]) => undefined),
  };
  const summaries = { schedule: vi.fn((_job: CompanionFoldJob) => undefined) };
  return { history, summaries };
}
