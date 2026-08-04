import { requireSession } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { getHealth } from "../../../lib/events";
import { getKillSwitchStatus } from "../../../lib/entities";
import { healthTone } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";

export const dynamic = "force-dynamic";
export const metadata = { title: "System" };

/** Switch state → tone. `live` is only good when the switch is something you want live. */
function switchTone(state: string, realSpend: boolean): "ok" | "warn" | "bad" | "muted" {
  if (state === "live") {
    // A LIVE real-spend switch is not a "healthy" green — it means money or messages are
    // genuinely going out. That is a state to be aware of, not to be reassured by.
    return realSpend ? "warn" : "ok";
  }
  if (state === "paused") return "warn";
  if (state === "disabled") return "muted";
  return "muted"; // blocked — the safe default posture
}

/**
 * System — health checks and the platform's provider switches.
 *
 * ── DISPLAY ONLY, STRUCTURALLY ──────────────────────────────────────────────────────────
 * There is no toggle on this page and there cannot be one: enabling a real provider is an
 * env/deploy action, staging-first and key-required (CLAUDE.md §2 #5), and the API has no
 * enable route by construction. `pause_via` is rendered as DOCUMENTATION — the env lever an
 * operator would actually pull — rather than as a button that would lie about what the
 * portal can do.
 *
 * ── IT DEGRADES BY ROLE RATHER THAN 403-ING ─────────────────────────────────────────────
 * The switch list needs `toggle_kill_switch` (super admin only). Health does not. So a
 * support or analyst admin gets the health half and an honest explanation of the missing
 * half, instead of a page that refuses to load — the health of the platform is not a secret.
 */
export default async function SystemPage() {
  const session = await requireSession();
  const maySeeSwitches = can(session.capabilities, "toggle_kill_switch");

  const [healthRes, switchesRes] = await Promise.allSettled([
    getHealth(),
    maySeeSwitches ? getKillSwitchStatus() : Promise.reject(new Error("no capability")),
  ]);
  const health = healthRes.status === "fulfilled" ? healthRes.value : null;
  const switches = switchesRes.status === "fulfilled" ? switchesRes.value : null;

  const mocked = health
    ? Object.entries(health.checks).filter(([, v]) => healthTone(v) === "warn")
    : [];

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">System</h1>
          <p className="page__sub">
            Live dependency health and the platform&apos;s provider switches.
          </p>
        </div>
      </header>

      {mocked.length > 0 && (
        <section className="notice notice--warn" role="status">
          <strong>
            {mocked.length} dependenc{mocked.length === 1 ? "y is" : "ies are"} simulated.
          </strong>{" "}
          The platform is up, but {mocked.map(([k]) => k.replace(/_/g, " ")).join(", ")}{" "}
          {mocked.length === 1 ? "is" : "are"} not exercising a real provider. A green
          overall status with a mocked dependency behind it is how a staging environment
          looks healthy for weeks while proving nothing.
        </section>
      )}

      <section className="panel" aria-labelledby="sy-health">
        <div className="panel__head">
          <h2 className="panel__title" id="sy-health">
            Dependency health
          </h2>
          <p className="panel__sub">Live from the API health probe.</p>
        </div>

        {health === null ? (
          <p className="empty">The health probe is unreachable.</p>
        ) : (
          <>
            <ul className="health">
              {Object.entries(health.checks).map(([name, value]) => {
                const tone = healthTone(value);
                return (
                  <li className="health__row" key={name}>
                    <span className={`dot dot--${tone}`} aria-hidden="true" />
                    <span className="health__name">{name.replace(/_/g, " ")}</span>
                    <span className={`health__value health__value--${tone}`}>{value}</span>
                  </li>
                );
              })}
            </ul>
            <p className="field__help">
              Environment <strong>{health.environment}</strong>. A check reading{" "}
              <code>mock</code> is deliberately amber, never green.
            </p>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="sy-switches">
        <div className="panel__head">
          <h2 className="panel__title" id="sy-switches">
            Provider switches
          </h2>
          <p className="panel__sub">
            Read-only. Enabling a real provider is an env/deploy action and is never a portal
            toggle — the lever is shown so you know what to pull, not so you can pull it here.
          </p>
        </div>

        {!maySeeSwitches ? (
          <p className="empty">
            Switch state requires the <code>toggle_kill_switch</code> capability (super admin
            only). Dependency health above is available to every admin.
          </p>
        ) : switches === null ? (
          <p className="empty">Switch state is unavailable right now.</p>
        ) : (
          <>
            <div className="tablewrap">
              <table className="table">
                <caption className="sr-only">Provider and operational switches</caption>
                <thead>
                  <tr>
                    <th scope="col">Switch</th>
                    <th scope="col">State</th>
                    <th scope="col">Spends money</th>
                    <th scope="col">Detail</th>
                    <th scope="col">Pause via</th>
                  </tr>
                </thead>
                <tbody>
                  {switches.switches.map((s) => (
                    <tr key={s.key}>
                      <td>
                        {s.label}
                        <span className="table__meta">{s.category.replace(/_/g, " ")}</span>
                      </td>
                      <td>
                        <StatusPill
                          value={s.state}
                          tone={switchTone(s.state, s.real_spend)}
                          title={
                            s.state === "live" && s.real_spend
                              ? "Live AND spends real money — worth knowing, not reassuring"
                              : undefined
                          }
                        />
                      </td>
                      <td className="table__meta">{s.real_spend ? "yes" : "no"}</td>
                      <td className="table__meta">{s.detail ?? "—"}</td>
                      <td>
                        <code className="mono">{s.pause_via}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="field__help">{switches.note}</p>
          </>
        )}
      </section>
    </div>
  );
}
