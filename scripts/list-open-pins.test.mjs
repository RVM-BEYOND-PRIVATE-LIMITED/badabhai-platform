// scripts/list-open-pins.test.mjs
// Self-test for scripts/list-open-pins.mjs — node:test, zero deps, no network.
//
// THE THING THIS FILE IS REALLY GUARDING. A pin lister that finds nothing is
// indistinguishable from a repository with no open pins, and the second reading is the
// comfortable one. So every provider is asserted to find at least one REAL pin whose id is
// named here, and the path filter is asserted in both directions — matches what it should,
// and does NOT match what it shouldn't.
//
// The first draft of the pytest provider capped a decorator at 400 characters and therefore
// reported zero on the one file in the repo that has an xfail in it. That bug is pinned as a
// case below: a 700-character reason must still be found.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS, collectPins, pinsTouching } from "./list-open-pins.mjs";

test("every provider finds at least one real pin", () => {
  // NOT VACUOUS: the assertion is per-provider, so a provider that silently stops working
  // fails here even while the other three keep the total looking healthy.
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const pins = provider();
    assert.ok(
      pins.length > 0,
      `provider '${name}' found no pins at all — either every pin of that kind was closed ` +
        "(update this test and say so) or the reader is broken, and those two look identical",
    );
    for (const pin of pins) {
      assert.ok(pin.id, `provider '${name}' produced a pin with no id`);
      assert.ok(pin.gates.length > 0, `pin ${pin.id} gates nothing, so no packet can surface it`);
    }
  }
});

test("the pytest provider survives a decorator longer than its old 400-char cap", () => {
  const pins = PROVIDERS.pytest();
  const r30 = pins.find((p) => p.why.includes("R30 RESIDUAL"));
  assert.ok(r30, "the R30 xfail is not being found — its `reason` is ~700 characters long");
  assert.match(r30.title, /^test_/, "the decorated function name should be the pin's title");
});

test("a table-driven gap suite reports its gaps with a stated cause", () => {
  const pins = PROVIDERS.table();
  assert.ok(
    pins.some((p) => /\[(gazetteer|window|band)\]/.test(p.why)),
    "table pins should carry their GAP_CLASS, or the list cannot be triaged",
  );
  assert.ok(
    pins.every((p) => p.gates.includes("packages/profiling-lexicon/data/salary.json")),
    "a salary gap gates the shared lexicon, not just the test that pins it",
  );
});

test("the path filter matches a directory prefix, a file, and nothing else", () => {
  const pins = [
    {
      id: "a",
      gates: ["apps/api/src/resume/resume-render-input.ts"],
      source: "x",
      why: "",
      title: "",
    },
    {
      id: "b",
      gates: ["packages/profiling-lexicon/data/salary.json"],
      source: "x",
      why: "",
      title: "",
    },
  ];
  assert.deepEqual(
    pinsTouching(pins, ["apps/api/src/resume"]).map((p) => p.id),
    ["a"],
  );
  assert.deepEqual(
    pinsTouching(pins, ["packages/profiling-lexicon/data/salary.json"]).map((p) => p.id),
    ["b"],
  );
  // A sibling whose name merely STARTS with the same characters must not match.
  assert.deepEqual(
    pinsTouching(pins, ["apps/api/src/resumes"]).map((p) => p.id),
    [],
  );
  assert.deepEqual(
    pinsTouching(pins, []).map((p) => p.id),
    [],
  );
});

test("an unavailable provider is reported, never silently counted as zero", () => {
  // The mutation: make one provider throw, exactly as a missing virtualenv does. The pins
  // list must shrink AND the failure must be named — a run that just returned fewer pins
  // would read as good news.
  const real = PROVIDERS.corpus;
  try {
    PROVIDERS.corpus = () => {
      throw new Error("simulated: corpus unreadable");
    };
    const { unavailable } = collectPins();
    assert.ok(
      unavailable.some((u) => u.includes("simulated: corpus unreadable")),
      "a throwing provider must appear in `unavailable`",
    );
  } finally {
    PROVIDERS.corpus = real;
  }
  assert.equal(collectPins().unavailable.length, 0, "no provider should be failing right now");
});
