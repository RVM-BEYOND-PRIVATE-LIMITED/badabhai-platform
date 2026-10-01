import type { Logger } from "@nestjs/common";
import type { TranscriptLine } from "@badabhai/ai-contracts";

import {
  type KnownNameSource,
  redactKnownName,
  redactKnownNameLines,
} from "../common/redact-known-name";

/**
 * R32 / ADR-0047 G2 — the worker's words as an INTERVIEW MODEL may read them: the message and
 * every history line, with the worker's own known name redacted out (`redactKnownName`).
 *
 * THE EGRESS OF BOTH INTERVIEW TURNS. `LlmTurnService.take` (Phase A) and `SkillsTurnService.take`
 * (the general road's skills stage) each send `message_text` and the whole `history` to
 * `/profiling/turn`; each calls this immediately before it builds the request, so a turn that
 * makes no model call reads no name.
 *
 * NOT KEYED ON `AI_RAW_PII_ENABLED`. Armed, the ai-service's prompt maskers pass the text through,
 * and a name the model reads it can write back into `role_label` — which settles into the answer
 * map as `trade`, then `profile.primary_role`, then the employer copy, where the name must show as
 * initials until an unlock. Off, it removes the un-cued forms the gateway provably misses (R32).
 * The interview never needs the worker's own name either way.
 *
 * THE OUTBOUND COPY ONLY. The buffer and `chat_messages` keep what the worker typed, and the caller
 * keeps reading its own `text`/`history` for everything that is not the request (the gate reply,
 * skill grounding, the repeat check).
 *
 * FAIL SAFE, exactly as the extraction's redaction: no name on record, an undecryptable one (the
 * source logs that and yields `null`) or a lookup that throws — the text goes out as typed, and the
 * turn is never failed for it. The warning carries the opaque ids only.
 */
export async function redactedTurnText(
  text: string,
  history: readonly TranscriptLine[],
  ctx: {
    readonly workerId: string;
    readonly sessionId: string;
    readonly knownName: KnownNameSource;
  },
  logger: Pick<Logger, "warn">,
): Promise<{ readonly messageText: string; readonly history: TranscriptLine[] }> {
  let fullName: string | null;
  try {
    fullName = await ctx.knownName();
  } catch {
    logger.warn(
      `known name unavailable worker=${ctx.workerId} session=${ctx.sessionId}; ` +
        `this model turn is not name-redacted`,
    );
    fullName = null;
  }
  return {
    messageText: redactKnownName(text, fullName),
    history: redactKnownNameLines(history, fullName),
  };
}
