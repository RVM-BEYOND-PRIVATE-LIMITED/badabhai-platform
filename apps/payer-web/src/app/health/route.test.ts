import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "./route";

/**
 * #965 — `/health` must say WHICH BUILD is running, not just that something is running.
 *
 * Two things are worth policing here, and only one of them is the happy path:
 *
 *  1. The `build` key is ALWAYS present. A consumer (the deploy health gate, a human
 *     debugging "is my fix even deployed?") must never have to distinguish "field absent"
 *     from "field unknown".
 *  2. A missing/EMPTY build arg yields `"unknown"` rather than an error. This is the real
 *     regression risk: a GitHub Actions `build-args:` line pointing at a value that does not
 *     exist passes `--build-arg GIT_COMMIT_SHA=`, and a declared ARG is not inert — Docker
 *     injects it, so the variable arrives PRESENT-AND-EMPTY. That mechanism already failed
 *     this app's build once (a zod schema rejecting ""). An observability nicety must never
 *     be able to fail a health check, so this route fails OPEN and these tests pin that.
 *
 * The Dockerfile assertions at the bottom exist because a route reading an env var that
 * nothing ever sets is green in unit tests and useless in production — the seam has to be
 * checked, not the handler alone.
 */

/** Parse the JSON body of the handler's response with the status/headers it came with. */
async function callHealth(): Promise<{
  status: number;
  contentType: string | null;
  body: Record<string, unknown>;
}> {
  const res = GET();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET /health", () => {
  const original = process.env.GIT_COMMIT_SHA;

  beforeEach(() => {
    delete process.env.GIT_COMMIT_SHA;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.GIT_COMMIT_SHA;
    else process.env.GIT_COMMIT_SHA = original;
  });

  it("keeps the existing liveness contract intact (200, status:ok, JSON)", async () => {
    process.env.GIT_COMMIT_SHA = "abc1234";
    const { status, contentType, body } = await callHealth();

    // PURELY ADDITIVE: the deploy health gate and nginx/uptime checks read these.
    expect(status).toBe(200);
    expect(contentType).toBe("application/json");
    expect(body.status).toBe("ok");
  });

  it("reports the build id from GIT_COMMIT_SHA", async () => {
    process.env.GIT_COMMIT_SHA = "sha-9f2c1ab";
    const { body } = await callHealth();

    expect(body.build).toBe("sha-9f2c1ab");
  });

  it('answers "unknown" — not an error — when GIT_COMMIT_SHA is UNSET', async () => {
    // No env var at all: the local `next dev` / `next start` case, and any image built
    // without the build arg.
    const { status, body } = await callHealth();

    expect(status).toBe(200);
    expect(body.build).toBe("unknown");
  });

  it('answers "unknown" when GIT_COMMIT_SHA is the EMPTY STRING', async () => {
    // THE TRAP: `--build-arg GIT_COMMIT_SHA=` from an absent CI secret bakes ENV="" into
    // the image. Empty must be equivalent to unset, everywhere.
    process.env.GIT_COMMIT_SHA = "";
    const { status, body } = await callHealth();

    expect(status).toBe(200);
    expect(body.build).toBe("unknown");
  });

  it('answers "unknown" when GIT_COMMIT_SHA is whitespace only', async () => {
    process.env.GIT_COMMIT_SHA = "   ";
    const { status, body } = await callHealth();

    expect(status).toBe(200);
    expect(body.build).toBe("unknown");
  });

  it("never omits the build key, whatever the env says", async () => {
    for (const value of ["deadbee", "", "  ", undefined]) {
      if (value === undefined) delete process.env.GIT_COMMIT_SHA;
      else process.env.GIT_COMMIT_SHA = value;

      const { body } = await callHealth();
      expect(Object.keys(body)).toContain("build");
      expect(typeof body.build).toBe("string");
      expect(body.build).not.toBe("");
    }
  });

  it('reports "unknown" rather than reflecting a hostile or oversized env value', async () => {
    // This body is UNAUTHENTICATED. An unbounded passthrough would echo whatever the image
    // was built with — control characters, a header-splitting attempt, kilobytes of text —
    // to anyone who can reach /health. Bounded to apps/api's shape; out-of-shape reads as
    // unset, and still never as an error.
    for (const hostile of ["a".repeat(5000), "sha\tnull", "has space", "line\nbreak", "-leading"]) {
      process.env.GIT_COMMIT_SHA = hostile;

      const { status, body } = await callHealth();
      expect(status).toBe(200);
      expect(body.build).toBe("unknown");
    }
  });

  it("exposes nothing beyond status and build", async () => {
    // A commit sha is public; nothing else belongs in an unauthenticated response.
    process.env.GIT_COMMIT_SHA = "abc1234";
    const { body } = await callHealth();

    expect(Object.keys(body).sort()).toEqual(["build", "status"]);
  });

  it("re-reads the env per request rather than freezing it at module load", async () => {
    process.env.GIT_COMMIT_SHA = "1111111";
    expect((await callHealth()).body.build).toBe("1111111");

    process.env.GIT_COMMIT_SHA = "2222222";
    expect((await callHealth()).body.build).toBe("2222222");
  });
});

describe("Dockerfile wiring for GIT_COMMIT_SHA (#965)", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
  const lines = dockerfile.split(/\r?\n/);
  const isInstruction = (line: string, re: RegExp) => re.test(line.trim());
  const runtimeStageAt = lines.findIndex((l) => /^FROM\s+.+\s+AS\s+runtime\s*$/i.test(l.trim()));

  it("declares the runtime stage this test reasons about", () => {
    expect(runtimeStageAt).toBeGreaterThan(-1);
  });

  it("promotes ARG GIT_COMMIT_SHA to an ENV so it survives into the container", () => {
    const argAt = lines.findIndex((l) => isInstruction(l, /^ARG\s+GIT_COMMIT_SHA$/));
    const envAt = lines.findIndex((l) =>
      isInstruction(l, /^ENV\s+GIT_COMMIT_SHA=\$\{?GIT_COMMIT_SHA\}?$/),
    );

    expect(argAt).toBeGreaterThan(-1);
    expect(envAt).toBeGreaterThan(argAt);
  });

  it("keeps the ARG out of the builder stage, away from `next build`", () => {
    // A build-stage ARG is injected into the `next build` RUN environment, where an empty
    // value has already broken this app once. Runtime-only is what makes that impossible.
    const referencing = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line.includes("GIT_COMMIT_SHA") && !line.startsWith("#"));

    // Not vacuous: there must BE instructions to check.
    expect(referencing.length).toBeGreaterThan(0);
    // Naming the offending lines beats a bare index comparison when this fails.
    const beforeRuntimeStage = referencing
      .filter(({ index }) => index < runtimeStageAt)
      .map(({ index, line }) => `L${index + 1}: ${line}`);
    expect(beforeRuntimeStage).toEqual([]);
  });
});
