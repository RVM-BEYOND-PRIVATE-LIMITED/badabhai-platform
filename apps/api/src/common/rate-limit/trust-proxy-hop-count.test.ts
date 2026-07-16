import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Controller, Get, Inject, Module, Req, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request } from "express";
import type { Queue } from "bullmq";
import type { AddressInfo } from "node:net";
import { IpRateLimit } from "./ip-rate-limit.service";
import type { PiiCryptoService } from "../pii-crypto.service";
import { hashIp } from "../crypto";

/**
 * TD25a — TRUST_PROXY_HOP_COUNT → `req.ip` regression suite (Express 5.2.1 via
 * @nestjs/platform-express 11, pinned EMPIRICALLY on 2026-07-16).
 *
 * WHY THIS EXISTS: every per-IP rate cap (e.g. the OTP per-IP hourly cap in
 * auth.controller.ts `requestOtp`) is keyed off `req.ip`. Behind a load balancer,
 * hop=0 makes `req.ip` the LB's address → EVERY client shares ONE bucket
 * (self-DoS + invisible abuse). A hop count that is TOO HIGH (or a blanket
 * `trust proxy: true` — banned) lets an abuser rotate X-Forwarded-For prefixes
 * for unlimited rate-limit identities (real SMS spend once real OTP is live).
 * The hop count must be EXACT; this suite pins what each value actually does.
 *
 * OBSERVED HOP-SEMANTICS TABLE (all rows asserted below; socket peer = 127.0.0.1):
 *
 * | hop | X-Forwarded-For          | observed req.ip | meaning                              |
 * |-----|--------------------------|-----------------|--------------------------------------|
 * | 0   | (none)                   | 127.0.0.1       | direct: socket peer                  |
 * | 0   | 203.0.113.7              | 127.0.0.1       | XFF IGNORED → per-proxy collapse bug |
 * | 1   | (none)                   | 127.0.0.1       | direct hit on a trusting app: peer   |
 * | 1   | 203.0.113.7              | 203.0.113.7     | proxy-appended client wins           |
 * | 1   | 1.2.3.4, 203.0.113.7     | 203.0.113.7     | forged prefix LOSES (rightmost wins) |
 * | 2   | 1.2.3.4, 203.0.113.7     | 1.2.3.4         | hop too high → FORGED value WINS     |
 *
 * (Express walks XFF right-to-left from the socket peer, trusting `hop` addresses;
 * `req.ip` is the first UNTRUSTED address. So with one real proxy, hop=1 is exact,
 * hop=2 hands the abuser their identity back. No divergence from the expected
 * semantics was observed — the table above is the observed truth.)
 *
 * The harness below boots a REAL Nest+Express HTTP server (ephemeral port) and
 * mirrors the production trust-proxy wiring VERBATIM from
 * apps/api/src/main.ts lines 56-65 (TD25, PR #197) — main.ts itself is NOT
 * imported because it eagerly boots the full AppModule + config asserts.
 * NEVER change this harness to `set("trust proxy", true)` — a blanket trust is
 * exactly the spoofing bug this suite exists to prevent.
 */

/** Per-IP cap used by the /capped probe (tiny so tests trip it fast). */
const CAP = 2;

/** Mirrors auth.controller.ts requestOtp: scope "otp_request", `req.ip ?? "unknown"`. */
interface EchoBody {
  ip: string | null;
  ip_defined: boolean;
  ips: string[];
}

@Controller()
class ProbeController {
  // Explicit @Inject: vitest's esbuild transform does not emit design:paramtypes.
  constructor(@Inject(IpRateLimit) private readonly ipRateLimit: IpRateLimit) {}

  /** Echo what Express resolved — the raw material every per-IP cap keys on. */
  @Get("echo")
  echo(@Req() req: Request): EchoBody {
    return { ip: req.ip ?? null, ip_defined: req.ip !== undefined, ips: req.ips };
  }

  /**
   * Exercises the REAL IpRateLimit service with the EXACT keying expression used
   * by the OTP endpoint (apps/api/src/auth/auth.controller.ts ~line 94-98):
   * `assertWithinHourlyIpCap("otp_request", req.ip ?? "unknown", cap)`.
   */
  @Get("capped")
  async capped(@Req() req: Request): Promise<{ ok: true }> {
    await this.ipRateLimit.assertWithinHourlyIpCap("otp_request", req.ip ?? "unknown", CAP);
    return { ok: true };
  }
}

interface Harness {
  app: INestApplication;
  base: string;
}

/**
 * Boot a minimal Nest app wired exactly like production for the trust-proxy seam.
 * IpRateLimit runs against an in-memory INCR/EXPIRE seam (the service only needs
 * those two commands) + the REAL keyed-HMAC `hashIp` with a test pepper — so the
 * cap-keying assertions exercise the true hash-before-Redis-key path without a
 * Redis server. (Gap noted honestly: this is the in-memory seam, not real Redis;
 * the Layer 2 compose harness in infra/docker/proxy-harness covers the real stack.)
 */
async function boot(hopCount: number): Promise<Harness> {
  const counters = new Map<string, number>();
  const redis = {
    incr: async (key: string): Promise<number> => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async (_key: string, _seconds: number): Promise<number> => 1,
  };
  const queue = { client: Promise.resolve(redis) };
  const pii = { hashIp: (ip: string): string => hashIp(ip, "td25a-test-pepper") };

  @Module({
    controllers: [ProbeController],
    providers: [
      {
        provide: IpRateLimit,
        useFactory: (): IpRateLimit =>
          new IpRateLimit(pii as unknown as PiiCryptoService, queue as unknown as Queue),
      },
    ],
  })
  class HarnessModule {}

  const app = await NestFactory.create(HarnessModule, { logger: false });

  // ---- VERBATIM mirror of apps/api/src/main.ts lines 56-65 (TD25 wiring) ----
  // (config.TRUST_PROXY_HOP_COUNT → hopCount; a hop COUNT, never a blanket `true`)
  if (hopCount > 0) {
    const express = app.getHttpAdapter().getInstance() as {
      set: (setting: string, value: number) => void;
    };
    express.set("trust proxy", hopCount);
  }
  // ---------------------------------------------------------------------------

  await app.listen(0, "127.0.0.1"); // IPv4 loopback → deterministic socket peer
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function getEcho(base: string, xff?: string): Promise<EchoBody> {
  const res = await fetch(`${base}/echo`, {
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as EchoBody;
}

async function getCapped(base: string, xff?: string): Promise<number> {
  const res = await fetch(`${base}/capped`, {
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });
  await res.arrayBuffer(); // drain the body so sockets are released
  return res.status;
}

/** Socket peer on the IPv4 loopback listener (Express may present the mapped form). */
const PEER_RE = /^(::ffff:)?127\.0\.0\.1$/;

// The "real client" as a single-hop edge proxy would append it, and a forged
// prefix an abusive client sends in its own request to that proxy.
const CLIENT_A = "203.0.113.7";
const CLIENT_B = "203.0.113.99";
const FORGED = "1.2.3.4";

describe("TD25a — TRUST_PROXY_HOP_COUNT → req.ip resolution", () => {
  let hop0: Harness;
  let hop1: Harness;
  let hop2: Harness;
  /** The OBSERVED socket-peer string (captured once, reused so assertions pin exact equality). */
  let peer: string;

  beforeAll(async () => {
    [hop0, hop1, hop2] = await Promise.all([boot(0), boot(1), boot(2)]);
    const direct = await getEcho(hop0.base);
    expect(direct.ip).toMatch(PEER_RE);
    peer = direct.ip as string;
  });

  afterAll(async () => {
    await Promise.all([hop0.app.close(), hop1.app.close(), hop2.app.close()]);
  });

  it("(1) hop=0, no proxy → req.ip is the socket peer", async () => {
    const body = await getEcho(hop0.base);
    expect(body.ip).toBe(peer);
    expect(body.ip_defined).toBe(true);
  });

  it("(2) hop=0 behind a proxy → req.ip is the PROXY, not the client (the collapse bug)", async () => {
    // The supertest-style peer (this test process) plays the proxy; XFF carries
    // the real client. With hop=0 the XFF is ignored entirely.
    const a = await getEcho(hop0.base, CLIENT_A);
    const b = await getEcho(hop0.base, CLIENT_B);
    expect(a.ip).toBe(peer); // NOT 203.0.113.7 — the proxy's address wins
    expect(b.ip).toBe(peer);
    expect(a.ip).toBe(b.ip); // two DIFFERENT clients collapse into ONE identity
  });

  it("(3) hop=1 behind one appending proxy → req.ip is the true client", async () => {
    const body = await getEcho(hop1.base, CLIENT_A);
    expect(body.ip).toBe(CLIENT_A);
  });

  it("(4) hop=1 + forged XFF prefix → the PROXY-APPENDED entry wins, the forgery loses", async () => {
    // Abusive client sends "X-Forwarded-For: 1.2.3.4"; the honest edge proxy
    // APPENDS the real peer → "1.2.3.4, 203.0.113.7". The forged prefix must
    // NOT become the rate-limit identity. This assertion is the whole point.
    const body = await getEcho(hop1.base, `${FORGED}, ${CLIENT_A}`);
    expect(body.ip).toBe(CLIENT_A);
    expect(body.ip).not.toBe(FORGED);
  });

  it("(5) hop TOO HIGH (2 with one proxy) → the FORGED value wins (why the count must be exact)", async () => {
    // Pinned deliberately: with hop=2 Express trusts one entry too many and the
    // abuser-controlled prefix becomes req.ip → rotatable rate-limit identity.
    // This is the documented failure mode of overcounting (and of blanket `true`).
    const body = await getEcho(hop2.base, `${FORGED}, ${CLIENT_A}`);
    expect(body.ip).toBe(FORGED);
  });

  it("hop=1, direct hit with NO XFF → falls back to the socket peer (no crash, no unknown)", async () => {
    const body = await getEcho(hop1.base);
    expect(body.ip).toBe(peer);
    expect(body.ip_defined).toBe(true);
  });

  it("req.ip is DEFINED on the proxied path — the auth.controller `?? \"unknown\"` fallback is never hit", async () => {
    // If req.ip were ever undefined, every capped request would collapse into a
    // single shared "unknown" bucket. Assert the fallback is dead on all paths.
    for (const [base, xff] of [
      [hop0.base, undefined],
      [hop0.base, CLIENT_A],
      [hop1.base, CLIENT_A],
      [hop1.base, `${FORGED}, ${CLIENT_A}`],
      [hop2.base, `${FORGED}, ${CLIENT_A}`],
    ] as Array<[string, string | undefined]>) {
      const body = await getEcho(base, xff);
      expect(body.ip_defined).toBe(true);
      expect(body.ip).not.toBe("unknown");
      expect(body.ip).toBeTruthy();
    }
  });

  it("hop=1 cap keying: different clients resolve to DIFFERENT identities; same client is stable", async () => {
    const a1 = await getEcho(hop1.base, CLIENT_A);
    const a2 = await getEcho(hop1.base, CLIENT_A);
    const b = await getEcho(hop1.base, CLIENT_B);
    expect(a1.ip).toBe(a2.ip); // same client → same bucket key input
    expect(a1.ip).not.toBe(b.ip); // different clients → different bucket key input
  });
});

describe("TD25a — the OTP per-IP cap keyed through the resolved req.ip", () => {
  it("hop=1: client A spams past the cap → A 429s, client B is UNAFFECTED", async () => {
    const { app, base } = await boot(1);
    try {
      expect(await getCapped(base, CLIENT_A)).toBe(200);
      expect(await getCapped(base, CLIENT_A)).toBe(200);
      expect(await getCapped(base, CLIENT_A)).toBe(429); // A exceeded CAP=2
      expect(await getCapped(base, CLIENT_B)).toBe(200); // B has its own bucket
    } finally {
      await app.close();
    }
  });

  it("hop=0 behind a proxy: A's spam 429s client B too — the shared-bucket bug, reproduced at the cap layer", async () => {
    const { app, base } = await boot(0);
    try {
      expect(await getCapped(base, CLIENT_A)).toBe(200);
      expect(await getCapped(base, CLIENT_A)).toBe(200);
      expect(await getCapped(base, CLIENT_A)).toBe(429);
      // B never spammed — but with hop=0 the XFF is ignored, every request keys
      // on the proxy's IP, and B inherits A's exhausted bucket. Self-DoS.
      expect(await getCapped(base, CLIENT_B)).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("hop=1: a forged XFF prefix cannot mint a fresh rate-limit identity", async () => {
    const { app, base } = await boot(1);
    try {
      // The abuser rotates the forged prefix on every request; the honest proxy
      // keeps appending their REAL address — so they stay in ONE bucket.
      expect(await getCapped(base, `${FORGED}, ${CLIENT_A}`)).toBe(200);
      expect(await getCapped(base, `5.6.7.8, ${CLIENT_A}`)).toBe(200);
      expect(await getCapped(base, `9.9.9.9, ${CLIENT_A}`)).toBe(429);
    } finally {
      await app.close();
    }
  });
});
