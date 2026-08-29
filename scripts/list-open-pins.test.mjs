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

test("one gap recorded twice is listed once, and says where else it lives (R14 §5)", () => {
  // THE REAL DUPLICATES, not a fixture. `sp_hajar`/`sp_hazzar` in the pytest table and
  // `sal_018`/`sal_019` in the shared corpus are the same two missing spellings — one gap each,
  // recorded once per mechanism because the two mechanisms were built a packet apart.
  const { pins } = collectPins();
  const hajar = pins.filter((p) => p.id.includes("sp_hajar") || p.id.startsWith("sal_018"));
  assert.equal(hajar.length, 1, "the hajar gap is still listed twice");
  assert.ok(
    hajar[0].alsoAt.some((id) => id.startsWith("sal_018")),
    "the surviving pin must name the corpus row it absorbed — folding is about the COUNT, and " +
      "closing the gap still means editing both places",
  );
  assert.ok(
    hajar[0].gates.includes("packages/profiling-lexicon/__fixtures__/utterances.jsonl"),
    "the absorbed pin's gated files must come with it, or the gap stops surfacing from that side",
  );

  // SEE ALSO keeps both and links them in both directions: the experience range and the salary
  // band are the same class, not the same gap.
  const exp028 = pins.find((p) => p.id.startsWith("exp_028"));
  const bandSe = pins.find((p) => p.id.endsWith("::band_se"));
  assert.ok(exp028 && bandSe, "both sides of the cross-reference must still be listed");
  assert.ok(exp028.seeAlso.some((id) => id.endsWith("::band_se")));
  assert.ok(bandSe.seeAlso.some((id) => id.startsWith("exp_028")));
});

test("an alias naming a pin that does not exist FAILS CLOSED", () => {
  // The failure mode this guards is worse than a duplicate: a fold whose target has been closed
  // and deleted would silently remove the surviving pin from the listing, and a shorter list
  // reads as progress. Reported like an unavailable provider, so the process exits non-zero.
  const real = PROVIDERS.corpus;
  try {
    PROVIDERS.corpus = () => [
      {
        source: "corpus",
        id: "fake_001 (nowhere:1)",
        title: "t",
        why: "pinned",
        raw: "pinned. SAME GAP AS a_pin_that_was_closed_and_deleted",
        gates: ["packages/profiling-lexicon/__fixtures__/utterances.jsonl"],
      },
    ];
    const { pins, unavailable } = collectPins();
    assert.ok(
      unavailable.some((u) => u.includes("a_pin_that_was_closed_and_deleted")),
      "a dangling alias must be reported by name",
    );
    assert.ok(
      pins.some((p) => p.id.startsWith("fake_001")),
      "and the pin must still be LISTED — dropping it is the silent deletion this guards",
    );
  } finally {
    PROVIDERS.corpus = real;
  }
});

test("the alias marker is read from the FULL note, not the truncated one", () => {
  // The bug this pins: `why` is capped at 200 characters for display and the first alias
  // written sat at character 340, so the fold silently did not happen. Every corpus pin must
  // therefore carry the untruncated note.
  const pins = PROVIDERS.corpus();
  assert.ok(
    pins.every((p) => typeof p.raw === "string" && p.raw.length >= p.why.length),
    "every corpus pin must carry its untruncated note as `raw`",
  );
  assert.ok(
    pins.some((p) => p.raw.length > 200),
    "no corpus note is long enough to be truncated — this guard would pass vacuously",
  );
});
