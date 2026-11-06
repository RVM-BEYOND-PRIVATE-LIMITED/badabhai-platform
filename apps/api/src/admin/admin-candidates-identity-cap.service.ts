import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { AdminEgressCapService } from "./admin-egress-cap.service";

/**
 * Minimal typed view of the extra Redis commands the budget alert needs (the
 * base class's counter view only declares INCRBY/EXPIRE; the runtime client is
 * ioredis, which has these).
 */
interface RedisReader {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
}

/**
 * CANDIDATES NAME-egress cap (ADR-0062 §3.7, #2559/B5) — the data-bank
 * screen's OWN budget on its OWN Redis namespace (`admin_candidates_identity:*`).
 *
 * A SUBCLASS PER CAP (the base file's rule): the namespace and the two config
 * keys are properties of the cap, and passing them per-call is how one caller
 * ends up charging another's budget. Sized in names actually disclosed
 * (2000/hour, 10000/day): a 100-row Candidates page costs what it discloses.
 *
 * BUDGET ALERT (ADR-0062 §3.7): {@link maybeAlertDailyBudget} reports the day
 * usage so the caller can emit `admin.candidates_name_budget_alert` at 50% —
 * once per admin per UTC day (SET NX marker), best-effort (a Redis error or an
 * unknown usage means NO alert, never a blocked read).
 */
@Injectable()
export class AdminCandidatesIdentityCapService extends AdminEgressCapService {
  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    // Reuse the existing BullMQ Redis connection — do NOT add a second client.
    // Kept as a field (the base holds its own private copy) for the usage/alert
    // reads below, which the base class deliberately does not expose.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly redisQueue: Queue,
  ) {
    super(
      config,
      redisQueue,
      "admin_candidates_identity",
      "ADMIN_CANDIDATES_IDENTITY_MAX_PER_HOUR",
      "ADMIN_CANDIDATES_IDENTITY_MAX_PER_DAY",
    );
  }

  /**
   * Today's disclosed-names count for one admin, or `null` when Redis cannot
   * say (unknown ⇒ no alert, never a blocked read).
   */
  async dayUsage(adminId: string): Promise<number | null> {
    try {
      const redis = (await this.redisClient()) as unknown as RedisReader;
      const raw = await redis.get(this.dayKey(adminId));
      if (raw === null) return 0;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * True the FIRST time it is called per admin per UTC day (SET NX marker with
   * a day TTL) — the "emit the 50% alert at most once a day" gate. False
   * afterwards, and false when Redis is unavailable (no alert, never an error).
   */
  async markBudgetAlerted(adminId: string): Promise<boolean> {
    try {
      const redis = (await this.redisClient()) as unknown as RedisReader;
      const marker = `admin_candidates_identity:alert:${adminId}:${AdminCandidatesIdentityCapService.candidatesUtcDay()}`;
      const set = await redis.set(
        marker,
        "1",
        "EX",
        AdminCandidatesIdentityCapService.secondsUntilUtcDayEnd(),
        "NX",
      );
      return set === "OK";
    } catch {
      return false;
    }
  }

  private async redisClient(): Promise<unknown> {
    return this.redisQueue.client;
  }

  private dayKey(adminId: string): string {
    return `admin_candidates_identity:day:${adminId}:${AdminCandidatesIdentityCapService.candidatesUtcDay()}`;
  }

  private static candidatesUtcDay(now: Date = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  private static secondsUntilUtcDayEnd(now: Date = new Date()): number {
    const endOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(1, Math.floor((endOfDay - now.getTime()) / 1000));
  }
}
