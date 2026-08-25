import { describe, it, expect, vi } from "vitest";
import { LearnLabelsService } from "./learn-labels.service";
import type { LearnEventRow } from "./learn-labels.repository";

/**
 * Unit tests for the LEARN label producer's ROUTING — which event becomes which write,
 * and that the cursor only advances over what was read. Idempotency mechanics
 * (ON CONFLICT / resolved_at guards) are DB facts covered by the migration's CHECKs +
 * UNIQUE key; here we pin the decisions around them.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "22222222-2222-4222-8222-222222222222";

function shownEvent(createdAt = new Date("2026-08-01T10:00:00Z")): LearnEventRow {
  return {
    id: "eeeeeeee-0000-4000-8000-000000000001",
    eventName: "feed.shown_v2",
    subjectType: "job_posting",
    payload: {
      worker_id: WORKER,
      job_posting_id: POSTING,
      rank: 3,
      match_tier: 2,
      boosted: false,
      matched_skill_id: "mskill_cnc_turner",
    },
    createdAt,
  };
}

function appliedEvent(createdAt: Date): LearnEventRow {
  return {
    id: "eeeeeeee-0000-4000-8000-000000000002",
    eventName: "application.submitted",
    subjectType: "job_posting",
    payload: { worker_id: WORKER, job_id: POSTING, rank: null, source_surface: "feed" },
    createdAt,
  };
}

function setup() {
  const repo = {
    readEventBatch: vi.fn(async (_ms: number, _limit: number): Promise<LearnEventRow[]> => []),
    ingestImpression: vi.fn(async (_ev: LearnEventRow) => true),
    resolvePending: vi.fn(async (_ev: LearnEventRow, _o: "applied" | "skipped") => true),
    getWatermark: vi.fn(async () => Date.parse("2026-08-01T09:00:00Z")),
    setWatermark: vi.fn(async (_ms: number) => undefined),
    countRelevantAfter: vi.fn(async () => 0),
  };
  const svc = new LearnLabelsService(repo as never);
  return { svc, repo };
}

describe("LearnLabelsService.processBatch", () => {
  it("routes feed.shown_v2 to an impression insert", async () => {
    const { svc, repo } = setup();
    repo.readEventBatch.mockResolvedValue([shownEvent()]);
    const summary = await svc.processBatch(100);

    expect(summary.impressionsIngested).toBe(1);
    expect(repo.ingestImpression).toHaveBeenCalledTimes(1);
    expect(repo.resolvePending).not.toHaveBeenCalled();
  });

  it("resolves pending impressions on application.submitted / .skipped", async () => {
    const { svc, repo } = setup();
    const t0 = new Date("2026-08-01T10:00:00Z");
    repo.readEventBatch.mockResolvedValue([
      shownEvent(t0),
      appliedEvent(new Date(t0.getTime() + 60_000)),
    ]);
    const summary = await svc.processBatch(100);

    expect(summary.impressionsIngested).toBe(1);
    expect(summary.submittedResolved).toBe(1);
    // Resolution is delegated with its OUTCOME; label polarity lives in the SQL guard.
    expect(repo.resolvePending).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "application.submitted" }),
      "applied",
    );
  });

  it("counts a LEGACY-subjected application as not applicable instead of writing it", async () => {
    // A V0 decision points at retired `jobs` rows; projecting it would put an id into
    // job_posting_id that means nothing there. The repository's subject guard returns
    // false → the service must COUNT it, not silently drop it.
    const { svc, repo } = setup();
    const ev = appliedEvent(new Date());
    repo.resolvePending.mockResolvedValue(false);
    repo.readEventBatch.mockResolvedValue([ev]);
    const summary = await svc.processBatch(100);

    expect(summary.skippedEvents).toBe(1);
    expect(summary.impressionsIngested).toBe(0);
  });

  it("advances the watermark over the batch's LAST event even when nothing ingested", async () => {
    const { svc, repo } = setup();
    const late = new Date("2026-08-01T12:00:00Z");
    repo.readEventBatch.mockResolvedValue([appliedEvent(late)]);
    repo.resolvePending.mockResolvedValue(false);
    await svc.processBatch(100);

    // Without this, an all-skipped batch would re-read forever.
    expect(repo.setWatermark).toHaveBeenCalledWith(late.getTime());
  });

  it("an empty batch writes no watermark", async () => {
    const { svc, repo } = setup();
    await svc.processBatch(100);
    expect(repo.setWatermark).not.toHaveBeenCalled();
  });

  it("dry-run counts pending without touching anything else", async () => {
    const { svc, repo } = setup();
    repo.countRelevantAfter.mockResolvedValue(42);
    expect(await svc.countPending()).toBe(42);
    expect(repo.readEventBatch).not.toHaveBeenCalled();
    expect(repo.setWatermark).not.toHaveBeenCalled();
  });
});
