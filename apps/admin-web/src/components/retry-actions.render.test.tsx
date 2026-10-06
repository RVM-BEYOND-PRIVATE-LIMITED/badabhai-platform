import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FirstPageAction, RetryActions } from "./retry-actions";

/**
 * The recoveries under a failed read of a paged list (docs/design/NAVIGATION.md): "Retry"
 * repeats exactly the current query, cursor included; "Back to the first page" is that query
 * without the cursor, offered only when there is one.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
/** The href of the link labelled `label` — string search, no RegExp built from the label. */
const hrefOf = (out: string, label: string): string | null => {
  const end = out.indexOf(`</i>${label}</a>`);
  if (end < 0) return null;
  const start = out.lastIndexOf('href="', end) + 'href="'.length;
  return out.slice(start, out.indexOf('"', start)).replace(/&amp;/g, "&");
};

describe("RetryActions", () => {
  it("without a cursor: Retry alone, to the query as it is", () => {
    const out = html(<RetryActions href="/workers" />);
    expect(hrefOf(out, "Retry")).toBe("/workers");
    expect(out).not.toContain("Back to the first page");
  });

  it("with a cursor: Retry keeps it, and the first page drops it", () => {
    const out = html(<RetryActions href="/workers" cursor="Y3Vyc29y" />);
    expect(hrefOf(out, "Retry")).toBe("/workers?cursor=Y3Vyc29y");
    expect(hrefOf(out, "Back to the first page")).toBe("/workers");
  });

  it("keeps the filters on both, and appends the cursor after them", () => {
    const out = html(<RetryActions href="/feedback?category=problem" cursor="Y3Vyc29y" />);
    expect(hrefOf(out, "Retry")).toBe("/feedback?category=problem&cursor=Y3Vyc29y");
    expect(hrefOf(out, "Back to the first page")).toBe("/feedback?category=problem");
  });

  it("encodes the cursor — it is an opaque value from the server", () => {
    const out = html(<RetryActions href="/events" cursor="a+b/c=" />);
    expect(hrefOf(out, "Retry")).toBe("/events?cursor=a%2Bb%2Fc%3D");
  });
});

/**
 * A REFUSED read (a 400) is not retried — the request would only be refused again — so its state
 * offers the first page alone, filters kept, when there is a cursor to drop.
 */
describe("FirstPageAction", () => {
  it("with a cursor: the first page of the same query, and no Retry", () => {
    const out = html(<FirstPageAction href="/jobs?status=open" cursor="c2" />);
    expect(hrefOf(out, "Back to the first page")).toBe("/jobs?status=open");
    expect(out).not.toContain("Retry");
    expect(out).toContain('class="state__actions"');
  });

  it("without one renders nothing — the address already is the first page", () => {
    expect(html(<FirstPageAction href="/jobs" cursor={undefined} />)).toBe("");
  });
});

/**
 * EVERY use passes the page's cursor. A RetryActions without one renders a "Retry" that drops
 * the page the read failed on — exactly the behaviour it exists to replace — and type-checks
 * fine, because `cursor` is optional for the first page of a list. Read with the TypeScript AST.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The recoveries whose `cursor` decides what they offer — every use must pass it. */
const RECOVERIES = new Set(["RetryActions", "FirstPageAction"]);

function uses(fileName: string, source: string): { line: number; attrs: string[] }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; attrs: string[] }[] = [];
  const visit = (node: ts.Node): void => {
    const el = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;
    if (el && RECOVERIES.has(el.tagName.getText(sf))) {
      found.push({
        line: sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1,
        attrs: el.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((a) => a.name.getText(sf)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const ALL = (() => {
  const out: { file: string; line: number; attrs: string[] }[] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(ent.name)) {
        const file = relative(srcRoot, full).replace(/\\/g, "/");
        for (const u of uses(file, readFileSync(full, "utf8"))) out.push({ file, ...u });
      }
    }
  })(srcRoot);
  return out;
})();

describe("every RetryActions carries the page's cursor", () => {
  it("the detector reads attributes from the AST", () => {
    expect(uses("t.tsx", 'const a = <RetryActions href="/x" cursor={c} />;')).toEqual([
      { line: 1, attrs: ["href", "cursor"] },
    ]);
    expect(uses("t.tsx", 'const a = <RetryActions href="/x" />;')[0]!.attrs).toEqual(["href"]);
    expect(uses("t.tsx", 'const a = <FirstPageAction href="/x" />;')[0]!.attrs).toEqual(["href"]);
  });

  it("is used by every paged list that can fail", () => {
    const files = new Set(ALL.map((u) => u.file));
    for (const f of [
      "app/(portal)/workers/page.tsx",
      "app/(portal)/jobs/page.tsx",
      "app/(portal)/events/page.tsx",
      "app/(portal)/companies/page.tsx",
      "app/(portal)/agencies/page.tsx",
      "components/entity-timeline.tsx",
      "app/(portal)/transactions/page.tsx",
      "app/(portal)/credits/page.tsx",
      "app/(portal)/skills/discovery/page.tsx",
      "app/(portal)/ai-calls/page.tsx",
      "app/(portal)/feedback/page.tsx",
      "app/(portal)/workers/[id]/journey/page.tsx",
    ]) {
      expect(files.has(f), f).toBe(true);
    }
  });

  it("and every use passes both the query and the cursor", () => {
    const missing = ALL.filter((u) => !u.attrs.includes("cursor") || !u.attrs.includes("href")).map(
      (u) => `${u.file}:${u.line}`,
    );
    expect(missing).toEqual([]);
  });
});
