import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import { getAppReleasePolicies } from "../../../lib/app-release-policy";
import {
  APP_RELEASE_NOT_READY,
  orderPolicies,
  type AppReleasePolicy,
} from "../../../lib/app-release-policy-model";
import { PageHeader } from "../../../components/page-header";
import { AppVersionCard } from "./app-version-card";

export const dynamic = "force-dynamic";
export const metadata = { title: "App versions" };

const TITLE = "App versions";
const DESCRIPTION =
  "The oldest build of each app that may still write, and the build that counts as the newest.";

function FailedState({ heading, body }: { heading: string; body: string }) {
  return (
    <section className="panel" aria-labelledby="app-versions-unavailable">
      <div className="state state--error">
        <h2 className="state__title" id="app-versions-unavailable">
          {heading}
        </h2>
        <p className="state__body">{body}</p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/app-versions">
            <Icon name={ACTION_ICON.retry} />
            Retry
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * App versions (#3058) — the minimum supported build of the worker app and the company app, per
 * platform (the API half is #3048). A build below the minimum is blocked from writing until it
 * updates; a build below the latest sees a "new version available" notice.
 *
 * Only a session holding `manage_app_release_policy` may open it (super_admin on the API). The
 * read is server-side and fresh; a failed read is an honest error state with Retry, never four
 * empty cards, and a 503 says the migration is still pending.
 */
export default async function AppVersionsPage() {
  const session = await requireCapability("manage_app_release_policy");

  let policies: AppReleasePolicy[];
  try {
    policies = orderPolicies(await getAppReleasePolicies());
  } catch (err) {
    if (!isAdminRequestError(err)) throw err;
    return (
      <div className="page page--reading">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        {err.status === 503 ? (
          <FailedState heading="App versions are not available yet" body={APP_RELEASE_NOT_READY} />
        ) : (
          <FailedState
            heading="App versions are unavailable"
            body="The app version settings did not load. That is a fault on our side, not an empty list."
          />
        )}
      </div>
    );
  }

  return (
    <div className="page page--reading">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      {policies.map((policy) => (
        <AppVersionCard
          key={`${policy.app}-${policy.platform}`}
          policy={policy}
          selfId={session.adminId}
        />
      ))}
    </div>
  );
}
