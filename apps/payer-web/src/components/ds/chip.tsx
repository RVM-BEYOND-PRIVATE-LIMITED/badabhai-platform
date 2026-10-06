"use client";

/**
 * BadaBhai Design System — Chip (selectable / removable pill).
 *
 * Two shapes, one look (style via `.bb-*` + tokens):
 *   - SELECTABLE (the default): the whole pill is ONE native `<button>`; `selected` is its
 *     `aria-pressed` state. A suggestion chip is the same button without `selected`.
 *   - REMOVABLE (`onRemove`): the pill is static content — its text is a value the payer entered,
 *     not a control — holding ONE real control: a native remove `<button>` built on the shared
 *     icon-only control (`IconButtonBase`, @badabhai/icons/button). So it is in the Tab order,
 *     works with Enter / Space, is named by `removeLabel` ("Remove Fanuc control" — WHICH chip,
 *     not a bare "Remove"), shows that name as its tooltip on hover and keyboard focus, and clears
 *     a 44px hit area on a phone or any coarse pointer (ds-components.css). It used to be a
 *     `span role="button"` nested INSIDE the chip's own button — never focusable, named only
 *     "Remove", and interactive content inside a button is invalid HTML.
 */
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import { IconButtonBase } from "@badabhai/icons/button";
import { hideTip, showTip, unwatchTip } from "./chip-tip";

interface ChipLook {
  /** Selected (brand) state. On a selectable chip it is also `aria-pressed`. */
  selected?: boolean;
  /** Leading glyph. */
  icon?: IconName;
  className?: string;
  children?: ReactNode;
}

/** A selectable / action chip: one native button. */
export interface SelectableChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className">,
    ChipLook {
  onRemove?: undefined;
  removeLabel?: undefined;
}

/** A removable chip: static text + one remove button. */
export interface RemovableChipProps extends ChipLook {
  /** Called when the remove button is activated (click, Enter or Space). */
  onRemove: (e: MouseEvent<HTMLButtonElement>) => void;
  /**
   * REQUIRED with `onRemove`: the remove button's accessible name AND its visible tooltip. Name
   * the item — `Remove ${item}` — so a list of chips is not a list of identical "Remove" buttons.
   */
  removeLabel: string;
  /** Disables the remove button. */
  disabled?: boolean;
}

export type ChipProps = SelectableChipProps | RemovableChipProps;

/**
 * Measure the remove button's tooltip as it shows (focus / hover) and keep it inside the row —
 * again on every window resize while it stays shown, until it hides (./chip-tip.ts).
 */
const placeTip = (e: { currentTarget: HTMLButtonElement }) => showTip(e.currentTarget, window);
const releaseTip = (e: { currentTarget: HTMLButtonElement }) => hideTip(e.currentTarget);
/**
 * A chip removed while its tooltip shows (by its own button) gets no blur or pointer leave: its
 * unmount ends the watch. A stable ref callback, so React runs it on mount and unmount only.
 */
const unwatchOnUnmount = (chip: HTMLSpanElement | null) => {
  if (chip === null) return;
  return () => {
    const button = chip.querySelector<HTMLButtonElement>(".bb-chip__remove");
    if (button !== null) unwatchTip(button);
  };
};

const chipClass = (selected: boolean, className: string, removable: boolean) =>
  [
    "bb-chip",
    removable ? "bb-chip--removable" : "",
    selected ? "bb-chip--selected" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

function RemovableChip({
  selected = false,
  icon,
  className = "",
  children,
  onRemove,
  removeLabel,
  disabled,
}: RemovableChipProps) {
  return (
    <span className={chipClass(selected, className, true)} ref={unwatchOnUnmount}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      <IconButtonBase
        classBase="bb-chip__remove"
        icon={ACTION_ICON.dismiss}
        label={removeLabel}
        // Grows inward from the chip's end, so a long name can never push the page sideways — and
        // slides back inside the row when it would cross the row's start (./chip-tip.ts).
        tooltipPlacement="top-end"
        onFocus={placeTip}
        onPointerEnter={placeTip}
        onBlur={releaseTip}
        onPointerLeave={releaseTip}
        disabled={disabled}
        onClick={onRemove}
      />
    </span>
  );
}

export function Chip(props: ChipProps) {
  if (props.onRemove !== undefined) return <RemovableChip {...props} />;
  const {
    selected = false,
    icon,
    className = "",
    children,
    onRemove: _onRemove,
    removeLabel: _removeLabel,
    ...rest
  } = props;
  return (
    <button
      type="button"
      className={chipClass(selected, className, false)}
      aria-pressed={selected}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  );
}
