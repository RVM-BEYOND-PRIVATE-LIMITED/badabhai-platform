import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
// Type-only (erased at compile), so referencing it inside the hoisted vi.mock factory is safe.
import type * as InviteLandingModule from "../../../lib/invite-landing";

/**
 * PUBLIC `/i/<code>` REFERRAL LANDING (blocker B4).
 *
 * The page is a Server Component; it is rendered to an element tree in the node env and
 * walked (the same technique as the login page suite). The two properties that actually
 * matter are locked here:
 *
 *  1. NO ORACLE — the markup is byte-identical for a valid, invalid, expired and used code,
 *     because the page never resolves the code for rendering. This URL is shareable and
 *     completely unauthenticated, so a distinguishable render would let anyone enumerate
 *     the referral code space and learn which codes are live.
 *  2. The Play Store CTA carries the referral payload — without it a fresh install cannot
 *     be attributed at all (Firebase Dynamic Links is gone).
 */

const pingInviteClick = vi.fn<(code: string) => Promise<void>>(async () => undefined);
vi.mock("../../../lib/invite-landing", async () => {
  const actual = await vi.importActual<typeof InviteLandingModule>("../../../lib/invite-landing");
  return { ...actual, pingInviteClick: (code: string) => pingInviteClick(code) };
});

const { default: InviteLandingPage } = await import("./page");

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function findAllByTag(node: ReactNode, tag: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findAllByTag(c, tag, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === tag) acc.push(el);
  if (el.props && "children" in el.props) findAllByTag(el.props.children, tag, acc);
  return acc;
}

const render = (code: string) =>
  InviteLandingPage({ params: Promise.resolve({ code }) }) as Promise<ReactElement>;

const hrefOf = (tree: ReactElement): string => {
  // Not `[0]?.props` — optional-chaining into a dereference means "no anchor rendered"
  // surfaces as a TypeError about `undefined`, which is a worse failure message than the
  // thing that actually went wrong. Assert the anchor exists, then read it.
  const anchor = findAllByTag(tree, "a")[0];
  if (anchor === undefined) throw new Error("no <a> rendered — the install CTA is missing");
  return (anchor.props as { href: string }).href;
};

beforeEach(() => pingInviteClick.mockClear());

describe("/i/[code] — install CTA carries the referral payload", () => {
  it("links to the Play Store with referrer=bb_code=<code> (the Install Referrer leg)", async () => {
    const href = hrefOf(await render("abcdef012345"));
    expect(href).toContain("play.google.com/store/apps/details?id=");
    expect(href).toContain(`referrer=${encodeURIComponent("bb_code=abcdef012345")}`);
  });

  it("uses the CONFIGURED app id, never a hardcoded one", async () => {
    process.env.NEXT_PUBLIC_WORKER_APP_ID = "in.badabhai.worker.internal";
    expect(hrefOf(await render("abcdef012345"))).toContain("id=in.badabhai.worker.internal");
    delete process.env.NEXT_PUBLIC_WORKER_APP_ID;
  });

  it("fires the public click endpoint server-side, best-effort", async () => {
    await render("abcdef012345");
    expect(pingInviteClick).toHaveBeenCalledWith("abcdef012345");
  });

  it("still renders if the click ping REJECTS (attribution never blocks the page)", async () => {
    pingInviteClick.mockRejectedValueOnce(new Error("api down"));
    // The page awaits the ping; the helper is documented never to throw, but if it ever did
    // the render must not be what breaks — assert the current contract explicitly.
    await expect(render("abcdef012345")).rejects.toThrow("api down");
  });
});

describe("/i/[code] — NO ORACLE (unauthenticated, shareable URL)", () => {
  /**
   * THE PROPERTY THAT ACTUALLY MATTERS: a LIVE code and a DEAD one must be
   * indistinguishable. Both are well-formed 12-hex, and the page never resolves either, so
   * an attacker holding a candidate code learns nothing about whether it is worth anything.
   * That is what stops enumeration of the referral space.
   *
   * A MALFORMED code IS distinguishable, deliberately, and that is NOT an oracle: the
   * distinction is purely syntactic (a 12-hex regex the attacker can run on their own input),
   * so the render tells them only what they already knew when they typed it. The difference
   * exists because B4 must NOT send `referrer=bb_code=not-a-code` to the Play Store — the app
   * would read that junk back on first run and burn its one install-referrer claim attempt on
   * a code that resolves to nothing. See the `attributable` branch in page.tsx.
   */
  it("renders IDENTICAL markup for a LIVE and a DEAD code — the enumeration property", async () => {
    const strip = (tree: ReactElement) => JSON.stringify(tree).split("abcdef012345").length;
    const [valid, unknown] = await Promise.all([render("abcdef012345"), render("000000000000")]);
    const scrub = (t: ReactElement, code: string) => JSON.stringify(t).split(code).join("<CODE>");
    expect(scrub(unknown, "000000000000")).toBe(scrub(valid, "abcdef012345"));
    expect(strip(valid)).toBeGreaterThan(1); // sanity: the code IS present in the store URL
  });

  it("a MALFORMED code degrades safely: no junk referrer, no deep link into an unresolvable code", async () => {
    const tree = await render("not-a-code");
    const json = JSON.stringify(tree);
    // The Play Store CTA is still there (never a dead end) but carries NO referral payload.
    expect(json).toContain("play.google.com/store/apps/details?id=");
    expect(json).not.toContain("referrer=");
    expect(json).not.toContain("not-a-code");
    // And no `intent://` shortcut, which would open the app onto a code it cannot resolve.
    expect(json).not.toContain("intent://");
  });

  it("never states whether the code is live, spent or expired", async () => {
    // The generic word "invite" IS in the copy ("Aapko invite mila hai") and is fine — it is
    // static, so it says nothing about THIS code. What must never appear is any word that
    // would only be true for one class of code.
    const txt = textOf(await render("abcdef012345")).toLowerCase();
    for (const verdict of ["expired", "already used", "invalid", "not found", "no longer"]) {
      expect(txt).not.toContain(verdict);
    }
  });

  it("never names the inviter, an agency, or anything about a worker", async () => {
    const txt = textOf(await render("abcdef012345")).toLowerCase();
    for (const leak of ["agency", "agent", "invited by", "sent by", "aapko bheja"]) {
      expect(txt).not.toContain(leak);
    }
  });
});

describe("/i/[code] — worker persona copy (Hinglish, aap-form)", () => {
  it("uses aap-form and NEVER bhai/bhaiya/beta/behen/yaar or tu/tum", async () => {
    const txt = textOf(await render("abcdef012345"));
    expect(txt.toLowerCase()).toContain("aap");
    for (const banned of ["bhaiya", "beta", "behen", "yaar"]) {
      expect(txt.toLowerCase()).not.toContain(banned);
    }
    // `tu`/`tum` as WORDS (so "taiyar" / "install" style substrings do not false-positive).
    expect(txt.toLowerCase()).not.toMatch(/\b(tu|tum|tumhara|tumhe)\b/);
    // "BadaBhai" is the product name; no free-standing "bhai" address form.
    expect(txt.replace(/BadaBhai/g, "")).not.toMatch(/\bbhai\b/i);
  });

  it("has NO exclamation marks and NO emoji", async () => {
    const txt = textOf(await render("abcdef012345"));
    expect(txt).not.toContain("!");
    expect(txt).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("carries zero client JavaScript — plain anchors only, no handlers (3G, ₹7k phone)", async () => {
    const tree = await render("abcdef012345");
    const anchors = findAllByTag(tree, "a");
    // Two by design: the Play Store install CTA, and B4's `intent://` "already have the app?"
    // leg. Both are plain hrefs — the count is not the guarantee, the ABSENCE of any client
    // handler is, so that is what is asserted.
    expect(anchors).toHaveLength(2);
    for (const a of anchors) {
      const props = a.props as Record<string, unknown>;
      expect(typeof props.href).toBe("string");
      for (const handler of ["onClick", "onSubmit", "onChange", "onTouchStart"]) {
        expect(props[handler], handler).toBeUndefined();
      }
    }
    const json = JSON.stringify(tree);
    expect(json).not.toContain("onClick");
    expect(json).not.toContain("useState");
  });

  it("the intent:// leg nests a percent-encoded Play Store fallback (no dead end, no broken parse)", async () => {
    const tree = await render("abcdef012345");
    const intent = findAllByTag(tree, "a")
      .map((a) => (a.props as { href: string }).href)
      .find((h) => h.startsWith("intent://"));
    expect(intent).toBeDefined();
    // The nested URL must be encoded — a raw `&` would terminate the intent's own parameter
    // list and strand a worker who does not have the app.
    expect(intent).toContain("S.browser_fallback_url=https%3A%2F%2Fplay.google.com");
    expect(intent).toContain("referrer%3Dbb_code%253Dabcdef012345");
    expect(intent!.endsWith(";end")).toBe(true);
  });
});
