import { vi } from "vitest";
import type { ProfilingLinesRead } from "../chat/profiling-chat-lines.reader";
import type { CompanionHistoryItem } from "./chat-companion.dto";
import type { HistoryRead, KeptTurn } from "./companion-history.service";
import type { CompanionFoldJob } from "./v2/companion-summary.service";

/**
 * #2297 — spies for the collaborators `ChatCompanionService` stores and reads its conversation
 * through, for the suites that construct the service by hand. The window read answers `stored` (an
 * empty, readable store by default) and the profiling read (#2391) answers `profiling` (no chat by
 * default); every write is recorded, never run.
 */
export function fakeCompanionHistory(
  stored: HistoryRead<CompanionHistoryItem[]> = { ok: true, value: [] },
  profiling: ProfilingLinesRead = { ok: true, value: [], truncated: false },
) {
  const history = {
    window: vi.fn(async (_workerId: string, _now: Date) => stored),
    keepTurn: vi.fn((_kept: KeptTurn, _afterStored?: () => Promise<void>) => undefined),
  };
  const summaries = { schedule: vi.fn((_job: CompanionFoldJob) => undefined) };
  const profilingLines = {
    since: vi.fn(async (_workerId: string, _since: Date) => profiling),
  };
  return { history, summaries, profilingLines };
}
