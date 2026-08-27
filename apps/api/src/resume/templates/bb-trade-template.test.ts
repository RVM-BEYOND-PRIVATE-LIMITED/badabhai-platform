/**
 * Structural guards on the locked BadaBhai trade sheet.
 *
 * These assert the properties that are INVISIBLE in a diff and silent at runtime — the ones a
 * formatter, a well-meaning tidy-up, or a copy-paste from another layout would break without
 * anything going red.
 *
 * THE WHITESPACE ONE IS NOT PEDANTRY. Every collapsible container in this layout is written on one
 * line, flush against its tags, because `:empty` does not match an element holding a single space
 * or a newline. Break a container across lines and every section a sparse profile is meant to hide
 * comes back: a worker with no certifications prints a "Certifications" heading with nothing under
 * it, on a sheet they hand to a supervisor. Nothing fails, nothing logs, the PDF renders — it is
 * just wrong, on the artifact that matters most.
 *
 * Measured 2026-08-28: `prettier --check` DID report style issues on this file and on the shipped
 * `classic.v3.html`, i.e. `pnpm format` would have rewritten the whole directory. The directory is
 * now in `.prettierignore`; this file is the guard that survives someone removing that entry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getResumeTemplate, RESUME_TEMPLATES } from "./registry";

const TEMPLATE_ID = "bb_trade";
const html = readFileSync(join(__dirname, "bb_trade.v1.html"), "utf8");

/**
 * The file with its comments removed — BOTH syntaxes.
 *
 * NEEDED BECAUSE THE COMMENTS TALK ABOUT THE MARKUP. The header explains the rules by naming them:
 * it contains the literal text `<style>` while describing the offline constraint, and the CSS
 * carries `never a "self-declared" label` next to the rule that enforces it. A scan of the raw file
 * therefore matches the documentation rather than the document — which is how both of these
 * assertions failed against a correct template, twice, the second time because `/* … *\/` inside
 * `<style>` is not an HTML comment and survived the first strip.
 */
const body = html.replace(/<!--[^]*?-->/g, "").replace(/\/\*[^]*?\*\//g, "");

describe("bb_trade.v1 — the locked trade sheet", () => {
  it("is registered, and is NOT the fallback", () => {
    const t = getResumeTemplate(TEMPLATE_ID);
    expect(t.id).toBe(TEMPLATE_ID);
    expect(t.version).toBe(1);
    expect(t.fallback ?? false).toBe(false);
    // Exactly one fallback across the whole registry — `getResumeTemplate` returns `find(fallback)!`
    // and a second one would make which layout an unknown id resolves to depend on array order.
    expect(RESUME_TEMPLATES.filter((x) => x.fallback).length).toBe(1);
  });

  it("every collapsible container opens flush against its region — no whitespace", () => {
    // `.sec:empty` is what removes a section heading when its region yields nothing. A newline
    // between `<div class="sec ...">` and `{{#region}}` defeats it permanently.
    // THE `[^>]*` IS LOAD-BEARING. `sec-cap` carries `data-title`, so a pattern anchored on
    // `">` skips it — and it is the one container whose markup changed. The count assertion below
    // pins how many containers this is expected to find, so a future attribute cannot quietly
    // drop another one out of the guard.
    const containers = html.match(/<div class="sec [a-z-]+"[^>]*>[^]{0,40}/g) ?? [];
    expect(containers.length).toBe(5);
    for (const c of containers) {
      expect(c, `container has whitespace before its region: ${c}`).toMatch(
        /<div class="sec [a-z-]+"[^>]*>\{\{#/,
      );
    }
  });

  it("every collapsible container closes flush against its region", () => {
    const closers = html.match(/\{\{\/[a-z_]+\}\}\s*<\/div>/g) ?? [];
    expect(closers.length).toBeGreaterThan(0);
    for (const c of closers) {
      expect(c, `whitespace between region close and </div>: ${JSON.stringify(c)}`).not.toMatch(
        /\s/,
      );
    }
  });

  it("carries no mustache syntax inside the CSS or the comments", () => {
    // The renderer substitutes over RAW TEXT and does not skip comments or <style>. A lone opening
    // region tag in prose pairs with the real closing tag far below and repeats half the page; a
    // scalar token interpolates real worker data into the served HTML source.
    const style = /<style>([^]*?)<\/style>/.exec(body)?.[1] ?? "";
    expect(style.length).toBeGreaterThan(0);
    expect(style, "the CSS contains mustache").not.toMatch(/\{\{/);
    for (const comment of html.match(/<!--[^]*?-->/g) ?? []) {
      expect(comment, "a comment contains mustache").not.toMatch(/\{\{/);
    }
  });

  it("is fully offline — no network reference of any kind", () => {
    // WeasyPrint would either block or hang on a remote fetch, and a resume must render in an
    // air-gapped container. The QR arrives as a `data:` URI through a slot, never as a URL.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(\s*['"]?(?!data:)/i);
  });

  it("renders both work-history shapes — the rich one AND the one that exists today", () => {
    // `employments` is what this sheet was designed for; `experiences` is what every profile in
    // the database actually has. Dropping the second would have shipped an empty WORK HISTORY for
    // every existing worker on day one.
    expect(html).toContain("{{#employments}}");
    expect(html).toContain("{{#roles}}");
    expect(html).toContain("{{#experiences}}");
  });

  it("declares the locked section headings as literals, each exactly once", () => {
    // These four are fixed by the guideline's zone map. They are NOT content and a mapper must
    // not be able to rename "Work history" — so they are literals in the CSS, not slots.
    for (const heading of [
      "In the worker's own words",
      "Availability & terms",
      "Work history",
      "Qualification, documents & languages",
    ]) {
      expect(html.split(heading).length - 1, `${heading} appears more than once`).toBe(1);
    }
  });

  it("takes the FIRST section's heading from data, and still collapses the section", () => {
    // A turner's sheet says "Machines, controllers & capability"; a welder's says "Processes,
    // positions & capability". Hard-coding it would be wrong for two roles out of three.
    expect(body, "the first heading is hard-coded").not.toMatch(/Machines, controllers/i);
    expect(html).toContain('data-title="{{cap_section_title}}"');
    expect(body).toMatch(/\.sec-cap::before\s*\{\s*content:\s*attr\(data-title\)/);
    // AND IT MUST BE AN ATTRIBUTE, NOT A TEXT NODE. `:empty` matches an element that carries
    // attributes but no children, so the attribute keeps the collapse working; a text slot would
    // make the container permanently non-empty and print a bare heading over nothing.
    expect(html).toMatch(/<div class="sec sec-cap"[^>]*>\{\{#/);
    expect(body).toMatch(/\.sec:empty\s*\{\s*display:\s*none/);
  });

  it("puts the trust badge in a slot that COLLAPSES, and hardcodes no tier", () => {
    // THE DURABLE PROPERTY IS "NO TIER LIVES HERE", not "which tiers exist". The tier vocabulary
    // is contested — an owner ruling says two (self-declared / BadaBhai Verified) while the Resume
    // Engine guideline lists five (self-declared, RVM-attested, document-verified, tenure-verified,
    // employer-rated) — and a template that hardcodes either answer has to be re-versioned when it
    // settles. It is a string slot, so both readings render and neither is baked into an immutable
    // file. An absent badge collapses: the unverified state must read as neutral, never as a
    // warning label on a worker who has done nothing wrong.
    expect(body).toContain("{{trust_badge}}");
    expect(body).toMatch(/\.badge:empty\s*\{\s*display:\s*none/);
    for (const tier of ["self-declared", "RVM-attested", "document-verified", "tenure-verified"]) {
      expect(body, `the badge hardcodes the tier "${tier}"`).not.toMatch(
        new RegExp(tier.replace("-", "[- ]"), "i"),
      );
    }
  });

  it("meets every typographic floor the guideline makes binding", () => {
    // THE FAILURE THIS CATCHES IS INVISIBLE IN A DIFF. An earlier draft of this file was authored
    // in px — body 10.2px, name 22px, section label 8.4px — which is 7.6pt / 16.5pt / 6.3pt once
    // WeasyPrint applies the 0.75 conversion. It was below TWO hard floors at once and looked
    // entirely reasonable on screen. Points are therefore mandatory here, and that is what the
    // first assertion enforces: it is the mechanism, not just the symptom.
    const style = /<style>([^]*?)<\/style>/.exec(body)?.[1] ?? "";
    expect(style.length).toBeGreaterThan(0);

    expect(style, "a font-size in px hides the pt floors behind a 0.75 conversion").not.toMatch(
      /font-size:\s*[\d.]+px/,
    );

    const sizeIn = (selector: string): number => {
      // DOUBLE BACKSLASHES ARE REQUIRED. In a template literal `\s` and `\{` collapse to
      // `s` and `{`, which turns this into /bodys*{...}/ — a regex that matches nothing and
      // makes every floor below pass vacuously. It did exactly that on the first run.
      const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(style)?.[1] ?? "";
      const pt = /font-size:\s*([\d.]+)pt/.exec(block)?.[1];
      expect(pt, `no pt font-size found for ${selector}`).toBeDefined();
      return Number(pt);
    };
    expect(sizeIn("body"), "body floor is 10.5pt").toBeGreaterThanOrEqual(10.5);
    expect(sizeIn("h1"), "name floor is 18pt").toBeGreaterThanOrEqual(18);
    expect(sizeIn("\\.sec::before"), "section label floor is 9pt").toBeGreaterThanOrEqual(9);

    // 12mm on every edge — these sheets are photocopied and gate-desk printers clip.
    const pageMargin = /@page\s*\{[^}]*margin:\s*([\d.]+)mm/.exec(style)?.[1];
    expect(pageMargin, "no @page margin found").toBeDefined();
    expect(Number(pageMargin)).toBeGreaterThanOrEqual(12);

    // No hairline under 0.5pt: a finer rule is dropped entirely by many office printers, which
    // silently removes every section divider on the page.
    const rules = [...style.matchAll(/--(?:rule|hair)-w:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
    expect(rules.length).toBeGreaterThan(0);
    for (const w of rules) expect(w, "rule finer than the 0.5pt floor").toBeGreaterThanOrEqual(0.5);
  });

  it("is one page by construction — no font-shrink hack", () => {
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    // A `scale()` or a viewport-relative font size would be the layout silently deciding to
    // squeeze rather than the mapper deciding what to drop. Caps belong in resume-render-input.ts.
    expect(html).not.toMatch(/transform:\s*scale/);
    expect(html).not.toMatch(/font-size:\s*[\d.]+v[wh]/);
  });
});
