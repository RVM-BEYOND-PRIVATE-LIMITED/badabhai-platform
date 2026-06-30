import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRootEnv } from "./root-env";

describe("loadRootEnv", () => {
  it("loads repo-root .env from a nested API path without overriding existing values", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-root-env-"));
    try {
      const nested = join(root, "apps", "api", "dist", "config");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
      writeFileSync(
        join(root, ".env"),
        [
          "EMAIL_PROVIDER=auto",
          "ZEPTOMAIL_API_TOKEN=root-token",
          "EXISTING=from-root",
          "BLANK_OPTIONAL=",
          'QUOTED_URL="https://us.cloud.langfuse.com"',
          "INLINE=value # comment",
        ].join("\n"),
      );

      const env: NodeJS.ProcessEnv = { EXISTING: "from-shell", ZEPTOMAIL_API_TOKEN: "" };
      const result = loadRootEnv({ env, startDirs: [nested] });

      expect(result.path).toBe(join(root, ".env"));
      expect(env.EMAIL_PROVIDER).toBe("auto");
      expect(env.ZEPTOMAIL_API_TOKEN).toBe("root-token");
      expect(env.EXISTING).toBe("from-shell");
      expect(env.BLANK_OPTIONAL).toBeUndefined();
      expect(env.QUOTED_URL).toBe("https://us.cloud.langfuse.com");
      expect(env.INLINE).toBe("value");
      expect(result.loaded).toBe(4);
      expect(result.skippedExisting).toBe(1);
      expect(result.skippedEmpty).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a no-op result when no workspace root is found", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-root-env-missing-"));
    try {
      const env: NodeJS.ProcessEnv = {};
      expect(loadRootEnv({ env, startDirs: [root] })).toEqual({
        path: null,
        loaded: 0,
        skippedExisting: 0,
        skippedEmpty: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
