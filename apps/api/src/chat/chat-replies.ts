/**
 * Worker-facing chat copy, in a module with NO imports.
 *
 * WHY IT IS NOT IN `chat.service.ts` ANY MORE. The voice form pre-renders every string the
 * platform can say to a worker into TTS audio, and enumerating that set must not require booting
 * Nest: importing a string constant from an `@Injectable()` service pulls the entire DI graph —
 * repositories, Redis, the queue, the occupation ladder — into a process whose whole job is to read
 * JSON and hash text. Two copies of the string would have solved the import and recreated the
 * problem the constant exists to prevent, so the constant moved instead.
 *
 * `chat.service.ts` re-exports it, so every existing import site is unchanged.
 */

/**
 * Served when the AI service is unreachable and no turn happened.
 *
 * DELIBERATELY NOT a copy of the ai-service's own degraded line, and deliberately not a
 * question. This is the same split the codebase already makes between Python's
 * `_BLOCKED_REPLY` and Flutter's `kChatBlockedNotice`: each surface says the thing IT
 * knows. The ai-service's fallback continues an interview it is still conducting; this
 * one is served when there is no interview happening at all, so asking a question here
 * would invite an answer nothing is listening for.
 *
 * On-persona by the same rules the guard enforces on the far side: "aap", no vocative,
 * no exclamation mark, no emoji, two short lines.
 */
export const CHAT_UNAVAILABLE_REPLY =
  "Abhi thodi dikkat aa rahi hai. Ek minute baad dobara bhejiye.";
