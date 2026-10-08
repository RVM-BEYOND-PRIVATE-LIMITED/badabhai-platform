/**
 * THE "READ MORE" TILES OF A LIVE-NEWS ANSWER (ADR-0054 §3.3, §8) — PURE.
 *
 * A news answer's sources come from the web search, not from the model's pen, but they still
 * arrive over the wire from a service that read the open web: UNTRUSTED. A tile is served only when
 * every check below passes, and a source that fails one is dropped:
 *
 *   - THE URL. The raw string carries no whitespace, control character or backslash, starts with
 *     `https://`, and its raw authority is plain `[A-Za-z0-9.-]` (no `%`, `;`, `@` credentials or
 *     `:` port). The WHATWG parser then agrees: `https:`, no credentials, no port, a host of plain
 *     `[a-z0-9-]` labels — an IDN look-alike is punycoded (`xn--…`) and so never equals a listed
 *     domain. The normalised form is at most {@link FREE_CHAT_NEWS_URL_MAX} characters, and its
 *     query string carries no open-redirect key ({@link OPEN_REDIRECT_KEYS}, and `q` / `r` when
 *     their value is a URL or a host).
 *   - THE HOST IS a domain on the owner-approved list (`FREE_CHAT_NEWS_DOMAINS`) or a subdomain of
 *     one, matched on a LABEL BOUNDARY — `x.indiatimes.com` passes, `evilindiatimes.com` and
 *     `indiatimes.com.evil.net` do not.
 *   - THE TITLE is third-party text a worker reads. Once control and format characters are removed
 *     and whitespace is collapsed it is non-empty, at most {@link FREE_CHAT_NEWS_TITLE_MAX}
 *     characters, and passes the content walls a headline must (ADR-0054 §8): no hard identifier
 *     (ADR-0047 G1), nothing the abuse lexicon flags, no job promise (the career gate's wall and its
 *     regional twin), no `{{`/`}}` template token. NOT the sensitive, rating or Latin-only walls: a
 *     real headline about loan rates, or one in Tamil, is legitimate. A check that throws drops the
 *     tile — fail closed.
 *
 * `site` is NEVER taken from the input: it is re-derived from the URL's host, minus `www.`. The
 * served `url` is the parsed URL's normalised `href`, so what the app opens is exactly what was
 * checked.
 *
 * NO IMPORT FROM `conversation-state.ts` — that module imports this one to re-validate the tiles a
 * replay stamp carries.
 */

import { isAbusive } from "@badabhai/profiling-lexicon";
import { FREE_CHAT_NEWS_DOMAINS } from "@badabhai/types";

import { statesJobPromise } from "../../chat-companion/v2/career-output.validator";
import { containsHardIdentifier } from "../resume-import/resume-parse-gates";
import { regionalPromise } from "./free-chat-regional-walls";

/** At most three tiles per answer (the contract's `sources` bound, ADR-0054 R6). */
export const FREE_CHAT_NEWS_LINKS_MAX = 3;
/** The longest URL a tile may carry, normalised. */
export const FREE_CHAT_NEWS_URL_MAX = 500;
/** The longest title a tile shows; a longer one is clipped, never rejected. */
export const FREE_CHAT_NEWS_TITLE_MAX = 200;

/**
 * Query keys that hand a link on to somewhere else — an article URL never needs one, and a listed
 * site's open redirect would turn an approved host into a hop to any host. Compared lower-cased,
 * after the parser has percent-decoded the key. Any value refuses the tile.
 */
export const OPEN_REDIRECT_KEYS: ReadonlySet<string> = new Set([
  "url",
  "redirect",
  "redirect_uri",
  "redirect_url",
  "redirect_to",
  "redir",
  "next",
  "goto",
  "dest",
  "destination",
  "out",
  "u",
  "link",
  "target",
  "to",
  "return",
  "returnurl",
  "return_url",
  "continue",
]);

/**
 * Keys that are ordinary on a news site (`?q=welder` is a search, `?r=2` a page) and a redirect only
 * when their value is a link: refused only when {@link looksLikeRedirectTarget} says so.
 */
export const VALUE_CHECKED_REDIRECT_KEYS: ReadonlySet<string> = new Set(["q", "r"]);

/** A scheme, a scheme-relative `//`, or a dot followed by a TLD-ish token (`evil.net`, `x.ru/a`). */
const REDIRECT_TARGET = /^\s*(?:https?:|\/\/)|\.[a-z]{2,}(?:[/:?#]|\s|$)/i;

/** Does a query value point somewhere — a URL or a host? */
export function looksLikeRedirectTarget(value: string): boolean {
  return REDIRECT_TARGET.test(value);
}

/** One "read more" tile: the article's title, its link, and the site it is on. */
export interface FreeChatNewsLink {
  readonly title: string;
  readonly url: string;
  readonly site: string;
}

/** One tile as the chat wire and a flushed row's metadata carry it — the same three fields. */
export interface FreeChatNewsLinkWire {
  title: string;
  url: string;
  site: string;
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
/** Anything a raw URL must not carry anywhere: whitespace, a control or format character, `\`. */
const RAW_URL_FORBIDDEN = /[\s\p{Cc}\p{Cf}\\]/u;
/** The raw scheme and authority: `https://` then plain host characters up to the path. */
const RAW_HTTPS_AUTHORITY = /^https:\/\/[A-Za-z0-9.-]+(?:[/?#]|$)/i;
/** A parsed host: plain lower-case labels on dot boundaries. */
const PLAIN_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const TEMPLATE_TOKEN = /\{\{|\}\}/;

/**
 * Is `host` a listed news domain, or a subdomain of one? Exact on a LABEL BOUNDARY: the host must
 * equal the domain, or end with `"." + domain`. A trailing-dot host (`thehindu.com.`) is neither,
 * and is refused — fail closed.
 */
export function isListedNewsHost(host: string): boolean {
  const lower = host.toLowerCase();
  return FREE_CHAT_NEWS_DOMAINS.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/** Does the query string carry a key that forwards the reader elsewhere? */
function carriesRedirectKey(url: URL): boolean {
  for (const [rawKey, value] of url.searchParams) {
    const key = rawKey.toLowerCase();
    if (OPEN_REDIRECT_KEYS.has(key)) return true;
    if (VALUE_CHECKED_REDIRECT_KEYS.has(key) && looksLikeRedirectTarget(value)) return true;
  }
  return false;
}

/** The checked, normalised URL — or null when any URL check fails. */
function checkedUrl(raw: string): URL | null {
  if (raw.length > FREE_CHAT_NEWS_URL_MAX) return null;
  if (RAW_URL_FORBIDDEN.test(raw) || !RAW_HTTPS_AUTHORITY.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (!PLAIN_HOST.test(url.hostname)) return null;
  if (url.href.length > FREE_CHAT_NEWS_URL_MAX) return null;
  if (carriesRedirectKey(url)) return null;
  return isListedNewsHost(url.hostname) ? url : null;
}

/**
 * A headline as a tile shows it: control characters read as spaces, format characters removed,
 * whitespace collapsed, clipped to {@link FREE_CHAT_NEWS_TITLE_MAX} without splitting a surrogate
 * pair — or null when nothing is left or it fails a content wall (see the module header).
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
  return failsTitleWall(clipped) ? null : clipped;
}

/** Any Unicode decimal digit (`Nd`): ASCII, Devanagari, Gujarati, Tamil, Telugu, Kannada, … */
const DECIMAL_DIGIT = /\p{Nd}/u;
const DECIMAL_DIGITS = /\p{Nd}/gu;

/**
 * Every Unicode decimal digit (`\p{Nd}`) as its ASCII twin: "९८७६" → "9876", "௧௨" → "12".
 *
 * HOW A DIGIT'S VALUE IS READ. Unicode encodes every `Nd` set as a CONTIGUOUS run 0…9 in ascending
 * order (a stability guarantee), and where sets sit back to back (the mathematical digits) the run
 * is a multiple of ten that starts on a zero. So a digit's value is its distance from the start of
 * its contiguous `Nd` run, modulo ten. The walk back is at most a few dozen code points.
 */
export function foldDecimalDigits(text: string): string {
  return text.replace(DECIMAL_DIGITS, (digit) => {
    const cp = digit.codePointAt(0) ?? 0;
    if (cp >= 0x30 && cp <= 0x39) return digit;
    let start = cp;
    while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((cp - start) % 10);
  });
}

/** The content walls a headline meets. Any check that throws counts as a hit — fail closed. */
function failsTitleWall(title: string): boolean {
  try {
    return (
      containsHardIdentifier(title) !== null ||
      // A phone in Devanagari / Gujarati / Tamil / … digits: the G1 scanner reads ASCII digits.
      containsHardIdentifier(foldDecimalDigits(title)) !== null ||
      TEMPLATE_TOKEN.test(title) ||
      isAbusive(title) ||
      statesJobPromise(title) ||
      regionalPromise(title)
    );
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

/**
 * `{ newsLinks }` when a stored value still holds a valid tile, else `{}` — the ONE spread every
 * reader of a stored copy uses (the replay stamp, the buffered line), so the field is ABSENT, never
 * empty, wherever nothing survives.
 */
export function newsLinksField(value: unknown): { newsLinks?: FreeChatNewsLink[] } {
  const links = narrowNewsLinks(value);
  return links === null ? {} : { newsLinks: links };
}

/**
 * Tiles as the wire and a flushed row's metadata carry them — mapped FIELD BY FIELD, so an internal
 * field added to a tile can never leak onto either. The one mapper both use.
 */
export function toWireNewsLinks(links: readonly FreeChatNewsLink[]): FreeChatNewsLinkWire[] {
  return links.map((link) => ({ title: link.title, url: link.url, site: link.site }));
}
