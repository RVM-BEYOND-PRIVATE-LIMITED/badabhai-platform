import { describe, it, expect } from "vitest";
import {
  MAX_TOMBSTONES_PER_DEVICE,
  MAX_TOMBSTONES_PER_WORKER,
  selectErasableRefreshTokens,
  type RefreshTokenCandidate,
  type SelectErasableOptions,
} from "./erased-refresh-tombstone";

/**
 * #2113 — the PURE selection of which refresh tokens an erasure tombstones. No Redis, no clock:
 * `nowMs` is injected, so every TTL below is exact arithmetic rather than a tolerance.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const REFRESH_TTL = 90 * 86400;
const HORIZON = 7 * 86400;

const OPTS: SelectErasableOptions = {
  workerId: WORKER,
  nowMs: NOW,
  refreshTtlSeconds: REFRESH_TTL,
  horizonSeconds: HORIZON,
};

/** A deterministic 64-hex "sha256" for candidate n — ordering by n is ordering by hash. */
const hash = (n: number): string => n.toString(16).padStart(64, "0");

/** A well-formed LIVE device-bound tip record (the shape mintRefresh writes), overridable. */
function rec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sid: "sid-1",
    family_id: "fam-1",
    worker_id: WORKER,
    used: false,
    superseded_by: null,
    created_at_ms: NOW - 1000,
    created_via_otp_at_ms: NOW - 1000,
    device_id: "device-a",
    ...over,
  });
}

const cand = (n: number, raw: string | null): RefreshTokenCandidate => ({
  tokenHash: hash(n),
  raw,
});

const hashes = (r: ReturnType<typeof selectErasableRefreshTokens>): string[] =>
  r.entries.map((e) => e.tokenHash);

describe("selectErasableRefreshTokens — which records are kept (#2113)", () => {
  it("keeps only parsed used:false records; drops a missing, an unparseable and a used:true record", () => {
    const out = selectErasableRefreshTokens(
      [
        cand(1, rec()), // live tip -> kept
        cand(2, null), // record gone (raw null)
        cand(3, "{not json"), // unparseable
        cand(4, rec({ used: true, superseded_by: hash(1) })), // rotated -> never tombstoned
      ],
      OPTS,
    );
    expect(hashes(out)).toEqual([hash(1)]);
    expect(out.dropped).toBe(3);
  });

  it("drops a record whose worker_id differs from the worker being erased", () => {
    const out = selectErasableRefreshTokens(
      [cand(1, rec()), cand(2, rec({ worker_id: OTHER_WORKER, device_id: "device-b" }))],
      OPTS,
    );
    expect(hashes(out)).toEqual([hash(1)]);
  });

  it("drops an UNBOUND record — no device_id, an empty one, or a non-string one (mirrors verifyPin gate (a))", () => {
    const unbound = JSON.parse(rec()) as Record<string, unknown>;
    delete unbound.device_id;
    const out = selectErasableRefreshTokens(
      [
        cand(1, JSON.stringify(unbound)),
        cand(2, rec({ device_id: "" })),
        cand(3, rec({ device_id: 42 })),
        cand(4, rec({ device_id: null })),
      ],
      OPTS,
    );
    expect(out.entries).toEqual([]);
    expect(out.dropped).toBe(4);
  });

  it("drops a malformed record — empty sid/family_id, or a non-finite created_at_ms", () => {
    const out = selectErasableRefreshTokens(
      [
        cand(1, rec({ sid: "" })),
        cand(2, rec({ family_id: undefined })),
        cand(3, rec({ created_at_ms: "1700000000000" })),
        cand(4, JSON.stringify({ ...JSON.parse(rec()), created_at_ms: null })),
        cand(5, "null"),
        cand(6, "[]"),
        cand(7, "123"),
      ],
      OPTS,
    );
    expect(out.entries).toEqual([]);
    expect(out.dropped).toBe(7);
  });

  it("used must be EXACTLY false — a missing or truthy-ish `used` is not a live tip", () => {
    const noUsed = JSON.parse(rec()) as Record<string, unknown>;
    delete noUsed.used;
    const out = selectErasableRefreshTokens(
      [cand(1, JSON.stringify(noUsed)), cand(2, rec({ used: "false" })), cand(3, rec({ used: 0 }))],
      OPTS,
    );
    expect(out.entries).toEqual([]);
  });
});

describe("selectErasableRefreshTokens — TTL = min(floor(natural remaining), horizon) (#2113)", () => {
  it("a fresh tip gets the full horizon", () => {
    const out = selectErasableRefreshTokens([cand(1, rec({ created_at_ms: NOW }))], OPTS);
    expect(out.entries).toEqual([{ tokenHash: hash(1), ttlSeconds: HORIZON }]);
  });

  it("a tip near the end of its life gets its FLOORED natural remaining life, never more", () => {
    // 100.7s of natural life left: floor -> 100. A ceil would hand out 101 — a tombstone that
    // outlives the token it stands in for.
    const createdAt = NOW - (REFRESH_TTL * 1000 - 100_700);
    const out = selectErasableRefreshTokens([cand(1, rec({ created_at_ms: createdAt }))], OPTS);
    expect(out.entries).toEqual([{ tokenHash: hash(1), ttlSeconds: 100 }]);
  });

  it("drops a tip with under 1s of life left (floor 0), and an already-expired one", () => {
    const almostDead = NOW - (REFRESH_TTL * 1000 - 600); // 0.6s left -> floor 0 -> dropped
    const expired = NOW - (REFRESH_TTL * 1000 + 5_000); // negative
    const out = selectErasableRefreshTokens(
      [
        cand(1, rec({ created_at_ms: almostDead })),
        cand(2, rec({ created_at_ms: expired, device_id: "device-b" })),
      ],
      OPTS,
    );
    expect(out.entries).toEqual([]);
    expect(out.dropped).toBe(2);
  });

  it("the horizon caps a long-lived tip", () => {
    const out = selectErasableRefreshTokens([cand(1, rec())], { ...OPTS, horizonSeconds: 3600 });
    expect(out.entries).toEqual([{ tokenHash: hash(1), ttlSeconds: 3600 }]);
  });

  it("horizon 0 (the kill switch) selects nothing, whatever the candidates", () => {
    const out = selectErasableRefreshTokens([cand(1, rec()), cand(2, rec())], {
      ...OPTS,
      horizonSeconds: 0,
    });
    expect(out).toEqual({ entries: [], dropped: 2 });
    // A negative or non-finite horizon is never read as "on" either.
    expect(
      selectErasableRefreshTokens([cand(1, rec())], { ...OPTS, horizonSeconds: -1 }).entries,
    ).toEqual([]);
    expect(
      selectErasableRefreshTokens([cand(1, rec())], { ...OPTS, horizonSeconds: Number.NaN })
        .entries,
    ).toEqual([]);
  });
});

describe("selectErasableRefreshTokens — caps and determinism (#2113)", () => {
  it(`keeps the ${MAX_TOMBSTONES_PER_DEVICE} NEWEST tips per device by created_at_ms`, () => {
    const out = selectErasableRefreshTokens(
      [
        cand(1, rec({ created_at_ms: NOW - 3000 })), // oldest -> dropped
        cand(2, rec({ created_at_ms: NOW - 1000 })), // newest
        cand(3, rec({ created_at_ms: NOW - 2000 })),
        cand(4, rec({ created_at_ms: NOW - 5000, device_id: "device-b" })), // own device -> kept
      ],
      OPTS,
    );
    expect(hashes(out)).toEqual([hash(2), hash(3), hash(4)]);
    expect(out.dropped).toBe(1);
  });

  it("breaks a created_at_ms tie by tokenHash ascending", () => {
    const sameInstant = { created_at_ms: NOW - 1000 };
    const out = selectErasableRefreshTokens(
      [cand(9, rec(sameInstant)), cand(3, rec(sameInstant)), cand(5, rec(sameInstant))],
      OPTS,
    );
    expect(hashes(out)).toEqual([hash(3), hash(5)]);
  });

  it(`caps one erasure at ${MAX_TOMBSTONES_PER_WORKER} tombstones, newest first, independent of input order`, () => {
    // 40 devices x 2 live tips = 80 eligible; the 64 newest survive.
    const candidates: RefreshTokenCandidate[] = [];
    for (let i = 0; i < 80; i += 1) {
      candidates.push(
        cand(i + 1, rec({ created_at_ms: NOW - (i + 1) * 1000, device_id: `device-${i % 40}` })),
      );
    }
    const out = selectErasableRefreshTokens(candidates, OPTS);
    expect(out.entries).toHaveLength(MAX_TOMBSTONES_PER_WORKER);
    expect(hashes(out)).toEqual(candidates.slice(0, 64).map((c) => c.tokenHash));
    expect(out.dropped).toBe(16);

    const reversed = selectErasableRefreshTokens([...candidates].reverse(), OPTS);
    expect(reversed.entries).toEqual(out.entries);
  });

  it("entries + dropped always account for every candidate", () => {
    const candidates = [
      cand(1, rec()),
      cand(2, null),
      cand(3, rec({ used: true })),
      cand(4, rec()),
    ];
    const out = selectErasableRefreshTokens(candidates, OPTS);
    expect(out.entries.length + out.dropped).toBe(candidates.length);
  });
});

describe("selectErasableRefreshTokens — the output carries NOTHING but {tokenHash, ttlSeconds} (#2113)", () => {
  it("no worker id, device id, sid or family id survives into an entry", () => {
    const out = selectErasableRefreshTokens(
      [cand(1, rec({ sid: "sid-secret", family_id: "fam-secret", device_id: "device-secret" }))],
      OPTS,
    );
    expect(out.entries).toHaveLength(1);
    for (const e of out.entries) expect(Object.keys(e).sort()).toEqual(["tokenHash", "ttlSeconds"]);
    const json = JSON.stringify(out);
    for (const leaked of [WORKER, "sid-secret", "fam-secret", "device-secret"]) {
      expect(json).not.toContain(leaked);
    }
  });
});
