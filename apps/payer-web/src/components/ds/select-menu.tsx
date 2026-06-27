"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * BadaBhai Design System — SelectMenu (accessible custom combobox).
 *
 * A token-styled replacement for a native `<select>` whose OPEN list the browser renders
 * un-themeable. This is a WAI-ARIA listbox: a button trigger (`aria-haspopup="listbox"`,
 * `aria-expanded`) + a popup `role="listbox"` with `role="option"` rows. Full keyboard
 * support (Up/Down/Home/End/Enter/Esc/type-ahead), `aria-activedescendant`, click-outside,
 * and a restrained entrance animation (collapses under prefers-reduced-motion via tokens).
 *
 * Contract is a plain value in / `onChange(value)` out — the consumer owns the value, so a
 * form's existing state + validation are untouched (drop-in for the DS `Select`). Presentation
 * only; no business logic. Mirrors the visual language of `.bb-input` / `.bb-select`.
 */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectMenuProps {
  id?: string;
  label?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SelectMenu({
  id,
  label,
  hint,
  error,
  optional = false,
  value,
  options,
  onChange,
  placeholder = "Select…",
}: SelectMenuProps) {
  const reactId = useId();
  const baseId = id || `bb-selectmenu-${reactId}`;
  const labelId = `${baseId}-label`;
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });

  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (opt) onChange(opt.value);
      close();
    },
    [options, onChange, close],
  );

  // Sync the active row to the current value each time the menu opens.
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx < 0 ? 0 : idx);
      // Move focus into the listbox so arrow keys are captured.
      listRef.current?.focus();
    }
  }, [open, options, value]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
    }
  }

  function typeaheadTo(key: string) {
    const now = Date.now();
    const t = typeahead.current;
    t.buffer = now - t.at > 600 ? key : t.buffer + key;
    t.at = now;
    const match = options.findIndex((o) => o.label.toLowerCase().startsWith(t.buffer.toLowerCase()));
    if (match >= 0) setActiveIndex(match);
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLUListElement>) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1) typeaheadTo(e.key);
    }
  }

  const triggerCls = [
    "bb-input",
    "bb-selectmenu__trigger",
    error ? "bb-input--error" : "",
    open ? "bb-selectmenu__trigger--open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="bb-field bb-selectmenu" ref={rootRef}>
      {label ? (
        <span className="bb-field__label" id={labelId}>
          {label}
          {optional && <span className="bb-field__opt"> · optional</span>}
        </span>
      ) : null}

      <div className="bb-selectmenu__wrap">
        <button
          type="button"
          id={baseId}
          ref={triggerRef}
          className={triggerCls}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={label ? `${labelId} ${baseId}` : undefined}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onTriggerKeyDown}
        >
          <span className={selected ? "bb-selectmenu__value" : "bb-selectmenu__placeholder"}>
            {selected ? selected.label : placeholder}
          </span>
          <i className="ph ph-caret-down bb-selectmenu__caret" aria-hidden="true" />
        </button>

        {open ? (
          <ul
            className="bb-selectmenu__list"
            role="listbox"
            ref={listRef}
            tabIndex={-1}
            aria-labelledby={label ? labelId : undefined}
            aria-activedescendant={`${baseId}-opt-${activeIndex}`}
            onKeyDown={onListKeyDown}
          >
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              const isActive = i === activeIndex;
              const cls = [
                "bb-selectmenu__option",
                isActive ? "bb-selectmenu__option--active" : "",
                isSelected ? "bb-selectmenu__option--selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li
                  key={opt.value}
                  id={`${baseId}-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={isSelected}
                  className={cls}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                >
                  <span className="bb-selectmenu__option-label">{opt.label}</span>
                  {isSelected ? (
                    <i className="ph ph-check bb-selectmenu__option-check" aria-hidden="true" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {error ? (
        <span className="bb-field__error">
          <i className="ph ph-warning-circle" aria-hidden="true" />
          {error}
        </span>
      ) : hint ? (
        <span className="bb-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}
