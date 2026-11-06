import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2542 — with `TRUST_PROXY_HOP_COUNT=1` Express trusts the ONE proxy hop for more than `req.ip`:
 * `req.protocol`/`req.secure` come from `X-Forwarded-Proto` (the box nginx sets it) and
 * `req.hostname`/`req.host` from `X-Forwarded-Host`, which nginx does NOT set — so a client's own
 * value would arrive there. Nothing in the api reads those fields today; this fence keeps it that
 * way (security review, 2026-11-04). If a route ever needs the host or scheme, take it from config
 * (the public base URL), never from the request.
 */
const SRC = join(__dirname, "..", "..");

const FORBIDDEN = [
  /\breq(?:uest)?\.(?:hostname|host|protocol|secure|subdomains)\b/,
  /x-forwarded-(?:host|proto)/i,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && !/\.test-support\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("api never reads forwarded host/scheme fields (#2542 fence)", () => {
  it("the patterns catch what they are meant to (not vacuous)", () => {
    for (const sample of ["req.hostname", "request.protocol", "req.secure", "X-Forwarded-Host", "x-forwarded-proto"]) {
      expect(FORBIDDEN.some((re) => re.test(sample)), sample).toBe(true);
    }
    expect(FORBIDDEN.some((re) => re.test("req.ip"))).toBe(false);
  });

  it("no api source file reads them", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => FORBIDDEN.some((re) => re.test(line)))
        .map(({ i }) => `${relative(SRC, file)}:${i + 1}`),
    );
    expect(hits).toEqual([]);
  });
});
