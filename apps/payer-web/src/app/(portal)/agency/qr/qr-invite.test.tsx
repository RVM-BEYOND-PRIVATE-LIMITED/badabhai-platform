import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { QRCodeSVG } from "qrcode.react";

/**
 * AGENCY QR INVITE tests — the ABSOLUTE-URL property is the load-bearing one.
 *
 * The mint returns a RELATIVE link ("/i/<code>"). A camera cannot resolve a relative path,
 * so encoding it would print a sheet that scans to nothing — a bug that ships silently
 * because the page still LOOKS right. These tests pin:
 *  - the encoded `value` is EXACTLY the absolute url built from `window.location.origin`
 *    (deep equality, not "contains");
 *  - no QR renders before a successful mint, and a failed mint renders the neutral error
 *    and NO QR (never a fabricated code);
 *  - the QR is rendered locally with no external image/fetch (a third-party QR service
 *    would transmit a live bearer token off-platform);
 *  - the printable sheet carries no agency name / counts / worker reference, and no
 *    per-code label field (a stored "who is this for?" caption is the bulk-upload harm).
 *
 * Env is node (no DOM); state is injected via a mocked `useState` (source order: sheet,
 * error) and `useTransition` runs its callback immediately.
 */

const createInviteAction = vi.fn();
vi.mock("../dashboard/invite-actions", () => ({
  createInviteAction: (i: unknown) => createInviteAction(i),
}));

let stateQueue: unknown[] = [];
let stateCursor = 0;
const setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const set = vi.fn();
  setters.push(set);
  return [seeded, set] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => useTransition(),
  };
});

const { AgencyQrInvite, toAbsoluteInviteUrl, printableInviteOrigin } = await import("./qr-invite");

interface Collected {
  forms: Array<{ onSubmit?: (e: { preventDefault: () => void }) => void }>;
  props: Array<Record<string, unknown>>;
  types: string[];
  qrValues: unknown[];
  text: string[];
  ariaLiveCount: number;
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  if (el.type === QRCodeSVG) acc.qrValues.push(el.props.value);
  if (el.type === "form") {
    acc.forms.push({
      onSubmit: el.props.onSubmit as ((e: { preventDefault: () => void }) => void) | undefined,
    });
  }
  if (el.props) {
    acc.props.push(el.props);
    if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
    if ("children" in el.props) walk(el.props.children, acc);
  }
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = {
    forms: [],
    props: [],
    types: [],
    qrValues: [],
    text: [],
    ariaLiveCount: 0,
  };
  walk(tree, acc);
  return acc;
}

/** Depth-first search for the element carrying `className`, so the PRINTED sheet can be
 *  asserted in isolation from the on-screen chrome around it. */
function findByClass(node: ReactNode, className: string): ReactElement | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findByClass(c, className);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (!el.props) return null;
  if (el.props.className === className) return el;
  return "children" in el.props ? findByClass(el.props.children, className) : null;
}

/** Render with an injected state: `sheet` (the minted QR) then `error`. */
function render(sheet: { code: string; url: string } | null, error: string | null = null) {
  stateQueue = [sheet, error];
  stateCursor = 0;
  setters.length = 0;
  return AgencyQrInvite() as ReactElement;
}

const ORIGIN = "https://portal.badabhai.test";

/** Give the module a browser-like `window` for the origin read + print(). */
function withWindow(origin: string | null) {
  if (origin === null) {
    delete (globalThis as { window?: unknown }).window;
    return;
  }
  (globalThis as { window?: unknown }).window = { location: { origin }, print: vi.fn() };
}

/** Flush the awaited Server Action inside the (immediately-run) transition callback. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Depth-first search for the announced region, so its CONTENT can be asserted. */
function findLiveRegion(node: ReactNode): ReactElement | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findLiveRegion(c);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (!el.props) return null;
  if (el.props["aria-live"] === "polite") return el;
  return "children" in el.props ? findLiveRegion(el.props.children) : null;
}

/** The text a screen reader would actually be handed, whitespace-normalised. */
function liveText(tree: ReactNode): string {
  const region = findLiveRegion(tree);
  expect(region).not.toBeNull();
  return collect(region).text.join(" ").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  createInviteAction
    .mockReset()
    .mockResolvedValue({ ok: true, code: "abc123def456", link: "/i/abc123def456" });
  // Hermetic: unless a test says otherwise there is NO canonical origin configured, so the
  // browsing origin is what gets encoded.
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  useState.mockClear();
  useTransition.mockClear();
});

afterEach(() => {
  withWindow(null);
  vi.unstubAllEnvs();
});

describe("toAbsoluteInviteUrl — a relative mint link becomes a scannable absolute url", () => {
  it("joins the browser origin to the relative link", () => {
    expect(toAbsoluteInviteUrl(ORIGIN, "/i/abc123def456")).toBe(`${ORIGIN}/i/abc123def456`);
  });

  it("tolerates a trailing slash on the origin and a missing leading slash on the link", () => {
    expect(toAbsoluteInviteUrl(`${ORIGIN}/`, "i/abc")).toBe(`${ORIGIN}/i/abc`);
  });

  it("passes an already-absolute link through unchanged", () => {
    expect(toAbsoluteInviteUrl(ORIGIN, "https://other.example/i/abc")).toBe(
      "https://other.example/i/abc",
    );
  });

  it("encodes NOTHING but the url (no payer id, campaign, or token appended)", () => {
    const url = toAbsoluteInviteUrl(ORIGIN, "/i/abc123def456");
    expect(url).toBe(`${ORIGIN}/i/abc123def456`);
    expect(url).not.toMatch(/[?#]/);
  });
});

describe("AgencyQrInvite — a QR renders ONLY after a successful mint", () => {
  it("renders no QR before any mint", () => {
    expect(collect(render(null)).qrValues).toHaveLength(0);
  });

  it("renders no QR when the mint failed, and shows the neutral error", () => {
    const { qrValues, text } = collect(render(null, "Could not create a QR invite right now."));
    expect(qrValues).toHaveLength(0);
    expect(text.join(" ")).toContain("Could not create a QR invite right now.");
  });

  it("encodes EXACTLY the absolute invite url once minted", () => {
    const url = `${ORIGIN}/i/abc123def456`;
    const { qrValues } = collect(render({ code: "abc123def456", url }));
    expect(qrValues).toEqual([url]);
  });

  it("uses a high error-correction level and a printable quiet zone", () => {
    const url = `${ORIGIN}/i/abc123def456`;
    const { props } = collect(render({ code: "abc123def456", url }));
    const qr = props.find((p) => typeof p.level === "string");
    expect(qr).toBeDefined();
    expect(["M", "Q", "H"]).toContain(qr!.level as string);
    expect(qr!.marginSize as number).toBeGreaterThanOrEqual(4);
  });
});

describe("AgencyQrInvite — the encoded value is built from the BROWSER origin", () => {
  it("stores origin + relative link (absolute) after a successful mint", async () => {
    withWindow(ORIGIN);
    const tree = render(null);
    collect(tree).forms[0]!.onSubmit!({ preventDefault: () => {} });
    await flush();
    // setters: [setSheet, setError] in source order.
    expect(setters[0]).toHaveBeenCalledWith({
      code: "abc123def456",
      url: `${ORIGIN}/i/abc123def456`,
    });
  });

  it("refuses to store a RELATIVE url when there is no browser origin (never an unscannable sheet)", async () => {
    withWindow(null);
    const tree = render(null);
    collect(tree).forms[0]!.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(setters[0]).toHaveBeenCalledWith(null); // sheet cleared, not set to "/i/…"
    expect(setters[1]).toHaveBeenCalledWith(expect.stringContaining("Could not create"));
  });

  it("shows the action's neutral error and NO sheet when the mint fails", async () => {
    withWindow(ORIGIN);
    createInviteAction.mockResolvedValueOnce({ ok: false, error: "Could not create an invite." });
    const tree = render(null);
    collect(tree).forms[0]!.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(setters[0]).toHaveBeenCalledWith(null);
    expect(setters[1]).toHaveBeenCalledWith("Could not create an invite.");
  });

  it("mints with an EMPTY body — no campaign, no label, no recipient", async () => {
    withWindow(ORIGIN);
    const tree = render(null);
    collect(tree).forms[0]!.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(createInviteAction).toHaveBeenCalledWith({});
  });
});

describe("AgencyQrInvite — the sheet is local, faceless and printable", () => {
  const sheet = { code: "abc123def456", url: `${ORIGIN}/i/abc123def456` };

  it("renders the QR locally: no <img>, no external host anywhere in the tree", () => {
    const { types, props } = collect(render(sheet));
    expect(types).not.toContain("img");
    for (const p of props) {
      for (const value of Object.values(p)) {
        if (typeof value !== "string") continue;
        expect(value).not.toMatch(/api\.qrserver\.com|chart\.googleapis\.com/);
      }
    }
  });

  it("performs no fetch while rendering", () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      collect(render(sheet));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("prints the human-readable link beneath the code (typeable when a scan fails)", () => {
    const { props, text } = collect(render(sheet));
    expect(props.some((p) => p.className === "agency-qr__link bb-mono")).toBe(true);
    expect(text).toContain(sheet.url);
  });

  it("wraps the printable content in .agency-qr__sheet", () => {
    expect(collect(render(sheet)).props.some((p) => p.className === "agency-qr__sheet")).toBe(true);
  });

  it("carries NO editable/persisted per-code label field on the sheet", () => {
    const sheetEl = findByClass(render(sheet), "agency-qr__sheet");
    expect(sheetEl).not.toBeNull();
    const { types, props } = collect(sheetEl);
    expect(types).not.toContain("input");
    expect(types).not.toContain("textarea");
    expect(types).not.toContain("form");
    expect(props.some((p) => typeof p.label === "string")).toBe(false);
  });

  it("the printed sheet shows no worker reference, no counts and no agency identity", () => {
    const sheetEl = findByClass(render(sheet), "agency-qr__sheet");
    const joined = collect(sheetEl).text.join(" ");
    // The sheet is the ONLY thing that goes on a public wall: it must mean nothing to
    // anyone who photographs it beyond "install this app".
    expect(joined).not.toMatch(/worker|candidate|referral|agency/i);
    expect(joined).not.toMatch(/\b(unlocked|applied|profile complete|invites?)\b/i);
    expect(joined).not.toMatch(/\d+\s+(links?|invites?|workers?)/i);
  });

  it("keeps the error region aria-live='polite'", () => {
    expect(collect(render(null)).ariaLiveCount).toBeGreaterThanOrEqual(1);
  });
});

describe("AgencyQrInvite — the SUCCESS is announced, not just the failure", () => {
  const sheet = { code: "abc123def456", url: `${ORIGIN}/i/abc123def456` };

  it("announces the created QR and the url it encoded", () => {
    // The whole sheet + the print button render OUTSIDE the live region and focus never
    // moves; announcing only errors meant a screen-reader user heard nothing on success.
    const announced = liveText(render(sheet));
    expect(announced).toMatch(/QR invite created/i);
    expect(announced).toContain(sheet.url);
  });

  it("announces nothing before a mint", () => {
    expect(liveText(render(null))).toBe("");
  });
});

describe("printableInviteOrigin — a printed poster prefers the CANONICAL host", () => {
  const PREVIEW = "https://preview-7.vercel.app";

  it("prefers a configured canonical origin over whatever host the staffer is browsing", () => {
    expect(printableInviteOrigin("https://app.badabhai.in", PREVIEW)).toBe(
      "https://app.badabhai.in",
    );
  });

  it("keeps only the ORIGIN — a path/query in the config never reaches the poster", () => {
    expect(printableInviteOrigin("https://app.badabhai.in/portal?x=1", PREVIEW)).toBe(
      "https://app.badabhai.in",
    );
  });

  for (const configured of [undefined, "", "   ", "not-a-url", "javascript:alert(1)"]) {
    it(`falls back to the browsing origin for ${JSON.stringify(configured)}`, () => {
      expect(printableInviteOrigin(configured, PREVIEW)).toBe(PREVIEW);
    });
  }

  it("encodes the canonical origin, not the preview host, when one is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.badabhai.in");
    withWindow(PREVIEW); // a preview deploy: permanent on paper, dead in a week
    const tree = render(null);
    collect(tree).forms[0]!.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(setters[0]).toHaveBeenCalledWith({
      code: "abc123def456",
      url: "https://app.badabhai.in/i/abc123def456",
    });
  });
});
