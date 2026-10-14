import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { WorkerNameReader, workerNameSources } from "./worker-name-sources";

/**
 * The worker's own name as TWO VIEWS OF ONE READ — the one definition `ChatService` and the Bada
 * Bhai chat's free-chat brain (ADR-0055) share. `knownName` fails OPEN (an undecryptable name reads
 * as none); `ownName` fails CLOSED (it rejects, so live news makes no search — ADR-0054 §8 M1).
 */

const WORKER = "11111111-1111-4111-8111-111111111111";

function deps(token: string | null, decrypt: (t: string) => string = () => "Ramesh Yadav") {
  return {
    readToken: vi.fn(async () => token),
    pii: { decrypt: vi.fn(decrypt) },
    logger: { warn: vi.fn() },
  };
}

describe("workerNameSources", () => {
  it("a name on file: both views read it, from ONE lookup and ONE decrypt", async () => {
    const d = deps("enc:token");
    const names = workerNameSources(WORKER, d);
    expect(await names.knownName()).toBe("Ramesh Yadav");
    expect(await names.ownName()).toBe("Ramesh Yadav");
    expect(await names.knownName()).toBe("Ramesh Yadav");
    expect(d.readToken).toHaveBeenCalledTimes(1);
    expect(d.pii.decrypt).toHaveBeenCalledTimes(1);
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("no name on file: both views read null, and nothing is decrypted", async () => {
    const d = deps(null);
    const names = workerNameSources(WORKER, d);
    expect(await names.knownName()).toBeNull();
    expect(await names.ownName()).toBeNull();
    expect(d.pii.decrypt).not.toHaveBeenCalled();
  });

  it("a token that will not decrypt: knownName is null, ownName REJECTS, the warning names the id only", async () => {
    const d = deps("enc:token", () => {
      throw new Error("bad auth tag");
    });
    const names = workerNameSources(WORKER, d);
    expect(await names.knownName()).toBeNull();
    await expect(names.ownName()).rejects.toThrow("could not be decrypted");
    expect(d.logger.warn).toHaveBeenCalledTimes(1);
    expect(d.logger.warn).toHaveBeenCalledWith(
      `could not decrypt full_name for worker ${WORKER}; ` +
        `reply stays name-less, the outbound turn is not name-redacted, and no news search is made`,
    );
  });

  it("a lookup that REJECTS is not kept: the next caller retries it", async () => {
    const readToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce("enc:token");
    const names = workerNameSources(WORKER, {
      readToken,
      pii: { decrypt: () => "Ramesh Yadav" },
      logger: { warn: vi.fn() },
    });
    await expect(names.knownName()).rejects.toThrow("db down");
    expect(await names.knownName()).toBe("Ramesh Yadav");
    expect(readToken).toHaveBeenCalledTimes(2);
  });
});

describe("WorkerNameReader — the injectable view", () => {
  it("reads full_name ALONE (findFullNameToken), never the whole row", async () => {
    const workers = { findFullNameToken: vi.fn(async () => "enc:token"), findById: vi.fn() };
    const reader = new WorkerNameReader(
      workers as never,
      { decrypt: () => "Ramesh Yadav" } as never,
    );
    const names = reader.sourcesFor(WORKER);
    // Lazy: nothing is read until a view is awaited.
    expect(workers.findFullNameToken).not.toHaveBeenCalled();
    expect(await names.ownName()).toBe("Ramesh Yadav");
    expect(workers.findFullNameToken).toHaveBeenCalledWith(WORKER);
    expect(workers.findById).not.toHaveBeenCalled();
  });
});
