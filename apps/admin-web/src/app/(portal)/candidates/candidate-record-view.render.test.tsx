import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  candidateRecord,
  facelessRecord,
  RECORD_POSTING_ID,
  RECORD_WORKER_ID,
} from "../../../../test/candidate-record";
import type { CandidateDetail } from "../../../lib/candidate-detail";
import { CANDIDATE_FIELDS, SOURCE_TAGS } from "../../../lib/candidate-view";
import { LOCK_REASONS } from "./locked-tag";

/**
 * A7 (#2577) — the drawer's seven tabs as rendered, from a full #2560 record: every field with
 * its value and a humanised source tag, the three locked fields, the name in each posture (never
 * an empty string), the honest empty Edit log, and no edit control anywhere.
 */

// The reveal is its own test (phone-reveal.render.test.tsx): here it is a marker.
vi.mock("./phone-reveal", () => ({
  PhoneField: ({ canReveal }: { canReveal: boolean }) => (
    <span data-phone-field={canReveal ? "can-reveal" : "cannot"} />
  ),
}));

const { CANDIDATE_TABS, CandidateRecordPanels, SourceTag, recordSummary } =
  await import("./candidate-record-view");

type Tab = (typeof CANDIDATE_TABS)[number]["id"];

const render = (
  detail: CandidateDetail = candidateRecord(),
  opts: { entitled?: boolean; canReveal?: boolean; active?: Tab } = {},
) =>
  renderToStaticMarkup(
    <CandidateRecordPanels
      detail={detail}
      entitled={opts.entitled ?? true}
      canReveal={opts.canReveal ?? true}
      active={opts.active ?? "profile"}
      idBase="t"
    />,
  );

/** One panel's markup. */
function panel(html: string, tab: Tab): string {
  const at = html.indexOf(`id="t-panel-${tab}"`);
  expect(at, tab).toBeGreaterThan(0);
  const start = html.lastIndexOf("<section", at);
  const end = html.indexOf('<section class="cdrawer__panel"', at);
  return html.slice(start, end < 0 ? undefined : end);
}

describe("the seven tabs", () => {
  it("are Profile · Work history · Skills · Applications · Resume · Activity · Edit log", () => {
    expect(CANDIDATE_TABS.map((t) => t.label)).toEqual([
      "Profile",
      "Work history",
      "Skills",
      "Applications",
      "Resume",
      "Activity",
      "Edit log",
    ]);
  });

  it("each is a tabpanel named by its tab; only the active one is shown", () => {
    const html = render(candidateRecord(), { active: "skills" });
    for (const t of CANDIDATE_TABS) {
      const p = panel(html, t.id);
      expect(p).toContain(`role="tabpanel"`);
      expect(p).toContain(`aria-labelledby="t-tab-${t.id}"`);
      if (t.id === "skills") expect(p).not.toMatch(/^<section[^>]*hidden/);
      else expect(p).toMatch(/^<section[^>]*hidden=""/);
    }
  });
});

describe("every field, with its value and where it came from", () => {
  const html = render();

  it("every field of the record is on a tab, under its one label", () => {
    for (const f of CANDIDATE_FIELDS) {
      // Work history is a list of employers, so its label heads its own section.
      const labelled =
        f.key === "work_history"
          ? `<h3 class="panel__section-title">${f.label}</h3>`
          : `<dt class="kv__k">${f.label}</dt>`;
      expect(html, f.key).toContain(labelled);
    }
  });

  it("a source tag beside each — one per field, plus each match skill and the profile's own", () => {
    const tags = html.match(/class="source-tag"/g) ?? [];
    expect(tags.length).toBe(
      CANDIDATE_FIELDS.length + candidateRecord().skills.match_skills.length + 1,
    );
  });

  it("the tags are humanised, and a raw source code never reaches the screen", () => {
    expect(html).toContain('title="The worker&#x27;s own answer or edit in the app.">');
    expect(html).toContain("Worker edit</span>");
    expect(html).toContain("Resume import</span>");
    for (const code of Object.keys(SOURCE_TAGS)) {
      expect(html).not.toContain(`>${code}<`);
    }
  });

  it("SourceTag tells a screen reader it is a source", () => {
    expect(renderToStaticMarkup(<SourceTag source="form" />)).toBe(
      '<span class="source-tag" title="From the trade form or the general form."><span class="sr-only">Source: </span>Form</span>',
    );
  });

  it("an empty value is a dash beside a Not stored tag", () => {
    const d = candidateRecord();
    d.location.current_state = { value: null, source: "none", correction: null };
    d.skills.machines = { value: [], source: "none", correction: null };
    const out = render(d);
    expect(out).toContain(
      '<dt class="kv__k">State</dt><dd class="kv__v"><span class="cfield"><span class="cfield__value"><span class="table__meta">—</span></span><span class="source-tag" title="Nothing is stored for this field."><span class="sr-only">Source: </span>Not stored</span>',
    );
  });

  it("values read as words — the salary band in ₹, months with years, an unanswered yes/no", () => {
    expect(html).toContain('<span class="ui-num">₹18,000–₹22,000</span>');
    expect(html).toContain("48 months (4 yr)");
    expect(html).toContain("Not answered");
    expect(html).toContain("Within a week · 15 days notice");
    expect(html).toContain("TIG Welder — Operator (confirmed)");
  });

  it("the worker id is there in full, with its copy button", () => {
    expect(html).toContain(`<span class="mono">${RECORD_WORKER_ID}</span>`);
    expect(html).toContain('aria-label="Copy worker id"');
  });
});

describe("locked: name, phone, WhatsApp and photo visibility", () => {
  const html = panel(render(), "profile");

  it("all four sit in the Locked group; name, WhatsApp and photo visibility carry their reasons here", () => {
    const locked = html.slice(html.indexOf(">Locked</h3>"), html.indexOf(">Identity</h3>"));
    expect(locked).toContain("Name</dt>");
    expect(locked).toContain("Phone</dt>");
    expect(locked).toContain("WhatsApp</dt>");
    expect(locked).toContain("Photo on resume</dt>");
    // The phone's own lock is drawn by the reveal field (phone-reveal.render.test.tsx).
    for (const why of [LOCK_REASONS.name, LOCK_REASONS.whatsapp, LOCK_REASONS.photo]) {
      expect(locked).toContain(why.replace(/'/g, "&#x27;"));
    }
    expect(locked.match(/class="lock-tag" role="img" aria-label="Locked"/g)?.length).toBe(3);
  });

  it("the reason is the tag's description, in the console's shared tooltip, reachable by keyboard", () => {
    expect(html).toMatch(
      /<span class="lock-tag" role="img" aria-label="Locked" aria-describedby="([^"]+)" tabindex="0">.*?<span class="bb-icon-tip bb-icon-tip--top-start" role="tooltip" id="\1">/,
    );
  });

  it("the phone row is the reveal field (its own test), offered by capability", () => {
    expect(html).toContain('data-phone-field="can-reveal"');
    expect(panel(render(candidateRecord(), { canReveal: false }), "profile")).toContain(
      'data-phone-field="cannot"',
    );
  });

  it("NOTHING on any tab is an edit control — corrections are #2561", () => {
    const all = render();
    expect(all).not.toMatch(/>\s*Edit\s*</);
    expect(all).not.toMatch(/<(input|textarea|select)\b/);
    expect(all.match(/<button\b/g)?.length ?? 0).toBe(
      (all.match(/aria-label="Copy [^"]+"/g) ?? []).length,
    );
  });
});

describe("the name — never an empty string", () => {
  it("named: the name", () => {
    expect(panel(render(), "profile")).toMatch(
      /Name<\/dt><dd class="kv__v"><span class="cfield"><span class="cfield__value">Ramesh Kumar<\/span>/,
    );
  });

  it("named, with none on record: the console's dash that says what a dash means", () => {
    const d = candidateRecord();
    d.identity.name = { value: null, source: "none", correction: null };
    expect(panel(render(d), "profile")).toContain(
      'title="No name on record for this account.">—</span>',
    );
  });

  it("an analyst (no read_identity): hidden FOR THE ROLE, and no withheld banner", () => {
    const html = panel(render(facelessRecord(), { entitled: false }), "profile");
    expect(html).toContain("Hidden for your role");
    expect(html).not.toContain("Names are withheld");
    expect(html).not.toContain("Ramesh");
  });

  it("an entitled admin whose budget is spent: withheld for this read, and the banner says why", () => {
    const html = panel(render(facelessRecord(), { entitled: true }), "profile");
    expect(html).toContain("Withheld — name budget spent");
    expect(html).toContain("Names are withheld on this page.");
    expect(html).toContain("hourly name budget");
    expect(html).not.toContain("Hidden for your role");
  });
});

describe("the other tabs render exactly the groups the response carries", () => {
  const html = render();

  it("Work history: experience, then each employer's stint and roles — in the worker's words", () => {
    const p = panel(html, "work");
    expect(p).toContain("4 years");
    expect(p).toContain("Automotive · 30 months (2.5 yr)");
    expect(p).toContain("<strong>Pune, Maharashtra</strong> · Apr 2021 – present");
    expect(p).toContain("Welded exhaust frames");
    expect(p).toContain("(declined — the resume prints their own words)");
    expect(p).toContain("Employer names are not shown here.");
  });

  it("Skills: the profile's, what matching reads (with each row's own source) and the employer card", () => {
    const p = panel(html, "skills");
    expect(p).toContain("TIG welding");
    expect(p).toContain('<caption class="sr-only">Match skills</caption>');
    expect(p).toContain("Ops</span>");
    expect(p).toContain("This worker is in the employer search pool");
  });

  it("Applications: the counts and the recent ones, each posting linked to its page", () => {
    const p = panel(html, "applications");
    expect(p).toContain("Applied");
    expect(p).toContain("Skipped");
    expect(p).toContain(`href="/jobs/${RECORD_POSTING_ID}"`);
    expect(p).toContain("Job feed");
  });

  it("Resume: the versions, and NO download — a resume prints the worker's phone", () => {
    const p = panel(html, "resume");
    expect(p).toContain("v2");
    // A finished render is fine, not a warning (the lifecycle map would call it one).
    expect(p).toContain('<span class="pill pill--ok">Rendered</span>');
    expect(p).toContain("Chat edit");
    expect(p).toContain("not offered for download here");
    expect(p).not.toMatch(/href="[^"]*(pdf|download|resume)/i);
  });

  it("Activity: the account, the profile with its source, consent, devices and the flag", () => {
    const p = panel(html, "activity");
    for (const title of ["Account", "Profile", "Consent", "Devices", "Flag"]) {
      expect(p).toContain(`>${title}</h3>`);
    }
    expect(p).toContain("Phone verified");
    expect(p).toContain("Employer sharing");
    expect(p).toContain("Interview</span>");
  });
});

describe("the Edit log", () => {
  it("is an honest empty state while no field carries a correction — never invented history", () => {
    const p = panel(render(), "edits");
    expect(p).toContain("No admin edits");
    expect(p).not.toContain("<table");
  });

  it("claims no closed list of writers — an operator (`ops`) writes values too, and its tag says so", () => {
    const d = candidateRecord();
    // The fixture's own record carries an operator-written value, shown under the Ops tag…
    expect(JSON.stringify(d)).toContain('"source":"ops"');
    const p = panel(render(d), "edits");
    // …so the empty Edit log must not say every value comes from the worker, the interview, a
    // form or the platform. It points at the tags, which name every writer, ops included.
    expect(p).toContain("No admin has corrected a field on this record.");
    expect(p).toContain("Each field&#x27;s source tag says where its value came from.");
    expect(p).not.toContain("Every value comes from");
  });

  it("lists a correction the record does carry, with its reason code and admin", () => {
    const d = candidateRecord();
    d.location.current_city = {
      ...d.location.current_city,
      correction: {
        override_id: "o-1",
        admin_id: "a1a1a1a1-0000-4000-8000-000000000001",
        reason_code: "worker_request",
        created_at: "2026-11-04T10:00:00.000Z",
      },
    };
    const p = panel(render(d), "edits");
    expect(p).toContain("<td>Current city</td>");
    expect(p).toContain("<td>Worker request</td>");
    expect(p).toContain('title="a1a1a1a1-0000-4000-8000-000000000001">a1a1…0001</span>');
  });
});

describe("the summary line", () => {
  it("is the trade and the city, or nothing", () => {
    expect(recordSummary(candidateRecord())).toBe("TIG Welder · Pune");
    const d = candidateRecord();
    d.trade.display_name = { value: null, source: "none", correction: null };
    d.location.current_city = { value: " ", source: "unknown", correction: null };
    expect(recordSummary(d)).toBe("");
  });
});

describe("privacy", () => {
  it("no phone-shaped number appears anywhere on the record's tabs", () => {
    expect(render()).not.toMatch(/(?<![\w-])\+?\d{10,}(?![\w-])/);
  });
});
