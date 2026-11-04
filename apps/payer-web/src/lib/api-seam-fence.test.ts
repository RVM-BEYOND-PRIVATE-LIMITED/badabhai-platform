import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * API SEAM FENCE (#2542) — payer-web reaches the network in ONE place: `payerFetch`
 * (lib/payer-http.ts), which carries the visitor IP and the session token and nothing else. A raw
 * `fetch(` anywhere else (the invite click ping was one) would skip the visitor IP — the API's
 * per-IP caps would bucket every visitor as this app again — or leak an origin to the browser.
 *
 * Counted in CODE only (comments stripped), over every shipped .ts/.tsx under src/.
 */
const SEAMS: Readonly<Record<string, number>> = { "lib/payer-http.ts": 1 };

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Code only — a comment may say "fetch(". (`https://` survives: the `:` guard.) */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Raw network calls: `fetch(` in any spelling, and the other ways out of a Node/browser app. */
const NETWORK_CALL =
  /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bEventSource\b|\bWebSocket\b|from\s+["'](?:node:)?https?["']|from\s+["']undici["']|from\s+["']axios["']/g;
const countCalls = (code: string): number => (code.match(NETWORK_CALL) ?? []).length;

function shippedSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(ent.name) && !/\.(test|spec)\.(tsx|ts)$/.test(ent.name))
        out.push(full);
    }
  })(srcRoot);
  return out;
}

const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");
const CODE = new Map(shippedSources().map((f) => [rel(f), stripComments(readFileSync(f, "utf8"))]));

describe("api seam fence — the counter catches what it must", () => {
  it("counts every raw form and ignores the seam's own name", () => {
    expect(countCalls("await fetch(`${base}/x`)")).toBe(1);
    expect(countCalls("globalThis.fetch (url)")).toBe(1);
    expect(countCalls("navigator.sendBeacon(u)")).toBe(1);
    expect(countCalls("new XMLHttpRequest()")).toBe(1);
    expect(countCalls('import { request } from "node:https";')).toBe(1);
    expect(countCalls('import { fetch as f } from "undici";')).toBe(1);
    expect(countCalls("await payerFetch('/payer/me', opts)")).toBe(0);
    expect(countCalls(stripComments("// says fetch(\n/* fetch( */ const u = 'https://x';"))).toBe(0);
  });

  it("the walk reads the seam (so a pass below means something)", () => {
    expect(CODE.has("lib/payer-http.ts")).toBe(true);
    expect(CODE.size).toBeGreaterThan(100);
  });
});

describe("api seam fence — no API call outside the seam", () => {
  it("every raw network call in shipped code is the seam's own", () => {
    const found: Record<string, number> = {};
    for (const [file, code] of CODE) {
      const n = countCalls(code);
      if (n > 0) found[file] = n;
    }
    expect(found).toStrictEqual(SEAMS);
  });
});
