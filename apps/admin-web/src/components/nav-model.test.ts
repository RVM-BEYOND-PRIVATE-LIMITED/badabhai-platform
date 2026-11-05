import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_ICON } from "@badabhai/icons";
import { NAV, NAV_ITEM_LIMIT, activeNavItem, navItemMatches } from "./nav-model";
import { decl, globalsCss, resolveToken, rules, tokensCss } from "../../test/css-rules";

const items = NAV.flatMap((s) => s.items);
const byHref = (href: string) => items.find((i) => i.href === href);
const groupOf = (href: string) => NAV.find((s) => s.items.some((i) => i.href === href))?.title;

/**
 * THE NAVIGATION (A6, #2576): five groups, Directory among them, down from 19 items so the whole
 * nav fits 1920×1080 without scrolling. Labels and groups moved; routes, API paths and capability
 * gates did not — the old addresses redirect (`app/legacy-redirects.test.ts`).
 */
describe("the groups and their items (A6)", () => {
  it("is five groups, in the plan's order, each item in the plan's place", () => {
    expect(NAV.map((s) => [s.title, s.items.map((i) => i.label)])).toEqual([
      ["Home", ["Dashboard"]],
      // User accounts (#2578) joins Directory with its page and its capability — see below.
      ["Directory", ["Candidates", "User accounts", "Companies", "Postings"]],
      ["Finance", ["Credits", "Payment orders"]],
      ["Quality & AI", ["Feedback", "AI calls", "Skill discovery", "Engine view"]],
      ["Audit & Admin", ["Events", "Admin users", "Roles", "System"]],
    ]);
  });

  it(`lists at most ${NAV_ITEM_LIMIT} items — it was 19`, () => {
    expect(NAV_ITEM_LIMIT).toBe(15);
    expect(items.length).toBeLessThanOrEqual(NAV_ITEM_LIMIT);
  });

  it("Workers is Candidates, on the moved /candidates route", () => {
    expect(byHref("/candidates")?.label).toBe("Candidates");
    expect(groupOf("/candidates")).toBe("Directory");
    expect(items.some((i) => i.href === "/workers" || i.label === "Workers")).toBe(false);
  });

  it("Companies holds both personas — there is no Agencies item", () => {
    expect(byHref("/companies")?.label).toBe("Companies");
    expect(groupOf("/companies")).toBe("Directory");
    expect(items.some((i) => i.href === "/agencies" || i.label === "Agencies")).toBe(false);
  });

  it("Agency match skills is a tab on the agency posting — no item of its own", () => {
    expect(items.some((i) => i.href === "/agency-jobs" || /match skills/i.test(i.label))).toBe(
      false,
    );
  });

  it("User accounts is listed in Directory, gated by its own capability (#2578, #2563)", () => {
    // It shipped with its page and its capability in the same change: `manage_payer_credentials`
    // is the API's own guard on every `/admin/accounts` and `/admin/payers` route.
    expect(byHref("/accounts")?.label).toBe("User accounts");
    expect(groupOf("/accounts")).toBe("Directory");
    expect(byHref("/accounts")?.capability).toBe("manage_payer_credentials");
    expect(items.length).toBeLessThanOrEqual(NAV_ITEM_LIMIT);
  });

  it("Account and Sign out are not nav items — they live in the topbar's avatar menu", () => {
    expect(items.some((i) => i.href === "/account" || /sign out/i.test(i.label))).toBe(false);
  });
});

/**
 * The sidebar's names (owner rulings 2026-10-01). LABELS ONLY: every route, API path and
 * capability key stays exactly as it was — the ruling renames what an operator reads, never
 * what a bookmark, an audit link or a guard points at.
 */
describe("nav labels", () => {
  it('the job entity is "Postings", on the unchanged /jobs route', () => {
    expect(byHref("/jobs")?.label).toBe("Postings");
    expect(items.some((i) => i.label === "Jobs")).toBe(false);
  });

  it("payment orders are named for what they are, on the unchanged /transactions route", () => {
    expect(byHref("/transactions")?.label).toBe("Payment orders");
    expect(items.some((i) => i.label === "Transactions")).toBe(false);
  });

  it("every label is sentence case and spelled out — no ampersand, no Title Case", () => {
    expect(byHref("/skills/discovery")?.label).toBe("Skill discovery");
    // The page is "Roles and capabilities"; the row says it short (A6).
    expect(byHref("/roles")?.label).toBe("Roles");
    for (const item of items) {
      expect(item.label, item.href).not.toContain("&");
      const words = item.label.split(" ").slice(1);
      // Only an acronym may be capitalised after the first word ("AI calls").
      for (const w of words)
        expect(w === w.toLowerCase() || w === w.toUpperCase(), item.label).toBe(true);
    }
  });

  it('skill discovery and the engine view sit in "Quality & AI", on the read floor', () => {
    expect(groupOf("/skills/discovery")).toBe("Quality & AI");
    expect(groupOf("/matching/engine")).toBe("Quality & AI");
    expect(byHref("/matching/engine")?.label).toBe("Engine view");
    // Mirrors the reads' `@RequireAdminRole("read_entities")` on both controllers.
    expect(byHref("/skills/discovery")?.capability).toBe("read_entities");
    expect(byHref("/matching/engine")?.capability).toBe("read_entities");
    expect(NAV.some((s) => s.title === "Skills" || s.title === "Matching")).toBe(false);
  });

  it("routes and capability gates did not move with the labels", () => {
    expect(byHref("/jobs")?.capability).toBe("read_entities");
    expect(byHref("/candidates")?.capability).toBe("read_entities");
    expect(byHref("/companies")?.capability).toBe("read_entities");
    expect(byHref("/transactions")?.capability).toBe("read_entities");
    expect(byHref("/credits")?.capability).toBe("read_entities");
    expect(byHref("/feedback")?.capability).toBe("read_entities");
    expect(byHref("/ai-calls")?.capability).toBe("read_ai_traces");
    expect(byHref("/events")?.capability).toBe("read_events");
    expect(byHref("/admins")?.capability).toBe("manage_admins");
    expect(byHref("/roles")?.capability).toBeUndefined();
    expect(byHref("/system")?.capability).toBeUndefined();
    expect(byHref("/")?.capability).toBeUndefined();
  });
});

describe("nav icons", () => {
  it("every item has a glyph, and no two items share one (one concept, one icon)", () => {
    for (const item of items) expect(item.icon, item.href).toBeTruthy();
    const icons = items.map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("uses the shared action glyph where the item IS that concept", () => {
    expect(byHref("/events")?.icon).toBe(ACTION_ICON.timeline);
    expect(byHref("/jobs")?.icon).toBe(ACTION_ICON.posting);
    expect(byHref("/credits")?.icon).toBe(ACTION_ICON.credits);
    // The roster row keeps Workers' glyph: many people (ACTION_ICON.users).
    expect(byHref("/candidates")?.icon).toBe(ACTION_ICON.users);
  });
});

describe("which item a path belongs to — one answer for the sidebar and the crumb", () => {
  it("matches the item's own page and anything below it, on a segment boundary", () => {
    expect(navItemMatches("/jobs", "/jobs")).toBe(true);
    expect(navItemMatches("/jobs", "/jobs/agency/x/match-skills")).toBe(true);
    expect(navItemMatches("/jobs", "/jobsx")).toBe(false);
    expect(navItemMatches("/", "/")).toBe(true);
    expect(navItemMatches("/", "/jobs")).toBe(false);
  });

  it("is the most specific item, with its group; null off the nav", () => {
    const sections = [
      { title: "A", items: [{ href: "/skills", label: "Skills", icon: "tag" as const }] },
      {
        title: "B",
        items: [
          { href: "/skills/discovery", label: "Discovery", icon: "list-magnifying-glass" as const },
        ],
      },
    ];
    expect(activeNavItem(sections, "/skills/discovery/x")?.item.label).toBe("Discovery");
    expect(activeNavItem(sections, "/skills/discovery/x")?.section.title).toBe("B");
    expect(activeNavItem(sections, "/skills/other")?.item.label).toBe("Skills");
    expect(activeNavItem(NAV, "/account")).toBeNull();
    expect(activeNavItem(NAV, "/nowhere")).toBeNull();
    expect(activeNavItem(NAV, "/jobs/agency")?.item.href).toBe("/jobs");
  });
});

/**
 * THE NAV FITS 1920×1080 WITHOUT SCROLLING (A6 acceptance). The node env has no layout engine, so
 * this adds up the DECLARED heights — the sidebar's padding and gaps, the brand, every group's
 * toggle and every row at its declared minimum — with all groups open and the full plan of 15
 * rows (User accounts included, so the budget holds the day it ships). 900px is a 1080p
 * screen's browser viewport with the OS bar, tabs, address bar and a bookmarks bar taken off.
 * Measured in headless Chrome at 1920×1080 and 1920×900 as well (see the PR).
 */
describe("the nav fits a 1080p browser without scrolling", () => {
  const CSS = globalsCss();
  const TOKENS = tokensCss();
  const all = rules(CSS);
  /** The LAST top-level value of `prop` on exactly `selector` — the one the cascade keeps. */
  const last = (selector: string, prop: string): string => {
    const hit = all.filter((r) => r.selector === selector && decl(r.body, prop) !== null).at(-1);
    expect(hit, `${selector} { ${prop} }`).toBeDefined();
    return decl(hit!.body, prop)!;
  };
  /** A length in px: a literal, or a `var(--token)` resolved through tokens.css; rem at 16px. */
  const px = (value: string): number => {
    const v = value.trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) return px(resolveToken(TOKENS, ref[1]!));
    const m = /^(\d*\.?\d+)(px|rem)$/.exec(v);
    expect(m, v).not.toBeNull();
    return Number(m![1]) * (m![2] === "rem" ? 16 : 1);
  };
  /** A `padding` / `gap` shorthand's block (vertical) value. */
  const block = (shorthand: string): number => px(shorthand.split(/\s+/)[0]!);

  it("adds up to at most 900px with every group open and all 15 rows", () => {
    const groups = NAV.length;
    const rows = NAV_ITEM_LIMIT;
    const sidebarPad = block(last(".sidebar", "padding")) * 2;
    const sidebarGap = px(last(".sidebar", "gap")); // brand ↔ nav: the foot is gone
    const brand = px("var(--logo-mark-md)") + px("var(--space-1)"); // tile + its sub-line's slack
    const groupGap = px(last(".sidebar__nav", "gap"));
    const toggle = px(last(".sidebar__grouptoggle", "min-height"));
    const toggleGap = px(last(".sidebar__grouptitle", "margin-block-end"));
    const row = px(last(".sidebar__link", "min-height"));
    const rowGap = px(last(".sidebar__list", "gap"));
    const total =
      sidebarPad +
      brand +
      sidebarGap +
      groups * (toggle + toggleGap) +
      (groups - 1) * groupGap +
      rows * row +
      (rows - groups) * rowGap;
    expect(total).toBeLessThanOrEqual(900);
  });

  it("has no sidebar foot left to push it down", () => {
    expect(all.some((r) => r.selector === ".sidebar__foot")).toBe(false);
  });
});

/**
 * A sidebar item names the capability its page REQUIRES (owner brief 2026-10-01). The sidebar
 * hides an item the session cannot use, and the breadcrumb now links a section only when the
 * reader's filtered sidebar holds it — so an item looser than its page puts a reader one click
 * from a redirect, and an item tighter than its page hides a screen they may open.
 *
 * Read from each page's source: the first gate it calls, `requireCapability("…")` or
 * `requireSession()` (an item with no capability).
 */
describe("every sidebar item's capability is its page's own gate", () => {
  const portal = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "(portal)");
  const pageOf = (href: string) => join(portal, ...href.split("/").filter(Boolean), "page.tsx");
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  /** The page's gate: a capability, `"session"` for requireSession, or null when it has none. */
  const gateOf = (src: string): string | null => {
    const code = strip(src);
    const cap = /requireCapability\(\s*"([a-z_]+)"\s*\)/.exec(code);
    const session = /requireSession\(\s*\)/.exec(code);
    if (cap && (!session || cap.index < session.index)) return cap[1]!;
    return session ? "session" : null;
  };

  it("reads a gate the way a page writes it", () => {
    expect(gateOf('await requireCapability("read_events");')).toBe("read_events");
    expect(gateOf("const s = await requireSession();")).toBe("session");
    expect(gateOf('// requireCapability("x")\nawait requireSession();')).toBe("session");
    expect(gateOf("export default function P() {}")).toBeNull();
  });

  for (const item of items) {
    it(`${item.label} (${item.href})`, () => {
      const gate = gateOf(readFileSync(pageOf(item.href), "utf8"));
      expect(gate, `${item.href} declares no gate`).not.toBeNull();
      expect(gate).toBe(item.capability ?? "session");
    });
  }
});
