import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { PayerDisclosureRateLimit } from "./payer-disclosure-rate-limit.service";

const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";

function setup(opts: { cap?: number; throwOn?: string; start?: number } = {}) {
  const config = { PAYER_DISCLOSURE_MAX_PER_HOUR: opts.cap ?? 3 } as unknown as ServerConfig;
  let counter = opts.start ?? 0;
  const client = {
    async incr(_key: string) {
      if (opts.throwOn === "incr") throw new Error("redis down");
      counter += 1;
      return counter;
    },
    async expire(_key: string, _sec: number) {
      if (opts.throwOn === "expire") throw new Error("redis down");
      return 1;
    },
  };
  const queue = { client: Promise.resolve(client) } as unknown as Queue;
  return new PayerDisclosureRateLimit(config, queue);
}

describe("PayerDisclosureRateLimit (XB-G — per-payer hourly disclosure cap)", () => {
  it("allows requests up to the cap, then rejects with 429", async () => {
    const svc = setup({ cap: 3 });
    await expect(svc.assertWithinHourlyCap(PAYER)).resolves.toBeUndefined(); // 1
    await expect(svc.assertWithinHourlyCap(PAYER)).resolves.toBeUndefined(); // 2
    await expect(svc.assertWithinHourlyCap(PAYER)).resolves.toBeUndefined(); // 3 == cap
    await expect(svc.assertWithinHourlyCap(PAYER)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    }); // 4 > cap
  });

  it("FAILS CLOSED (429) when Redis is unavailable rather than uncapping", async () => {
    const svc = setup({ throwOn: "incr" });
    await expect(svc.assertWithinHourlyCap(PAYER)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });
});
