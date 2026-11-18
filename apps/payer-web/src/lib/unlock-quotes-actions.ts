"use server";

import { z } from "zod";
import { getUnlockQuotes } from "./payer-api";
import type { UnlockQuotes } from "./contracts";
import { quoteWorkerIds } from "./unlock-quotes";

/**
 * #2750 — fetch the contact-cost quotes for one page of cards (client-invoked after
 * the list has loaded, and again when the payer returns to the page after a purchase).
 *
 * FAILURE-SAFE BY CONSTRUCTION: a company outside the credit rules (404), a malformed
 * call, an outage or an unreadable answer all return `null`, so the list keeps today's
 * button. It never logs, never names a worker fact, and opens/spends nothing.
 */
const inputSchema = z
  .object({ workerIds: z.array(z.string().uuid()).min(1).max(50) })
  .strict();

export async function unlockQuotesAction(input: {
  workerIds: string[];
}): Promise<UnlockQuotes | null> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return null;
  const workerIds = quoteWorkerIds(parsed.data.workerIds);
  // The API's body is strict: repeats are refused, so never forward them.
  if (workerIds.length !== parsed.data.workerIds.length) return null;
  try {
    return await getUnlockQuotes(workerIds);
  } catch {
    return null;
  }
}
