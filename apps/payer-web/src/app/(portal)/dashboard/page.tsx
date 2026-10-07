import Link from "next/link";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import { getCredits, getPostings, getUnlocks } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { unlockUnitPriceInr } from "../../../lib/pricing-config";
import { postingRoutes } from "../../../lib/posting-routes";
import { recentUnlockRows } from "../../../lib/unlock-history";
import { Badge, Card, StatTile } from "../../../components/ds";
import { PageHeader } from "../../../components/page-header";
import { RetryButton } from "../../../components/retry-button";
import { formatInr } from "../../../lib/format";
import { AgentSections } from "./agent-sections";
import { buildAttentionItems } from "./attention";

export const dynamic = "force-dynamic";

/**
 * Payer dashboard — rebuilt as a COMMAND CENTRE (UI-1).
 *
 * The screen used to be three counters and two lists at equal visual weight, which answered
 * "what are my totals?" but never "what needs me?". It now reads top-down in the order a
 * payer actually needs:
 *
 *   1. NEEDS YOU     — only rendered when something genuinely does (see attention.ts).
 *   2. POSITION      — the counters, now secondary to the alerts above them.
 *   3. DO SOMETHING  — the high-frequency actions, as first-class targets.
 *   4. YOUR WORK     — the postings themselves.
 *   5. RECENT        — unlock history, quietest of the five.
 *
 * Nothing here invents data: every alert is a statement about a field that is in the
 * payload, and no new endpoint was added.
 *
 * UNCHANGED: the authz path (requirePayer → XB-A binds every read to the server-held payer
 * id), the role branching, and the FACELESS invariant — no worker name, phone or opaque id
 * ever reaches the DOM; a recent-unlock row carries its dates and status, plus its posting's
 * title when the unlock was made from one of the payer's own company postings.
 *
 * MERGE-1 (agent branch): when `session.role === "agent"` the agency demand modules render
 * INLINE below via {@link AgentSections}, a SERVER component that re-asserts requireAgent(),
 * fail-closes on the portal flag, and wraps every agency payload in assertNoAgencyPII.
 *
 * DATA-COHERENCE (the agent case): the shared top reads the EMPLOYER `job-postings` entity
 * while the agency modules read the `jobs.payer_id` entity — DIFFERENT data sets for an
 * agent. The agency data is the source of truth for their postings, so the shared top OMITS
 * its `job-postings`-derived tile and section for agents.
 *
 * ONE DOOR PER DESTINATION (owner ruling 2026-10-01). "New posting" is the head's one primary
 * action — for an agency it opens the AGENCY form (`jobs`), never the company one. The Postings
 * list is reached from the "Your postings" panel alone. A posting card opens THAT POSTING, and its
 * "Applicants" action opens the feed — the one rule on every surface (F12, as on the agency
 * dashboard). The counters are counts, the balance included; an unlock row is a door only to the
 * applicants of the own posting it names (where that worker shows unlocked). There is
 * no standing door to Credits on the page (F15 — a "Buy credits" card repeated the header's balance
 * chip): a member whose balance is empty or low gets the needs-you item's own contextual "Buy
 * credits" — the one labelled way to buy, shown exactly when it matters. A needs-you item shows no
 * button for a destination the page itself already offers (the head's New posting, a quick
 * action). Credits is open to every member, Owner or Recruiter (owner ruling 2026-10-07), so the
 * page takes no org role at all. Plans & capacity is a company page (it sells company-posting
 * entitlements), so an agency gets no card.
 *
 * EACH PART IS READ ON ITS OWN (F29). Credits, unlocks and (for a company) postings are three
 * reads; one failing used to replace the WHOLE page with "We could not load your account" — the
 * postings, the needs-you band and the head's New posting with it. Now a failed part is `null`:
 * its counter shows a neutral "—", its panel its own error state with Retry, and it raises no
 * needs-you item (an unread balance is not an empty wallet). The head always renders.
 *
 * READS: an agency session never asks for the company postings list — it shows none, and the
 * backend gate for it is #1885. The per-unlock price comes from the live catalog (the same source
 * as Credits), never a literal.
 */
export default async function DashboardPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const posting = postingRoutes(isAgency);
  // The per-unlock price (the same source as Credits), read BESIDE the three reads. It never
  // rejects (a failed read is the compile-time catalog).
  const catalog = getLiveCatalog();

  // Three independent reads (F29): one failing never takes the others — or the page — with it.
  // An agency never reads the company postings list (it shows none).
  const [creditsRead, unlocksRead, postingsRead] = await Promise.allSettled([
    getCredits(),
    getUnlocks(),
    isAgency ? Promise.resolve([]) : getPostings(),
  ]);
  const credits = readValue(creditsRead);
  const unlocks = readValue(unlocksRead);
  const postings = readValue(postingsRead);

  // No caption when the catalog offers no unlock price.
  const unitPrice = unlockUnitPriceInr(await catalog);
  // Newest first by the day each row prints (a re-grant moves it; the API's order does not).
  // An unread list renders the panel's error state instead (below), never these rows. A row
  // names a posting only from the postings list this page already read (no read of its own): an
  // agency reads none, and a failed postings read leaves every row plain.
  const recentUnlocks = recentUnlockRows(unlocks ?? [], postings ?? [], Date.now());
  const attention = buildAttentionItems({ credits, unlocks, postings }, { isAgency });
  const quick = quickActions({ isAgency });
  // The destinations this page ALREADY offers — the head's primary and the quick actions it
  // renders: an attention item does not repeat one. (The shell's balance chip is not one: it
  // shows a number and hides when its read fails — so the empty/low-balance item keeps its own
  // labelled "Buy credits".)
  const pageDoors = new Set<string>([
    ...(posting ? [posting.create] : []),
    ...quick.map((q) => q.href),
  ]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          isAgency
            ? "Your postings, referred workers and unlocked contacts."
            : "Your postings, credits and unlocked contacts — and anything that needs you."
        }
        primaryAction={
          posting
            ? { href: posting.create, label: "New posting", icon: ACTION_ICON.create }
            : undefined
        }
      />

      {/* 1 · NEEDS YOU — absent entirely when nothing does, so its presence always means
          something. A permanent "all clear" panel trains people to stop reading it. */}
      {attention.length > 0 ? (
        <section className="attention" aria-labelledby="attention-heading">
          <h2 className="attention__heading" id="attention-heading">
            Needs your attention
          </h2>
          <ul className="attention__list">
            {attention.map((item) => (
              <li className={`attention__item attention__item--${item.tone}`} key={item.id}>
                <Icon name={TONE_ICON[item.tone]} className="attention__icon" />
                <div className="attention__text">
                  <p className="attention__title">{item.title}</p>
                  <p className="attention__body">{item.body}</p>
                </div>
                {item.actionHref && !pageDoors.has(item.actionHref) ? (
                  <Link
                    className="bb-btn bb-btn--secondary bb-btn--sm attention__action"
                    href={item.actionHref}
                  >
                    {item.actionIcon ? <Icon name={item.actionIcon} /> : null}
                    <span>{item.actionLabel}</span>
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 2 · POSITION — the KPI variant: no hole beside a lone third tile, and a compact
          ledger row per tile on a phone so the counters stay secondary to bands 1 and 3. */}
      <div className="stat-row stat-row--kpi">
        {/* A count like its neighbours, never a door: Credits is reached from the header chip
            and, when the balance is empty or low, the needs-you item. */}
        <StatTile
          label="Credit balance"
          value={credits?.balance ?? UNREAD}
          icon={ACTION_ICON.credits}
          caption={
            credits === null ? (
              UNREAD_CAPTION
            ) : unitPrice !== null ? (
              <>
                <span className="bb-mono">{formatInr(unitPrice)}</span> per unlock
              </>
            ) : undefined
          }
        />
        {isAgency ? null : (
          <StatTile
            label="Open postings"
            value={postings === null ? UNREAD : postings.filter((x) => x.status === "open").length}
            icon={ACTION_ICON.posting}
            caption={postings === null ? UNREAD_CAPTION : `${postings.length} total`}
          />
        )}
        {/* No "Revenue — Coming soon" tile (F21): the KPI row holds counts that were read, never
            a placeholder. The parked Revenue page is reached from the rail's "Coming soon"
            group, behind the same agency-portal flag. */}
        {/* A count, not a door: the postings list it used to open shows no unlocks. */}
        <StatTile
          label="Contacts unlocked"
          value={unlocks?.length ?? UNREAD}
          icon={ACTION_ICON.unlock}
          caption={unlocks === null ? UNREAD_CAPTION : "1 credit each"}
        />
      </div>

      {/* 3 · DO SOMETHING — the handful of things a payer does over and over. These were
          previously buried as small links inside section headers. Absent when there are none. */}
      {quick.length > 0 ? (
        <section className="quick" aria-labelledby="quick-heading">
          <h2 className="quick__heading" id="quick-heading">
            Quick actions
          </h2>
          <div className="quick__grid">
            {quick.map((q) => (
              <Link className="quick__card" href={q.href} key={q.href}>
                <span className="quick__icon">
                  <Icon name={q.icon} />
                </span>
                <span className="quick__label">{q.label}</span>
                <span className="quick__desc">{q.description}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* 4 · YOUR WORK — omitted for agents (different entity; see the header note). */}
      {isAgency ? null : (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Your postings</h2>
            <div className="panel__actions">
              {/* The dashboard's ONE link to the Postings list, named as the rail item and the
                  list's H1 name it: one label per destination. */}
              <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/postings">
                <span>Postings</span>
                <Icon name={ACTION_ICON.next} />
              </Link>
            </div>
          </div>
          <div className="panel__body">
            {postings === null ? (
              readFailed(
                "We couldn’t load your postings",
                "Nothing has changed — your postings and their applicants are safe. Retry to read them again.",
              )
            ) : postings.length === 0 ? (
              <div className="state">
                <span className="state__icon">
                  <Icon name={ACTION_ICON.posting} />
                </span>
                <h3 className="state__title">No postings yet</h3>
                {/* What to do next is the page's one primary action, "New posting", above. */}
                <p className="state__body">
                  Matched workers can only find you once a role is live — use New posting above.
                  Posting is free through launch.
                </p>
              </div>
            ) : (
              <div className="dash-postings">
                {postings.slice(0, 6).map((post) => (
                  // Whole-card link to THIS posting's details (F12 — a posting's title always
                  // opens the posting). The id is the posting's OWN opaque uuid (never a worker
                  // id/phone).
                  <Card
                    key={post.id}
                    padding="sm"
                    className="dash-posting"
                    href={`/postings/${post.id}`}
                    ariaLabel={`${post.roleTitle} — view posting`}
                  >
                    <div className="dash-posting__main">
                      <div className="dash-posting__title">{post.roleTitle}</div>
                      {/* The applicant COUNT is deliberately not shown. It is not in the
                          job-posting projection (see toPostingSummary in payer-api.ts), so it
                          was hardcoded to 0 and every row read "0 applicants" — telling an
                          employer they had none when they may have had many. Until the count
                          is on the wire, the row offers the feed instead of a false figure. */}
                      <div className="dash-posting__meta">
                        {post.locationLabel ?? "Location flexible"} · {post.vacancyBand} openings
                      </div>
                    </div>
                    <div className="dash-posting__right">
                      {/* The posting's "Applicants" action (F12/F13): a real link ABOVE the
                          card's stretched overlay (z-index in CSS), named for its posting so a
                          list of them reads apart. The whole card still opens the posting. */}
                      <Link
                        className="dash-posting__applicants"
                        href={`/postings/${post.id}/applicants`}
                        aria-label={`${post.roleTitle} — Applicants`}
                      >
                        <Icon name={ACTION_ICON.users} />
                        <span>Applicants</span>
                      </Link>
                      <Badge tone={post.status === "open" ? "success" : "neutral"} upper>
                        {post.status}
                      </Badge>
                      <span className="dash-posting__cta">
                        View posting
                        <Icon name={ACTION_ICON.next} className="dash-view__arrow" />
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 5 · RECENT — the quietest band. */}
      <section className="panel">
        <div className="panel__head">
          <div className="panel__text">
            <h2 className="panel__title">Recent unlocks</h2>
            <p className="panel__sub">
              Contacts you have revealed. Identities stay masked until you unlock them.
            </p>
          </div>
        </div>
        <div className="panel__body">
          {unlocks === null ? (
            readFailed(
              "We couldn’t load your recent unlocks",
              "Nothing has changed — your unlocked contacts are safe. Retry to read them again.",
            )
          ) : recentUnlocks.length === 0 ? (
            <div className="state">
              <span className="state__icon">
                <Icon name={ACTION_ICON.unlock} />
              </span>
              <h3 className="state__title">No contacts unlocked yet</h3>
              <p className="state__body">
                Open a posting&rsquo;s applicants and unlock one to see their routed contact here.
              </p>
            </div>
          ) : (
            <div className="dash-candlist">
              {recentUnlocks.map((row) => {
                // FACELESS: a row names nobody — no worker id/phone/name reaches the DOM. It says
                // WHEN and whether access is still open — an ended window is a neutral "Expired",
                // never a green "Unlocked" — and, for a company unlock made from one of THIS
                // payer's own postings (#2033's posting context, matched against the list read
                // above), WHICH posting: the row then opens that posting's applicants, where the
                // worker shows unlocked. Any other row names no posting and is not a link. An
                // agency unlock carries its `jobs` id, but this page does not read the agency's
                // jobs (AgentSections reads them itself, behind its own role gate and flag), so an
                // agency row stays plain; the agency applicant feed shows the held unlock (#2053).
                // `href` and its accessible name travel together (the DS link contract).
                const link = row.posting
                  ? {
                      href: `/postings/${row.posting.id}/applicants`,
                      ariaLabel: `${row.posting.title} — Applicants`,
                    }
                  : {};
                return (
                  <Card key={row.key} padding="sm" className="dash-unlock" {...link}>
                    <div className="dash-unlock__main">
                      <div className="dash-unlock__title">
                        {row.posting ? row.posting.title : "Unlocked contact"}
                      </div>
                      <div className="dash-unlock__meta">
                        Unlocked <span className="bb-mono">{row.unlockedOn}</span> ·{" "}
                        {row.live ? "until" : "ended"} <span className="bb-mono">{row.endsOn}</span>
                      </div>
                    </div>
                    <div className="dash-unlock__right">
                      <Badge tone={row.live ? "success" : "neutral"} upper>
                        {row.live ? "Unlocked" : "Expired"}
                      </Badge>
                      {row.posting ? (
                        <span className="dash-unlock__cta">
                          Applicants
                          <Icon name={ACTION_ICON.next} className="dash-view__arrow" />
                        </span>
                      ) : null}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* MERGE-1: agency demand modules render INLINE for an AGENT only. */}
      {isAgency ? <AgentSections /> : null}
    </>
  );
}

/** A counter whose read failed: neutral, never a 0 that was not read (F29). */
const UNREAD = "—";
const UNREAD_CAPTION = "Not available right now";

/** A settled read's value, or null when it failed (the page shows that part's own state). */
function readValue<T>(read: PromiseSettledResult<T>): T | null {
  return read.status === "fulfilled" ? read.value : null;
}

/**
 * A panel whose read failed (F29): the shared error state, in place of the panel's content, with
 * an in-page Retry. Neutral copy — it never carries the backend's reason.
 */
function readFailed(title: string, body: string) {
  return (
    <div className="state state--error">
      <span className="state__icon">
        <Icon name="warning-circle" />
      </span>
      <h3 className="state__title">{title}</h3>
      <p className="state__body">{body}</p>
      <div className="state__actions">
        <RetryButton />
      </div>
    </div>
  );
}

const TONE_ICON: Record<"critical" | "warning" | "info", IconName> = {
  critical: "warning-octagon",
  warning: "warning",
  info: "info",
};

interface QuickAction {
  href: string;
  label: string;
  description: string;
  icon: IconName;
}

/**
 * The high-frequency actions that are NOT already on this page. "New posting" is the head's
 * primary, and each posting card opens its posting, so neither is repeated here; an agency's
 * invite tools live in its own sections (agent-sections.tsx), and quick actions add none; and
 * Credits is reached from the header chip — and, at an empty or low balance, the needs-you item's
 * "Buy credits" — so there is no "Buy credits" card (F15). Every card follows its destination's
 * gate: Plans & capacity is a COMPANY page, so an agency has none.
 */
function quickActions({ isAgency }: { isAgency: boolean }): QuickAction[] {
  if (isAgency) return [];
  return [
    {
      href: "/plans",
      label: "Plans & capacity",
      description: "How many postings you can run at once.",
      icon: "chart-donut",
    },
  ];
}
