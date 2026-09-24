/**
 * #966 — THE PUBLISHED WORKER APK MUST SAY WHICH BUILD IT IS.
 *
 * The app reads its build id from a COMPILE-TIME define (`kAppBuild`,
 * `String.fromEnvironment('APP_BUILD')`, falling back to `dev`). It shows it on the Settings screen
 * and sends it as `x-app-build`. For five weeks after #966 closed, nothing passed the define, so
 * every APK on the Releases page reported "build dev". A tester with a days-old install could not
 * tell it from today's, and "the fix is merged but I can't see it" had no quick answer.
 *
 * Both halves are text: the Dart key and the CI build line. A rename on either side would put the
 * app back on "dev" with every check green, so this test reads both and holds them together.
 *
 * Text-based on purpose (no YAML parser), like the other workflow guards in this directory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const BUILD_INFO = readFileSync(
  join(ROOT, "apps", "worker-app", "lib", "core", "config", "build_info.dart"),
  "utf8",
);

/** The define name the app compiles against, read from the Dart source. */
function dartDefineKey(): string {
  const key = /kAppBuild\s*=\s*String\.fromEnvironment\(\s*'([A-Z_]+)'/.exec(BUILD_INFO)?.[1];
  if (key === undefined) throw new Error("could not read kAppBuild's define from build_info.dart");
  return key;
}

/** The worker APK's build command: the one `flutter build apk` line that arms ENABLE_TEST_DELETE. */
function workerApkBuildLine(): string {
  const lines = CI.split("\n").filter(
    (line) => line.includes("flutter build apk") && line.includes("ENABLE_TEST_DELETE"),
  );
  // Vacuity guard: exactly one line, or this test is reading the wrong thing.
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

describe("the worker APK carries its build id (#966)", () => {
  it("the app still reads APP_BUILD", () => {
    expect(dartDefineKey()).toBe("APP_BUILD");
  });

  it("the published build passes that define", () => {
    expect(workerApkBuildLine()).toContain(`--dart-define=${dartDefineKey()}=`);
  });

  it("stamps the same short SHA the release tag and the APK filename carry", () => {
    // The release is tagged `worker-app-sha-<first 7 of github.sha>`; Settings must read the same.
    expect(workerApkBuildLine()).toContain("${GITHUB_SHA::7}");
    expect(CI).toContain('SHORT_SHA="$(echo "${{ github.sha }}" | cut -c1-7)"');
  });
});
