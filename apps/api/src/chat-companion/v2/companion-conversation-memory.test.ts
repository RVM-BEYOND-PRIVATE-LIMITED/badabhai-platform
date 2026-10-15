import { describe, expect, it, vi } from "vitest";
import type { CompanionModelLine } from "../companion-history.repository";
import type { HistoryRead } from "../companion-history.service";
import { CompanionConversationMemory } from "./companion-conversation-memory";

/**
 * #2297 (ADR-0056) — the recent turns a companion model call reads: on the brain the stored
 * conversation (so the AI remembers across an app restart), the Redis memory when that read fails,
 * and the Redis memory alone under the kill switch.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-15T10:00:00.000Z");
const REDIS_TURNS = [{ role: "worker" as const, text: "from redis" }];

function setup(opts: { brain: boolean; stored?: HistoryRead<CompanionModelLine[]> }) {
  const redis = {
    read: vi.fn(async () => REDIS_TURNS),
    append: vi.fn(async () => undefined),
  };
  const history = {
    modelLines: vi.fn(async (..._args: unknown[]) => opts.stored ?? { ok: true, value: [] }),
  };
  const config = {
    CHAT_COMPANION_V2_ENABLED: true,
    CHAT_FREE_CHAT_DISABLED: !opts.brain,
    CHAT_COMPANION_V2_MEMORY_TURNS: 6,
  };
  const memory = new CompanionConversationMemory(config as never, redis as never, history as never);
  return { memory, redis, history };
}

describe("CompanionConversationMemory", () => {
  it("on the brain: the last six stored model lines, as contract turns, and Redis is not read", async () => {
    const h = setup({
      brain: true,
      stored: {
        ok: true,
        value: [
          { role: "worker", text: "  welding ka kaam  ", createdAt: NOW },
          { role: "bada_bhai", text: "Achha kaam hai {{token}}", createdAt: NOW },
          { role: "worker", text: "   ", createdAt: NOW },
        ],
      },
    });
    expect(await h.memory.read(WORKER, NOW)).toEqual([
      { role: "worker", text: "welding ka kaam" },
      { role: "bada_bhai", text: "Achha kaam hai" },
    ]);
    expect(h.history.modelLines).toHaveBeenCalledWith(WORKER, NOW, 6);
    expect(h.redis.read).not.toHaveBeenCalled();
  });

  it("on the brain, a stored conversation that is readable but empty is no memory", async () => {
    const h = setup({ brain: true, stored: { ok: true, value: [] } });
    expect(await h.memory.read(WORKER, NOW)).toEqual([]);
    expect(h.redis.read).not.toHaveBeenCalled();
  });

  it("on the brain, a read that FAILS (e.g. migration 0135 not applied) falls back to Redis", async () => {
    const h = setup({ brain: true, stored: { ok: false } });
    expect(await h.memory.read(WORKER, NOW)).toEqual(REDIS_TURNS);
  });

  it("under the kill switch: the Redis memory alone, exactly as today", async () => {
    const h = setup({ brain: false });
    expect(await h.memory.read(WORKER, NOW)).toEqual(REDIS_TURNS);
    expect(h.history.modelLines).not.toHaveBeenCalled();
  });

  it("appends go to the Redis memory (the fallback source)", async () => {
    const h = setup({ brain: true });
    await h.memory.append(WORKER, { role: "worker", text: "hi" });
    expect(h.redis.append).toHaveBeenCalledWith(WORKER, { role: "worker", text: "hi" });
  });
});
