import Link from "next/link";
import type { CompanyDetail } from "../lib/companies";
import { formatRelative, shortId, timestampTitle } from "../lib/format";
import { queryHref } from "../lib/query-href";
import { StatusPill } from "./status-pill";
import { CopyId } from "./copy-id";
import { ACTION_ICON, Icon } from "@badabhai/icons";

const ORG_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  member: "Member",
};

/**
 * The Users tab (A9, #2579): the company's founder plus every team login, and one link into
 * User accounts filtered to the organisation (`/accounts?org_id=…`). No login identifier or
 * contact is rendered here — those live on the User accounts surface behind its own capability.
 */
export function CompanyUsersTab({
  company,
  mayOpenAccounts,
}: {
  company: CompanyDetail;
  mayOpenAccounts: boolean;
}) {
  const accountsHref =
    mayOpenAccounts && company.org_id
      ? queryHref("/accounts", { org_id: company.org_id })
      : null;
  const noun = company.kind === "employer" ? "company" : "agency";

  return (
    <div className="company-users">
      <div className="panel__head panel__head--row">
        <div>
          <h2 className="panel__title">Users</h2>
          <p className="panel__sub">
            The founder and every invited or active team login. User accounts holds the login
            identifiers and credential actions.
          </p>
        </div>
        {accountsHref ? (
          <Link className="btn btn--ghost" href={accountsHref}>
            <Icon name={ACTION_ICON.users} />
            Open User accounts
          </Link>
        ) : null}
      </div>

      {company.org_id === null ? (
        <div className="state">
          <h3 className="state__title">No organisation record yet</h3>
          <p className="state__body">
            This {noun} has not completed sign-up, so it has no team organisation to filter User
            accounts by.
          </p>
        </div>
      ) : (
        <>
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Team logins for this company</caption>
              <thead>
                <tr>
                  <th scope="col">Login</th>
                  <th scope="col">Org role</th>
                  <th scope="col">Membership</th>
                  <th scope="col">Account status</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Invited</th>
                  <th scope="col">Accepted</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <span className="tag">Founder</span>
                    <span className="mono" title={company.id}>
                      {shortId(company.id)}
                    </span>
                    <CopyId id={company.id} label="founder login id" />
                  </td>
                  <td>Owner</td>
                  <td>—</td>
                  <td>
                    <StatusPill value={company.status} />
                  </td>
                  <td>
                    {company.last_login_at ? (
                      <time
                        dateTime={company.last_login_at}
                        title={timestampTitle(company.last_login_at)}
                      >
                        {formatRelative(company.last_login_at)}
                      </time>
                    ) : (
                      <span className="table__meta">Never</span>
                    )}
                  </td>
                  <td>—</td>
                  <td>—</td>
                </tr>
                {company.members.map((member) => (
                  <tr key={member.member_id}>
                    <td>
                      {member.payer_id ? (
                        <>
                          <span className="mono" title={member.payer_id}>
                            {shortId(member.payer_id)}
                          </span>
                          <CopyId id={member.payer_id} label="member login id" />
                        </>
                      ) : (
                        <span className="table__meta">Invite not accepted</span>
                      )}
                    </td>
                    <td>{ORG_ROLE_LABELS[member.org_role] ?? member.org_role.replace(/_/g, " ")}</td>
                    <td>
                      <StatusPill value={member.member_status} />
                    </td>
                    <td>
                      {member.payer_status ? (
                        <StatusPill value={member.payer_status} />
                      ) : (
                        <span className="table__meta">—</span>
                      )}
                    </td>
                    <td>
                      {member.last_login_at ? (
                        <time
                          dateTime={member.last_login_at}
                          title={timestampTitle(member.last_login_at)}
                        >
                          {formatRelative(member.last_login_at)}
                        </time>
                      ) : (
                        <span className="table__meta">Never</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={member.invited_at} title={timestampTitle(member.invited_at)}>
                        {formatRelative(member.invited_at)}
                      </time>
                    </td>
                    <td>
                      {member.accepted_at ? (
                        <time
                          dateTime={member.accepted_at}
                          title={timestampTitle(member.accepted_at)}
                        >
                          {formatRelative(member.accepted_at)}
                        </time>
                      ) : (
                        <span className="table__meta">Not yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field__help">
            {accountsHref ? (
              <>
                Login identifiers and password actions are on{" "}
                <Link className="link" href={accountsHref}>
                  User accounts
                </Link>
                , filtered to this organisation.
              </>
            ) : (
              "Login identifiers and password actions sit on User accounts, which your role cannot open."
            )}
          </p>
        </>
      )}
    </div>
  );
}
