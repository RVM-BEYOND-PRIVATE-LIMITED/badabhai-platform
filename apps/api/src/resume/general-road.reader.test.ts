import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GeneralRoadReader } from "./general-road.reader";
import type { GeneralRoadRepository } from "./general-road.repository";

/**
 * ═══ THE GENERAL ROAD, BY THE RÉSUMÉ'S OWN PROVENANCE (ADR-0045 Phase 5) ═══
 *
 * The reader answers one question — was the profile this résumé renders built on the general
 * road? — and three properties matter more than the answer itself: it asks the RÉSUMÉ's session
 * (never "the worker's newest handover"), every read is scoped to the résumé's worker, and it
 * NEVER throws and never returns anything but a marker (the stamp carries labels; none of them
 * may leave).
 */

const RESUME = { id: "resume-1", workerId: "11111111-1111-4111-8111-111111111111" } as const;
const SESSION = "22222222-2222-4222-8222-222222222222";

/** The stamp exactly as `general_road` persists it for a handed-over session. */
const HANDED_OVER = {
  v: 1,
  lane: "skills",
  role_label: "House electrician",
  domain_label: "Electrical work",
  skills: ["House wiring", "Panel fitting"],
  outcome: "confirmed",
  handed_over: true,
} as const;

function build(opts: {
  sessionId?: string | null;
  stamp?: unknown;
  sessionMissing?: boolean;
  throwsAt?: "resume" | "session";
}) {
  const roads = {
    findResumeExtractionSessionId: vi.fn(async () => {
      if (opts.throwsAt === "resume") throw new TypeError(`bad value ${RESUME.workerId}`);
      return opts.sessionId === undefined ? SESSION : opts.sessionId;
    }),
    findSessionGeneralRoad: vi.fn(async () => {
      if (opts.throwsAt === "session") throw new RangeError("driver said: Ramesh Kumar");
      if (opts.sessionMissing) return undefined;
      return { generalRoad: "stamp" in opts ? opts.stamp : HANDED_OVER };
    }),
  };
  return { reader: new GeneralRoadReader(roads as unknown as GeneralRoadRepository), roads };
}

afterEach(() => vi.restoreAllMocks());

describe("GeneralRoadReader.forResume", () => {
  it("answers the road for a résumé whose extraction session handed over — a marker, nothing else", async () => {
    const { reader, roads } = build({});
    const marker = await reader.forResume(RESUME);
    expect(marker).toEqual({ road: "general" });
    // NEVER THE LABELS: the stamp's role, domain and skills stay behind this method.
    expect(JSON.stringify(marker)).not.toMatch(/electric|wiring|Panel/i);
    // BOTH reads are scoped to the résumé's worker, and the session read is THIS résumé's session.
    expect(roads.findResumeExtractionSessionId).toHaveBeenCalledWith(RESUME.id, RESUME.workerId);
    expect(roads.findSessionGeneralRoad).toHaveBeenCalledWith(SESSION, RESUME.workerId);
  });

  it("is not the road when the session never handed over", async () => {
    const { reader } = build({ stamp: { ...HANDED_OVER, handed_over: false } });
    expect(await reader.forResume(RESUME)).toBeNull();
  });

  it("is not the road for a session with no stamp, or one the strict reader cannot parse", async () => {
    for (const stamp of [null, {}, { ...HANDED_OVER, v: 2 }, { ...HANDED_OVER, extra: 1 }]) {
      const { reader } = build({ stamp });
      expect(await reader.forResume(RESUME), JSON.stringify(stamp)).toBeNull();
    }
  });

  it("is absent for a profile with no extraction session — a legacy row or the voice form", async () => {
    const { reader, roads } = build({ sessionId: null });
    expect(await reader.forResume(RESUME)).toBeNull();
    // Nothing to ask about: the second read never runs.
    expect(roads.findSessionGeneralRoad).not.toHaveBeenCalled();
  });

  it("never sends a non-UUID session id to a uuid column — a hand-written job row", async () => {
    const { reader, roads } = build({ sessionId: "not-a-uuid" });
    expect(await reader.forResume(RESUME)).toBeNull();
    expect(roads.findSessionGeneralRoad).not.toHaveBeenCalled();
  });

  it("is absent when the session is not this worker's (the scoped read finds nothing)", async () => {
    const { reader } = build({ sessionMissing: true });
    expect(await reader.forResume(RESUME)).toBeNull();
  });

  it.each(["resume", "session"] as const)(
    "a read that THROWS at the %s link degrades to null, warning with ids only",
    async (throwsAt) => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const { reader } = build({ throwsAt });
      await expect(reader.forResume(RESUME)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain(RESUME.id);
      expect(line).toContain(RESUME.workerId);
      // The error's CLASS, never its message — a driver message can quote a value.
      expect(line).toMatch(/TypeError|RangeError/);
      expect(line).not.toMatch(/bad value|driver said|Ramesh/);
    },
  );
});
