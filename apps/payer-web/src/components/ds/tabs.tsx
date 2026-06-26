"use client";

/**
 * BadaBhai Design System — Tabs (underline page sections / segmented filters).
 *
 * Client primitive: emits the selected id via `onChange` (the parent owns selection).
 * Presentational only. Prop contract mirrors
 * docs/design/.../components/navigation/Tabs.d.ts.
 */
import type { HTMLAttributes, ReactNode } from "react";

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
}

export function Tabs({ tabs, value, onChange, variant = "underline", className = "", ...rest }: TabsProps) {
  const cls = ["bb-tabs", `bb-tabs--${variant}`, className].filter(Boolean).join(" ");

  return (
    <div className={cls} role="tablist" {...rest}>
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`bb-tab ${active ? "bb-tab--active" : ""}`}
            onClick={() => onChange?.(t.id)}
          >
            {t.icon && <i className={`${active ? "ph-fill" : "ph"} ph-${t.icon}`} aria-hidden="true" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
