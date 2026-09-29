import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every RELATIVE `url()` in the shared token file must point at a file that ships in the
 * package. Those urls (the Kilimanjaro Sans face, the brand-kit monogram and logotype) are
 * resolved by each app's bundler at build time, so a missing or renamed file fails the image
 * build — or, worse, a url that never resolves renders the portal with no logo and headings in
 * the fallback face. The root-relative `/fonts/…` urls resolve against each app's public/ and
 * are checked against payer-web's copy.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..", "..", "..", "..", "packages", "design-tokens");
const tokens = readFileSync(join(pkgDir, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const urls = [...tokens.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);

describe("design-tokens · every url() resolves to a shipped file", () => {
  it("finds the font and brand urls it is meant to guard", () => {
    // Vacuity check: the guard below is only evidence if it actually iterates these.
    expect(urls).toEqual(
      expect.arrayContaining([
        "./fonts/KilimanjaroSans-Regular.woff",
        "./brand/badabhai-mark.png",
        "./brand/badabhai-wordmark.png",
        "./brand/badabhai-wordmark-navy.png",
      ]),
    );
  });

  it.each(urls)("%s exists", (url) => {
    const file = url.startsWith("./")
      ? join(pkgDir, url)
      : join(here, "..", "..", "public", url.replace(/^\//, ""));
    expect(existsSync(file), `${url} → ${file}`).toBe(true);
  });

  it("the package publishes every directory those urls live in", () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { files: string[] };
    for (const url of urls.filter((u) => u.startsWith("./"))) {
      const top = url.slice(2).split("/")[0]!;
      expect(pkg.files, `package.json "files" must include ${top}`).toContain(top);
    }
  });
});
