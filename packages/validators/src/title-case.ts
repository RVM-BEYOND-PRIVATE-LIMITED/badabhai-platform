import { dartVmUpperCase } from "./title-case-dart-upper";

/**
 * The worker app's `titleCaseName`, ported EXACTLY (#1432).
 *
 * Source of truth: `apps/worker-app/lib/core/util/title_case.dart`. Since worker-app 24285c14 the
 * app runs that function over `employer_name`, `role_label` and the education `field` before every
 * PUT, so every NEW row arrives cased by it. This port exists so a row stored BEFORE that fix can be
 * brought to the byte-identical value the app would have sent — which is only true if the two
 * functions agree on every input, not merely on the obvious ones. `title-case.test.ts` holds it to
 * the app's own test cases AND to a recording of the app's function on the Dart VM over every
 * Unicode scalar value (`__fixtures__/title-case.dart-vm.json`).
 *
 * THE RULE: walk the string by CODE POINT (Dart `runes`); a whitespace code point is copied and
 * starts a new word; the first code point of each word goes through the Dart VM's `toUpperCase()`;
 * every other code point is copied untouched. Nothing is ever lowercased — `RVM CAD` and
 * `CNC Operator` come back byte-identical — which is the whole reason this is not Postgres
 * `INITCAP()`.
 *
 * ⚠ NOT `apps/api/src/resume/resume-text-case.ts`'s `titleCaseName`. That is the RENDERER's rule
 * and it is deliberately wider (a hyphen, an opening parenthesis and `&` also start a word there).
 * The two answer different questions — "what does the app store" versus "what does the sheet
 * print" — so they are not merged here.
 *
 * TWO PLACES WHERE A LITERAL TRANSLATION OF THE DART WOULD BE WRONG IN JAVASCRIPT:
 *
 *   1. WHITESPACE. Dart's `char.trim().isEmpty` and JavaScript's `trim()` disagree on U+0085
 *      (NEXT LINE): Dart trims it, JavaScript does not. The set below is Dart's own list
 *      (`String.trim`: Unicode White_Space plus U+FEFF), and the recording confirms it is exactly
 *      the set of code points that break a word in the app.
 *   2. UPPER-CASING. Measured on Node 24, JavaScript's `toUpperCase()` — even held to one code
 *      point out — disagrees with the Dart VM's on 501 code points, and unheld it EXPANDS 102
 *      (`ß` → `SS`). So the upper-casing is `title-case-dart-upper.ts`, the VM's table as measured,
 *      never JavaScript's. Every mapping there is one code point to one, so a cased value is never
 *      longer than the stored one and can never break a column's length CHECK.
 */

/** Dart's `String.trim` whitespace: Unicode White_Space plus the BOM (U+FEFF). */
const DART_WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

/** Is this code point whitespace by Dart's definition (`char.trim().isEmpty`)? */
export function isDartWhitespace(codePoint: number): boolean {
  return DART_WHITESPACE.has(codePoint);
}

/**
 * `rvm cad pvt lt` → `Rvm Cad Pvt Lt`; `RVM CAD` → `RVM CAD`; `mCA institute` → `MCA Institute`.
 *
 * Same signature as the Dart: a string in, a string out, the empty string returned as is.
 */
export function titleCaseWords(text: string): string {
  if (text === "") return text;
  let out = "";
  let atWordStart = true;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (isDartWhitespace(codePoint)) {
      out += char;
      atWordStart = true;
      continue;
    }
    out += atWordStart ? String.fromCodePoint(dartVmUpperCase(codePoint)) : char;
    atWordStart = false;
  }
  return out;
}
