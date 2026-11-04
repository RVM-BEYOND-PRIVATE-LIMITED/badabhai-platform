"use client";

/**
 * BadaBhai Design System — Tabs (underline page sections / segmented filters / role views).
 *
 * Client primitive: emits the selected id via `onChange` (the parent owns selection).
 * Presentational only. Prop contract mirrors
 * docs/design/.../components/navigation/Tabs.d.ts.
 *
 * ARIA: a real WAI-ARIA tablist — `role=tablist` wraps `role=tab` buttons with
 * `aria-selected`, ROVING TABINDEX (only the active tab is tab-stoppable), and ←/→
 * (and Home/End) arrow navigation that moves selection + focus. When `idBase` is
 * supplied each tab gets a stable id and an `aria-controls` pointing at its panel, so a
 * consumer can render `role=tabpanel` + `aria-labelledby={tabId(idBase, id)}` and the
 * pair is announced as one widget. `idBase` is additive/optional — existing call sites
 * (segmented filters) keep working unchanged.
 *
 * ONE SLIDING INDICATOR (#2583): the underline and the segment's raised pill are a single
 * aria-hidden element that glides to the active tab (transform only, --duration-slow /
 * --ease-glide; still under reduced motion). It is placed from the live layout by a callback ref
 * — no hooks, see below — and re-placed when the tablist resizes. Until it is placed (server
 * render, before hydration) the active tab draws its own static marker, so there is never a frame
 * without one.
 */
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { Icon, type IconName } from "@badabhai/icons";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional Phosphor glyph name (filled when active). */
  icon?: IconName;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Tab definitions. */
  tabs: TabItem[];
  /** Selected tab id. */
  value?: string;
  /** Called with the new tab id. */
  onChange?: (id: string) => void;
  /** @default 'underline' */
  variant?: "underline" | "segmented";
  /**
   * When set, every tab receives a stable `id` of `${idBase}-tab-${tabId}` and an
   * `aria-controls` of `${idBase}-panel-${tabId}`. Use {@link tabId} / {@link tabPanelId}
   * to label the matching `role=tabpanel`. Omit it for plain segmented filters.
   */
  idBase?: string;
}

/** The element id of a tab button for a given `idBase` (use as a panel's `aria-labelledby`). */
export const tabId = (idBase: string, id: string) => `${idBase}-tab-${id}`;
/** The element id of a tab's panel for a given `idBase` (use as the tab's `aria-controls`). */
export const tabPanelId = (idBase: string, id: string) => `${idBase}-panel-${id}`;

/** Set on the tablist once its indicator is placed; the stylesheet hands the marker over then. */
export const TABS_INDICATOR_ATTR = "data-indicator";

/**
 * Move the indicator onto the active tab: its offset box becomes the indicator's CSS variables.
 * With no active tab the attribute is dropped and no tab is marked.
 */
export function placeTabsIndicator(list: HTMLElement): void {
  const bar = list.querySelector<HTMLElement>(".bb-tabs__indicator");
  const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!bar || !active) {
    list.removeAttribute(TABS_INDICATOR_ATTR);
    return;
  }
  bar.style.setProperty("--bb-tabs-x", `${active.offsetLeft}px`);
  bar.style.setProperty("--bb-tabs-y", `${active.offsetTop}px`);
  bar.style.setProperty("--bb-tabs-w", `${active.offsetWidth}px`);
  bar.style.setProperty("--bb-tabs-h", `${active.offsetHeight}px`);
  list.setAttribute(TABS_INDICATOR_ATTR, "ready");
}

/**
 * The tablist's callback ref. A fresh function each render, so React calls it after EVERY commit
 * — a new active tab is placed without a hook — and its cleanup stops the resize watch.
 */
function indicatorRef(list: HTMLDivElement | null): (() => void) | undefined {
  if (!list) return undefined;
  placeTabsIndicator(list);
  if (typeof ResizeObserver === "undefined") return undefined;
  const watch = new ResizeObserver(() => placeTabsIndicator(list));
  watch.observe(list);
  return () => watch.disconnect();
}

export function Tabs({
  tabs,
  value,
  onChange,
  variant = "underline",
  idBase,
  className = "",
  ...rest
}: TabsProps) {
  const cls = ["bb-tabs", `bb-tabs--${variant}`, className].filter(Boolean).join(" ");

  const activeIndex = tabs.findIndex((t) => t.id === value);

  // Hook-free focus management: locate sibling tab buttons via the live tablist DOM at
  // key-time (keeps this primitive a pure function component — no useRef/useState — so it
  // stays renderable from any RSC walker + test). `currentTarget` is the pressed tab button.
  function moveTo(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const wrapped = ((index % tabs.length) + tabs.length) % tabs.length;
    const t = tabs[wrapped];
    if (!t) return;
    onChange?.(t.id);
    const list = e.currentTarget.parentElement;
    const buttons = list?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[wrapped]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        moveTo(e, index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        moveTo(e, index - 1);
        break;
      case "Home":
        e.preventDefault();
        moveTo(e, 0);
        break;
      case "End":
        e.preventDefault();
        moveTo(e, tabs.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div className={cls} role="tablist" ref={(el) => indicatorRef(el)} {...rest}>
      {tabs.map((t, i) => {
        const active = value === t.id;
        // Roving tabindex: only the active tab (or the first, when none is active) is a
        // tab-stop; the rest are reached with the arrow keys.
        const tabStop = active || (activeIndex < 0 && i === 0);
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={idBase ? tabId(idBase, t.id) : undefined}
            aria-selected={active}
            aria-controls={idBase ? tabPanelId(idBase, t.id) : undefined}
            tabIndex={tabStop ? 0 : -1}
            className={`bb-tab ${active ? "bb-tab--active" : ""}`}
            onClick={() => onChange?.(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {/* Solid glyph in both states (brand: no outline icons) — the active tab is
                carried by .bb-tab--active + aria-selected, not by the icon weight. */}
            {t.icon && <Icon name={t.icon} />}
            {t.label}
          </button>
        );
      })}
      <span className="bb-tabs__indicator" aria-hidden="true" />
    </div>
  );
}
