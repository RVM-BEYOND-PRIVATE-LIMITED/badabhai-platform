/**
 * THE "READ MORE" TILES OF A LIVE-NEWS ANSWER (ADR-0054 §3.3) — PURE.
 *
 * A news answer's sources come from the web search, not from the model's pen, but they still
 * arrive over the wire from a service that read the open web: UNTRUSTED. A tile is served only when
 * every check below passes, and a source that fails one is dropped:
 *
 *   - the URL parses, is `https:`, carries no credentials and no explicit port, and its normalised
 *     form is at most {@link FREE_CHAT_NEWS_URL_MAX} characters;
 *   - its host IS a domain on the owner-approved list (`FREE_CHAT_NEWS_DOMAINS`) or a subdomain of
 *     one, matched on a LABEL BOUNDARY — `x.indiatimes.com` passes, `evilindiatimes.com` and
 *     `indiatimes.com.evil.net` do not;
 *   - its title, once control and format characters are removed and whitespace is collapsed, is
 *     non-empty, at most {@link FREE_CHAT_NEWS_TITLE_MAX} characters, and carries no hard identifier
 *     (ADR-0047 G1, `containsHardIdentifier` — a scanner that errors drops the tile: fail closed).
 *
 * `site` is NEVER taken from the input: it is re-derived from the URL's host, minus `www.`. The
 * served `url` is the parsed URL's normalised `href`, so what the app opens is exactly what was
 * checked.
 *
 * NO IMPORT FROM `conversation-state.ts` — that module imports this one to re-validate the tiles a
 * replay stamp carries.
 */

import { FREE_CHAT_NEWS_DOMAINS } from "@badabhai/types";

import { containsHardIdentifier } from "../resume-import/resume-parse-gates";

/** At most three tiles per answer (the contract's `sources` bound, ADR-0054 R6). */
export const FREE_CHAT_NEWS_LINKS_MAX = 3;
/** The longest URL a tile may carry, normalised. */
export const FREE_CHAT_NEWS_URL_MAX = 500;
/** The longest title a tile shows; a longer one is clipped, never rejected. */
export const FREE_CHAT_NEWS_TITLE_MAX = 200;

/** One "read more" tile: the article's title, its link, and the site it is on. */
export interface FreeChatNewsLink {
  readonly title: string;
  readonly url: string;
  readonly site: string;
}

/** A source as the search reported it — `site` is ignored, see the module header. */
export interface FreeChatNewsSourceLike {
  readonly url: string;
  readonly title: string;
}

/** Control (`Cc`) characters read as a space: a newline in a headline is a word break. */
const CONTROL_CHARS = /\p{Cc}/gu;
/** Format (`Cf`) characters are removed outright: bidi overrides, zero-width joiners, soft hyphens. */
const FORMAT_CHARS = /\p{Cf}/gu;
const WHITESPACE_RUN = /\s+/g;
const LEADING_WWW = /^www\./;
/** A lone high surrogate left at the end of a clipped string. */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * Is `host` a listed news domain, or a subdomain of one? Exact on a LABEL BOUNDARY: the host must
 * equal the domain, or end with `"." + domain`. A trailing-dot host (`thehindu.com.`) is neither,
 * and is refused — fail closed.
 */
export function isListedNewsHost(host: string): boolean {
  const lower = host.toLowerCase();
  return FREE_CHAT_NEWS_DOMAINS.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/** The checked, normalised URL — or null when any URL check fails. */
function checkedUrl(raw: string): URL | null {
  if (raw.length > FREE_CHAT_NEWS_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.href.length > FREE_CHAT_NEWS_URL_MAX) return null;
  return isListedNewsHost(url.hostname) ? url : null;
}

/**
 * A headline as a tile shows it: control characters read as spaces, format characters removed,
 * whitespace collapsed, clipped to {@link FREE_CHAT_NEWS_TITLE_MAX} without splitting a surrogate
 * pair — or null when nothing is left or it carries a hard identifier (G1, fail closed).
 */
export function cleanNewsTitle(raw: string): string | null {
  const text = raw
    .replace(CONTROL_CHARS, " ")
    .replace(FORMAT_CHARS, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  const clipped =
    text.length <= FREE_CHAT_NEWS_TITLE_MAX
      ? text
      : text.slice(0, FREE_CHAT_NEWS_TITLE_MAX).replace(TRAILING_HIGH_SURROGATE, "").trim();
  if (clipped.length === 0) return null;
  return carriesHardIdentifier(clipped) ? null : clipped;
}

/** G1 over a title. A scanner that throws counts as a hit — fail closed. */
function carriesHardIdentifier(text: string): boolean {
  try {
    return containsHardIdentifier(text) !== null;
  } catch {
    return true;
  }
}

/** One source as a tile, or null when any check fails. */
export function newsLinkOf(source: FreeChatNewsSourceLike): FreeChatNewsLink | null {
  const url = checkedUrl(source.url);
  if (url === null) return null;
  const title = cleanNewsTitle(source.title);
  if (title === null) return null;
  return { title, url: url.href, site: url.hostname.replace(LEADING_WWW, "") };
}

/**
 * The tiles a news answer may serve, in the order its sources came: every source that passes, each
 * URL at most once, at most {@link FREE_CHAT_NEWS_LINKS_MAX}. Empty means the answer has no source
 * left — and an answer is never served without one.
 */
export function newsLinksOf(sources: readonly FreeChatNewsSourceLike[]): FreeChatNewsLink[] {
  const links: FreeChatNewsLink[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (links.length >= FREE_CHAT_NEWS_LINKS_MAX) break;
    const link = newsLinkOf(source);
    if (link === null || seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
  }
  return links;
}

/**
 * Tiles read back from a STORED copy — a replay stamp, a buffered line, a flushed row's metadata —
 * re-checked exactly as they were on the way out (this service wrote them, but they round-trip
 * through Redis and Postgres as JSON). Null when the value is absent, not a list, or nothing in it
 * survives, so a caller spreads the field only when there is something to show.
 */
export function narrowNewsLinks(value: unknown): FreeChatNewsLink[] | null {
  if (!Array.isArray(value)) return null;
  const sources: FreeChatNewsSourceLike[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const v = entry as Record<string, unknown>;
    if (typeof v.url === "string" && typeof v.title === "string") {
      sources.push({ url: v.url, title: v.title });
    }
  }
  const links = newsLinksOf(sources);
  return links.length > 0 ? links : null;
}
