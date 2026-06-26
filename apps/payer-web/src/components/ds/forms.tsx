/**
 * BadaBhai Design System — FORM primitives (typed React wrappers).
 *
 * These are SHARED (no "use client"): purely presentational, no hooks and no
 * internally-defined handlers — they only forward `onClick`/`onChange` etc. via
 * `...rest`, so a consumer adopts the right runtime (a client screen renders them
 * client-side; a server component renders them server-side). Style comes only from
 * the `.bb-*` design-system classes + tokens (src/styles/ds-components.css). No
 * business logic. Prop contracts mirror docs/design/.../components/forms/*.d.ts.
 *
 * Phosphor glyphs (`ph ph-*`) are aria-hidden and degrade to empty inline marks if
 * the icon font is not loaded — text labels always carry the meaning.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

/* Auto-id for fields rendered without an explicit `id` (label ↔ control association). */
let _fieldId = 0;
const nextFieldId = (prefix: string) => `${prefix}-${++_fieldId}`;

/* Shared label + hint/error slots for the Input/Select/Textarea field shell. */
function FieldLabel({ id, label, optional }: { id: string; label?: string; optional?: boolean }) {
  if (!label) return null;
  return (
    <label className="bb-field__label" htmlFor={id}>
      {label}
      {optional && <span className="bb-field__opt"> · optional</span>}
    </label>
  );
}

function FieldFeedback({ error, hint }: { error?: string; hint?: string }) {
  if (error) {
    return (
      <span className="bb-field__error">
        <i className="ph ph-warning-circle" aria-hidden="true" />
        {error}
      </span>
    );
  }
  if (hint) return <span className="bb-field__hint">{hint}</span>;
  return null;
}

/* ---------- Button ---------- */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. `primary` (brand) is the single CTA per screen. @default 'primary' */
  variant?: "primary" | "secondary" | "tonal" | "ghost" | "success" | "danger";
  /** @default 'md' */
  size?: "sm" | "md" | "lg";
  /** Stretch to fill the container width. */
  block?: boolean;
  /** Phosphor glyph name rendered before the label. */
  iconLeft?: string;
  /** Phosphor glyph name rendered after the label. */
  iconRight?: string;
  /** Show a spinner and disable interaction. */
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  iconLeft,
  iconRight,
  loading = false,
  disabled = false,
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    "bb-btn",
    `bb-btn--${variant}`,
    size !== "md" ? `bb-btn--${size}` : "",
    block ? "bb-btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="bb-btn__spinner" aria-hidden="true" />}
      {!loading && iconLeft && <i className={`ph ph-${iconLeft}`} aria-hidden="true" />}
      {children != null && <span>{children}</span>}
      {!loading && iconRight && <i className={`ph ph-${iconRight}`} aria-hidden="true" />}
    </button>
  );
}

/* ---------- IconButton ---------- */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Phosphor glyph name (no `ph-` prefix). */
  icon: string;
  /** Accessible label — required, also used as the tooltip title. */
  label: string;
  /** @default 'ghost' */
  variant?: "ghost" | "solid" | "outline";
  /** @default 'md' */
  size?: "sm" | "md" | "lg";
}

export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  className = "",
  ...rest
}: IconButtonProps) {
  const cls = [
    "bb-iconbtn",
    variant !== "ghost" ? `bb-iconbtn--${variant}` : "",
    size !== "md" ? `bb-iconbtn--${size}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={cls} aria-label={label} title={label} {...rest}>
      <i className={`ph ph-${icon}`} aria-hidden="true" />
    </button>
  );
}

/* ---------- Input ---------- */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  iconLeft?: string;
  iconRight?: string;
  optional?: boolean;
}

export function Input({
  label,
  hint,
  error,
  iconLeft,
  iconRight,
  optional = false,
  id,
  className = "",
  ...rest
}: InputProps) {
  const inputId = id || nextFieldId("bb-input");
  const cls = [
    "bb-input",
    iconLeft ? "bb-input--has-left" : "",
    iconRight ? "bb-input--has-right" : "",
    error ? "bb-input--error" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="bb-field">
      <FieldLabel id={inputId} label={label} optional={optional} />
      <div className="bb-input-wrap">
        {iconLeft && (
          <span className="bb-input__icon bb-input__icon--left">
            <i className={`ph ph-${iconLeft}`} aria-hidden="true" />
          </span>
        )}
        <input id={inputId} className={cls} {...rest} />
        {iconRight && (
          <span className="bb-input__icon bb-input__icon--right">
            <i className={`ph ph-${iconRight}`} aria-hidden="true" />
          </span>
        )}
      </div>
      <FieldFeedback error={error} hint={hint} />
    </div>
  );
}

/* ---------- Select ---------- */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children?: ReactNode;
}

export function Select({
  label,
  hint,
  error,
  optional = false,
  id,
  className = "",
  children,
  ...rest
}: SelectProps) {
  const sid = id || nextFieldId("bb-select");
  const cls = ["bb-input", "bb-select", error ? "bb-input--error" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="bb-field">
      <FieldLabel id={sid} label={label} optional={optional} />
      <div className="bb-select-wrap">
        <select id={sid} className={cls} {...rest}>
          {children}
        </select>
        <span className="bb-select__chevron">
          <i className="ph ph-caret-down" aria-hidden="true" />
        </span>
      </div>
      <FieldFeedback error={error} hint={hint} />
    </div>
  );
}

/* ---------- Textarea ---------- */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  /** @default 4 */
  rows?: number;
}

export function Textarea({
  label,
  hint,
  error,
  optional = false,
  rows = 4,
  id,
  className = "",
  ...rest
}: TextareaProps) {
  const taId = id || nextFieldId("bb-textarea");
  const cls = ["bb-input", "bb-textarea", error ? "bb-input--error" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="bb-field">
      <FieldLabel id={taId} label={label} optional={optional} />
      <textarea id={taId} className={cls} rows={rows} {...rest} />
      <FieldFeedback error={error} hint={hint} />
    </div>
  );
}

/* ---------- Checkbox ---------- */
export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
}

export function Checkbox({ label, className = "", ...rest }: CheckboxProps) {
  return (
    <label className={["bb-choice", "bb-choice--checkbox", className].filter(Boolean).join(" ")}>
      <input type="checkbox" {...rest} />
      <span className="bb-choice__box">
        <i className="ph-bold ph-check" aria-hidden="true" />
      </span>
      {label != null && <span className="bb-choice__label">{label}</span>}
    </label>
  );
}

/* ---------- Radio ---------- */
export interface RadioProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
}

export function Radio({ label, className = "", ...rest }: RadioProps) {
  return (
    <label className={["bb-choice", "bb-choice--radio", className].filter(Boolean).join(" ")}>
      <input type="radio" {...rest} />
      <span className="bb-choice__box">
        <span className="bb-choice__dot" aria-hidden="true" />
      </span>
      {label != null && <span className="bb-choice__label">{label}</span>}
    </label>
  );
}

/* ---------- Switch ---------- */
export interface SwitchProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
}

export function Switch({ label, className = "", ...rest }: SwitchProps) {
  return (
    <label className={["bb-switch", className].filter(Boolean).join(" ")}>
      <input type="checkbox" role="switch" {...rest} />
      <span className="bb-switch__track">
        <span className="bb-switch__thumb" />
      </span>
      {label != null && <span className="bb-switch__label">{label}</span>}
    </label>
  );
}
