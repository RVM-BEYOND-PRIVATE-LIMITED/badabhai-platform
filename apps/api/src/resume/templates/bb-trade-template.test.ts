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
// THE LIVE VERSION, resolved through the registry rather than pinned to a filename: the
// structural invariants below must hold for whatever version the registry serves, and v1 is
// frozen on disk (asserted separately below) precisely so it no longer needs to be re-tested.
const html = readFileSync(join(__dirname, getResumeTemplate(TEMPLATE_ID).file), "utf8");

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

describe("bb_trade — the locked trade sheet (current version)", () => {
  it("is registered, and is NOT the fallback", () => {
    const t = getResumeTemplate(TEMPLATE_ID);
    expect(t.id).toBe(TEMPLATE_ID);
    // v2 = v1 + the worker-copy-only WhatsApp line (ADR-0042 D9 / Layer A (a)).
    expect(t.version).toBe(2);
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

  it("carries the location line under the name, in a slot that COLLAPSES", () => {
    // Owner ruling 2026-09-08 — the worker's registered city and state, directly under his name.
    //
    // THE FLUSH MARKUP IS THE WHOLE MECHANISM, exactly as it is for the section containers above:
    // `.loc:empty` cannot match an element holding a space or a newline, so a worker who gave no
    // location would get a blank line under his name on a sheet he hands to a supervisor.
    expect(html).toContain('<div class="loc">{{location_line}}</div>');
    expect(body).toMatch(/\.loc:empty\s*\{\s*display:\s*none/);

    // POSITION IS THE RULING. Under the name (and its Devanagari line, so a name and its own
    // transliteration stay adjacent) and above the Verdict Line, which §5.1 ranks first.
    expect(html.indexOf("{{full_name}}")).toBeLessThan(html.indexOf("{{location_line}}"));
    expect(html.indexOf("{{name_devanagari}}")).toBeLessThan(html.indexOf("{{location_line}}"));
    expect(html.indexOf("{{location_line}}")).toBeLessThan(html.indexOf("{{headline_line}}"));

    // SMALL, WHICH IS WHAT WAS ASKED FOR, AND NEVER SMALLER THAN THE SHEET's SMALLEST TYPE. 9pt
    // is the section-label floor; anything under it stops surviving a photocopy, and a floor
    // asserted here is a floor a later tidy-up cannot quietly lower.
    const style = /<style>([^]*?)<\/style>/.exec(body)?.[1] ?? "";
    const loc = /\.loc\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    const pt = Number(/font-size:\s*([\d.]+)pt/.exec(loc)?.[1]);
    expect(pt, "the location line has no pt font-size").toBeGreaterThanOrEqual(9);
    expect(pt, "the location line is not smaller than the body — it must read as secondary").
      toBeLessThan(10.5);
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

  it("v2 adds exactly the WhatsApp line, and it collapses when absent (Layer A (a))", () => {
    // THE SLOT IS `.wa` WITH `.wa:empty` — the mapper composes "WhatsApp: …" as one string, so
    // an absent number leaves the element empty and the rule removes it. A label written into
    // the template would survive an absent number (`.wa:empty` can never match), which is why
    // this test pins BOTH halves rather than just the token.
    expect(body).toContain('<div class="wa">{{whatsapp_line}}</div>');
    expect(body).toMatch(/\.wa:empty\s*\{\s*display:\s*none/);
    // The WhatsApp slot is the ONE addition; the phone slot it sits beside is untouched.
    expect(body).toContain('<div class="phone">{{phone}}</div>');
  });

  it("carries the #1547 footer brand — mark + mixed-case wordmark left, wordmark lockup right", () => {
    // THE TWINS STAY IN STEP. `v1` is frozen only about the v2-only `whatsapp_line`; the footer
    // brand is an owner-required visual correction applied to BOTH files, so every assertion here
    // runs over both.
    const v1 = readFileSync(join(__dirname, "bb_trade.v1.html"), "utf8");
    const marks: string[] = [];
    for (const [name, file] of [
      ["v1", v1],
      ["v2", html],
    ] as const) {
      // LEFT: the two-figure mark as an inline SVG data URI (offline — no network asset), then
      // the MIXED-CASE wordmark. `text-transform: uppercase` is what made the old footer read
      // BADABHAI, and it must not come back on this line.
      const markSrc = /class="foot-mark"><img src="(data:image\/svg\+xml,[^"]+)"/.exec(file)?.[1];
      expect(markSrc, `${name}: the footer mark data URI is missing`).toBeTruthy();
      marks.push(markSrc!);
      // BRAND-KIT COLOURS. The mark is the two-figure lockup from badabhai-mark.svg, adapted
      // for white paper: the small figure the kit draws white renders in print navy (white is
      // invisible on the sheet), the large figure in safety-yellow, the knockout halo white.
      // All-ink would read as a black blob beside the wordmark.
      const decodedMark = decodeURIComponent(markSrc!);
      expect(decodedMark, `${name}: the large figure is not safety-yellow`).toContain("#FFB32C");
      expect(decodedMark, `${name}: the small figure is not print navy`).toContain("#0f3d6e");
      expect(decodedMark, `${name}: the mark regressed to all-ink`).not.toContain("#14181d");
      expect(file, `${name}: the wordmark is not mixed case`).toContain(
        'alt="" />BadaBhai</div>',
      );
      const style = /<style>([^]*?)<\/style>/.exec(file)?.[1] ?? "";
      const markCss = /\.foot-mark\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
      expect(markCss, `${name}: .foot-mark uppercases the wordmark`).not.toContain(
        "text-transform",
      );

      // RIGHT: the wordmark lockup, ink, as its own non-shrinking slot.
      expect(file, `${name}: the right logo lockup is missing`).toContain(
        '<div class="foot-logo">BADABHAI <span class="hi">बड़ाभाई</span></div>',
      );
      const logoCss = /\.foot-logo\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
      expect(logoCss, `${name}: the right logo may shrink`).toMatch(/flex:\s*0 0 auto/);
      expect(logoCss, `${name}: the right logo may wrap`).toMatch(/white-space:\s*nowrap/);

      // NO OVERLAP IS STRUCTURAL, not a width guess: the text column absorbs the leftover width
      // and wraps internally (`flex: 1 1 auto` + `min-width: 0`, since a flex item otherwise
      // refuses to shrink below its content's preferred width), while the QR, mark and logo keep
      // their intrinsic size. The two-page spill case is the same rules on a flowing `.foot`.
      const txtCss = /\.foot-txt\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
      expect(txtCss, `${name}: the text column cannot shrink`).toMatch(/flex:\s*1 1 auto/);
      expect(txtCss, `${name}: the text column has no min-width: 0`).toMatch(/min-width:\s*0/);

      // QR / caption / short link / footer meta / disclaimer unchanged.
      for (const slot of ["{{#qr}}", "{{qr_caption}}", "{{short_link}}", "{{footer_meta}}"]) {
        expect(file, `${name}: ${slot} went missing`).toContain(slot);
      }
      expect(file, `${name}: the disclaimer changed`).toContain(
        "Details as stated by the worker. BadaBhai does not guarantee hiring.",
      );
    }
    // ONE MARK, TWO FILES: the same encoded bytes, so the twins cannot drift apart.
    expect(marks[0]).toBe(marks[1]);
  });

  it("keeps v1 frozen on disk — a shipped version is immutable", () => {
    // v1 still renders for every PDF already issued under it (the registry's own contract), so
    // it must remain byte-identical at the path old rows resolve to. If this fails, someone
    // edited history rather than adding v2.
    //
    // #1547 IS THE ONE SANCTIONED IN-PLACE AMENDMENT TO BOTH FILES: the footer brand lockup is a
    // visual correction the owner required on the twins together. What this test protects is the
    // VERSION BOUNDARY — the v2-only `whatsapp_line` must never appear in v1.
    const v1 = readFileSync(join(__dirname, "bb_trade.v1.html"), "utf8");
    expect(v1).toContain('id: "bb_trade", version: 1');
    expect(v1).not.toContain("whatsapp_line");
  });
});
