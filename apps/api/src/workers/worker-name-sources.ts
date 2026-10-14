import { Injectable, Logger } from "@nestjs/common";

// VALUE imports: constructor parameters, resolved by Nest from the emitted `design:paramtypes`.
import { PiiCryptoService } from "../common/pii-crypto.service";
import { onceRetrying, type KnownNameSource } from "../common/redact-known-name";
import { decryptWorkerName, type WorkerNameRead } from "../common/worker-name-read";
import { WorkersRepository } from "./workers.repository";

/**
 * The worker's own name for ONE request, as TWO VIEWS OF ONE READ (at most one lookup and one
 * decrypt, memoised by `onceRetrying`; a rejected read is retried by the next caller):
 *
 *   - `knownName` — the DECRYPTED `full_name`, or `null` when there is none OR it cannot be
 *     decrypted. The R32 redaction at the interview model's egress, the free chat's classify and
 *     reply, and the AI-PERSONA-2 vocative read this one. A malformed / rotated-key / tampered token
 *     degrades to `null` — a key rotation must not break every worker's chat at once.
 *   - `ownName` — the same value, except that a name that could not be DECRYPTED REJECTS instead
 *     of reading as "no name on file" (ADR-0054, security M1). Live news reads this one and fails
 *     closed on it: a question that cannot be name-redacted never reaches a third-party search.
 */
export interface WorkerNameSources {
  readonly knownName: KnownNameSource;
  readonly ownName: KnownNameSource;
}

/** What one name read needs: how to fetch the stored token, how to decrypt it, where to warn. */
export interface WorkerNameReadDeps {
  /** The ENCRYPTED `workers.full_name` token, or null/undefined when none is on file. */
  readonly readToken: () => Promise<string | null | undefined>;
  readonly pii: Pick<PiiCryptoService, "decrypt">;
  readonly logger: Pick<Logger, "warn">;
}

/**
 * THE ONE DEFINITION of the two name views (`ChatService` and the Bada Bhai chat's free-chat brain,
 * ADR-0055, both read through it), so the surfaces cannot drift on what "no name" and "unreadable"
 * mean.
 *
 * The plaintext never leaves the request: it is used to REMOVE text on the way out
 * (`redactKnownName`) and, in the profiling chat only, to interpolate the client-facing vocative. It
 * is never logged, evented, stored, or sent to the ai-service/LLM. The warning carries the opaque
 * worker id ONLY, never the token or the decrypted value.
 */
export function workerNameSources(workerId: string, deps: WorkerNameReadDeps): WorkerNameSources {
  const read = onceRetrying(() => readWorkerName(workerId, deps));
  return {
    knownName: async () => {
      const result = await read();
      return result.ok ? result.name : null;
    },
    ownName: async () => {
      const result = await read();
      if (!result.ok) throw new Error("the worker's own name could not be decrypted");
      return result.name;
    },
  };
}

/**
 * One read of `workers.full_name`: the name, nothing on file, or a decrypt that failed. The decision
 * is the shared `decryptWorkerName` (also the free-chat probe's); this adds the warning.
 */
async function readWorkerName(workerId: string, deps: WorkerNameReadDeps): Promise<WorkerNameRead> {
  const read = decryptWorkerName(await deps.readToken(), deps.pii);
  if (!read.ok) {
    deps.logger.warn(
      `could not decrypt full_name for worker ${workerId}; ` +
        `reply stays name-less, the outbound turn is not name-redacted, and no news search is made`,
    );
  }
  return read;
}

/**
 * THE WORKER'S OWN NAME, FOR REDACTION ONLY — the injectable view of {@link workerNameSources} for a
 * module that must not reach the chat (ADR-0055: the Bada Bhai chat's free-chat brain redacts the
 * worker's own name from its classify, reply and news inputs, exactly as the profiling chat does).
 *
 * READS ONE COLUMN. `findFullNameToken` projects `full_name` alone — never the phone, its hash or
 * any other column — so nothing but the token this needs enters the process.
 *
 * NOT A WAY TO SHOW A NAME. A caller hands the sources to the free-chat model calls, whose only use
 * of the plaintext is `redactKnownName`; nothing returned from here is put on a wire, an event, a
 * log line or a store.
 */
@Injectable()
export class WorkerNameReader {
  private readonly logger = new Logger(WorkerNameReader.name);

  constructor(
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
  ) {}

  /** The two views for one worker, one request — read lazily, at most once. */
  sourcesFor(workerId: string): WorkerNameSources {
    return workerNameSources(workerId, {
      readToken: () => this.workers.findFullNameToken(workerId),
      pii: this.pii,
      logger: this.logger,
    });
  }
}
