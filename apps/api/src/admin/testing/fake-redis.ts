import { RECORD_FAILURE_SCRIPT } from "../admin-attempt-lockout.service";

/**
 * An in-memory stand-in for the BullMQ Redis client, covering exactly the commands the admin
 * auth stores use (OTP-pending marker, attempt lockout, trusted devices). Shared so the lockout
 * semantics — in particular the ATOMIC record-failure script — are emulated ONE way in every
 * test rather than re-implemented (and drifting) per file.
 *
 * `eval` accepts ONLY {@link RECORD_FAILURE_SCRIPT} and emulates its contract (INCR, then arm the
 * TTL iff the key has none). Any other script throws, so a production change that swaps the
 * script is caught here instead of being silently "emulated".
 *
 * `calls` records every command name in order, so a test can assert HOW a write happened (one
 * atomic `eval`, never a bare `incr` followed by `expire`). `throwOn` makes one command reject.
 */
export interface FakeRedis {
  store: Map<string, string>;
  ttls: Map<string, number>;
  calls: string[];
  client: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null>;
    setex(key: string, seconds: number, value: string): Promise<"OK">;
    del(...keys: string[]): Promise<number>;
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    eval(script: string, numKeys: number, ...args: string[]): Promise<number>;
  };
}

export function fakeRedis(opts: { throwOn?: string } = {}): FakeRedis {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const calls: string[] = [];
  const guard = (cmd: string): void => {
    calls.push(cmd);
    if (opts.throwOn === cmd) throw new Error(`redis ${cmd} failed`);
  };
  const bump = (key: string): number => {
    const next = Number(store.get(key) ?? "0") + 1;
    store.set(key, String(next));
    return next;
  };

  return {
    store,
    ttls,
    calls,
    client: {
      async get(key) {
        guard("get");
        return store.get(key) ?? null;
      },
      async set(key, value, ...args) {
        guard("set");
        const flags = args.map((a) => String(a).toUpperCase());
        if (flags.includes("NX") && store.has(key)) return null;
        store.set(key, value);
        const ex = flags.indexOf("EX");
        if (ex >= 0) ttls.set(key, Number(args[ex + 1]));
        return "OK";
      },
      async setex(key, seconds, value) {
        guard("setex");
        store.set(key, value);
        ttls.set(key, seconds);
        return "OK";
      },
      async del(...keys) {
        guard("del");
        let n = 0;
        for (const k of keys) {
          if (store.delete(k)) n += 1;
          ttls.delete(k);
        }
        return n;
      },
      async incr(key) {
        guard("incr");
        return bump(key);
      },
      async expire(key, seconds) {
        guard("expire");
        if (!store.has(key)) return 0;
        ttls.set(key, seconds);
        return 1;
      },
      async eval(script, _numKeys, key, ttl) {
        guard("eval");
        if (script !== RECORD_FAILURE_SCRIPT) throw new Error("fake redis: unexpected script");
        const n = bump(key as string);
        if (!ttls.has(key as string)) ttls.set(key as string, Number(ttl));
        return n;
      },
    },
  };
}
