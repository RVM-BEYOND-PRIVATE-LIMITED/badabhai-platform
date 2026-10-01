import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * Not found, inside the portal chrome — so an operator who mistypes an id keeps their
 * navigation and can carry on, rather than being dropped onto a bare page.
 *
 * DS: the shared `.state` block with the recovery action in `.state__actions`. The state itself
 * draws no glyph — the title and body carry the meaning; the recovery action carries its own.
 */
export default function PortalNotFound() {
  return (
    <div className="state">
      <h1 className="state__title">Not found</h1>
      <p className="state__body">
        That record does not exist, or it has been removed. If you followed a link from an
        incident report, the id may refer to a different environment.
      </p>
      <div className="state__actions">
        <Link className="btn btn--primary" href="/">
          <Icon name={ACTION_ICON.back} />
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
