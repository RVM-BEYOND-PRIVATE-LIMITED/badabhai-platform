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
 */
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional Phosphor glyph name (filled when active). */
  icon?: string;
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
    <div className={cls} role="tablist" {...rest}>
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
            {t.icon && <i className={`${active ? "ph-fill" : "ph"} ph-${t.icon}`} aria-hidden="true" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
