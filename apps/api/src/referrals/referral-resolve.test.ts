import { describe, it, expect } from "vitest";
import {
  fallbackTarget,
  isLikelyBot,
  isWellFormedReferralCode,
  platformFromUserAgent,
  resolveTarget,
} from "./referral-resolve";

const BASE = "https://app.badabhai.in";
const CODE = "abcdef012345";

const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 11; RMX2185 Build/RP1A) AppleWebKit/537.36 Version/4.0 Chrome/98 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17 Mobile Safari/604.1",
  whatsapp: "WhatsApp/2.23.20.0 A",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
} as const;

describe("isWellFormedReferralCode — the 12-hex shape shared with both legacy funnels", () => {
  it("accepts exactly 12 lowercase hex", () => {
    expect(isWellFormedReferralCode(CODE)).toBe(true);
    expect(isWellFormedReferralCode("000000000000")).toBe(true);
  });

  it("rejects wrong length, uppercase, non-hex, and padding", () => {
    for (const bad of [
      "abcdef01234", // 11
      "abcdef0123456", // 13
      "ABCDEF012345", // uppercase
      "abcdefg12345", // 'g'
      " abcdef012345", // leading space
      "abcdef012345 ", // trailing space
      "",
      "../../etc/passwd",
      "abcdef012345\n",
    ]) {
      expect(isWellFormedReferralCode(bad), bad).toBe(false);
    }
  });
});

describe("platformFromUserAgent", () => {
  it("classifies Android (both Chrome and in-app WebView)", () => {
    expect(platformFromUserAgent(UA.androidChrome)).toBe("android");
    expect(platformFromUserAgent(UA.androidWebView)).toBe("android");
  });

  it("classifies desktop", () => {
    expect(platformFromUserAgent(UA.windows)).toBe("desktop");
    expect(platformFromUserAgent(UA.mac)).toBe("desktop");
  });

  it("classifies iOS as 'other' — there is no iOS app, so it must not take the app branch", () => {
    expect(platformFromUserAgent(UA.iphone)).toBe("other");
  });

  it("a missing UA is 'other', never a crash", () => {
    expect(platformFromUserAgent(undefined)).toBe("other");
    expect(platformFromUserAgent("")).toBe("other");
  });

  it("Android wins over the Linux substring it also contains", () => {
    // The Android UA literally contains "Linux". Order matters, and this pins it.
    expect(UA.androidChrome).toContain("Linux");
    expect(platformFromUserAgent(UA.androidChrome)).toBe("android");
  });
});

describe("isLikelyBot — a crawler prefetch must never become a worker's first touch", () => {
  it("flags the preview crawlers that actually matter for a WhatsApp-distributed link", () => {
    expect(isLikelyBot(UA.whatsapp)).toBe(true);
    expect(isLikelyBot(UA.facebook)).toBe(true);
    expect(isLikelyBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isLikelyBot("Slackbot-LinkExpanding 1.0")).toBe(true);
  });

  it("flags scripted clients", () => {
    expect(isLikelyBot("curl/8.4.0")).toBe(true);
    expect(isLikelyBot("python-requests/2.31.0")).toBe(true);
    expect(isLikelyBot("Go-http-client/2.0")).toBe(true);
  });

  it("treats a MISSING or blank UA as a bot (fail-safe: drop a stat, never fabricate one)", () => {
    expect(isLikelyBot(undefined)).toBe(true);
    expect(isLikelyBot("")).toBe(true);
    expect(isLikelyBot("   ")).toBe(true);
  });

  it("does NOT flag the real worker browsers this product actually serves", () => {
    expect(isLikelyBot(UA.androidChrome)).toBe(false);
    expect(isLikelyBot(UA.androidWebView)).toBe(false);
    expect(isLikelyBot(UA.windows)).toBe(false);
    expect(isLikelyBot(UA.iphone)).toBe(false);
  });
});

describe("resolveTarget — the branch table", () => {
  it("SCENARIO 2 (direct deep link): Android gets the App Link URL the manifest claims", () => {
    const t = resolveTarget({ base: BASE, code: CODE, platform: "android" });
    // This exact shape is what apps/worker-app AndroidManifest.xml registers with
    // autoVerify (scheme=https, host=app.badabhai.in, pathPrefix=/i/). If this changes,
    // the installed app stops intercepting and every referral falls back to the browser.
    expect(t.url).toBe(`${BASE}/i/${CODE}`);
    expect(t.leg).toBe("app_link");
  });

  it("desktop gets its OWN route (the QR bridge), not a query flag on the mobile page", () => {
    const t = resolveTarget({ base: BASE, code: CODE, platform: "desktop" });
    expect(t.url).toBe(`${BASE}/i/${CODE}/desktop`);
    expect(t.leg).toBe("masked_page");
  });

  it("'other' (iOS/unknown) shares the App Link route — its Play Store CTA is the honest answer", () => {
    expect(resolveTarget({ base: BASE, code: CODE, platform: "other" }).url).toBe(
      `${BASE}/i/${CODE}`,
    );
  });

  it("normalises a trailing slash on the base so the URL never doubles up", () => {
    expect(resolveTarget({ base: `${BASE}///`, code: CODE, platform: "android" }).url).toBe(
      `${BASE}/i/${CODE}`,
    );
  });

  it("percent-encodes the code so it cannot break out of the path segment", () => {
    const t = resolveTarget({ base: BASE, code: "../../admin", platform: "android" });
    expect(t.url).toBe(`${BASE}/i/..%2F..%2Fadmin`);
    expect(t.url).not.toContain("/admin");
  });
});

describe("fallbackTarget — a shared link must never dead-end", () => {
  it("sends an unresolvable code to a real, installable page", () => {
    expect(fallbackTarget(BASE)).toBe(`${BASE}/i/unknown`);
  });

  it("uses a placeholder that FAILS the code shape check, so the page declines to ping a click", () => {
    // Otherwise the fallback would manufacture click rows for garbage traffic.
    expect(isWellFormedReferralCode("unknown")).toBe(false);
  });

  it("normalises a trailing slash", () => {
    expect(fallbackTarget(`${BASE}/`)).toBe(`${BASE}/i/unknown`);
  });
});
