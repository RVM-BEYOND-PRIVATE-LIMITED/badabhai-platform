import { describe, expect, it } from "vitest";

import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  PROFILING_ENVELOPE_KEYS,
  resolvePackPointer,
  stampUniversalPointer,
  type ProfilingEnvelope,
} from "./conversation-state";

/**
 * Defect-A fix (owner ruling 2026-09-18, option a): the envelope-stamped universal
 * pointer. The occupation-pin slot (`packId`) is never written here — these tests pin
 * that by asserting the stamp leaves it alone while the resolver still prefers it.
 */
function stamped(over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope {
  return {
    ...emptyProfilingEnvelope(),
    universalPackId: "qp_universal",
    universalPackVersion: 4,
    ...over,
  };
}

const UNIVERSAL_PACK = { pack_id: "qp_universal", version: 4 } as const;

describe("stampUniversalPointer", () => {
  it("stamps the served universal pack onto an unstamped envelope", () => {
    const out = stampUniversalPointer(emptyProfilingEnvelope(), UNIVERSAL_PACK);
    expect(out.universalPackId).toBe("qp_universal");
    expect(out.universalPackVersion).toBe(4);
  });

  it("never touches the occupation-pin slot", () => {
    const pinned = {
      ...emptyProfilingEnvelope(),
      packId: "qp_tailoring",
      packVersion: 2,
    };
    const out = stampUniversalPointer(pinned, UNIVERSAL_PACK);
    expect(out.packId).toBe("qp_tailoring");
    expect(out.packVersion).toBe(2);
    expect(out.universalPackId).toBe("qp_universal");
  });

  it("is a no-op (identical object) when the same version is already stamped", () => {
    const env = stamped();
    expect(stampUniversalPointer(env, UNIVERSAL_PACK)).toBe(env);
  });

  it("floats with the served version across a mid-interview pack publish", () => {
    const env = stampUniversalPointer(stamped(), { pack_id: "qp_universal", version: 5 });
    expect(env.universalPackVersion).toBe(5);
  });

  it("leaves the envelope identical when no pack resolved", () => {
    const env = emptyProfilingEnvelope();
    expect(stampUniversalPointer(env, null)).toBe(env);
    expect(stampUniversalPointer(env, undefined)).toBe(env);
  });
});

describe("resolvePackPointer", () => {
  it("prefers the occupation pin over the stamp", () => {
    expect(
      resolvePackPointer({
        ...stamped(),
        packId: "qp_tailoring",
        packVersion: 2,
      }),
    ).toEqual({ packId: "qp_tailoring", packVersion: 2 });
  });

  it("falls back to the stamped universal pointer when unpinned", () => {
    expect(resolvePackPointer(stamped())).toEqual({
      packId: "qp_universal",
      packVersion: 4,
    });
  });

  it("is null when neither exists — the pre-fix no-attribution rule", () => {
    expect(resolvePackPointer(emptyProfilingEnvelope())).toBeNull();
  });

  it("fails closed on half pointers (mirrors the durable pin's both-or-neither CHECK)", () => {
    expect(resolvePackPointer({ ...stamped(), packId: "qp_tailoring", packVersion: null })).toEqual(
      { packId: "qp_universal", packVersion: 4 },
    );
    expect(resolvePackPointer({ ...stamped(), universalPackVersion: null })).toBeNull();
    expect(resolvePackPointer({ ...stamped(), universalPackId: null })).toBeNull();
  });
});

describe("universal pointer narrowing + key closure", () => {
  it("round-trips stamped values through Redis-shaped JSON", () => {
    const revived = narrowProfilingEnvelope(JSON.parse(JSON.stringify(stamped())));
    expect(revived?.universalPackId).toBe("qp_universal");
    expect(revived?.universalPackVersion).toBe(4);
  });

  it("absent reads as null — every in-flight envelope across the deploy", () => {
    const {
      universalPackId: _droppedId,
      universalPackVersion: _droppedVersion,
      ...rest
    } = stamped();
    void _droppedId;
    void _droppedVersion;
    const revived = narrowProfilingEnvelope(rest);
    expect(revived?.universalPackId).toBeNull();
    expect(revived?.universalPackVersion).toBeNull();
  });

  it("malformed values narrow to null, never to a guess", () => {
    const base = stamped();
    expect(
      narrowProfilingEnvelope({ ...base, universalPackVersion: 0 })?.universalPackVersion,
    ).toBeNull();
    expect(
      narrowProfilingEnvelope({ ...base, universalPackVersion: 1.5 })?.universalPackVersion,
    ).toBeNull();
    expect(narrowProfilingEnvelope({ ...base, universalPackId: 42 })?.universalPackId).toBeNull();
  });

  it("the mechanical closure lists both fields (build breaks if the interface drifts)", () => {
    expect(PROFILING_ENVELOPE_KEYS.universalPackId).toBe(true);
    expect(PROFILING_ENVELOPE_KEYS.universalPackVersion).toBe(true);
  });
});
