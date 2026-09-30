import { Injectable, Logger } from "@nestjs/common";

import { readGeneralRoadStamp } from "../profiling/conversation-state";
import { GeneralRoadRepository } from "./general-road.repository";

/** What the reader answers when the résumé IS on the general road. Nothing else rides it. */
export interface GeneralRoadMarker {
  readonly road: "general";
}

/** A UUID, as `chat_sessions.id` stores it — checked before the value reaches a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WAS THE PROFILE THIS RÉSUMÉ RENDERS BUILT ON THE GENERAL ROAD? (ADR-0045 Phase 5)
 *
 * ANSWERED BY THE RÉSUMÉ'S OWN PROVENANCE, NOT BY "THE WORKER'S NEWEST HANDOVER". The résumé row
 * names its profile; the profile names the extraction job that built it; the job names the chat
 * session it read; and that session's durable stamp says whether it handed the worker over to the
 * general form (`readGeneralRoadStamp(...)?.handed_over === true` — the same strict reader the
 * extraction processor keyed the zero-model build on, so "the road" means here exactly what it
 * meant when the profile was built). See `GeneralRoadRepository` for the links.
 *
 * WHY NOT THE NEWEST HANDOVER. The stamp belongs to a SESSION and a worker can have many. A worker
 * who finished the general form and then opened a later chat he abandoned — no extraction, no new
 * résumé — would, under "the newest handover" or "the newest session", lose the brief, the
 * "Fresher" label and the dated years from his still-current general-road résumé, on both copies,
 * and every employer disclosure rendered live from it would inherit the loss. Provenance cannot
 * move: a résumé built from a road profile renders as the road until a NEW profile (and so a new
 * résumé) is built from something else.
 *
 * FLAG-INDEPENDENT, on the Phase 4 precedent: a handed-over stamp can only have been written while
 * `CHAT_GENERAL_ROAD_ENABLED` was on, and the road is a property of that session from then on. A
 * flag flip must not re-render a road worker's résumé as something his profile was never built as.
 *
 * RETURNS A MARKER OR NULL — NEVER THE NAME, THE BRIEF, THE ROLE OR THE SKILLS. The stamp carries
 * labels; none of them leaves this method. The brief is read by the mapper from the attribute row
 * the render already loads, so there is one source for it, not two.
 *
 * NEVER THROWS. Every failure — a read that errors, a session id that is not a UUID, a row that is
 * gone — degrades to null, which is today's sheet, with a warn carrying ids only. A résumé is not
 * worth losing over the question of whether it gets a brief.
 */
@Injectable()
export class GeneralRoadReader {
  private readonly logger = new Logger(GeneralRoadReader.name);

  constructor(private readonly roads: GeneralRoadRepository) {}

  async forResume(resume: {
    readonly id: string;
    readonly workerId: string;
  }): Promise<GeneralRoadMarker | null> {
    try {
      const sessionId = await this.roads.findResumeExtractionSessionId(resume.id, resume.workerId);
      // No extraction session (a legacy profile, the voice-form path) is simply not the road. A
      // value that is not a UUID came from a hand-written job row; it names no session we can read.
      if (sessionId === null || !UUID_RE.test(sessionId)) return null;
      const session = await this.roads.findSessionGeneralRoad(sessionId, resume.workerId);
      if (session === undefined) return null;
      return readGeneralRoadStamp({ general_road: session.generalRoad })?.handed_over === true
        ? { road: "general" }
        : null;
    } catch (err) {
      // IDS ONLY. The error's class, never its message: a driver message can quote a value.
      this.logger.warn(
        `could not read the general-road provenance of resume ${resume.id} (worker ` +
          `${resume.workerId}); rendering without the road ` +
          `(${err instanceof Error ? err.name : "UnknownError"})`,
      );
      return null;
    }
  }
}
