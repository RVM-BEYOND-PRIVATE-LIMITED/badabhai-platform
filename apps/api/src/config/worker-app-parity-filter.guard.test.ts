/**
 * The worker-app parity tests must run when only the server file they read changes (TD144).
 *
 * `chat_opening_parity_test`, `chat_resume_menu_test` and `chat_companion_keys_test` open
 * server sources byte-for-byte (`File('../api/...')`) to catch the app and the server drifting
 * apart. The `worker-app` gate in `ci.yml` is path-filtered, so a PR that edits ONLY one of
 * those server files used to skip the very tests that exist to catch it — and ship green.
 *
 * WHAT IS PINNED:
 *   1. the `worker-app-parity` filter lists EXACTLY the server paths the Flutter tests read —
 *      a new parity test that forgets the filter fails here, in the `node` job, which has no
 *      path filter of its own;
 *   2. that filter actually triggers the `worker-app` gate;
 *   3. `worker-app-apk` still requires the app's OWN filter, so a server-only change gates
 *      the tests without publishing a byte-identical APK Release.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const APP_TESTS = join(ROOT, "apps", "worker-app", "test");

/** The list entries of one `dorny/paths-filter` key inside the `changes` job, as written. */
export function filterPaths(yaml: string, key: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `            ${key}:`);
  if (start < 0) return [];
  const paths: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (/^ {12}[A-Za-z0-9_-]+:/.test(line)) break; // the next filter key
    if (/^ {0,11}\S/.test(line)) break; // left the filters block
    const entry = /^ {14}- '([^']+)'\s*$/.exec(line);
    if (entry) paths.push(entry[1] as string);
  }
  return paths;
}

/** One job's block (from `  <job>:` to the next two-space job key), as written. */
export function jobBlock(yaml: string, job: string): string {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * One job's `if:` expression, comments excluded — a comment that QUOTES the expression must
 * never satisfy an assertion about the expression itself.
 */
export function jobIf(yaml: string, job: string): string {
  const lines = jobBlock(yaml, job).split("\n");
  const at = lines.findIndex((l) => /^ {4}if:/.test(l));
  if (at < 0) return "";
  const head = (lines[at] as string).replace(/^ {4}if:\s*/, "");
  if (head !== ">-" && head !== ">" && head !== "|") return head;
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!/^ {6}/.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    body.push(line.trim());
  }
  return body.join(" ");
}

function dartFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...dartFiles(full));
    else if (name.endsWith(".dart")) out.push(full);
  }
  return out;
}

/**
 * Every server path a worker-app test reads, repo-relative. Flutter runs tests from
 * apps/worker-app, so `'../api/x'` is `apps/api/x`.
 */
function serverPathsReadByAppTests(): string[] {
  const found = new Set<string>();
  for (const file of dartFiles(APP_TESTS)) {
    for (const m of readFileSync(file, "utf8").matchAll(/'\.\.\/api\/([^'$]+)'/g)) {
      found.add(`apps/api/${m[1] as string}`);
    }
  }
  return [...found].sort();
}

describe("TD144 — the worker-app parity filter", () => {
  const filter = filterPaths(CI, "worker-app-parity");

  it("lists exactly the server files the worker-app parity tests read", () => {
    const read = serverPathsReadByAppTests();
    // Vacuity guard: a broken extractor must not pass by finding nothing on either side.
    expect(read.length).toBeGreaterThan(0);
    expect([...filter].sort()).toEqual(read);
  });

  it("names only files that exist", () => {
    for (const path of filter) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });

  it("is exported by the changes job", () => {
    expect(jobBlock(CI, "changes")).toContain(
      "worker-app-parity: ${{ steps.filter.outputs.worker-app-parity }}",
    );
  });

  it("triggers the worker-app gate", () => {
    const gate = jobIf(CI, "worker-app");
    expect(gate).toContain("needs.changes.outputs.worker-app == 'true'");
    expect(gate).toContain("needs.changes.outputs.worker-app-parity == 'true'");
  });

  it("does not publish an APK on its own: worker-app-apk still requires the app's filter", () => {
    const apk = jobIf(CI, "worker-app-apk");
    expect(apk).toContain("needs.worker-app.result == 'success'");
    expect(apk).toContain("needs.changes.outputs.worker-app == 'true'");
    expect(apk).not.toContain("worker-app-parity");
  });
});
