import type { PiiCryptoService } from "./pii-crypto.service";

/**
 * What one read of a worker's own name found: the name, nothing on file (`name: null`), or a stored
 * token that would not decrypt (`ok: false` — a malformed, rotated-key or tampered value).
 * ADR-0054, security M1: the two failure kinds stay distinct, because live news fails CLOSED on an
 * undecryptable name while the vocative and the R32 redaction read it as "no name".
 */
export type WorkerNameRead =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false };

/**
 * ONE decision for turning a stored `workers.full_name` token into a {@link WorkerNameRead}, shared
 * by every reader of the worker's own name — `ChatService.readWorkerName` and the free-chat probe
 * (ADR-0051 §10) — so the two cannot drift on what "no name" and "unreadable" mean.
 *
 * `full_name` is encrypted at rest (TD21). The plaintext is returned, never logged: a caller that
 * logs the failure logs the opaque worker id only, never the token or the value. Pure; no IO — the
 * caller decides how the token is read.
 */
export function decryptWorkerName(
  token: string | null | undefined,
  pii: Pick<PiiCryptoService, "decrypt">,
): WorkerNameRead {
  if (!token) return { ok: true, name: null };
  try {
    return { ok: true, name: pii.decrypt(token) };
  } catch {
    return { ok: false };
  }
}
