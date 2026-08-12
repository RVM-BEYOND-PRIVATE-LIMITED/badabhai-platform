import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the `environment:` block of one service out of a compose file, for the guard tests
 * that assert what the DEPLOYED box is wired to.
 *
 * WHY THESE GUARDS EXIST AT ALL. Compose forwards ONLY the names a service's `environment:`
 * block declares — it does not pass the host shell through. So "the operator exports it on the
 * box" is not a fact about the box, it is a fact about THIS FILE, and a name missing here is
 * invisible to every other test in the repo: the value sits in the box's shell, the process
 * reads its schema default, and the feature is silently off with nothing naming the cause.
 * That exact failure has now shipped three times — `VOICE_NOTES_BUCKET` (asymmetric defaults),
 * `WORKER_PHOTOS_BUCKET` (#794, undeclared), `CHAT_LLM_INTERVIEW_ENABLED` (#798, undeclared) —
 * which is what makes it worth a parser rather than a review habit.
 *
 * EXTRACTED FROM voice-storage-compose.guard.test.ts, which owned the only copy when the
 * second guard (#798) needed the same parse. Shared rather than copied so a compose-shape
 * change is fixed in ONE place and cannot leave one guard silently parsing nothing.
 */

/** Repo root, from `apps/api/src/common/testing/` — five levels up. */
const REPO_ROOT = join(__dirname, "../../../../..");

export const STAGING_COMPOSE_PATH = join(REPO_ROOT, "docker-compose.staging.yml");
/** The DEV-LAPTOP file. Guards assert it stays UNARMED — see the real-call posture guard. */
export const BASE_COMPOSE_PATH = join(REPO_ROOT, "docker-compose.yml");

/**
 * The `environment:` entries of one service, as `NAME: value` pairs, with the value exactly
 * as written (interpolation syntax and quotes intact — asserting on `${VAR:-}` vs a literal
 * is the entire point, so this must NOT resolve or unquote anything).
 *
 * Hand-rolled rather than a YAML dependency: this repo has no yaml parser in any package.json
 * and adding one to assert a handful of names would cost more than it proves. The file's shape
 * is fixed and machine-checked by compose itself — 2-space service keys, 6-space environment
 * entries — so anchoring on that indentation is stable, and a shape change loud enough to break
 * this parser would also break the deploy.
 *
 * Callers MUST pair this with a canary assertion on a long-stable name (see either guard): if
 * the parser silently found nothing, every `expect(env.get(...))` would pass vacuously and the
 * guard would report green while asserting nothing at all.
 */
export function environmentOf(compose: string, service: string): Map<string, string> {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in the compose file`);

  const env = new Map<string, string>();
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // the next service — stop.
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment && /^ {4}\S/.test(line)) inEnvironment = false; // a sibling of environment.
    if (!inEnvironment) continue;

    const entry = /^ {6}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (entry) env.set(entry[1]!, entry[2]!.trim());
  }
  return env;
}

/** `environmentOf` against a compose file on disk. */
export function environmentOfFile(path: string, service: string): Map<string, string> {
  return environmentOf(readFileSync(path, "utf8"), service);
}
