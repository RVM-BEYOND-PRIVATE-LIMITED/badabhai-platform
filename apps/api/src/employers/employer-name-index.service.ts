import { Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EmployerNameRepository } from "./employer-name.repository";

/**
 * THE PLATFORM'S OWN EMPLOYER-NAME INDEX (TD147(1), WP7) — a cached, in-memory set of the
 * company/payer and worker-employment names the API already stores, so a career answer cannot
 * name an employer the platform itself knows.
 *
 * WHY IT LIVES OUTSIDE `chat-companion/`. The companion is a leaf whose egress boot test forbids
 * any file under it from importing `pii-crypto` (ADR-0044: the companion must never decrypt
 * worker PII). Decrypting an employer name is exactly that, so the DECRYPTION is here, in its own
 * module, and the companion injects the exported index. The companion still never touches a
 * worker name or phone: this module reads only employer/payer ORG names.
 *
 * WHAT IT EXPOSES: `isKnownEmployer(text)` — true/false from the index, or null when it has
 * never loaded. The matching, TTL and fail-soft behaviour are below; nothing here logs a name.
 *
 * WHY IT EXISTS. `looksLikeOrgName` is a suffix heuristic: it refuses "Tata Motors Ltd" but not
 * "apply at Tata Motors or Maruti" — no suffix, no match. The model usually refuses by itself
 * (O10), but the deterministic backstop should not depend on the model's mood. The index is that
 * backstop: a name the platform holds is refused whatever its shape.
 *
 * PURE MATCHING, ONE SHAPE. `normaliseEmployerName` (exported for tests) NFKC-folds, lowercases
 * and tokenises on non-alphanumerics, then strips the trailing legal suffixes; the SAME
 * normalisation runs over the answer. A match is either:
 *   - a multi-word name's full contiguous token phrase, or
 *   - a single distinctive token (a one-word name, or any non-generic token of a longer name).
 * GENERIC_TOKENS keeps industry words ("steel", "motors", "industries") from matching alone —
 * the measured false positives the task names. "Tata Motors" matches; "steel" alone does not.
 *
 * IN MEMORY, 15-MINUTE TTL, FAIL CLOSED. The snapshot is rebuilt at most every
 * `EMPLOYER_INDEX_TTL_MS`; concurrent refreshes share one load. If a refresh fails, the last
 * good snapshot (if any) keeps serving and a counts-only warning is logged; if there has never
 * been one, `isKnownEmployer` answers `null` — "unknown" — and the caller falls back to the
 * heuristic, recording that it did. Nothing here logs a name, raw or normalised.
 */
export const EMPLOYER_INDEX_TTL_MS = 15 * 60_000;

/** Tokens too common to identify a company on their own — the false-positive stoplist. */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "steel",
  "steels",
  "motors",
  "motor",
  "auto",
  "autos",
  "automobile",
  "automobiles",
  "industries",
  "industrial",
  "engineering",
  "engineers",
  "engineer",
  "works",
  "work",
  "power",
  "services",
  "service",
  "solutions",
  "technology",
  "technologies",
  "foods",
  "food",
  "textiles",
  "textile",
  "construction",
  "builders",
  "group",
  "india",
  "indian",
  "international",
  "exports",
  "export",
  "trading",
  "traders",
  "company",
  "enterprise",
  "enterprises",
  "general",
  "national",
]);

/** Legal suffixes stripped from the END of a name (repeatedly), never from the middle. */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "ltd",
  "limited",
  "pvt",
  "private",
  "llp",
  "llc",
  "inc",
  "corp",
  "corporation",
  "co",
  "company",
]);

/** One loaded index: the names as token phrases and their distinctive tokens. */
export interface EmployerSnapshot {
  readonly phrases: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
  readonly loadedAt: number;
  /** Names whose stored token could not be decrypted this refresh (counts only). */
  readonly decryptFailures: number;
}

/**
 * Normalise one name to its tokens: NFKC, lowercase, split on anything that is not a letter or
 * digit, then drop trailing legal suffixes. Exported so the tests pin the exact form the matcher
 * and the loader both use.
 */
export function normaliseEmployerName(raw: string): string[] {
  const tokens = raw
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens;
}

/** The deterministic snapshot builder. Pure, so the service tests exercise it directly. */
export function buildEmployerSnapshot(names: readonly string[], loadedAt: number): EmployerSnapshot {
  const phrases = new Set<string>();
  const tokens = new Set<string>();
  for (const name of names) {
    const parts = normaliseEmployerName(name);
    if (parts.length === 0) continue;
    if (parts.length > 1) phrases.add(parts.join(" "));
    for (const token of parts) {
      if (!GENERIC_TOKENS.has(token)) tokens.add(token);
    }
  }
  return { phrases, tokens, loadedAt, decryptFailures: 0 };
}

/** Whether a loaded snapshot finds one of its names in the answer text. */
export function snapshotMatches(snapshot: EmployerSnapshot, text: string): boolean {
  const parts = normaliseEmployerName(text);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (snapshot.tokens.has(part)) return true;
  }
  if (snapshot.phrases.size === 0) return false;
  const haystack = ` ${parts.join(" ")} `;
  for (const phrase of snapshot.phrases) {
    if (haystack.includes(` ${phrase} `)) return true;
  }
  return false;
}

@Injectable()
export class EmployerNameIndex {
  private readonly logger = new Logger(EmployerNameIndex.name);
  private snapshot: EmployerSnapshot | null = null;
  private loading: Promise<EmployerSnapshot | null> | null = null;

  constructor(
    private readonly repo: EmployerNameRepository,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * Whether the answer names an employer the platform holds: `true`/`false` from the index, or
   * `null` when it has never loaded — the caller keeps the heuristic and records the fallback.
   */
  async isKnownEmployer(text: string): Promise<boolean | null> {
    const snapshot = await this.snapshotOrLoad(Date.now());
    if (snapshot === null) return null;
    return snapshotMatches(snapshot, text);
  }

  /** Test seam: the TTL clock. */
  async snapshotOrLoad(now: number): Promise<EmployerSnapshot | null> {
    const current = this.snapshot;
    if (current !== null && now - current.loadedAt < EMPLOYER_INDEX_TTL_MS) return current;
    if (this.loading !== null) return this.loading;
    this.loading = this.load(now).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(now: number): Promise<EmployerSnapshot | null> {
    try {
      const [payerTokens, employerTokens] = await Promise.all([
        this.repo.listPayerOrgNameTokens(),
        this.repo.listEmployerNameTokens(),
      ]);
      const names: string[] = [];
      let decryptFailures = 0;
      for (const token of [...payerTokens, ...employerTokens]) {
        try {
          names.push(this.pii.decrypt(token));
        } catch {
          // One unreadable row must not cost the whole index; the count is logged, the name not.
          decryptFailures += 1;
        }
      }
      const snapshot = { ...buildEmployerSnapshot(names, now), decryptFailures };
      if (decryptFailures > 0) {
        this.logger.warn(
          `employer name index refreshed with ${decryptFailures} unreadable name token(s) skipped`,
        );
      }
      this.snapshot = snapshot;
      return snapshot;
    } catch (err) {
      // Fail closed: keep the last good snapshot if there is one; otherwise "unknown".
      this.logger.warn(
        `employer name index unavailable; career employer checks fall back to the heuristic (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return this.snapshot;
    }
  }
}
