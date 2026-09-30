import { describe, expect, it } from "vitest";
import { trimSnapshot, type SnapshotRow } from "./edit-snapshot";

/** `n` rows of one ref family, each carrying one field value. */
function family(prefix: string, section: SnapshotRow["section"], field: string, n: number): SnapshotRow[] {
  return Array.from({ length: n }, (_, i) => ({
    ref: `${prefix}${i + 1}`,
    section,
    fields: { [field]: `${field} value ${i + 1}` },
    target: { member: `${field} value ${i + 1}` },
  }));
}

// BUG-SNAPSHOT-CAP — the trim is pure and deterministic: the same profile and the same message
// always send the same rows, in the snapshot's own order.
describe("trimSnapshot", () => {
  const rows = [
    ...family("e", "employment", "employer_name", 4),
    ...family("s", "skills", "skill", 70),
    ...family("l", "languages", "language", 3),
    ...family("pc", "preferences", "preferred_cities", 5),
  ];

  it("a snapshot within the cap goes out whole and unchanged", () => {
    const small = rows.slice(0, 10);
    expect(trimSnapshot(small, "kuch", 64)).toEqual(small);
  });

  it("fills the cap exactly, keeps every small family whole and trims only the big one", () => {
    const sent = trimSnapshot(rows, "kuch", 64);
    expect(sent).toHaveLength(64);
    const refs = sent.map((r) => r.ref);
    for (const ref of ["e1", "e4", "l1", "l3", "pc1", "pc5"]) expect(refs).toContain(ref);
    expect(sent.filter((r) => r.section === "skills")).toHaveLength(64 - 4 - 3 - 5);
  });

  it("is deterministic and keeps the snapshot's own order", () => {
    const first = trimSnapshot(rows, "kuch", 64);
    expect(trimSnapshot(rows, "kuch", 64)).toEqual(first);
    const positions = first.map((r) => rows.indexOf(r));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("a row the message names verbatim (any case) is kept over one it does not", () => {
    const sent = trimSnapshot(rows, "SKILL VALUE 70 hata do", 64);
    expect(sent.some((r) => r.ref === "s70")).toBe(true);
    // Its family's share is unchanged: one unnamed skill made room for it.
    expect(sent).toHaveLength(64);
  });

  it("shares the cap fairly when every family is large", () => {
    const big = [
      ...family("s", "skills", "skill", 50),
      ...family("c", "qualifications", "certificate_name", 40),
    ];
    const sent = trimSnapshot(big, "kuch", 64);
    expect(sent.filter((r) => r.ref.startsWith("s"))).toHaveLength(32);
    expect(sent.filter((r) => r.ref.startsWith("c"))).toHaveLength(32);
  });
});
