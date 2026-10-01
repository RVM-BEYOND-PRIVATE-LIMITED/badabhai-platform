import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import {
  Avatar,
  BadaBhaiLogo,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  IconButton,
  Input,
  MaskedCandidate,
  OtpInput,
  ProgressBar,
  Radio,
  Select,
  StatTile,
  Switch,
  Tabs,
  Textarea,
  Toast,
  Tooltip,
} from "./index";

/**
 * DS0.2 — stories/render test for the shared primitive library.
 *
 * Each primitive is mounted (real SSR via renderToStaticMarkup — the repo's node env,
 * no new deps) in its DEFAULT + a KEY VARIANT, and we assert it emits its `.bb-*` base
 * class and the variant modifier. Props are typed against the matching `.d.ts` (every
 * documented prop is exercised below, so `tsc` is the parity gate). Two cross-cutting
 * checks: the masked candidate never leaks a passed real name, and no wrapper source
 * carries a raw hex/px literal (design-system adherence).
 */
const html = (el: ReactElement): string => renderToStaticMarkup(el);
const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

describe("DS0.2 · primitives render with their design-system classes", () => {
  it("Button — default primary + success/lg/loading variant", () => {
    expect(html(<Button>Go</Button>)).toMatch(/bb-btn bb-btn--primary[^"]*">.*Go/s);
    const v = html(
      <Button variant="success" size="lg" block loading iconLeft="check">
        Spend
      </Button>,
    );
    expect(v).toContain("bb-btn--success");
    expect(v).toContain("bb-btn--lg");
    expect(v).toContain("bb-btn--block");
    expect(v).toContain("bb-btn__spinner");
    expect(v).toContain("disabled");
  });

  it("IconButton — base class, accessible label, icon, visible tooltip (no title)", () => {
    const out = html(<IconButton icon="plus" label="Add trade" variant="solid" size="sm" />);
    expect(out).toContain("bb-iconbtn");
    expect(out).toContain("bb-iconbtn--solid");
    expect(out).toContain("bb-iconbtn--sm");
    expect(out).toContain('aria-label="Add trade"');
    expect(out).toContain("ph-plus");
    expect(out).toContain('<span class="bb-icon-tip bb-icon-tip--top" aria-hidden="true">Add trade</span>');
    expect(out).not.toContain("title=");
  });

  it("Input — field shell, error state replaces hint, leading icon", () => {
    const out = html(<Input label="Phone" hint="we never show it" error="Required" iconLeft="phone" />);
    expect(out).toContain("bb-field");
    expect(out).toContain("bb-input--error");
    expect(out).toContain("bb-input--has-left");
    expect(out).toContain("bb-field__error");
    expect(out).toContain("Phone");
    // error wins over hint
    expect(out).not.toContain("we never show it");
  });

  it("Select — restyled native select with chevron + options", () => {
    const out = html(
      <Select label="Trade">
        <option value="cnc">CNC</option>
      </Select>,
    );
    expect(out).toContain("bb-select");
    expect(out).toContain("bb-select__chevron");
    expect(out).toContain("CNC");
  });

  it("Textarea — multiline shell honoring rows", () => {
    const out = html(<Textarea label="Job description" rows={3} optional />);
    expect(out).toContain("bb-textarea");
    expect(out).toContain('rows="3"');
    expect(out).toContain("optional");
  });

  it("Checkbox / Radio / Switch — choice + switch shells with labels", () => {
    expect(html(<Checkbox label="I consent" />)).toContain("bb-choice--checkbox");
    expect(html(<Radio name="g" label="Day shift" />)).toContain("bb-choice--radio");
    const sw = html(<Switch label="Alerts" defaultChecked />);
    expect(sw).toContain("bb-switch");
    expect(sw).toContain('role="switch"');
  });

  it("OtpInput — renders N cells and marks the filled ones", () => {
    const out = html(<OtpInput length={4} value="12" />);
    expect(count(out, /bb-otp__cell(?!--)/g)).toBe(4);
    expect(count(out, /bb-otp__cell--filled/g)).toBe(2);
  });

  it("Card — variant + padding + tag override", () => {
    const out = html(
      <Card variant="ink" padding="lg" interactive as="section">
        body
      </Card>,
    );
    expect(out).toContain("bb-card--ink");
    expect(out).toContain("bb-card--pad-lg");
    expect(out).toContain("bb-card--interactive");
    expect(out.startsWith("<section")).toBe(true);
  });

  it("Badge — tone + solid variant + icon", () => {
    const out = html(
      <Badge tone="success" variant="solid" upper icon="seal-check">
        Verified
      </Badge>,
    );
    expect(out).toContain("bb-badge--success");
    expect(out).toContain("bb-badge--solid");
    expect(out).toContain("bb-badge--upper");
    expect(out).toContain("Verified");
  });

  it("Chip — a selectable chip is one toggle button", () => {
    const out = html(
      <Chip selected icon="wrench">
        CNC
      </Chip>,
    );
    expect(out).toContain("bb-chip--selected");
    expect(out).toMatch(/^<button type="button" class="bb-chip bb-chip--selected" aria-pressed="true">/);
    expect(out).not.toContain("bb-chip__remove");
  });

  it("Chip — a removable chip is static text + ONE real remove button, named for its item", () => {
    const out = html(
      <Chip selected icon="wrench" removeLabel="Remove CNC" onRemove={() => {}}>
        CNC
      </Chip>,
    );
    expect(out).toContain("bb-chip--selected");
    expect(out).toContain("bb-chip--removable");
    // The pill is not a control (no toggle state, not a button) …
    expect(out.startsWith('<span class="bb-chip bb-chip--removable bb-chip--selected">')).toBe(true);
    expect(out).not.toContain("aria-pressed");
    // … its remove is a NATIVE button (focusable, Enter/Space), named for the item, with the
    // shared tooltip — and no button sits inside another.
    expect(count(out, /<button[\s>]/g)).toBe(1);
    expect(out).toMatch(/<button type="button" class="bb-chip__remove" aria-label="Remove CNC"/);
    expect(out).not.toContain('role="button"');
    expect(out).toContain('<span class="bb-icon-tip bb-icon-tip--top-end" aria-hidden="true">Remove CNC</span>');
    expect(out).toContain("ph-x");
  });

  it("Chip — the remove tooltip is placed as it shows (focus AND hover), kept inside the chip's row", () => {
    const el = Chip({ removeLabel: "Remove CNC", onRemove: () => {}, children: "CNC" }) as ReactElement<
      Record<string, unknown>
    >;
    // The removable chip's own tree: <span class="bb-chip …">…<IconButtonBase …/></span>
    const tree = (el.type as (p: unknown) => ReactElement<{ children: ReactElement[] }>)(el.props);
    const remove = (tree.props.children as ReactElement<Record<string, unknown>>[]).find(
      (c) => c && typeof c === "object" && (c.props as { classBase?: string }).classBase === "bb-chip__remove",
    )!;
    const writes: string[] = [];
    const target = {
      style: { setProperty: (k: string, v: string) => writes.push(`${k}=${v}`), removeProperty: () => "" },
      querySelector: () => ({ getClientRects: () => [{}], getBoundingClientRect: () => ({ left: -10 }) }),
      closest: () => ({ parentElement: { getBoundingClientRect: () => ({ left: 20 }) } }),
    };
    for (const handler of ["onFocus", "onPointerEnter"]) {
      writes.length = 0;
      (remove.props[handler] as (e: unknown) => void)({ currentTarget: target });
      expect(writes, handler).toEqual(["--bb-tip-shift=30"]);
    }
  });

  it("StatTile — mono value, label, delta direction", () => {
    const out = html(<StatTile label="Balance" value="₹40" icon="wallet" delta="+2 this week" deltaDir="up" />);
    expect(out).toContain("bb-stat__value");
    expect(out).toContain("₹40");
    expect(out).toContain("bb-stat__delta--up");
  });

  it("Avatar — masked blur class + verified seal, sized from prop", () => {
    const out = html(<Avatar name="Test User" size={52} masked verified />);
    expect(out).toContain("bb-avatar--masked");
    expect(out).toContain("bb-avatar__seal");
    expect(out).toMatch(/width:52px/);
  });

  it("Dialog — open renders the modal; closed renders nothing", () => {
    const open = html(
      <Dialog open title="Confirm unlock" onClose={() => {}} footer={<span>actions</span>}>
        Spend 1 credit?
      </Dialog>,
    );
    expect(open).toContain("bb-dialog");
    expect(open).toContain('role="dialog"');
    expect(open).toContain("Confirm unlock");
    expect(open).toContain("Spend 1 credit?");
    expect(html(<Dialog open={false}>hidden</Dialog>)).toBe("");
  });

  it("Toast — tone class, title, message, neutral by default", () => {
    const out = html(
      <Toast tone="danger" title="Could not unlock" onClose={() => {}}>
        Please try again
      </Toast>,
    );
    expect(out).toContain("bb-toast--danger");
    expect(out).toContain("Could not unlock");
    expect(out).toContain("Please try again");
    expect(html(<Toast title="Saved" />)).toMatch(/bb-toast(?!--)/);
  });

  it("Tooltip — wraps a trigger and exposes the label", () => {
    const out = html(
      <Tooltip label="Why masked?" placement="bottom">
        <span>?</span>
      </Tooltip>,
    );
    expect(out).toContain("bb-tooltip--bottom");
    expect(out).toContain("Why masked?");
  });

  it("ProgressBar — clamps out-of-range value to 100%", () => {
    const out = html(<ProgressBar value={150} showValue label="Quota" />);
    expect(out).toContain("width:100%");
    expect(out).toContain("100%");
    expect(out).toContain('aria-valuenow="100"');
  });

  it("Tabs — one active tab, role wiring, both rendered", () => {
    const out = html(
      <Tabs
        variant="segmented"
        value="new"
        tabs={[
          { id: "new", label: "New" },
          { id: "short", label: "Shortlist" },
        ]}
      />,
    );
    expect(count(out, /class="bb-tab(?: |")/g)).toBe(2);
    expect(count(out, /bb-tab--active/g)).toBe(1);
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain("Shortlist");
  });

  it("BadaBhaiLogo — the brand-kit monogram on a tile + the navy logotype, sized by token var (no raw hex)", () => {
    const out = html(<BadaBhaiLogo />);
    expect(out).toContain("bb-lockup");
    expect(out).toContain("bb-lockup__tile");
    // The images are CSS backgrounds from the token package — no <img>, nothing to announce.
    expect(out).toContain('<span class="bb-lockup__tile" aria-hidden="true"><span class="bb-lockup__mark"></span></span>');
    expect(out).not.toContain("<img");
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="BadaBhai"');
    // The official logotype image (Shift Blue on paper); decorative — the root names it.
    expect(out).toContain('<span class="bb-lockup__wordmark" aria-hidden="true"></span>');
    expect(out).toContain("--bb-lockup-size:32px");
    expect(out).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("BadaBhaiLogo — ink drops the tile fill (on-ink), mark/wordmark variants, caption", () => {
    const ink = html(<BadaBhaiLogo theme="ink" sub="for Employers" />);
    expect(ink).toContain("bb-lockup--on-ink");
    // On the navy band the WHITE logotype, never the navy one (it would vanish).
    // The on-ink class is what swaps in the WHITE logotype (tokens.css); the markup is shared.
    expect(ink).toContain('class="bb-lockup bb-lockup--on-ink"');
    expect(ink).toContain('<span class="bb-lockup__sub">for Employers</span>');
    expect(html(<BadaBhaiLogo variant="mark" />)).not.toContain("bb-lockup__wordmark");
    expect(html(<BadaBhaiLogo variant="wordmark" />)).not.toContain("bb-lockup__tile");
  });
});

describe("DS0.2 · MaskedCandidate never leaks a passed real name while masked", () => {
  it("masked: blurs to a decoy, drops the real name, shows the unlock CTA", () => {
    const out = html(<MaskedCandidate masked name="ZZSENTINELNAME" trade="CNC" experience="6 yrs" price="₹40" />);
    expect(out).toContain("bb-candidate--masked");
    expect(out).toContain("••");
    expect(out).toContain("₹40");
    // the real name must NOT appear anywhere in the masked DOM
    expect(out).not.toContain("ZZSENTINELNAME");
  });

  it("unmasked: shows the supplied label + the unlocked state, no price button", () => {
    const out = html(<MaskedCandidate masked={false} name="Asha R" trade="CNC" />);
    expect(out).toContain("Asha R");
    expect(out).toContain("bb-candidate__unlocked");
    expect(out).not.toContain("bb-candidate--masked");
  });
});

describe("DS0.2 · adherence — no raw hex / px literal in any wrapper source", () => {
  const dsDir = fileURLToPath(new URL("./", import.meta.url));
  const sources = readdirSync(dsDir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && !f.includes(".stories."))
    .map((f) => ({ f, code: stripComments(readFileSync(new URL(f, import.meta.url), "utf8")) }));

  it("covers the whole library (13 component modules — the swipe JobCard was removed in PR-B; IconButton moved to its own module)", () => {
    expect(sources.length).toBe(13);
  });

  for (const { f } of sources) {
    it(`${f} — uses tokens, not raw hex colors`, () => {
      const code = sources.find((s) => s.f === f)!.code;
      expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
    it(`${f} — uses tokens, not raw px literals`, () => {
      const code = sources.find((s) => s.f === f)!.code;
      expect(code).not.toMatch(/\b\d+px\b/);
    });
  }
});

/** Strip block + line comments so the adherence grep sees code, not prose (the real
 *  adherence oxlint inspects AST literals, not comments). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
