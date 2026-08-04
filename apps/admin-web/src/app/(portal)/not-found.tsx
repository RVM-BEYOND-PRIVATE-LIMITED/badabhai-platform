import Link from "next/link";

/**
 * Not found, inside the portal chrome — so an operator who mistypes an id keeps their
 * navigation and can carry on, rather than being dropped onto a bare page.
 */
export default function PortalNotFound() {
  return (
    <div className="state">
      <h1 className="state__title">Not found</h1>
      <p className="state__body">
        That record does not exist, or it has been removed. If you followed a link from an
        incident report, the id may refer to a different environment.
      </p>
      <Link className="btn btn--primary" href="/">
        Back to dashboard
      </Link>
    </div>
  );
}
