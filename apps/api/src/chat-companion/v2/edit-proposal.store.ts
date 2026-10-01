import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import { COMPANION_V2_EDIT_OPS, COMPANION_V2_EDIT_SECTIONS } from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { EDIT_CARD_ROWS_MAX } from "../chat-companion.dto";

/**
 * Minimal typed view of the raw Redis KV commands this store needs — the same narrowing
 * `AdminMfaSecretStore` uses, for the same reason (ioredis at runtime, BullMQ's interface
 * declares less).
 */
interface RedisKvClient {
  set(key: string, value: string, expiryMode: "EX", seconds: number): Promise<unknown>;
  /** SET … NX: "OK" when this caller took the key, null when someone already holds it. */
  set(key: string, value: string, expiryMode: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * How long a card's RECORD outlives its `expires_at` (contracts §4, §7).
 *
 * The card's life is still `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS` — the service refuses a Haan
 * or a Nahi past `expires_at` exactly as before. The record stays a little longer so that such a
 * late tap can be told apart from an unknown id: it names the worker's OWN card, so it can be
 * recorded as `chat.companion_edit_cancelled{reason:"expired"}` without ever putting a
 * client-supplied id on the spine.
 */
export const PROPOSAL_EXPIRY_GRACE_SECONDS = 300;

/**
 * The result of claiming a card for one Haan / Nahi.
 *   - `claimed`     — this request owns the card; nobody else may apply or cancel it;
 *   - `held`        — another request already claimed it (a double tap, a retry, a done card);
 *   - `unavailable` — Redis refused the claim, so at-most-once cannot be promised.
 */
export type ProposalClaim = "claimed" | "held" | "unavailable";

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
    // Never more rows than one confirm may tick (O5): a larger stored card is off-contract.
    rows: z.array(StoredEditProposalRowSchema).min(1).max(EDIT_CARD_ROWS_MAX),
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
 * THE RECORD OUTLIVES THE CARD by {@link PROPOSAL_EXPIRY_GRACE_SECONDS}, so a late tap can be
 * recorded as `expired`; the service, not Redis, decides the card is past `expires_at`.
 *
 * AT MOST ONCE, BY CLAIM. `companion:v2:proposal-claim:{workerId}:{proposalId}` is taken with
 * SET NX before a Haan applies anything (or a Nahi cancels): a double tap, a client retry while
 * the first request is still working, or a re-confirm after a failed delete finds it held and
 * is answered 404. A rolled-back apply RELEASES it so the worker may tap again; a successful
 * one keeps it until it expires with the record. Keyed by the proposal, so a NEW card is never
 * blocked by an old card's claim.
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

  /** `companion:v2:proposal-claim:{workerId}:{proposalId}` — one Haan/Nahi per card. */
  private static claimKey(workerId: string, proposalId: string): string {
    return `companion:v2:proposal-claim:${workerId}:${proposalId}`;
  }

  private async client(): Promise<RedisKvClient> {
    return (await this.queue.client) as unknown as RedisKvClient;
  }

  /** The card's life plus the grace in which a late tap is still recognisable as `expired`. */
  private recordTtlSeconds(): number {
    return this.config.CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS + PROPOSAL_EXPIRY_GRACE_SECONDS;
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
        this.recordTtlSeconds(),
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

  /** Drop the card (Haan, Nahi or stale). Best-effort — the TTL is the backstop. */
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

  /**
   * Claim the card for ONE Haan or Nahi (SET NX). Never throws: a Redis failure is
   * `unavailable`, and the caller must then apply nothing — at-most-once is not promisable.
   * The claim lives as long as the card's record, so it outlives every tap that could reach it.
   */
  async claim(workerId: string, proposalId: string): Promise<ProposalClaim> {
    try {
      const taken = await (
        await this.client()
      ).set(EditProposalStore.claimKey(workerId, proposalId), "1", "EX", this.recordTtlSeconds(), "NX");
      return taken === null ? "held" : "claimed";
    } catch (err) {
      this.logger.warn(
        `companion edit proposal not claimed for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return "unavailable";
    }
  }

  /**
   * Hand a claim back after a rolled-back apply, so the worker may tap Haan again. Best-effort:
   * a failed release leaves the card unconfirmable (404) until its record expires — closed, never
   * a second apply.
   */
  async release(workerId: string, proposalId: string): Promise<void> {
    try {
      await (await this.client()).del(EditProposalStore.claimKey(workerId, proposalId));
    } catch (err) {
      this.logger.warn(
        `companion edit proposal claim not released for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
