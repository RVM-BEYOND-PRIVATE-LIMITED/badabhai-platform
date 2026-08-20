import { describe, it, expect } from "vitest";
import {
  NO_NAME_ON_RECORD,
  displayName,
  identityPosture,
  nameDisclosed,
  type IdentityPosture,
} from "./identity";

/**
 * The three-valued name contract, on the client side of the wire.
 *
 * The property under test is that ABSENT and NULL never collapse into each other. The server
 * goes to real trouble to keep them apart — over its 50-name bound it discloses nothing at all
 * rather than naming the first fifty, precisely because the unnamed remainder would arrive as
 * `null` and `null` MEANS "nobody recorded a name". Every function here exists to carry that
 * distinction the last hop into the markup, so each test below is written as "which of the
 * three did this input mean", not "did it return something truthy".
 */

describe("nameDisclosed — PRESENCE is the answer, never the value", () => {
  it("a NULL name is a disclosure: we were told nobody recorded one", () => {
    // The single most important assertion in this file. Reading `row.full_name` and testing it
    // for truthiness — the obvious implementation — gets this case exactly backwards.
    expect(nameDisclosed({ full_name: null }, "full_name")).toBe(true);
  });

  it("an ABSENT key is not a disclosure", () => {
    expect(nameDisclosed({}, "full_name")).toBe(false);
  });

  it("a string name is a disclosure", () => {
    expect(nameDisclosed({ full_name: "Ramesh Kumar" }, "full_name")).toBe(true);
  });

  it("an EMPTY-STRING name is still a disclosure — it renders as a dash, but it was told", () => {
    // `displayName` dashes it; that is a rendering decision. Whether the read was permitted is
    // a different question and this function answers only that one.
    expect(nameDisclosed({ full_name: "" }, "full_name")).toBe(true);
  });

  it("reads the field ASKED FOR, not any field that happens to be there", () => {
    // Three surfaces use three different keys (`full_name`, `org_name`, `name`); a helper that
    // ignored its argument would silently report the payer key as disclosed on a worker row.
    expect(nameDisclosed({ org_name: "Acme Fabrication" }, "full_name")).toBe(false);
    expect(nameDisclosed({ org_name: "Acme Fabrication" }, "org_name")).toBe(true);
  });

  it("an INHERITED key is not a disclosure — own properties only", () => {
    // `"full_name" in row` would be true here. A parsed row never has a prototype carrying
    // these keys, but the distinction is the whole reason `Object.hasOwn` is the right tool.
    const row = Object.create({ full_name: "Inherited Name" }) as object;
    expect(nameDisclosed(row, "full_name")).toBe(false);
  });
});

describe("displayName — the dash cases, which are the layout cases", () => {
  it("returns the name", () => {
    expect(displayName("Ramesh Kumar")).toBe("Ramesh Kumar");
  });

  it("null and undefined both become the dash", () => {
    expect(displayName(null)).toBeNull();
    expect(displayName(undefined)).toBeNull();
  });

  it("a BLANK name becomes the dash rather than an empty cell", () => {
    // The layout-collapse case. `full_name` is worker-entered free text, so a row really can
    // hold "" or "   ", and rendering it verbatim leaves a cell that looks broken rather than
    // one that says "we have no usable name".
    expect(displayName("")).toBeNull();
    expect(displayName("   ")).toBeNull();
    expect(displayName("\n\t ")).toBeNull();
  });

  it("TRIMS a name that has usable text in it rather than dropping it", () => {
    // The other half of the trim: it must not be an excuse to discard a real name whose input
    // had a stray space. Without this assertion, "always return null" passes the test above.
    expect(displayName("  Ramesh Kumar  ")).toBe("Ramesh Kumar");
  });

  it("keeps a name that is only punctuation or a single character — we do not judge names", () => {
    // Guards against a "looks like a real name" heuristic creeping in. A one-character name is
    // a name; deciding otherwise would blank a real person's row.
    expect(displayName("R")).toBe("R");
    expect(displayName("ओ")).toBe("ओ");
  });

  it("does not coerce a non-string the parser should never have let through", () => {
    expect(displayName(42 as unknown as string)).toBeNull();
  });
});

describe("identityPosture — which of the three screens this render is", () => {
  const NAMED_ROW = { id: "w1", full_name: "Ramesh Kumar" };
  const UNNAMED_ROW = { id: "w2", full_name: null };
  const WITHHELD_ROW = { id: "w3" };

  it("rows carrying the key are NAMED", () => {
    expect(identityPosture([NAMED_ROW], "full_name", true)).toBe<IdentityPosture>("named");
  });

  it("rows carrying only NULL names are still NAMED — the column belongs on that page", () => {
    // A page of workers who have never given us a name is a fully disclosed page. Treating it
    // as capped would post a "names are withheld" warning over a truthful answer.
    expect(identityPosture([UNNAMED_ROW], "full_name", true)).toBe<IdentityPosture>("named");
  });

  it("no key + NO capability is FACELESS — the pre-ruling console, not a failure", () => {
    expect(identityPosture([WITHHELD_ROW], "full_name", false)).toBe<IdentityPosture>("faceless");
  });

  it("no key + the capability held is CAPPED — the read was refused, not the role", () => {
    // The distinction the whole file exists for: same response bytes, different screen, and
    // only the client can tell them apart because only the client knows the capability.
    expect(identityPosture([WITHHELD_ROW], "full_name", true)).toBe<IdentityPosture>("capped");
  });

  it("an EMPTY page is never CAPPED — nothing was withheld because there was nothing to hold", () => {
    expect(identityPosture([], "full_name", true)).toBe<IdentityPosture>("named");
    expect(identityPosture([], "full_name", false)).toBe<IdentityPosture>("faceless");
  });

  it("ANY row carrying the key names the page, even mixed with rows that do not", () => {
    // A partially-named page would be a server-side contract break. Reading it as NAMED shows
    // the names that did arrive (the disclosure already happened) and dashes the rest, which
    // beats hiding real disclosures behind a "withheld" banner.
    expect(identityPosture([WITHHELD_ROW, NAMED_ROW], "full_name", true)).toBe<IdentityPosture>(
      "named",
    );
  });

  it("MEASURES the rows rather than predicting from the capability", () => {
    // If `/admin/me` and the entity read ever disagree, the names are already over the wire.
    // Hiding the column would not un-disclose them; claiming in copy that nothing was shown
    // while showing it is the failure worth preventing.
    expect(identityPosture([NAMED_ROW], "full_name", false)).toBe<IdentityPosture>("named");
  });

  it("reads the field it was given, per surface", () => {
    const payerRow = { id: "p1", org_name: "Acme Fabrication" };
    expect(identityPosture([payerRow], "org_name", true)).toBe<IdentityPosture>("named");
    // The same row asked about the WORKER key is a capped worker page, not a named one.
    expect(identityPosture([payerRow], "full_name", true)).toBe<IdentityPosture>("capped");
  });
});

describe("the dash's hover copy", () => {
  it("says ABSENT-ON-RECORD, which is the only thing a dash can honestly mean", () => {
    // If this string ever grows a "or withheld from you" clause, the three postures have been
    // collapsed back into one and the column-hiding above has stopped meaning anything.
    expect(NO_NAME_ON_RECORD).toContain("No name on record");
    expect(NO_NAME_ON_RECORD.toLowerCase()).not.toContain("withheld");
    expect(NO_NAME_ON_RECORD.toLowerCase()).not.toContain("permission");
  });
});
