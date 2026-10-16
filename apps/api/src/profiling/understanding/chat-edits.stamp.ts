import { z } from "zod";

import { ExperienceEntrySchema, type ExperienceEntry } from "@badabhai/ai-contracts";
import { PROFILING_EDIT_OPS } from "@badabhai/types";

import type { ProfilingEnvelope } from "../conversation-state";
import { MAX_EXPERIENCE_ENTRIES } from "../llm-turn.service";
import { MAX_SKILLS } from "../skill-certifier";
import { MAX_EDIT_LEDGER } from "./edit-gate.state";
import { EXPERIENCE_KEY, SKILLS_KEY } from "./profiling-schema";

/**
 * THE CONFIRMED-CHANGE STAMP (ADR-0057 R9, #2313) — what the profile build must honour after the
 * flush, when the transcript beside it still says the value the worker changed.
 *
 * THE DEFECT IT CLOSES. The build's Phase C re-reads the WHOLE transcript, and Phase C wins for the
 * job list, the skill list and the city; the transcript-typed parse fills any field the answer map
 * leaves empty. So a worker who confirmed "5 saal → 2 saal" for a job, deleted a job, or removed a
 * field could have the old value read straight back out of the conversation.
 *
 * A SIBLING KEY OF `conversation_state`, VERSIONED AND STRICT, outside the frozen contract — the
 * `general_road` stamp precedent. ABSENT for every session with no confirmed change, so every such
 * session's state, and the profile built from it, is byte-identical to today's.
 *
 * WHAT IT HOLDS:
 *   - `ledger` — every confirmed change, catalogue keys and ops only;
 *   - `skills` / `experiences` — the settled list, ONLY for a list the worker changed (owner ruling
 *     2026-10-16: the chat's list wins over Phase C's for that list);
 *   - `deleted_fields` — the pack fields the worker removed and never answered again, by target
 *     field: what the build keeps empty.
 * A changed pack value needs no copy here: the answer map, which the flush persists, holds it.
 */

/** The key on `chat_sessions.conversation_state`. */
export const CHAT_EDITS_KEY = "chat_edits";

const LABEL_MAX = 200;

export const ChatEditsStampSchema = z
  .object({
    v: z.literal(1),
    ledger: z
      .array(
        z
          .object({
            field_key: z.string().min(1).max(64),
            op: z.enum(PROFILING_EDIT_OPS),
            target_field: z.string().min(1).max(64).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_EDIT_LEDGER),
    skills: z.array(z.string().min(1).max(LABEL_MAX)).max(MAX_SKILLS).nullable(),
    experiences: z.array(ExperienceEntrySchema).max(MAX_EXPERIENCE_ENTRIES).nullable(),
    deleted_fields: z.array(z.string().min(1).max(64)).max(MAX_EDIT_LEDGER),
  })
  .strict();
export type ChatEditsStamp = z.infer<typeof ChatEditsStampSchema>;

/**
 * The stamp for this envelope, spread into every writer that REPLACES `conversation_state` (the
 * checkpoint, the flush, the abandon sweep) — or `{}`, the key absent, when nothing was confirmed.
 */
export function toChatEditsStatePatch(envelope: ProfilingEnvelope): { chat_edits?: ChatEditsStamp } {
  // `?? []`: an envelope fixture from before this field existed must not make a writer throw.
  const ledger = envelope.editLedger ?? [];
  if (ledger.length === 0) return {};
  const touched = (key: string): boolean => ledger.some((entry) => entry.key === key);
  const answered = new Set(
    envelope.answerMap.filter((record) => record.status === "answered").map((r) => r.question_key),
  );
  const deleted = new Set<string>();
  for (const entry of ledger) {
    // REMOVED AND NOT ANSWERED SINCE. A field asked again and answered has its new value in the
    // answer map, which the build already prefers; only a field left empty is kept empty.
    if (entry.op === "delete" && entry.targetField !== null && !answered.has(entry.key)) {
      deleted.add(entry.targetField);
    }
  }
  const experiences: ExperienceEntry[] = envelope.llmDraft.experiences.slice(0, MAX_EXPERIENCE_ENTRIES);
  return {
    chat_edits: {
      v: 1,
      ledger: ledger.map((entry) => ({
        field_key: entry.key,
        op: entry.op,
        target_field: entry.targetField,
      })),
      skills: touched(SKILLS_KEY)
        ? envelope.llmDraft.skills.slice(0, MAX_SKILLS).filter((skill) => skill.trim().length > 0)
        : null,
      experiences: touched(EXPERIENCE_KEY) ? experiences : null,
      deleted_fields: [...deleted],
    },
  };
}

/**
 * The stamp the row ALREADY holds, raw — spread BEFORE {@link toChatEditsStatePatch}, so an
 * envelope rebuilt after a lost Redis key (an empty ledger, so an absent patch) never erases the
 * changes a checkpoint already made durable. The `storedFreeChatLock` precedent.
 */
export function storedChatEdits(state: unknown): { chat_edits?: unknown } {
  if (typeof state !== "object" || state === null) return {};
  const held = (state as Record<string, unknown>)[CHAT_EDITS_KEY];
  return held === undefined ? {} : { chat_edits: held };
}

/**
 * The stamp, read back by the profile build — or null for no stamp, or one the strict schema
 * refuses (a `v: 2` from a later build, a hand-edited row). Never throws: null is "no confirmed
 * change", which builds exactly today's profile.
 */
export function readChatEditsStamp(state: unknown): ChatEditsStamp | null {
  if (typeof state !== "object" || state === null) return null;
  const parsed = ChatEditsStampSchema.safeParse((state as Record<string, unknown>)[CHAT_EDITS_KEY]);
  return parsed.success ? parsed.data : null;
}
