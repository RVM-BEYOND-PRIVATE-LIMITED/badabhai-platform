/**
 * The BadaBhai Admin lockup: the two-figure monogram on its tile, the BADABHAI logotype, and
 * the "Admin" sub-line. Shared by the sidebar (on the Shift Blue band) and the two
 * unauthenticated pages, sign-in and invite-accept (monogram on its own navy tile), so they
 * cannot drift. The layout and colour live in the `.bb-lockup*` classes of
 * `@badabhai/design-tokens`; nothing is styled here. Both images are the Sept 2026 brand kit's
 * files in public/brand/ — the logotype is white on the band and Shift Blue on a light page.
 *
 * ACCESSIBLE NAME. The monogram is decorative (`alt=""`, `aria-hidden`); the logotype carries
 * `alt="BadaBhai"`, and the space before the sub-line makes the whole read "BadaBhai Admin".
 *
 * Plain `<img>`s, not `next/image`: this app ships without `sharp` (see next.config.mjs), and
 * small PNGs served from `public/` need no optimizer. Intrinsic width/height are set so the
 * browser reserves the box before the file arrives.
 */

const MARK_SRC = "/brand/badabhai-mark.png";
const MARK_INTRINSIC_SIZE = 192;
const WORDMARK_SRC = { light: "/brand/badabhai-wordmark-navy.png", ink: "/brand/badabhai-wordmark.png" };
const WORDMARK_W = 716;
const WORDMARK_H = 96;

export type BrandLockupSurface = "light" | "ink";

export function BrandLockup({ surface = "light" }: { surface?: BrandLockupSurface }) {
  return (
    <span className={surface === "ink" ? "bb-lockup bb-lockup--on-ink" : "bb-lockup"}>
      <span className="bb-lockup__tile">
        <img
          className="bb-lockup__mark"
          src={MARK_SRC}
          alt=""
          aria-hidden="true"
          width={MARK_INTRINSIC_SIZE}
          height={MARK_INTRINSIC_SIZE}
        />
      </span>
      <span className="bb-lockup__text">
        <img
          className="bb-lockup__wordmark"
          src={WORDMARK_SRC[surface]}
          alt="BadaBhai"
          width={WORDMARK_W}
          height={WORDMARK_H}
        />{" "}
        <span className="bb-lockup__sub">Admin</span>
      </span>
    </span>
  );
}
