import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../config/config.module";
import {
  codePointCount,
  foldAwayMarks,
  foldName,
  nameWordParts,
} from "../../common/name-fold";

/**
 * Whole-word name tokens for the candidate read table (B4, #2557 —
 * ADR-0062 §3.6). HMAC-SHA256 of each word under a key from the DEDICATED
 * `ADMIN_NAME_TOKEN_KEYS` keyring — never `PII_HASH_PEPPER`, never another
 * secret, no fallback.
 *
 * Token shape (canonical, documented so the later Candidates search service
 * reproduces it byte-for-byte): `foldName` the stored name → split on
 * whitespace → `nameWordParts` each word → `foldAwayMarks` + lowercase each
 * part → drop parts under 2 code points → HMAC-SHA256 hex → de-duplicated,
 * stored in HASH order (not name order, so the array leaks no name shape).
 *
 * UNAVAILABLE (fail closed) when the keyring or the active kid is unset or
 * malformed: the projector stores empty token sets with a NULL key id, and
 * name search stays off. A row's tokens are always computed atomically under
 * ONE key — key ids never mix in a row.
 *
 * ONLY this service and the later Candidates search service may compute a
 * token — `name-token-static.test.ts` enforces that by scanning the repo.
 */
export interface NameTokenKeyring {
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKid: string;
}

/** Parse + validate the keyring env. `null` = name search unavailable (fail closed). */
export function parseNameTokenKeyring(
  keysRaw: string,
  activeKidRaw: string,
): NameTokenKeyring | null {
  const kid = activeKidRaw.trim();
  const raw = keysRaw.trim();
  if (raw === "" || kid === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = new Map<string, Buffer>();
  for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== "string" || !/^[0-9a-fA-F]{64}$/.test(key)) return null;
    keys.set(id, Buffer.from(key, "hex"));
  }
  if (!keys.has(kid)) return null;
  return { keys, activeKid: kid };
}

/**
 * WHICH kind of name a token belongs to (#2564). Under one key the same word must NOT produce the
 * same token for a worker and a company, or the two token sets would be joinable ("which
 * candidates share a word with this company's name"). `worker` is the ORIGINAL, UNPREFIXED input
 * — every token already stored in `admin_candidate_index` was computed that way, so it must stay
 * byte-identical. Every other domain prefixes the folded word with `<domain>:` before the HMAC.
 */
export type NameTokenDomain = "worker" | "company";

/**
 * The canonical word tokens of a stored name under one keyring key. Pure —
 * the projector calls it with the decrypted name IN MEMORY ONLY (named decrypt
 * site: the plaintext never leaves this call, is never returned, never logged).
 */
export function computeNameTokens(
  name: string,
  key: Buffer,
  domain: NameTokenDomain = "worker",
): string[] {
  const words = foldName(name).split(/\s+/).filter((w) => w.length > 0);
  const tokens = new Set<string>();
  for (const word of words) {
    for (const { part } of nameWordParts(word)) {
      const folded = foldAwayMarks(part).toLowerCase();
      if (codePointCount(folded) < 2) continue;
      const input = domain === "worker" ? folded : `${domain}:${folded}`;
      tokens.add(createHmac("sha256", key).update(input, "utf8").digest("hex"));
    }
  }
  return [...tokens].sort();
}

/**
 * A search query's tokens under every key in the ring (ADR-0062 §3.6 rotation: hash under each
 * key, accept a row stored under either). `unavailable` = the keyring is unset or malformed —
 * name search is OFF and the caller must say so rather than return a silently empty result.
 */
export type NameQueryTokens =
  | { readonly available: false }
  | {
      readonly available: true;
      /** Per key id; `hashes` is EMPTY when the query holds no word of 2+ letters. */
      readonly perKey: ReadonlyArray<{ readonly kid: string; readonly hashes: string[] }>;
    };

@Injectable()
export class NameTokenService {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  /** The active keyring, or `null` when name search is unavailable (fail closed). */
  keyring(): NameTokenKeyring | null {
    return parseNameTokenKeyring(
      this.config.ADMIN_NAME_TOKEN_KEYS,
      this.config.ADMIN_NAME_TOKEN_ACTIVE_KID,
    );
  }

  /**
   * Tokenise a decrypted name, or `{ hashes: [], kid: null }` when the keyring
   * is unavailable. The name plaintext is an argument only — never stored,
   * logged or returned.
   */
  tokenise(
    name: string | null,
    domain: NameTokenDomain = "worker",
  ): { hashes: string[]; kid: string | null } {
    const ring = this.keyring();
    if (ring === null || name === null || name.trim() === "") {
      return { hashes: [], kid: null };
    }
    const key = ring.keys.get(ring.activeKid);
    if (!key) return { hashes: [], kid: null };
    return { hashes: computeNameTokens(name, key, domain), kid: ring.activeKid };
  }

  /**
   * #2564 — tokenise a SEARCH QUERY under every key in the ring, for whole-word exact matching
   * (`stored_tokens @> query_tokens` for the row's own key id). The query text is an argument
   * only — never stored, logged or returned.
   */
  queryTokens(query: string, domain: NameTokenDomain): NameQueryTokens {
    const ring = this.keyring();
    if (ring === null) return { available: false };
    const perKey = [...ring.keys.entries()].map(([kid, key]) => ({
      kid,
      hashes: computeNameTokens(query, key, domain),
    }));
    return { available: true, perKey };
  }
}
