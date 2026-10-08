import { describe, expect, it } from "vitest";
import { FREE_CHAT_NEWS_DOMAINS } from "@badabhai/types";

import {
  cleanNewsTitle,
  FREE_CHAT_NEWS_TITLE_MAX,
  FREE_CHAT_NEWS_URL_MAX,
  isListedNewsHost,
  narrowNewsLinks,
  newsLinkOf,
  newsLinksOf,
} from "./free-chat-news-links";

/**
 * ADR-0054 §3.3 — the "read more" tiles. A source is untrusted input from the open web: only an
 * `https:` link on an owner-approved site (or its subdomain, on a label boundary), with a clean,
 * bounded, identifier-free title, becomes a tile.
 */

const source = (url: string, title = "Naya kaarkhana Pune mein") => ({ url, title });

describe("the host check — the listed domain or a subdomain, on a LABEL boundary", () => {
  it("accepts every listed domain itself and a subdomain of one", () => {
    for (const domain of FREE_CHAT_NEWS_DOMAINS) expect(isListedNewsHost(domain)).toBe(true);
    expect(isListedNewsHost("timesofindia.indiatimes.com")).toBe(true);
    expect(isListedNewsHost("x.indiatimes.com")).toBe(true);
    expect(isListedNewsHost("a.b.thehindu.com")).toBe(true);
  });

  it("refuses a look-alike that only CONTAINS a listed domain", () => {
    expect(isListedNewsHost("evilindiatimes.com")).toBe(false);
    expect(isListedNewsHost("indiatimes.com.evil.net")).toBe(false);
    expect(isListedNewsHost("thehindu.co")).toBe(false);
    expect(isListedNewsHost("thehindu.com.")).toBe(false);
    expect(isListedNewsHost("example.com")).toBe(false);
  });
});

describe("one source → one tile", () => {
  it("serves the normalised URL, the cleaned title and the site re-derived from the host", () => {
    expect(
      newsLinkOf({
        url: "https://WWW.TheHindu.com/news/a?x=1#top",
        title: "  Factory   opens\nin Pune  ",
      }),
    ).toEqual({
      title: "Factory opens in Pune",
      url: "https://www.thehindu.com/news/a?x=1#top",
      site: "thehindu.com",
    });
  });

  it("IGNORES the source's own `site` — the host decides it", () => {
    const link = newsLinkOf({
      url: "https://economictimes.indiatimes.com/a",
      title: "Wages",
      site: "trusted-news.example",
    } as never);
    expect(link?.site).toBe("economictimes.indiatimes.com");
  });

  it("refuses anything but https", () => {
    for (const url of [
      "http://www.thehindu.com/a",
      "ftp://thehindu.com/a",
      "javascript:alert(1)",
      "data:text/html,hi",
      "//thehindu.com/a",
      "thehindu.com/a",
      "not a url",
    ]) {
      expect(newsLinkOf(source(url)), url).toBeNull();
    }
  });

  it("refuses an unlisted or look-alike host", () => {
    for (const url of [
      "https://evilindiatimes.com/a",
      "https://indiatimes.com.evil.net/a",
      "https://thehindu.com.evil.net/a",
      "https://example.com/thehindu.com",
    ]) {
      expect(newsLinkOf(source(url)), url).toBeNull();
    }
  });

  it("refuses credentials and an explicit port", () => {
    expect(newsLinkOf(source("https://user:pw@www.thehindu.com/a"))).toBeNull();
    expect(newsLinkOf(source("https://evil.net@www.thehindu.com/a"))).toBeNull();
    expect(newsLinkOf(source("https://www.thehindu.com:8443/a"))).toBeNull();
  });

  it("refuses a URL longer than 500 characters, raw or normalised", () => {
    const base = "https://www.thehindu.com/";
    expect(
      newsLinkOf(source(base + "a".repeat(FREE_CHAT_NEWS_URL_MAX - base.length))),
    ).not.toBeNull();
    expect(newsLinkOf(source(base + "a".repeat(FREE_CHAT_NEWS_URL_MAX)))).toBeNull();
    // Each inner space normalises to "%20": short raw, too long once normalised.
    expect(newsLinkOf(source(`${base}a${" ".repeat(200)}b`))).toBeNull();
  });
});

describe("strict hosts and no open redirect (ADR-0054 §8, security F)", () => {
  it("refuses an IDN LOOK-ALIKE — the parser punycodes it, and xn-- is never listed", () => {
    // "thehіndu.com" with a Cyrillic "і" (U+0456).
    const lookAlike = `https://www.theh${String.fromCodePoint(0x456)}ndu.com/news/a`;
    expect(new URL(lookAlike).hostname).toMatch(/^www\.xn--/);
    expect(newsLinkOf(source(lookAlike))).toBeNull();
    expect(newsLinkOf(source("https://www.xn--thehndu-6gg.com/a"))).toBeNull();
  });

  it("refuses a raw authority that is not plain host characters", () => {
    for (const url of [
      "https://www.thehindu%2Ecom/a",
      "https://www.thehindu.com;evil.net/a",
      "https://evil.net\\@www.thehindu.com/a",
      "https://www.thehindu.com\\evil",
      " https://www.thehindu.com/a",
      "https://www.thehindu.com/a b",
      "https://www.thehindu.com/a\n",
      `https://www.thehindu.com/${String.fromCodePoint(0x200b)}a`,
      "HTTPS://evil.net/a",
    ]) {
      expect(newsLinkOf(source(url)), JSON.stringify(url)).toBeNull();
    }
    // An upper-case scheme and host are the same URL, normalised.
    expect(newsLinkOf(source("HTTPS://WWW.THEHINDU.COM/a"))?.url).toBe(
      "https://www.thehindu.com/a",
    );
  });

  it.each([
    "url",
    "redirect",
    "redirect_uri",
    "redirect_url",
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
    "redir",
    "redirect_to",
  ])("refuses a query carrying the open-redirect key %j", (key) => {
    expect(newsLinkOf(source(`https://www.thehindu.com/r?${key}=https://evil.net`))).toBeNull();
    // Case-insensitive, and after the parser percent-decodes the key.
    expect(newsLinkOf(source(`https://www.thehindu.com/r?id=1&${key.toUpperCase()}=x`))).toBeNull();
  });

  it.each(["q", "r", "Q"])("refuses %j only when its value is a URL or a host", (key) => {
    for (const value of [
      "https://evil.net/a",
      "http://evil.net",
      "//evil.net/a",
      "evil.net",
      "x.ru/a",
    ]) {
      expect(
        newsLinkOf(source(`https://www.thehindu.com/search?${key}=${encodeURIComponent(value)}`)),
        `${key}=${value}`,
      ).toBeNull();
    }
    for (const value of ["welder", "ITI admission 2026", "3.5 lakh", "2"]) {
      expect(
        newsLinkOf(source(`https://www.thehindu.com/search?${key}=${encodeURIComponent(value)}`)),
        `${key}=${value}`,
      ).not.toBeNull();
    }
  });

  it("refuses a percent-encoded redirect key, and keeps an ordinary query", () => {
    expect(newsLinkOf(source("https://www.thehindu.com/r?%75rl=https://evil.net"))).toBeNull();
    expect(newsLinkOf(source("https://www.thehindu.com/a?ref=home&page=2"))).not.toBeNull();
  });
});

describe("the title — cleaned, bounded, and no hard identifier (G1)", () => {
  it("removes control and format characters and collapses whitespace", () => {
    expect(cleanNewsTitle("Pune\u0000 factory\u202e opens\u200b\ttoday")).toBe(
      "Pune factory opens today",
    );
  });

  it("clips to 200 characters without splitting a surrogate pair", () => {
    expect(cleanNewsTitle("a".repeat(250))).toHaveLength(FREE_CHAT_NEWS_TITLE_MAX);
    const clipped = cleanNewsTitle(`${"a".repeat(FREE_CHAT_NEWS_TITLE_MAX - 1)}\u{1F600}tail`)!;
    expect(clipped).toBe("a".repeat(FREE_CHAT_NEWS_TITLE_MAX - 1));
  });

  it("is null when nothing is left", () => {
    expect(cleanNewsTitle(" \u200b\u0007 ")).toBeNull();
    expect(newsLinkOf(source("https://www.thehindu.com/a", "\u202e"))).toBeNull();
  });

  it("drops a title carrying a phone number, an email or an Aadhaar-shaped run", () => {
    for (const title of [
      "Helpline 98765 43210 par call karein",
      "Mail jobs@factory.in for openings",
      "Card 2345 6789 0123 found",
    ]) {
      expect(newsLinkOf(source("https://www.thehindu.com/a", title)), title).toBeNull();
    }
  });

  it("drops a title the content walls fail: abuse, a job promise (Hinglish or regional), a template token", () => {
    for (const title of [
      "Chutiya log pakde gaye",
      "Sabko naukri pakki milegi",
      "100% job guarantee scheme",
      "Kaam zaroor milegi, abhi apply karein",
      "Velai pakku kidaikkum",
      "Offer {{worker_name}} ke liye",
    ]) {
      expect(newsLinkOf(source("https://www.thehindu.com/a", title)), title).toBeNull();
    }
  });

  it("does NOT apply the sensitive, rating or Latin-only walls — real headlines pass", () => {
    for (const title of [
      "RBI keeps home loan rates unchanged",
      "Court orders minimum wage revision",
      "Top 10 ITI ranking released",
      "சென்னையில் புதிய தொழிற்சாலை",
    ]) {
      expect(newsLinkOf(source("https://www.thehindu.com/a", title))?.title, title).toBe(title);
    }
  });

  it("keeps a Devanagari headline from a Hindi site", () => {
    expect(newsLinkOf(source("https://www.bhaskar.com/a", "पुणे में नई फैक्ट्री"))?.title).toBe(
      "पुणे में नई फैक्ट्री",
    );
  });
});

describe("the tile list", () => {
  it("keeps sources in order, drops failures and duplicates, and stops at three", () => {
    const links = newsLinksOf([
      source("https://www.thehindu.com/a", "One"),
      source("http://www.thehindu.com/b", "Insecure"),
      source("https://www.thehindu.com/a", "One again"),
      source("https://www.livemint.com/c", "Two"),
      source("https://www.ndtv.com/d", "Three"),
      source("https://www.bbc.com/e", "Four"),
    ]);
    expect(links.map((l) => l.title)).toEqual(["One", "Two", "Three"]);
  });

  it("is empty when nothing survives", () => {
    expect(newsLinksOf([source("https://evil.example/a")])).toEqual([]);
  });

  it("re-checks a stored copy: a tampered entry is dropped, nothing left is null", () => {
    expect(narrowNewsLinks(undefined)).toBeNull();
    expect(narrowNewsLinks("x")).toBeNull();
    expect(
      narrowNewsLinks([{ url: "https://evil.example/a", title: "x", site: "thehindu.com" }]),
    ).toBeNull();
    expect(
      narrowNewsLinks([
        { url: "https://www.thehindu.com/a", title: "Kept", site: "evil.example" },
        { url: 42, title: "x" },
        null,
      ]),
    ).toEqual([{ url: "https://www.thehindu.com/a", title: "Kept", site: "thehindu.com" }]);
  });
});
