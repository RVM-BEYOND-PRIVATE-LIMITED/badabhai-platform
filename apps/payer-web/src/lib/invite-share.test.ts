import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browsingOrigin,
  inviteShareMessage,
  qrDownloadFileName,
  shareableInviteOrigin,
  shareableInviteUrl,
  toAbsoluteInviteUrl,
  whatsAppShareUrl,
} from "./invite-share";

/**
 * INVITE SHARING — the absolutisation is the load-bearing property.
 *
 * `POST /payer/agency/invites` returns a RELATIVE `link: "/i/<code>"`. The dashboard panels
 * copied that path verbatim, so an agent who pressed "Copy link" and pasted into WhatsApp
 * sent `/i/abc123` — which resolves to nothing anywhere except a tab already sitting on the
 * portal. The QR sheet had been absolutising all along; the two panels had not. These tests
 * pin the shared helper all three now use.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toAbsoluteInviteUrl", () => {
  it("turns the relative mint link into an absolute url", () => {
    expect(toAbsoluteInviteUrl("https://app.badabhai.in", "/i/abc123")).toBe(
      "https://app.badabhai.in/i/abc123",
    );
  });

  it("does not double the slash when the origin has a trailing one", () => {
    expect(toAbsoluteInviteUrl("https://app.badabhai.in/", "/i/abc")).toBe(
      "https://app.badabhai.in/i/abc",
    );
    expect(toAbsoluteInviteUrl("https://app.badabhai.in/", "i/abc")).toBe(
      "https://app.badabhai.in/i/abc",
    );
  });

  it("leaves an already-absolute link alone", () => {
    expect(toAbsoluteInviteUrl("https://app.badabhai.in", "https://other.example/i/abc")).toBe(
      "https://other.example/i/abc",
    );
  });
});

describe("shareableInviteOrigin — a shared link outlives the tab that made it", () => {
  const PREVIEW = "https://payer-web-git-preview.vercel.app";

  it("prefers the configured canonical host over the browsing origin", () => {
    expect(shareableInviteOrigin("https://app.badabhai.in", PREVIEW)).toBe(
      "https://app.badabhai.in",
    );
  });

  it("keeps only the ORIGIN — a path/query/fragment never reaches a shared link", () => {
    expect(shareableInviteOrigin("https://app.badabhai.in/portal?x=1#f", PREVIEW)).toBe(
      "https://app.badabhai.in",
    );
  });

  for (const configured of [undefined, "", "   ", "not-a-url", "javascript:alert(1)"]) {
    it(`falls back to the browsing origin for ${JSON.stringify(configured)}`, () => {
      expect(shareableInviteOrigin(configured, PREVIEW)).toBe(PREVIEW);
    });
  }
});

describe("shareableInviteUrl — the call every share surface makes", () => {
  it("absolutises against the configured site url", () => {
    // THE REGRESSION PIN. Before the fix this value was the raw "/i/abc123": copied to the
    // clipboard, shown on screen, and pasted into WhatsApp as a dead path.
    expect(shareableInviteUrl("/i/abc123", "https://app.badabhai.in")).toBe(
      "https://app.badabhai.in/i/abc123",
    );
  });

  it("absolutises against the BROWSING origin when nothing is configured", () => {
    vi.stubGlobal("window", { location: { origin: "https://portal.example" } });
    expect(shareableInviteUrl("/i/abc123", undefined)).toBe("https://portal.example/i/abc123");
  });

  it("returns '' when no origin can be established, so callers can degrade honestly", () => {
    // Server-rendered with nothing configured: better to show the raw link than to render
    // a confidently broken absolute url.
    expect(shareableInviteUrl("/i/abc123", undefined)).toBe("");
  });
});

describe("browsingOrigin", () => {
  it("is '' with no window (SSR)", () => {
    expect(browsingOrigin()).toBe("");
  });

  it("is the window origin in a browser", () => {
    vi.stubGlobal("window", { location: { origin: "https://portal.example" } });
    expect(browsingOrigin()).toBe("https://portal.example");
  });
});

describe("whatsAppShareUrl", () => {
  it("is the CONTACT-PICKER form — no phone number in the path", () => {
    const url = new URL(whatsAppShareUrl("hello"));
    expect(url.host).toBe("wa.me");
    // A number here would open a chat with THAT number instead of letting the agent choose
    // who to invite — and we have no worker's number to put there in the first place.
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("text")).toBe("hello");
  });

  it("percent-encodes so the whole message survives the query string", () => {
    const raw = "a&b#c?d https://app.badabhai.in/i/abc";
    const url = new URL(whatsAppShareUrl(raw));
    // An unencoded `&` would truncate the message at the first ampersand.
    expect(url.searchParams.get("text")).toBe(raw);
    expect(whatsAppShareUrl(raw)).toContain("%26");
  });

  it("does not mangle Devanagari", () => {
    const raw = "नौकरी https://app.badabhai.in/i/abc";
    expect(new URL(whatsAppShareUrl(raw)).searchParams.get("text")).toBe(raw);
  });

  it("carries the invite url intact end to end", () => {
    const url = "https://app.badabhai.in/i/abc123";
    const text = new URL(whatsAppShareUrl(inviteShareMessage(url))).searchParams.get("text");
    expect(text).toContain(url);
  });
});

describe("inviteShareMessage", () => {
  it("includes the url and stays to one line", () => {
    const msg = inviteShareMessage("https://app.badabhai.in/i/abc");
    expect(msg).toContain("https://app.badabhai.in/i/abc");
    expect(msg).not.toContain("\n");
  });
});

describe("qrDownloadFileName", () => {
  it("names the file after the opaque code", () => {
    expect(qrDownloadFileName("abc123def456")).toBe("badabhai-invite-abc123def456.png");
  });

  it("cannot be talked into a path separator or a second extension", () => {
    // The code reaches a filesystem name, so the alphabet is constrained rather than trusted.
    expect(qrDownloadFileName("../../etc/passwd")).toBe("badabhai-invite-etcpasswd.png");
    expect(qrDownloadFileName("a.exe")).toBe("badabhai-invite-aexe.png");
  });

  it("still produces a usable name when nothing survives the filter", () => {
    expect(qrDownloadFileName("///")).toBe("badabhai-invite-code.png");
  });
});
