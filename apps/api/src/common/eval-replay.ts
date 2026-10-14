import { parseArgs } from "node:util";
import type { z } from "zod";

/**
 * THE PLUMBING EVERY STAGING-EVAL REPLAY SHARES (`chat-companion/v2/career-served-rate.ts`,
 * `profiling/free-chat/free-chat-reply-served.ts`). A replay reads an eval dump the operator names
 * and scores it through the API's own gate. The dump holds model output, so nothing here ever echoes
 * a file's content: an error names a path, an errno code, a zod path and code, or a flag — never a
 * value read from the file.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The process boundary, injected so a replay's exit codes are testable without a process. */
export interface ReplayIo {
  /** The file's text; throws when it cannot be read. */
  readFile(path: string): string;
  out(line: string): void;
  err(line: string): void;
}

/**
 * The two production fallbacks that run BEFORE an answer gate: the API client aborted a late call,
 * or the response failed its contract schema. Either way the caller got null and served its
 * fallback line.
 */
export const OVER_API_TIMEOUT = "over_api_timeout";
export const CONTRACT_SCHEMA = "contract_schema";

/** At most this many schema issues are named when a file is rejected. */
const ISSUES_SHOWN = 5;

/** Zod issues as `path: code` — never `message`, which can echo a value from the file. */
export function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, ISSUES_SHOWN)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
}

/**
 * The named string flags, strictly: an unknown flag, a positional or a flag given twice is an
 * error. `parseArgs` keeps the LAST of a repeated option, so `--file a --file b` would otherwise
 * silently score b.
 */
export function readStrictFlags<N extends string>(
  argv: readonly string[],
  names: readonly N[],
): Parsed<Partial<Record<N, string>>> {
  try {
    const { values, tokens } = parseArgs({
      args: [...argv],
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) {
        return { ok: false, error: `--${token.name} is given more than once` };
      }
      seen.add(token.name);
    }
    return { ok: true, value: values as Partial<Record<N, string>> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "bad arguments" };
  }
}

/** A file's text, or why it cannot be read (its errno code only). */
export function readText(io: ReplayIo, path: string): Parsed<string> {
  try {
    return { ok: true, value: io.readFile(path) };
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    return { ok: false, error: `cannot read ${path}${code ? ` (${code})` : ""}` };
  }
}

/** A file's JSON, or why not. */
export function readJson(io: ReplayIo, path: string): Parsed<unknown> {
  const text = readText(io, path);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    // The parser's message quotes the text around the fault, which is model output: not shown.
    return { ok: false, error: `${path} is not JSON` };
  }
}
