/**
 * The BadaBhai Admin lockup: the two-figure monogram on its tile, the BADABHAI logotype, and
 * the "Admin" sub-line. Shared by the sidebar (on the Shift Blue band) and the two
 * unauthenticated pages, sign-in and invite-accept (monogram on its own navy tile), so they
 * cannot drift. Layout, colour AND the brand-kit images live in the `.bb-lockup*` classes of
 * `@badabhai/design-tokens` (the images are CSS backgrounds bundled under /_next/static, so
 * they cache even behind this app's `no-store` catch-all); nothing is styled here.
 *
 * ACCESSIBLE NAME. Both images are decorative (`aria-hidden`); the name is the visually hidden
 * "BadaBhai" plus the visible sub-line, and the space between them makes it read
 * "BadaBhai Admin" rather than "BadaBhaiAdmin".
 */

export type BrandLockupSurface = "light" | "ink";

export function BrandLockup({ surface = "light" }: { surface?: BrandLockupSurface }) {
  return (
    <span className={surface === "ink" ? "bb-lockup bb-lockup--on-ink" : "bb-lockup"}>
      <span className="bb-lockup__tile" aria-hidden="true">
        <span className="bb-lockup__mark" />
      </span>
      <span className="bb-lockup__text">
        <span className="bb-lockup__wordmark" aria-hidden="true" />
        <span className="sr-only">BadaBhai</span>{" "}
        <span className="bb-lockup__sub">Admin</span>
      </span>
    </span>
  );
}
