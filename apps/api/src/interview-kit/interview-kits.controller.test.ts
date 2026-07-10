import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { InterviewKitsController } from "./interview-kits.controller";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { REQUIRED_KIT_TRADE_KEYS } from "./interview-kit-content";
import { TradeKeyParamSchema } from "./interview-kit.dto";

const IP = "203.0.113.9";
const CAP = 30;

// Mirrors interview-kit-content.test.ts's no-fabricated-specifics check: the wire
// responses must never carry worker/contact-ish tokens, currency, or company names.
const PII_TOKENS = /worker|phone|name@|₹/i;
const COMPANY_TOKENS = /\b(Pvt|Ltd)\b/;

function make() {
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR: CAP } as ServerConfig;
  const controller = new InterviewKitsController(ipRateLimit as unknown as IpRateLimit, config);
  return { controller, ipRateLimit };
}

const capError = () =>
  new HttpException("Too many requests from this network", HttpStatus.TOO_MANY_REQUESTS);

describe("InterviewKitsController — GET /interview-kits (list)", () => {
  it("returns exactly the 15 wired kits, matching REQUIRED_KIT_TRADE_KEYS", async () => {
    const { controller } = make();
    const res = await controller.list(IP);
    expect(res.kits).toHaveLength(15);
    expect(new Set(res.kits.map((k) => k.trade_key))).toEqual(new Set(REQUIRED_KIT_TRADE_KEYS));
  });

  it("every item carries trade_key + display_name ONLY (no kit body in the list)", async () => {
    const { controller } = make();
    const res = await controller.list(IP);
    for (const item of res.kits) {
      expect(Object.keys(item).sort()).toEqual(["display_name", "trade_key"]);
      expect(item.trade_key.length).toBeGreaterThan(0);
      expect(item.display_name.length).toBeGreaterThan(0);
    }
  });

  it("never leaks an unwired draft kit (no hosp_ keys)", async () => {
    const { controller } = make();
    const res = await controller.list(IP);
    for (const item of res.kits) expect(item.trade_key).not.toMatch(/^hosp_/);
  });

  it("applies the shared per-IP cap FIRST, on the interview_kit bucket", async () => {
    const { controller, ipRateLimit } = make();
    await controller.list(IP);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("interview_kit", IP, CAP);
  });

  it("a cap rejection blocks the response", async () => {
    const { controller, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      capError(),
    );
    await expect(controller.list(IP)).rejects.toBeInstanceOf(HttpException);
  });
});

describe("InterviewKitsController — GET /interview-kits/:tradeKey (detail)", () => {
  it("returns the full kit for a known trade (spot-check)", async () => {
    const { controller } = make();
    const kit = await controller.detail("cnc_operator", IP);
    expect(kit.trade_key).toBe("cnc_operator");
    expect(kit.display_name).toBe("CNC Operator");
    expect(kit.overview.length).toBeGreaterThan(0);
    expect(kit.common_questions.length).toBeGreaterThan(0);
    expect(kit.practical_questions.length).toBeGreaterThan(0);
    expect(kit.safety_questions.length).toBeGreaterThan(0);
    expect(kit.drawing_measurement_questions.length).toBeGreaterThan(0);
    expect(kit.skill_checklist.length).toBeGreaterThan(0);
    expect(kit.revise_before.length).toBeGreaterThan(0);
    expect(kit.documents_to_carry.length).toBeGreaterThan(0);
    expect(kit.common_mistakes.length).toBeGreaterThan(0);
    expect(kit.hinglish_note.length).toBeGreaterThan(0);
  });

  it("unknown tradeKey → NotFoundException", async () => {
    const { controller } = make();
    await expect(controller.detail("not_a_trade", IP)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("applies the shared per-IP cap FIRST — a cap rejection wins even over a 404", async () => {
    const { controller, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      capError(),
    );
    // Unknown key + tripped cap must reject with the CAP error, proving the cap
    // runs before the kit lookup.
    await expect(controller.detail("not_a_trade", IP)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("interview_kit", IP, CAP);
  });

  it("malformed tradeKey is rejected by the param schema (ZodValidationPipe input)", () => {
    expect(TradeKeyParamSchema.safeParse("cnc_operator").success).toBe(true);
    expect(TradeKeyParamSchema.safeParse("CNC Operator").success).toBe(false);
    expect(TradeKeyParamSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(TradeKeyParamSchema.safeParse("").success).toBe(false);
    expect(TradeKeyParamSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("InterviewKitsController — PII-free responses", () => {
  it("the list response carries no PII-ish or company tokens", async () => {
    const { controller } = make();
    const blob = JSON.stringify(await controller.list(IP));
    expect(blob).not.toMatch(PII_TOKENS);
    expect(blob).not.toMatch(COMPANY_TOKENS);
  });

  it("every detail response carries no PII-ish or company tokens", async () => {
    const { controller } = make();
    for (const tradeKey of REQUIRED_KIT_TRADE_KEYS) {
      const blob = JSON.stringify(await controller.detail(tradeKey, IP));
      expect(blob).not.toMatch(PII_TOKENS);
      expect(blob).not.toMatch(COMPANY_TOKENS);
    }
  });
});
