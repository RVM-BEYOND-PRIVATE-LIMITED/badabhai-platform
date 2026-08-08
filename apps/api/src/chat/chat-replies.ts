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

/**
 * The one-shot composite opener, as REVIEWED COPY rather than a generated line.
 *
 * WHAT IT REPLACED. `AiService.profilingOpening()` spent one `capable`-tier call on the chat
 * MOUNT — before the worker had said anything at all — to produce a greeting that was then
 * memoized and served identically to everyone anyway. A constant does the same job for nothing.
 *
 * The invitation to answer several things at once is the point: a worker who volunteers their
 * trade, city and experience in one message has those captured on turn one, and the engine simply
 * asks for whatever they left out. A partial answer degrades to the ordinary question-by-question
 * flow, so this can only ever shorten the interview.
 *
 * ON-PERSONA by the same rules the pack validator enforces: "aap", no vocative, no exclamation,
 * no emoji, one question mark, under twenty words.
 *
 * WHY IT LIVES HERE AND NOT IN `chat.service.ts` (#679). It is the literal first thing a worker
 * hears, and while it sat on the service it was enumerated by NOTHING: not `CONSTANT_REPLIES`, so
 * `assertNoInterpolation` never saw it, and not the pack corpus, so `validateQuestionPackCorpus`
 * never saw it either. A module whose header claims to hold EVERY STRING THE INTERVIEW CAN EVER
 * SAY cannot reach into the Nest DI graph to read one, so the constant moved to the import-free
 * side instead — the same trade, and the same reasoning, as `CHAT_UNAVAILABLE_REPLY` above.
 */
export const CHAT_OPENING_TEXT =
  "Namaste. Aap kaun sa kaam karte hain, kahan rehte hain, aur kitna tajurba hai?";
