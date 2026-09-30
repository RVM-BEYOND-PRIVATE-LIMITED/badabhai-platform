import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import { COMPANION_V2_EDIT_OPS, COMPANION_V2_EDIT_SECTIONS } from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";

/**
 * Minimal typed view of the raw Redis KV commands this store needs — the same narrowing
 * `AdminMfaSecretStore` uses, for the same reason (ioredis at runtime, BullMQ's interface
 * declares less).
 */
interface RedisKvClient {
  set(key: string, value: string, expiryMode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * ONE STORED EDIT ROW, exactly as the card will apply it.
 *
 * `row_id` is what the wire's checkboxes send back; `target` is the section-specific identity
 * the writer needs (an employment id, a language slug, a list position), resolved by the API
 * BEFORE the card is shown so the model never sees a DB id; `before` is the value captured at
 * proposal time, which the confirm route re-reads to refuse a stale card. `value` is what the
 * worker will be writing — their own words, TTL-bounded in Redis, never logged.
 */
export const StoredEditProposalRowSchema = z
  .object({
    row_id: z.string().uuid(),
    section: z.enum(COMPANION_V2_EDIT_SECTIONS),
    op: z.enum(COMPANION_V2_EDIT_OPS),
    field: z.string().min(1).max(64).nullable(),
    value: z.string().max(4000).nullable(),
    before: z.string().nullable(),
    /** The wire's display label for this section (reviewed copy, API-authored). */
    section_label: z.string().min(1).max(80),
    /** Section-specific real identity, resolved server-side; null for `add`. */
    target: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
  })
  .strict();
export type StoredEditProposalRow = z.infer<typeof StoredEditProposalRowSchema>;

/** The whole proposal as it round-trips through Redis. `.strict()` so a stray key is a bug. */
export const StoredEditProposalSchema = z
  .object({
    proposal_id: z.string().uuid(),
    expires_at: z.string().datetime(),
    rows: z.array(StoredEditProposalRowSchema).min(1),
  })
  .strict();
export type StoredEditProposal = z.infer<typeof StoredEditProposalSchema>;

/**
 * THE PENDING EDIT CARD (ADR-0046 O4/O5), one active proposal per worker.
 *
 * `companion:v2:proposal:{workerId}` holds the JSON of the card the worker is looking at, for
 * `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS`. A NEW proposal REPLACES the old one — SET, not
 * append — because a worker who edits again while a card is open means the new card, and two
 * confirmable cards would make "which rows does Haan apply?" ambiguous.
 *
 * SAVE REPORTS WHETHER IT LANDED, and that is the one place this store is NOT fail-soft:
 * contracts §7 says a Redis failure means NO card is offered ("abhi badlav nahi ho paaya, thodi
 * der mein try karein"), so the caller has to know. Reads and deletes are fail-soft: an
 * unreadable proposal is indistinguishable from an expired one (404), and a failed delete
 * leaves a row the TTL will clear.
 *
 * PRIVACY: the rows carry the worker's proposed values, which are what their own record will
 * hold after Haan — TTL-bounded, never logged, and the API drops any row still carrying a
 * placeholder token before this store ever sees it (O17).
 */
@Injectable()
export class EditProposalStore {
  private readonly logger = new Logger(EditProposalStore.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client. The queue is
    // borrowed for its connection only; nothing enqueues to it from here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** `companion:v2:proposal:{workerId}` — one active card per worker, by construction. */
  private static key(workerId: string): string {
    return `companion:v2:proposal:${workerId}`;
  }

  private async client(): Promise<RedisKvClient> {
    return (await this.queue.client) as unknown as RedisKvClient;
  }

  /** Store the card (replacing any prior one). Returns false when Redis refused. */
  async save(workerId: string, proposal: StoredEditProposal): Promise<boolean> {
    try {
      await (
        await this.client()
      ).set(
        EditProposalStore.key(workerId),
        JSON.stringify(proposal),
        "EX",
        this.config.CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `companion edit proposal not stored for worker ${workerId}; no card is offered (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return false;
    }
  }

  /**
   * The worker's active proposal, or null when absent, expired, unreadable or off-contract.
   *
   * A stored JSON that fails the schema is treated exactly like an expired one: the card
   * cannot be applied safely, and guessing at a half-valid row is the failure this contract
   * exists to prevent.
   */
  async load(workerId: string): Promise<StoredEditProposal | null> {
    try {
      const raw = await (await this.client()).get(EditProposalStore.key(workerId));
      if (raw === null) return null;
      const parsed = StoredEditProposalSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.logger.warn(
        `companion edit proposal unreadable for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  /** Drop the card (Haan, Nahi, expired or stale). Best-effort — the TTL is the backstop. */
  async delete(workerId: string): Promise<void> {
    try {
      await (await this.client()).del(EditProposalStore.key(workerId));
    } catch (err) {
      this.logger.warn(
        `companion edit proposal not deleted for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
