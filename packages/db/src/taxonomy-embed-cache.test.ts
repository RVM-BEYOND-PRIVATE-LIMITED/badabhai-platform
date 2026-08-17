import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cacheKey, createEmbedCache } from "./taxonomy-embed-cache";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "embed-cache-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cacheKey", () => {
  it("separates the same text under different models", () => {
    // Two models are two vector spaces. A shared key would return a vector from the wrong
    // geometry and every cosine computed against it would be meaningless while looking normal.
    expect(cacheKey("model-a", "turning")).not.toBe(cacheKey("model-b", "turning"));
  });

  it("is stable for the same model and text", () => {
    expect(cacheKey("m", "turning")).toBe(cacheKey("m", "turning"));
  });

  it("separates texts that differ only in case or spacing", () => {
    // The embedder is case-sensitive — "Coolant management" and "coolant management" measured
    // 0.7509 and 0.7426 against the same query — so they must not share a cache entry.
    expect(cacheKey("m", "Coolant management")).not.toBe(cacheKey("m", "coolant management"));
  });
});

describe("createEmbedCache", () => {
  it("calls the provider once per distinct text and serves repeats from cache", async () => {
    let calls = 0;
    const c = createEmbedCache({
      model: "m",
      dir: tmp(),
      fetchVector: async (t) => {
        calls += 1;
        return [t.length, 1];
      },
    });
    await c.embed("a");
    await c.embed("a");
    await c.embed("b");
    expect(calls).toBe(2);
    expect(c.stats()).toEqual({ hits: 1, misses: 2 });
  });

  it("persists across instances so a re-run costs nothing", async () => {
    const dir = tmp();
    const mk = (onFetch: () => void) =>
      createEmbedCache({
        model: "m",
        dir,
        fetchVector: async () => {
          onFetch();
          return [1, 2, 3];
        },
      });

    const first = mk(() => undefined);
    await first.embed("x");
    first.flush();

    let refetched = false;
    const second = mk(() => {
      refetched = true;
    });
    expect(await second.embed("x")).toEqual([1, 2, 3]);
    expect(refetched).toBe(false);
  });

  it("MISSES when the model changes rather than reusing a foreign vector", async () => {
    const dir = tmp();
    const a = createEmbedCache({ model: "old", dir, fetchVector: async () => [1, 0] });
    await a.embed("turning");
    a.flush();

    const b = createEmbedCache({ model: "new", dir, fetchVector: async () => [0, 1] });
    expect(await b.embed("turning")).toEqual([0, 1]);
  });

  it("does not write anything when every text was a hit", async () => {
    const dir = tmp();
    const a = createEmbedCache({ model: "m", dir, fetchVector: async () => [1] });
    await a.embed("x");
    a.flush();

    const b = createEmbedCache({ model: "m", dir, fetchVector: async () => [9] });
    await b.embed("x");
    b.flush(); // no-op: nothing new to persist
    const c = createEmbedCache({ model: "m", dir, fetchVector: async () => [9] });
    expect(await c.embed("x")).toEqual([1]);
  });

  describe("offline", () => {
    it("serves hits", async () => {
      const dir = tmp();
      const warm = createEmbedCache({ model: "m", dir, fetchVector: async () => [4, 2] });
      await warm.embed("known");
      warm.flush();

      const off = createEmbedCache({
        model: "m",
        dir,
        offline: true,
        fetchVector: async () => {
          throw new Error("must not be called");
        },
      });
      expect(await off.embed("known")).toEqual([4, 2]);
    });

    it("THROWS on a miss instead of returning a partial simulation", async () => {
      // The failure this prevents: quota is gone, every text stalls through two minutes of
      // backoff and yields nothing, and the harness reports a summary computed over whatever
      // subset happened to succeed — a partial result wearing a complete result's format.
      const off = createEmbedCache({
        model: "m",
        dir: tmp(),
        offline: true,
        fetchVector: async () => [1],
      });
      await expect(off.embed("unknown")).rejects.toThrow(/OFFLINE and no cached vector/);
    });

    it("names the model in the refusal, since a model change is the likely cause", async () => {
      const off = createEmbedCache({
        model: "gemini-embedding-001",
        dir: tmp(),
        offline: true,
        fetchVector: async () => [1],
      });
      await expect(off.embed("x")).rejects.toThrow(/gemini-embedding-001/);
    });
  });
});
