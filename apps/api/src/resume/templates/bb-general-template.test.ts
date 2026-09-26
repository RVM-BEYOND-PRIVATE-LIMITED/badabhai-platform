/**
 * Structural guards on the BadaBhai general sheet — the owner's format (2026-09-25) for every
 * worker whose pack is not one of the 21 predefined roles.
 *
 * THE SAME CLASS OF GUARD AS `bb-trade-template.test.ts`, for the same reason: every property
 * below is invisible in a diff and silent at runtime. A section that fails to collapse, a
 * qualification row routed to no section, or a watermark that lands in the text layer all
 * render a perfectly good-looking PDF. The page count and the pixels need WeasyPrint, which the
 * Node suite does not have — `bb-general-sheet.render.test.ts` emits the pages for that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildQualificationRows } from "../resume-sheet-rows";
import { getResumeTemplate, RESUME_TEMPLATES } from "./registry";

const TEMPLATE_ID = "bb_general";
const html = readFileSync(join(__dirname, getResumeTemplate(TEMPLATE_ID).file), "utf8");
const trade = readFileSync(join(__dirname, getResumeTemplate("bb_trade").file), "utf8");

/** The file with both comment syntaxes removed, so assertions read the markup, not its docs. */
const body = html.replace(/<!--[^]*?-->/g, "").replace(/\/\*[^]*?\*\//g, "");
const style = /<style>([^]*?)<\/style>/.exec(body)?.[1] ?? "";

/** Every rule as `[selectors, declarations]`, in source order. */
const RULES: ReadonlyArray<readonly [readonly string[], string]> = [
  ...style.matchAll(/([^{}]+)\{([^}]*)\}/g),
].map((m) => [m[1]!.split(",").map((s) => s.trim()), m[2]!] as const);

/**
 * The declarations of EVERY rule whose selector list contains `selector` verbatim, in source
 * order — so a later rule that overrides an earlier one is what the reader below sees last, as in
 * the cascade. A missing selector FAILS rather than returning "" for a negative check to pass on.
 */
function ruleFor(selector: string): string {
  const found = RULES.filter(([sels]) => sels.includes(selector)).map(([, decl]) => decl);
  expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return found.join(";");
}

/** The LAST pt font-size in the declarations — the one the cascade applies. */
function ptIn(declarations: string): number {
  const sizes = [...declarations.matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => m[1]);
  expect(sizes.length, `no pt font-size in: ${declarations}`).toBeGreaterThan(0);
  return Number(sizes.at(-1));
}

/**
 * Which sections show a qualification row with this label — evaluated from the stylesheet, the
 * way the cascade does it: each section's `> .q` and `> .q[data-label="…"]` display rules, in
 * source order, over a default of visible. This is the routing itself, not its vocabulary.
 */
function sectionsShowing(label: string): string[] {
  return ["sec-avail", "sec-edu", "sec-cert"].filter((section) => {
    let visible = true;
    for (const [selectors, decl] of RULES) {
      const display = /display:\s*(none|block)/.exec(decl)?.[1];
      if (!display) continue;
      const applies = selectors.some(
        (sel) => sel === `.${section} > .q` || sel === `.${section} > .q[data-label="${label}"]`,
      );
      if (applies) visible = display === "block";
    }
    return visible;
  });
}

describe("bb_general — registration", () => {
  it("is registered at v1 and is not the fallback", () => {
    const entry = RESUME_TEMPLATES.find((t) => t.id === TEMPLATE_ID);
    expect(entry).toMatchObject({ id: TEMPLATE_ID, version: 1, file: "bb_general.v1.html" });
    expect(entry?.fallback).toBeFalsy();
    // Resolves to ITSELF — an unregistered id would silently render the plain fallback.
    expect(getResumeTemplate(TEMPLATE_ID).id).toBe(TEMPLATE_ID);
  });
});

describe("bb_general — collapse mechanics", () => {
  it("every section container opens and closes flush against its regions", () => {
    // `:empty` does not match an element holding a space or a newline. The count is pinned so a
    // new container cannot drop out of the guard by carrying an attribute the pattern misses.
    const containers = html.match(/<div class="sec [a-z-]+"[^>]*>[^]{0,40}/g) ?? [];
    expect(containers).toHaveLength(5);
    for (const c of containers) {
      expect(c, `container has whitespace before its region: ${c}`).toMatch(
        /<div class="sec [a-z-]+"[^>]*>\{\{#/,
      );
    }
    for (const close of html.match(/\{\{\/[a-z_]+\}\}\s*<\/(?:div|ul)>/g) ?? []) {
      expect(close, `whitespace before a container closes: ${JSON.stringify(close)}`).not.toMatch(
        /\s/,
      );
    }
  });

  it("every list row is flush, so an empty list takes its label with it", () => {
    // The label rides the first item's ::before, so an empty `<ul>` must be truly `:empty`.
    const lists = html.match(/<ul class="u lrow [a-z-]+">[^]{0,30}/g) ?? [];
    expect(lists).toHaveLength(3);
    for (const l of lists) expect(l).toMatch(/<ul class="u lrow [a-z-]+">\{\{#/);
    expect(style).toMatch(/\.lrow:empty\s*\{\s*display:\s*none/);
  });

  it("every masthead and footer scalar sits alone in an element that collapses", () => {
    for (const [cls, slot] of [
      ["phone", "phone"],
      ["deva", "name_devanagari"],
      ["loc", "location_line"],
      ["wa", "whatsapp_line"],
      ["headline", "headline_line"],
      ["foot-lead", "qr_caption"],
      ["foot-link", "short_link"],
      ["foot-meta", "footer_meta"],
    ] as const) {
      expect(html).toContain(`<div class="${cls}">{{${slot}}}</div>`);
      expect(style, `.${cls} never collapses`).toMatch(
        new RegExp(`\\.${cls}:empty[^{]*\\{\\s*display:\\s*none`),
      );
    }
    expect(html).toContain('<span class="badge">{{trust_badge}}</span>');
    expect(style).toMatch(/\.badge:empty\s*\{\s*display:\s*none/);
    expect(style).toMatch(/h1:empty\s*\{\s*display:\s*none/);
  });

  it("carries no mustache syntax inside the CSS or the comments", () => {
    // The renderer substitutes over RAW TEXT, comments and <style> included. Checked on the raw
    // style block so a CSS comment cannot hide one either.
    const rawStyle = /<style>([^]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(rawStyle.length).toBeGreaterThan(0);
    expect(rawStyle, "the CSS contains mustache").not.toMatch(/\{\{|\}\}/);
    for (const comment of html.match(/<!--[^]*?-->/g) ?? []) {
      expect(comment, "a comment contains mustache").not.toMatch(/\{\{/);
    }
  });

  it("renders both work-history shapes and the overflow tail", () => {
    // The mapper fills exactly one of the two; dropping either empties Work History for a
    // whole population of workers.
    for (const region of [
      "{{#employments}}",
      "{{#roles}}",
      "{{#experiences}}",
      "{{#employments_more}}",
    ]) {
      expect(html).toContain(region);
    }
  });
});

describe("bb_general — the owner's section structure", () => {
  const HEADINGS = [
    "Skills",
    "Availability & Terms",
    "Work History",
    "Education",
    "Certifications & Training",
  ];

  it("declares the five headings as CSS literals, each exactly once", () => {
    for (const heading of HEADINGS) {
      // Quote- and space-insensitive, so a second declaration written differently still counts.
      const n = [...style.matchAll(/content:\s*["']([^"']+)["']/g)].filter(
        (m) => m[1] === heading,
      ).length;
      expect(n, `"${heading}" is declared ${n} times`).toBe(1);
    }
  });

  it("withdraws each first-visible-row heading from every later visible row", () => {
    // THE "PRINTS ONCE" MECHANISM. Every visible row offers its section's heading; these rules
    // take it back from any visible row that has a visible row before it. Drop one and a section
    // prints its bar twice — on real data, not on the fixture that happens to have one row.
    const withdraw = RULES.filter(([, decl]) => /content:\s*none/.test(decl)).flatMap(
      ([sels]) => sels,
    );
    expect(withdraw.sort()).toEqual(
      [
        ".sec-skills > .row ~ .u::before",
        ".sec-skills > .lrow:not(:empty) ~ .u::before",
        ".sec-avail > .row:not(.q) ~ .u::before",
        '.sec-avail > .q[data-label="Languages spoken"] ~ .u::before',
        '.sec-edu > .q[data-label="Education"] ~ .q::before',
        '.sec-edu > .q[data-label="Qualification"] ~ .q::before',
        '.sec-cert > .q:not([data-label="Education"]):not([data-label="Qualification"]):not([data-label="Languages spoken"]) ~ .q::before',
      ].sort(),
    );
  });

  it("lays the sections out in the owner's order, above the footer", () => {
    const at = (cls: string) => body.indexOf(`class="sec ${cls}"`);
    const order = ["sec-skills", "sec-avail", "sec-work", "sec-edu", "sec-cert"].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body.indexOf('class="foot"')).toBeGreaterThan(order[4]!);
    // Headline under the name block, above every section.
    expect(body.indexOf("{{location_line}}")).toBeLessThan(body.indexOf("{{headline_line}}"));
    expect(body.indexOf("{{headline_line}}")).toBeLessThan(order[0]!);
  });

  it("routes every qualification label the composer can emit to a section", () => {
    // THE COUPLING THIS PINS. The qualification rows arrive as one list and the template splits
    // them across three sections by `data-label`. The routing defaults to VISIBLE (an unknown
    // label lands in Certifications & Training with its label shown), so a new label can never
    // vanish — but it should be a decision, not an accident. A new or renamed label fails here.
    const emitted = buildQualificationRows({
      educationHeadline: "x",
      education: ["x"],
      certifications: ["x"],
      languages: ["x"],
      trainings: ["x"],
    }).map((r) => r.label);
    expect(emitted).toEqual(["Education", "Certificates", "Training", "Languages spoken"]);

    // The protected row the degradation ladder can append, read from its own source.
    const degradation = readFileSync(join(__dirname, "..", "resume-degradation.ts"), "utf8");
    const protectedLabel = /PROTECTED_QUAL_LABEL = "([^"]+)"/.exec(degradation)?.[1];
    expect(protectedLabel).toBe("Qualification");

    const routed = new Set([...style.matchAll(/data-label="([^"]+)"/g)].map((m) => m[1]));
    expect([...routed].sort()).toEqual([...emitted, protectedLabel!].sort());

    // THE ROUTING ITSELF: every label shows in exactly one section, and the right one.
    expect(sectionsShowing("Education")).toEqual(["sec-edu"]);
    expect(sectionsShowing(protectedLabel!)).toEqual(["sec-edu"]);
    expect(sectionsShowing("Languages spoken")).toEqual(["sec-avail"]);
    expect(sectionsShowing("Certificates")).toEqual(["sec-cert"]);
    expect(sectionsShowing("Training")).toEqual(["sec-cert"]);
    // A label nobody routed yet defaults to VISIBLE in Certifications & Training — never nowhere.
    expect(sectionsShowing("Some future label")).toEqual(["sec-cert"]);
  });

  it("repeats the qualification region once per section that draws from it", () => {
    expect(html.split("{{#qual_fact_rows}}").length - 1).toBe(3);
    // Each copy carries the label as a data attribute — the only handle CSS has on a row.
    expect(html.split('data-label="{{label}}"').length - 1).toBe(3);
  });

  it("does not print the two bb_trade elements the format has no place for", () => {
    // Both are duplicates on this page: the subhead restates city, availability and pay (all
    // three are Availability & Terms rows), and the own-words quotes restate the Work History
    // lines. The summary slot is the verdict line's facts again, not prose.
    expect(body).not.toContain("{{subhead_line}}");
    expect(body).not.toContain("{{#own_words}}");
    expect(body).not.toContain("{{summary}}");
  });

  it("keeps the disclaimer the format prints, as a literal", () => {
    expect(body).toContain(
      "Details as stated by the worker. BadaBhai does not guarantee hiring or accuracy of claims.",
    );
  });
});

describe("bb_general — print safety", () => {
  it("is fully offline — no network reference of any kind", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(\s*['"]?(?!data:)/i);
  });

  it("sizes type in pt and holds the print floors", () => {
    expect(style, "a font-size in px hides the pt floors").not.toMatch(/font-size:\s*[\d.]+px/);
    // Body at the owner's 10pt, never below it; the name at the 18pt floor or above.
    expect(ptIn(ruleFor("body"))).toBeGreaterThanOrEqual(10);
    expect(ptIn(ruleFor("h1"))).toBeGreaterThanOrEqual(18);
    expect(ptIn(ruleFor("h1.fit"))).toBeGreaterThanOrEqual(18);
    // The grey section bar: every heading shares one rule.
    expect(ptIn(ruleFor(".sec-work::before"))).toBeGreaterThanOrEqual(9);
    // 12mm on EVERY edge — gate-desk printers clip. All values of the shorthand, not the first.
    const margin = /@page\s*\{[^}]*margin:\s*((?:[\d.]+mm\s*){1,4});/.exec(style)?.[1];
    expect(margin, "no @page margin in mm").toBeDefined();
    for (const v of margin!.trim().split(/\s+/)) expect(parseFloat(v)).toBeGreaterThanOrEqual(12);
    const pageRule = /@page\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(pageRule, "a per-edge @page margin could undercut the shorthand").not.toMatch(
      /margin-(?:top|right|bottom|left)\s*:/,
    );
    const rules = [...style.matchAll(/--rule-w:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
    expect(rules.length).toBeGreaterThan(0);
    for (const w of rules) expect(w).toBeGreaterThanOrEqual(0.5);
  });

  it("opens its @page rule the way the headroom script requires", () => {
    // scripts/measure-sheet-headroom.py substitutes the page height on exactly this prefix and
    // exits FATAL otherwise, so the general sheet stays measurable.
    expect(style).toMatch(/@page\s*\{\s*size:\s*A4;/);
    expect(html).not.toMatch(/transform:\s*scale/);
    expect(html).not.toMatch(/font-size:\s*[\d.]+v[wh]/);
  });

  it("keeps long work-history text inside its column", () => {
    // A 56-letter employer token or a 120-character duration in the worker's own words used to
    // print over the dates: the title could not shrink below its longest word, and the duration
    // could not wrap. Both measured in WeasyPrint 69.
    expect(ruleFor(".job-title")).toMatch(/min-width:\s*0/);
    expect(ruleFor(".job-title")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toContain('<span class="when dur">{{duration}}</span>');
    expect(ruleFor(".when.dur")).toMatch(/white-space:\s*normal/);
  });

  it("keeps the masthead band at its padding plus the mark — no inline-flex line box", () => {
    // `inline-flex` on the lockup made WeasyPrint wrap it in a line box: 29pt of band against the
    // sample's 19.5pt, with the mark sitting in its bottom third.
    expect(ruleFor(".wordmark")).toMatch(/display:\s*flex/);
  });

  it("never leaves the footer alone on a page", () => {
    expect(ruleFor(".foot")).toMatch(/break-before:\s*avoid/);
  });

  it("positions nothing, so a spilled sheet ends with its footer on the last page", () => {
    // Anchored so `background-position` (the watermark's centring) is not mistaken for layout.
    expect(style).not.toMatch(/(?<![-\w])position\s*:/);
  });

  it("draws the watermark as outlines in the page background — nothing in the text layer", () => {
    // A text watermark is the first string pypdf extracts from every page, which is what résumé
    // re-import and an employer's ATS both read.
    // UNQUOTED on purpose: base64 needs no quoting, and the offline guard above reads a quoted
    // `url("data:` as a non-data reference (its optional quote backtracks).
    const uri =
      /@page\s*\{[^}]*background-image:\s*url\(data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)\)/.exec(
        style,
      )?.[1];
    expect(uri, "the watermark is not a base64 SVG page background").toBeTruthy();
    const svg = Buffer.from(uri!, "base64").toString("utf8");
    expect(svg).toMatch(/^<svg [^>]*viewBox="[-\d. ]+"/);
    expect(svg).toContain("<path ");
    for (const banned of ["<text", "<image", "href", "<script", "<foreignObject"]) {
      expect(svg, `the watermark SVG contains ${banned}`).not.toContain(banned);
    }
    // Light enough to read through: a fill at or above #e8e8e8 per channel.
    const fill = /fill="#([0-9a-f]{6})"/i.exec(svg)?.[1];
    expect(fill).toBeTruthy();
    for (const channel of fill!.match(/../g)!)
      expect(parseInt(channel, 16)).toBeGreaterThanOrEqual(0xe8);
    // Repeated on every page by being the page background, and never scaled into the margins.
    expect(style).toMatch(/background-repeat:\s*no-repeat/);
  });
});

describe("bb_general — brand", () => {
  const markIn = (file: string, cls: string): string | undefined =>
    new RegExp(`class="${cls}"><img src="(data:image/png;base64,[^"]+)"`).exec(file)?.[1];

  it("carries the SAME two marks as the trade sheet, byte for byte", () => {
    // `bb-trade-template.test.ts` pins both artworks by SHA-256; equality here extends that pin
    // to this sheet instead of forking a second copy of the hashes.
    expect(markIn(html, "wordmark")).toBeTruthy();
    expect(markIn(html, "wordmark")).toBe(markIn(trade, "wordmark"));
    expect(markIn(html, "foot-mark")).toBeTruthy();
    expect(markIn(html, "foot-mark")).toBe(markIn(trade, "foot-mark"));
    // Never stretched: the same boxes the trade sheet reserves for the same rasters.
    expect(ruleFor(".wordmark img")).toMatch(/width:\s*5\.84mm;\s*height:\s*4mm/);
    expect(ruleFor(".foot-mark img")).toMatch(/width:\s*6\.65mm;\s*height:\s*4\.55mm/);
  });

  it("puts the lockup at the LEFT of the band, as the format does, in mixed case", () => {
    expect(body).toContain('/>BadaBhai</span><span class="badge">{{trust_badge}}</span>');
    expect(ruleFor(".badge")).toMatch(/margin-left:\s*auto/);
    expect(ruleFor(".bar")).not.toMatch(/justify-content/);
    for (const sel of [".bar", ".wordmark", ".foot-mark"]) {
      expect(ruleFor(sel), `${sel} uppercases the brand`).not.toContain("text-transform");
    }
    expect(body).toContain('alt="" />BadaBhai</div>');
  });
});
