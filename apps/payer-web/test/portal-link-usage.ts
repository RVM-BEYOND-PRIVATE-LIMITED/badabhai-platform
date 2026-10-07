import ts from "typescript";

/**
 * How a source file names the portal's link wrapper (components/portal-link.tsx) and the pending
 * cue (components/nav-pending.tsx), read from its syntax tree — shared by the suites that must
 * agree on it (app/every-link-shows-the-cue.test.ts, app/nav-pending.css.test.ts).
 */

/** A module specifier without its script extension: `./nav-pending.tsx` → `./nav-pending`. */
export function specifierStem(specifier: string): string {
  for (const ext of [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]) {
    if (specifier.endsWith(ext)) return specifier.slice(0, -ext.length);
  }
  return specifier;
}

/** Does `specifier` load the module named `name` (`./name`, `../x/name`, `@/x/name`, `name.tsx`)? */
export function loadsModule(specifier: string | null, name: string): boolean {
  if (specifier === null) return false;
  const stem = specifierStem(specifier);
  return stem === name || stem.endsWith(`/${name}`);
}

/**
 * A predicate over JSX tag names: is this tag the wrapper? Follows the file's own imports — the
 * name it is imported under (`{ PortalLink as L }` → `<L>`) and a namespace import
 * (`* as P` → `<P.PortalLink>`).
 */
export function portalLinkTags(sf: ts.SourceFile): (tag: ts.JsxTagNameExpression) => boolean {
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!loadsModule(st.moduleSpecifier.text, "portal-link")) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if ((el.propertyName ?? el.name).text === "PortalLink") locals.add(el.name.text);
      }
    }
  }
  return (tag) =>
    (ts.isIdentifier(tag) && locals.has(tag.text)) ||
    (ts.isPropertyAccessExpression(tag) &&
      ts.isIdentifier(tag.expression) &&
      namespaces.has(tag.expression.text) &&
      tag.name.text === "PortalLink");
}
