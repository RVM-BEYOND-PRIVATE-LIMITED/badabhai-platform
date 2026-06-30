import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface RootEnvLoadOptions {
  env?: NodeJS.ProcessEnv;
  startDirs?: string[];
}

export interface RootEnvLoadResult {
  path: string | null;
  loaded: number;
  skippedExisting: number;
  skippedEmpty: number;
}

/**
 * Load the repo-root `.env` before backend config validation.
 *
 * The API may be launched from `apps/api`, from the repo root, or from built `dist`.
 * We find the workspace root by walking upward to `pnpm-workspace.yaml`, then fill only
 * missing/blank process env values. Blank values in `.env` are ignored so optional
 * placeholders such as `WHATSAPP_API_KEY=` do not fail Zod's non-empty optional fields.
 */
export function loadRootEnv(options: RootEnvLoadOptions = {}): RootEnvLoadResult {
  const env = options.env ?? process.env;
  const root = findWorkspaceRoot(options.startDirs ?? [process.cwd(), __dirname]);
  if (!root) return { path: null, loaded: 0, skippedExisting: 0, skippedEmpty: 0 };

  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return { path: envPath, loaded: 0, skippedExisting: 0, skippedEmpty: 0 };

  let loaded = 0;
  let skippedExisting = 0;
  let skippedEmpty = 0;

  for (const [key, value] of parseEnv(readFileSync(envPath, "utf8"))) {
    if (value === "") {
      skippedEmpty += 1;
      continue;
    }
    if (env[key] && env[key] !== "") {
      skippedExisting += 1;
      continue;
    }
    env[key] = value;
    loaded += 1;
  }

  return { path: envPath, loaded, skippedExisting, skippedEmpty };
}

function findWorkspaceRoot(startDirs: string[]): string | null {
  const seen = new Set<string>();
  for (const start of startDirs) {
    let dir = resolve(start);
    while (!seen.has(dir)) {
      seen.add(dir);
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function parseEnv(source: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const text = source.replace(/^\uFEFF/, "");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1]!;
    const value = parseValue(match[2] ?? "");
    out.push([key, value]);
  }

  return out;
}

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const quote = trimmed[0];
  if ((quote === `"` || quote === `'`) && trimmed.endsWith(quote)) {
    const body = trimmed.slice(1, -1);
    return quote === `"` ? body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, `"`) : body;
  }

  const hash = trimmed.indexOf(" #");
  return (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
}
