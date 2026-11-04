import { describe, expect, it, vi } from "vitest";
import { candidateRecord } from "../../../../test/candidate-record";
import {
  CANDIDATE_PARAM,
  RECORD_SETTLE_MS,
  drawerMove,
  fetchCandidateRecord,
  narrowRecordResult,
  neighbours,
  recordHref,
  takesArrows,
  type DrawerKeyPress,
} from "./candidate-drawer-model";

/**
 * A7 (#2577) — the drawer's rules: where ↑/↓ go on the current page, which presses are a move,
 * and how a record is read from the browser.
 */
const ROWS = [
  { id: "w1", title: "Ramesh Kumar" },
  { id: "w2", title: "Candidate w2" },
  { id: "w3", title: "Sunita Devi" },
];

describe("the address", () => {
  it("is ?c=<worker id>, and a move settles 350ms before it reads — longer than a ↓ skim's gap", () => {
    expect(CANDIDATE_PARAM).toBe("c");
    expect(RECORD_SETTLE_MS).toBe(350);
    // About four presses a second while scanning: each passed row must not start a read.
    expect(RECORD_SETTLE_MS).toBeGreaterThan(1000 / 4);
  });
});

describe("neighbours — the previous and next row of the current page", () => {
  it("in the middle: both", () => {
    expect(neighbours(ROWS, "w2")).toEqual({ index: 1, prev: ROWS[0], next: ROWS[2] });
  });

  it("at the ends: nothing past the first or the last row (the page is the range)", () => {
    expect(neighbours(ROWS, "w1")).toEqual({ index: 0, prev: null, next: ROWS[1] });
    expect(neighbours(ROWS, "w3")).toEqual({ index: 2, prev: ROWS[1], next: null });
  });

  it("a candidate not on this page (a pasted link, a later page) has no neighbours", () => {
    expect(neighbours(ROWS, "elsewhere")).toEqual({ index: -1, prev: null, next: null });
    expect(neighbours(ROWS, null)).toEqual({ index: -1, prev: null, next: null });
    expect(neighbours([], "w1")).toEqual({ index: -1, prev: null, next: null });
  });
});

describe("drawerMove — ↑ is the previous row, ↓ the next", () => {
  const press = (over: Partial<DrawerKeyPress> = {}): DrawerKeyPress => ({
    key: "ArrowDown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    inField: false,
    outside: false,
    ...over,
  });
  const middle = neighbours(ROWS, "w2");

  it("moves on a plain ↑ / ↓", () => {
    expect(drawerMove(press({ key: "ArrowDown" }), middle)).toBe(ROWS[2]);
    expect(drawerMove(press({ key: "ArrowUp" }), middle)).toBe(ROWS[0]);
  });

  it("not with a modifier — those are the browser's and the OS's", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(drawerMove(press({ [mod]: true }), middle), mod).toBeNull();
    }
  });

  it("not on a held key's auto-repeat — holding ↓ must not read row after row", () => {
    expect(drawerMove(press({ repeat: true }), middle)).toBeNull();
  });

  it("not in a field that uses the arrows, and not from a confirm opened over the drawer", () => {
    expect(drawerMove(press({ inField: true }), middle)).toBeNull();
    expect(drawerMove(press({ outside: true }), middle)).toBeNull();
  });

  it("at an end there is nowhere to go — the arrow keeps its own meaning (it scrolls)", () => {
    expect(drawerMove(press({ key: "ArrowUp" }), neighbours(ROWS, "w1"))).toBeNull();
    expect(drawerMove(press({ key: "ArrowDown" }), neighbours(ROWS, "w3"))).toBeNull();
  });

  it("no other key is a move", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "j", "k", "Enter", "PageDown"]) {
      expect(drawerMove(press({ key }), middle), key).toBeNull();
    }
  });
});

describe("takesArrows", () => {
  it("text fields, selects and editable regions keep their arrows", () => {
    expect(takesArrows({ tagName: "INPUT" })).toBe(true);
    expect(takesArrows({ tagName: "textarea" })).toBe(true);
    expect(takesArrows({ tagName: "SELECT" })).toBe(true);
    expect(takesArrows({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("a button, a tab, a link or nothing focused do not", () => {
    expect(takesArrows({ tagName: "BUTTON" })).toBe(false);
    expect(takesArrows({ tagName: "A" })).toBe(false);
    expect(takesArrows(null)).toBe(false);
  });
});

describe("reading a record from the browser", () => {
  it("the same-origin route, the id encoded", () => {
    expect(recordHref("0b7f/../x")).toBe("/candidates/0b7f%2F..%2Fx/record");
  });

  it("narrows the route's envelope — a record, or one of the four failures", () => {
    const detail = candidateRecord();
    expect(narrowRecordResult({ status: "ok", detail })).toEqual({ status: "ok", detail });
    for (const status of ["not_found", "forbidden", "signed_out", "error"]) {
      expect(narrowRecordResult({ status })).toEqual({ status });
    }
  });

  it("anything else is the honest error — an HTML page from a proxy, a truncated body", () => {
    for (const body of [null, "<html>", 42, {}, { status: "ok" }, { status: "ok", detail: null }, { status: "maybe" }]) {
      expect(narrowRecordResult(body)).toEqual({ status: "error" });
    }
  });

  it("asks with no-store and the abort signal, and narrows what came back", async () => {
    const detail = candidateRecord();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok", detail })));
    const signal = new AbortController().signal;
    expect(await fetchCandidateRecord("w1", signal, fetchImpl as unknown as typeof fetch)).toEqual({
      status: "ok",
      detail,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/candidates/w1/record", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  });

  it("a failed request is the error state; a 404 body is not found", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      await fetchCandidateRecord("w1", new AbortController().signal, down as unknown as typeof fetch),
    ).toEqual({ status: "error" });
    const missing = vi.fn(async () => new Response(JSON.stringify({ status: "not_found" }), { status: 404 }));
    expect(
      await fetchCandidateRecord("w1", new AbortController().signal, missing as unknown as typeof fetch),
    ).toEqual({ status: "not_found" });
  });

  it("an aborted read REJECTS — the drawer moved on, so no state is set from it", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      fetchCandidateRecord("w1", controller.signal, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow();
  });
});
