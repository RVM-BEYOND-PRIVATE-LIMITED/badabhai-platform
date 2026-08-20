import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { IpRateLimit } from "./ip-rate-limit.service";
import type { PiiCryptoService } from "../pii-crypto.service";

const IP = "203.0.113.7";

function makeRedis(incrResults: Array<number | Error>) {
  let i = 0;
  const incr = vi.fn(async (_key: string) => {
    const r = incrResults[Math.min(i, incrResults.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);
  return { incr, expire };
}

function setup(opts: { incrResults?: number[] | Error[]; clientThrows?: boolean } = {}) {
  const redis = makeRedis(opts.incrResults ?? [1]);
  const queue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };
  // Simulate hashIp: deterministic, and (like the real HMAC) does NOT echo the
  // raw IP — so we can assert the raw IP never reaches the Redis key.
  //
  // `hmac` is the device-id side of the same rule (#1035), and it returns a DIFFERENT constant
  // on purpose: with one shared value the namespace assertions below would still pass if the
  // two kinds collapsed into a single bucket, which is the exact mistake they exist to catch.
  const pii = {
    hashIp: vi.fn((_ip: string) => "d3adb33fcafef00dd3adb33fcafef00dd3adb33fcafef00d"),
    hmac: vi.fn((_value: string) => "beefcafe1234567890abcdefbeefcafe1234567890abcdef"),
  };
  const svc = new IpRateLimit(
    pii as unknown as PiiCryptoService,
    queue as unknown as Queue,
  );
  return { svc, redis, pii };
}

async function expect429(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  await expect(p).rejects.toBeInstanceOf(HttpException);
}

describe("IpRateLimit.assertWithinHourlyIpCap", () => {
  it("allows when the per-IP count is within cap", async () => {
    const { svc, redis } = setup({ incrResults: [1] });
    await expect(svc.assertWithinHourlyIpCap("resume_download", IP, 20)).resolves.toBeUndefined();
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1); // TTL asserted every hit
  });

  it("429s when the per-IP count exceeds the cap", async () => {
    const { svc } = setup({ incrResults: [21] });
    await expect429(svc.assertWithinHourlyIpCap("resume_download", IP, 20));
  });

  it("NEVER uses the raw IP as the key — it hashes first", async () => {
    const { svc, redis, pii } = setup({ incrResults: [1] });
    await svc.assertWithinHourlyIpCap("interview_kit", IP, 20);
    expect(pii.hashIp).toHaveBeenCalledWith(IP);
    const key = redis.incr.mock.calls[0]![0];
    expect(key).not.toContain(IP); // raw IP must not appear in the Redis key
    expect(key).toContain("ratelimit:ip:interview_kit:");
  });

  it("FAILS CLOSED with 429 when the redis client throws (outage)", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect429(svc.assertWithinHourlyIpCap("resume_download", IP, 20));
  });

  it("FAILS CLOSED with 429 when INCR throws mid-flight", async () => {
    const { svc } = setup({ incrResults: [new Error("READONLY")] });
    await expect429(svc.assertWithinHourlyIpCap("resume_download", IP, 20));
  });
});

const DEVICE = "3f7c1b9a-0d4e-4c62-9a11-77b2c5e8d013";

describe("IpRateLimit.assertWithinHourlySenderCap — keyed on the handset (#1035)", () => {
  it("allows a device within cap, and re-asserts the TTL like every other bucket", async () => {
    const { svc, redis } = setup({ incrResults: [1] });
    await expect(
      svc.assertWithinHourlySenderCap("otp_request", { kind: "device", value: DEVICE }, 20),
    ).resolves.toBeUndefined();
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it("429s a device over cap", async () => {
    const { svc } = setup({ incrResults: [21] });
    await expect429(
      svc.assertWithinHourlySenderCap("otp_request", { kind: "device", value: DEVICE }, 20),
    );
  });

  it("NEVER uses the raw device id as the key — it HMACs first (§2)", async () => {
    // The same posture `worker_devices.device_hash` already takes for this identifier: it is a
    // stable pseudonymous handle for one person's handset, so it does not go into a key raw.
    const { svc, redis, pii } = setup({ incrResults: [1] });
    await svc.assertWithinHourlySenderCap("otp_request", { kind: "device", value: DEVICE }, 20);
    expect(pii.hmac).toHaveBeenCalledWith(DEVICE);
    const key = redis.incr.mock.calls[0]![0];
    expect(key).not.toContain(DEVICE);
    expect(key).toMatch(/^ratelimit:dev:otp_request:[0-9a-f]{32}:\d{10}$/);
  });

  it("BOUNDS the key whatever the caller sends — 32 hex chars, always", async () => {
    // This header is unauthenticated and Node accepts a ~16KB block. `request-sender` refuses
    // an over-long value before this point, but the truncation here is the second, unconditional
    // guarantee: the width of a key we write is never the caller's choice.
    const { svc, redis, pii } = setup({ incrResults: [1] });
    pii.hmac.mockReturnValueOnce("f".repeat(512));
    await svc.assertWithinHourlySenderCap(
      "otp_request",
      { kind: "device", value: "a".repeat(256) },
      20,
    );
    expect(redis.incr.mock.calls[0]![0]).toMatch(/^ratelimit:dev:otp_request:f{32}:\d{10}$/);
  });

  it("THE NAMESPACE SPLIT: a device and an address never share a bucket", async () => {
    // Both hashes are 32 hex chars, so a shared namespace would put a device-id hash and an
    // address hash in one key with nothing to say which was which — and one device could then
    // spend a whole network's allowance, or inherit one.
    const { svc, redis } = setup({ incrResults: [1] });
    await svc.assertWithinHourlySenderCap("otp_request", { kind: "device", value: DEVICE }, 20);
    await svc.assertWithinHourlySenderCap("otp_request", { kind: "ip", value: IP }, 20);
    const [deviceKey, ipKey] = redis.incr.mock.calls.map((c) => c[0]);
    expect(deviceKey).toContain("ratelimit:dev:");
    expect(ipKey).toContain("ratelimit:ip:");
    expect(deviceKey).not.toBe(ipKey);
  });

  it("the ip kind writes the SAME key assertWithinHourlyIpCap always did", async () => {
    // Load-bearing across the deploy that ships this: live buckets keep counting instead of
    // every network silently getting a fresh allowance the moment the new build boots.
    const a = setup({ incrResults: [1] });
    await a.svc.assertWithinHourlySenderCap("otp_request", { kind: "ip", value: IP }, 20);
    const b = setup({ incrResults: [1] });
    await b.svc.assertWithinHourlyIpCap("otp_request", IP, 20);
    expect(a.redis.incr.mock.calls[0]![0]).toBe(b.redis.incr.mock.calls[0]![0]);
  });

  it("assertWithinHourlyIpCap still hashes with hashIp, not hmac — no behaviour moved", async () => {
    const { svc, pii } = setup({ incrResults: [1] });
    await svc.assertWithinHourlyIpCap("resume_download", IP, 20);
    expect(pii.hashIp).toHaveBeenCalledWith(IP);
    expect(pii.hmac).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED for a device too — a Redis outage cannot uncap the send path", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect429(
      svc.assertWithinHourlySenderCap("otp_request", { kind: "device", value: DEVICE }, 20),
    );
  });

  it("the 429 wording is IDENTICAL for both kinds — no oracle for a prober", async () => {
    // A different message would tell a caller whether their device id was accepted as one.
    const device = setup({ incrResults: [21] });
    const ip = setup({ incrResults: [21] });
    const [d, i] = await Promise.all([
      device.svc
        .assertWithinHourlySenderCap("otp_request", { kind: "device", value: DEVICE }, 20)
        .catch((e: HttpException) => e),
      ip.svc
        .assertWithinHourlySenderCap("otp_request", { kind: "ip", value: IP }, 20)
        .catch((e: HttpException) => e),
    ]);
    expect((d as HttpException).message).toBe((i as HttpException).message);
    expect((d as HttpException).getStatus()).toBe((i as HttpException).getStatus());
  });

  it("an empty ip value still buckets as 'unknown' rather than the empty string", async () => {
    const { svc, pii } = setup({ incrResults: [1] });
    await svc.assertWithinHourlySenderCap("otp_request", { kind: "ip", value: "" }, 20);
    expect(pii.hashIp).toHaveBeenCalledWith("unknown");
  });
});

describe("a cap that fires says so (#1019)", () => {
  // The same silence #1019 hit in `OtpService`: this limiter throws the neutral 429 that four
  // other throttles also throw, so without a line here "which limit did this worker hit?" can
  // only be answered by reading Redis on the box by hand.
  it("logs the kind, the scope and the count — never the raw address or device id", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc } = setup({ incrResults: [21] });
    await expect429(svc.assertWithinHourlySenderCap("otp_request", { kind: "ip", value: IP }, 20));
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("cap reached"));
    expect(line).toContain("scope=otp_request");
    expect(line).toMatch(/count=21\/20/);
    expect(line).not.toContain(IP);
    warn.mockRestore();
  });

  it("says which KIND of bucket it was, so a device cap is not read as a network one", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc } = setup({ incrResults: [21] });
    await expect429(
      svc.assertWithinHourlySenderCap("otp_request", { kind: "device", value: "dev-aaa1" }, 20),
    );
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("cap reached"));
    expect(line).toMatch(/^device rate-limit cap reached/);
    expect(line).not.toContain("dev-aaa1");
    warn.mockRestore();
  });

  it("a request WITHIN cap logs nothing — the line marks a refusal, not a hit", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc } = setup({ incrResults: [1] });
    await svc.assertWithinHourlySenderCap("otp_request", { kind: "ip", value: IP }, 20);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("cap reached"))).toEqual([]);
    warn.mockRestore();
  });
});
